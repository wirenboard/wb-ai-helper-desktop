import type { ChatCompletionTool } from 'openai/resources/chat/completions.mjs'
import { parseHostPort, type Discovery, type Controller } from './discovery.ts'
import type { MqttPool } from './mqtt-pool.ts'
import type { SshPool } from './ssh.ts'
import { probe } from './http-probe.ts'
import type { DbHandle } from './db.ts'
import { getTodos, setTodos, formatTodos, type TodoItem, type TodoStatus } from './todos.ts'
import {
  getSkill, upsertUserSkill, deleteUserSkill,
  trackLoadedSkill, unloadSkillFromSession, getLoadedSkills, extractDescription, SKILL_NAME_RE,
} from './skills.ts'
import { truncateLog } from './log-truncate.ts'
import { trackJob, getRunningJobForSn, updateJobState } from './jobs.ts'
import { runAudit, runSnapshot, runDiffSnapshot } from './audit.ts'
import { basename } from 'node:path'
import { saveAttachment, getAttachment, readAttachment, listSession as listAttachments } from './attachments.ts'
import JSZip from 'jszip'
import { extract as tarExtract } from 'tar-stream'
import { Readable } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import { renderHistoryChart } from './history-chart.ts'
import {
  readMarkedSection,
  normalizeInterface,
  pickDefaultRoute,
  parseNmcliColons,
  parsePingLossPct,
  parseCloudMqttControls,
} from './diagnostics-parsers.ts'
import { buildInventory } from './mqtt-inventory.ts'
import { normalizeAptCommand } from './apt-defaults.ts'
import {
  parseTemplatesList,
  filterTemplates,
  summarizeByGroup,
  renderTemplate,
  buildLoadConfigParams,
  enrichSerialRpcError,
} from './modbus-templates.ts'

/** Common controller-target params: either `sn` (registry key, usually a serial
 *  like A25NDEMJ from list_controllers) or `host` (IP/hostname/host:port for
 *  ad-hoc connection). At least one must be present, but `required` is left empty
 *  — a runtime fallback to chat contextSns handles the case when neither sn nor
 *  host is passed. JSON Schema XOR cannot express this reliably across providers,
 *  so validation lives on the backend (`resolve1`). */
const CONTROLLER_TARGET_PROPS = {
  sn: { type: 'string' as const, description: 'Controller serial number (e.g. A25NDEMJ) from the chat context or the list_controllers response.' },
  host: { type: 'string' as const, description: 'Alternative to sn — IP, hostname or host:port (e.g. 192.168.1.10, wirenboard-abc.local, 192.168.1.10:2222). Use it when the controller is shown by IP, or you explicitly want to address it over a non-standard SSH port.' },
}

export function toolSchemas(): ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'list_controllers',
        description:
          'List of all Wirenboard controllers found on the local network via mDNS, plus manually added ones. Returns SN, hostname, reachability and the time of the last response.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'probe_controller',
        description: 'Check controller reachability over HTTP (web UI) and refresh its status.',
        parameters: {
          type: 'object',
          properties: { ...CONTROLLER_TARGET_PROPS },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_devices',
        description:
          'List of devices on controllers (or a group). Polls the MQTT topics /devices/+/meta/name. If sn is not specified, the current chat context is used.',
        parameters: {
          type: 'object',
          properties: {
            sn: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
              description: 'SN or an array of SNs. If omitted — all controllers from the chat context.',
            },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_controls',
        description: 'List of controls of a specific device on the controller (via MQTT).',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string' },
            device: { type: 'string', description: 'Device ID, e.g. `wb-mr6c_45`' },
          },
          required: ['device'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mqtt_inventory',
        description: 'Combined snapshot of MQTT devices in a single call: id, name, driver, error + a list of controls with unpacked meta (value, type, units, readonly, order, min/max, precision, error). Replaces the pair `list_devices` + N×`list_controls`. The `error` field is parsed per [WB MQTT Conventions](https://github.com/wirenboard/conventions): `r` (read), `w` (write), `p` (period miss) and combinations. **When `error.read=true` the value in the value-topic is last-known-good (the last successfully read value), not the current live readout** — without this knowledge the model often makes a wrong diagnosis like "the sensor shows 23°C, but the device is offline". Additionally returns an `errors` array summarizing all problems on the controller. By default `includeEmpty=false` (devices without controls are hidden).',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            device: { type: 'string', description: 'Filter by device_id (substring, case-insensitive). Empty — all devices.' },
            timeout: { type: 'number', description: 'Collection window in seconds. Default 3.' },
            includeEmpty: { type: 'boolean', description: 'Include devices without controls (meta only). Default false.' },
            includeMeta: { type: 'boolean', description: 'Put the full raw meta object into each control. Default false (unpacked fields only).' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mqtt_read',
        description: 'Read a single retained topic value (mosquitto_sub -C 1 -W). Returns the current value or null if the topic is not retained.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string' },
            topic: { type: 'string', description: 'Full topic path, e.g. `/devices/wb-mr6c_45/controls/K1`' },
          },
          required: ['topic'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mqtt_write',
        description:
          'Publish a value to an MQTT topic on the controller (mosquitto_pub). For control use the /on suffix (e.g. /devices/wb-gpio/controls/A1_OUT/on). By default qos=1, retain=false — this is required for `/on` commands. To write retained config (e.g. into system topics or meta settings) set retain=true. HITL: before the call, explain to the user what you are doing and wait for confirmation.',
        parameters: {
          type: 'object',
          properties: {
            sn: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
            },
            topic: { type: 'string' },
            payload: { type: 'string' },
            qos: { type: 'integer', enum: [0, 1, 2], description: 'MQTT QoS, default 1.' },
            retain: { type: 'boolean', description: 'Publish as retained, default false.' },
          },
          required: ['topic', 'payload'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ssh_exec',
        description:
          'Run a shell command on the controller. For instant commands (local cache, no network): ls, cat, dpkg -l, apt list, apt policy, wb-release, systemctl status, journalctl. For network/long-running ones (apt update/install/upgrade, wb-release -t, tar of large directories) — use ssh_exec_async. For dangerous commands — first explain to the user, wait for confirmation.',
        parameters: {
          type: 'object',
          properties: {
            sn: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
              description: 'SN or an array of SNs. If omitted — controllers from the chat context.',
            },
            command: { type: 'string' },
            timeoutMs: { type: 'number', description: 'command timeout (default 10000, maximum 120000)' },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ssh_read_file',
        description: 'Read a file from the controller over SSH (via head -c, size-limited).',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string' },
            path: { type: 'string' },
            maxBytes: { type: 'number', description: 'default 64000' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ssh_read_logs',
        description: 'Last lines of the systemd journal. If a unit is specified — only that service; otherwise the full journal. For diagnostics use priority="err" to see only errors.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string' },
            unit: { type: 'string', description: 'systemd unit, e.g. wb-mqtt-serial' },
            lines: { type: 'number', description: 'number of lines (default 200, maximum 2000)' },
            priority: { type: 'string', description: 'journalctl priority filter: err, warning, info, debug. Default — all levels.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'todo_write',
        description: 'Write a plan of subtasks for the current session. Overwrites the list ENTIRELY — pass the whole set of items every time, including already completed ones. Use it for tasks with 3+ steps, for analysis/assessment (audit, diagnostics, comparing controllers), multi-stage updates and backups. After each step update the status immediately: exactly one item "in_progress", completed ones — "completed". Do not use it for trivial single-step tasks. The list is visible to the model on every turn.',
        parameters: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                },
                required: ['content', 'status'],
              },
            },
          },
          required: ['todos'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'checkpoint',
        description: 'Record an intermediate result of the current stage and compact the context. Call it when: (1) 5-7+ tools have run in a row, (2) a logical stage is finished (diagnostics, data collection, installation), (3) all items of the current todo_write phase are marked completed. The summary parameter is a 3-7 sentence summary: what was investigated/done, what was found, what is planned next. Current pending tasks from todo_write are automatically saved in the checkpoint — no need to duplicate them in the summary. After a checkpoint, old tool results are replaced by the summary, and the new phase starts from a clean context.',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
          },
          required: ['summary'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'load_skill',
        description: 'Load the content of a specialized skill (markdown with instructions) BEFORE acting on the relevant topic. The list of available skills with descriptions is in the system prompt. After finishing the task, unload the skill via unload_skill to free up context.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name from the catalog, kebab-case.' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'unload_skill',
        description: 'Unload a previously loaded skill from the active session context. Call it after finishing the task the skill was needed for — this frees up context. The skill stays in the catalog and can be loaded again via load_skill.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_skill',
        description: 'Create or update a user skill in the catalog. Call it when the user asks to "create a skill", "update skill X", "make a skill out of this", "remember this topic as a skill". Before the call, load skill-creator and follow the format. The catalog description is extracted by the server itself from the first paragraph after the `# <name>` heading. System skills are not overwritten by this tool.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'kebab-case, 1-63 characters.' },
            content: { type: 'string', description: 'Markdown. Required: # <name>, blank line, description, content.' },
          },
          required: ['name', 'content'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_skill',
        description: 'Delete a user skill from the DB. System skills are not deleted.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_controller',
        description: 'Basic information about the controller: hostname, uname, uptime, firmware version. Done in a single SSH request.',
        parameters: {
          type: 'object',
          properties: { ...CONTROLLER_TARGET_PROPS },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_metrics',
        description: 'System metrics of the controller: load average, RAM, disks (/, /mnt/data). Raw data from cat /proc/loadavg, free -m, df -h.',
        parameters: {
          type: 'object',
          properties: { ...CONTROLLER_TARGET_PROPS },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'failed_units',
        description: 'List of failed systemd units on the controller (`systemctl --failed`). One of the first steps when diagnosing "something broke" — faster than reading the whole journalctl.',
        parameters: {
          type: 'object',
          properties: { ...CONTROLLER_TARGET_PROPS },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'systemd_unit',
        description: 'Manage a systemd unit and inspect it. The `status` action (default) returns a structured object {active, sub, load, unitFileState, exitCode, mainPid, since, statusTail} — enough for most diagnostic questions. `cat` (the unit with all drop-ins) and `list-deps` are also read-only. State-changing actions — `start`/`stop`/`restart`/`reload`/`enable`/`disable`/`mask`/`unmask`: HITL — before the call, explain to the user what you are doing and wait for confirmation. The unit name may have the suffix or not (`wb-mqtt-serial` ≡ `wb-mqtt-serial.service`).',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            unit: { type: 'string', description: 'Unit name (wb-mqtt-serial.service, fstrim.timer, mosquitto). The .service suffix may be omitted.' },
            action: {
              type: 'string',
              enum: ['status', 'start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask', 'cat', 'list-deps'],
              description: 'Action. Default status.',
            },
          },
          required: ['unit'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'network_status',
        description: 'Network summary of the controller in a single call: interfaces (ip -j addr) with IPv4 addresses and state, default route (ip -j route), active NetworkManager connections (nmcli connection show / device) and optionally a ping to a target host. A typical first call for diagnosing "no internet"/"not visible over VPN"/"uplink dropped".',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            pingTarget: { type: 'string', description: 'If set — `ping -c1 -W2 <target>` (e.g. 8.8.8.8). Otherwise the ping is skipped.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cloud_status',
        description: 'State of the Wiren Board Cloud agent in a single call: whether the wb-cloud-agent service is active, presence of the device certificate, list of linked providers, retained MQTT controls (status / activation_link / cloud_base_url) for each provider. A single call shows whether the controller is linked to the cloud and in what status.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write content to a file on the controller (via SFTP). HITL: before the call, show the user the diff or the content and wait for confirmation.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            path: { type: 'string', description: 'Absolute path to the file.' },
            content: { type: 'string', description: 'Full content of the file.' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the internet via Brave Search. Returns the top 10 results: {title, url, snippet}. Max 3 calls per model response (the counter resets on every new user message). Prefer a direct web_fetch to wiki.wirenboard.com. Use web_search only when you do not know the URL. If there are no results — do NOT retry, use web_fetch.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query in Russian or English.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Download the content of a web page by URL. Use it when you are unsure about conventions/API/syntax and want to check against Wiren Board documentation (github.com/wirenboard/*), READMEs of third-party libraries, specific template files, etc. Returns text/plain (HTML is converted to readable text; markdown/json/code — as is). Limit 20 000 characters.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full URL (http/https).' },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mqtt_rpc',
        description: 'Call an MQTT RPC on the controller. ALWAYS pass the `params` parameter explicitly — even if the RPC accepts {} — otherwise the call will be malformed. Examples: mqtt_rpc(sn, "wb-mqtt-serial", "device", "LoadConfig", params={port, slave_id, ...}); mqtt_rpc(sn, "wb-mqtt-serial", "config", "Load", params={}); mqtt_rpc(sn, "wbrules", "Editor", "Save", params={path: "name.js", content: "..."}) — for Editor.Save both fields path (with the .js extension) and content are REQUIRED; mqtt_rpc(sn, "wbrules", "Editor", "List", params={}); mqtt_rpc(sn, "wbrules", "Editor", "Load", params={path: "name.js"}).',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            driver: { type: 'string', description: 'RPC driver name: wb-mqtt-serial, confed, db_logger, wb-device-manager, wbrules.' },
            service: { type: 'string', description: 'Service name (device, config, Editor, history, etc.)' },
            method: { type: 'string', description: 'Method name (LoadConfig, Load, Save, Start, etc.)' },
            params: { type: 'object', description: 'Call parameters. For empty parameters — {}.' },
            timeoutSec: { type: 'integer', minimum: 1, maximum: 30, description: 'Response wait timeout (default 5s).' },
          },
          required: ['driver', 'service', 'method', 'params'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mqtt_list_topics',
        description: 'List MQTT topics on the controller. By default — all of them, can be narrowed by a prefix (e.g. "/devices/wb-gpio/#"). Supports pagination: limit (default 200) and offset. If has_more=true — request the next page with next_offset.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            prefix: { type: 'string', description: 'MQTT filter, default "#".' },
            timeoutSec: { type: 'integer', minimum: 1, maximum: 10 },
            limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Max topics per page (default 200).' },
            offset: { type: 'integer', minimum: 0, description: 'Skip N topics (for pagination, default 0).' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ssh_exec_async',
        description: 'Run a shell command on the controller in the background as a transient systemd unit. Returns {jobId, startedAt} instantly and does not hold the SSH connection. The command survives a connection drop and keeps running under systemd. Use it for operations longer than a couple of minutes: apt update/upgrade, wb-release -t testing, FIT update, a full tar backup, long bus scans. HITL same as ssh_exec: dangerous commands — user confirmation first. After starting, check progress via job_status/job_tail; do not spam polling — once every 10-30 sec is enough.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            command: { type: 'string' },
            label: { type: 'string', description: 'Short human-readable label.' },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'job_status',
        description: 'State of a background job from ssh_exec_async: running / exited (+ exitCode), how long it has been running, how many lines in the log, the command, the label.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            jobId: { type: 'string', description: '8-character hex id from ssh_exec_async.' },
          },
          required: ['jobId'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'job_tail',
        description: 'Last lines of a background job log (stdout+stderr merged). Incremental: the response nextFromLine tells which line to request from next.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            jobId: { type: 'string' },
            fromLine: { type: 'integer', minimum: 1, description: 'Which line to read from (1-based). Default 1.' },
            maxLines: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum number of lines to return. Default 100.' },
          },
          required: ['jobId'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'job_cancel',
        description: 'Abort a background job: SIGTERM → SIGKILL. HITL: confirm with the user before aborting.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            jobId: { type: 'string' },
          },
          required: ['jobId'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'job_list',
        description: 'All background jobs on the controller started via ssh_exec_async: running and recently exited (TTL 24h).',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'serial_debug_collect',
        description: 'Collects a wb-mqtt-serial debug log with raw packets over the specified time. Call it right away when diagnosing serial errors.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            durationSec: { type: 'integer', minimum: 10, maximum: 300, description: 'How many seconds to collect debug data. Default 30.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wb_bus_scan',
        description: 'Fast Modbus bus scan — finds Wiren Board and Onokom devices. If port is not specified — it automatically discovers all RS-485 ports. A fast scan takes about 40 seconds.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            port: { type: 'string', description: 'Port path, e.g. "/dev/ttyRS485-1".' },
            baud_rate: { type: 'integer', description: 'Baud rate, by default tries 115200 and 9600.' },
            data_bits: { type: 'integer', description: 'Data bits, default 8.' },
            parity: { type: 'string', description: '"N", "E" or "O". Default "N".' },
            stop_bits: { type: 'integer', description: '1 or 2. Default 2.' },
            scan_type: { type: 'string', enum: ['extended', 'standard'], description: '"extended" — Fast Modbus (default). "standard" — regular Modbus.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wb_add_devices',
        description: 'Adds devices found by the scanner (wb_bus_scan) to the wb-mqtt-serial configuration. Call it AFTER wb_bus_scan. Requires confirmation (HITL).',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'modbus_templates_list',
        description: 'List of available wb-mqtt-serial Modbus templates via RPC `wb-mqtt-serial/config/Load.types`. Without `filter` — a summary by groups {group: {count, deprecated}}, so as not to overflow the context (a typical firmware has 250+ templates). With `filter` (substring, case-insensitive over type/mqtt-id/name) — a flat list of matches.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            filter: { type: 'string', description: 'Substring for filtering (e.g. "wb-mr6c", "dimmer", "MAI"). Case-insensitive.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'modbus_device_info',
        description: 'Firmware parameters of a specific Modbus device: fw version, model string, current values of all parameters (debounce, modes, mappings, etc.). RPC `wb-mqtt-serial/device/LoadConfig`. This is NOT a list of channels — for channels and the template use `modbus_template`. Two modes: (1) by `device_id` (the MQTT name, e.g. "wb-mr6c_138") — the simplest; (2) by explicit `path` + `slave_id` (optionally with device_type/baud_rate/parity/data_bits/stop_bits) — for devices not in the config.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            device_id: { type: 'string', description: 'Device name in MQTT (wb-mr6c_138). Alternative to path+slave_id.' },
            path: { type: 'string', description: 'Port (/dev/ttyRS485-1) — if without device_id.' },
            slave_id: { type: 'number', description: 'Modbus slave-id — if without device_id.' },
            device_type: { type: 'string', description: 'Optional: device type from templates (for devices not in the config).' },
            baud_rate: { type: 'number' },
            parity: { type: 'string' },
            data_bits: { type: 'number' },
            stop_bits: { type: 'number' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'modbus_probe',
        description: 'A quick ping of a single Modbus device by slave_id on the specified port. Does not touch the wb-mqtt-serial config — a targeted "does it respond at all?" check. RPC `wb-mqtt-serial/device/Probe`. Useful when `wb_bus_scan` missed a device (a known case with WB-MAP6S — the scanner does not see all of them, Probe does).',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            path: { type: 'string', description: 'Port (/dev/ttyRS485-1).' },
            slave_id: { type: 'number', description: 'Modbus slave-id.' },
            baud_rate: { type: 'number', description: 'Baud, default 9600.' },
            parity: { type: 'string', description: 'Parity, default "N".' },
            data_bits: { type: 'number', description: 'Data bits, default 8.' },
            stop_bits: { type: 'number', description: 'Stop bits, default 2.' },
          },
          required: ['path', 'slave_id'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'modbus_ports',
        description: 'Parameters of all configured wb-mqtt-serial RS-485 ports: path, baud_rate, parity, stop_bits, data_bits, timeouts, enabled flag. RPC `wb-mqtt-serial/ports/Load`. Returns only ACTIVE ports from the config (not every physically existing `/dev/ttyRS485-*`).',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'modbus_template',
        description: 'Content of a single Modbus template: channels, parameters, groups. Resolves `device_type` (e.g. "WB-MR6C") to `mqtt-id` via RPC config/Load.types and reads `/usr/share/wb-mqtt-serial/templates/config-<mqtt-id>.json`. Views: `summary` (default — a compact list of channels with reg_type/address/format/type/units), `full` (the whole template), `channels-only` (channels only), `meta-only` (without channels and parameters — headers only). Optionally filters channels (`enabledOnly`, `channelFilter`).',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            device_type: { type: 'string', description: 'Device type as in Load.types[].types[].type (e.g. "WB-MR6C"). Alternative — mqtt_id.' },
            mqtt_id: { type: 'string', description: 'Template mqtt-id (e.g. "wb-mr6c"). If set — resolution is skipped, the config-<mqtt_id>.json file is read directly.' },
            view: { type: 'string', enum: ['summary', 'full', 'channels-only', 'meta-only'], description: 'View. Default summary.' },
            enabledOnly: { type: 'boolean', description: 'Only enabled channels (default false).' },
            channelFilter: { type: 'string', description: 'Substring in the channel name (case-insensitive).' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_history',
        description: 'Get the history of MQTT channel values from wb-mqtt-db. Returns an array of points {v, t}, statistics (min/max/avg), units and precision. Use period instead of from/to.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            channels: {
              type: 'array',
              description: 'Channels to query. Each element is a pair [device_id, control_name].',
              items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
              minItems: 1,
            },
            period: { type: 'string', description: 'Period: number + unit (m/h/d/w/y). Examples: "2h", "30m", "3d".' },
            from: { type: 'number', description: 'Range start (unix timestamp, seconds).' },
            to: { type: 'number', description: 'Range end (unix timestamp, seconds).' },
          },
          required: ['channels'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_history_chart',
        description:
          'Build a chart of MQTT channel history and save it as an attachment (SVG). ' +
          'Uses wb-mqtt-db via RPC db_logger/history/get_values, renders via vega-lite. ' +
          'By default builds a line chart (chart_type=line). Change chart_type when the user asks for a specific kind: ' +
          '"histogram" -> histogram (value distribution), "eye/heat map/density" -> heatmap, ' +
          '"boxes/spread by day" -> boxplot, "bars/events" -> bar, "area/fill" -> area, "points/outliers" -> point. ' +
          'Supports several series on one chart, twin Y-axis for different units.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            channels: {
              type: 'array',
              description: 'Channels for the chart. Each element is a pair [device_id, control_name].',
              items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
              minItems: 1,
            },
            period: { type: 'string', description: 'Period: number + unit (m/h/d/w/y). Examples: "2h", "30m", "3d", "1y".' },
            from: { type: 'number', description: 'Range start (unix timestamp, seconds). Use only if period does not fit.' },
            to: { type: 'number', description: 'Range end (unix timestamp, seconds). Default — now.' },
            title: { type: 'string', description: 'Chart title (e.g. "CPU Temperature over a day").' },
            ylabel: { type: 'string', description: 'Y-axis label (usually the unit of measurement, e.g. "°C").' },
            chart_type: {
              type: 'string',
              enum: ['line', 'bar', 'area', 'point', 'histogram', 'heatmap', 'boxplot'],
              description:
                'Chart type. line — a regular time series (default). bar — bars (for discrete events). area — fill under the line. ' +
                'point — scatter (outliers). histogram — value distribution (by bins). ' +
                'heatmap — density over time (draws an "eye" view — shows the typical level and outliers). ' +
                'boxplot — box-and-whisker by periods (hour/day).',
            },
          },
          required: ['channels'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_history_table',
        description: 'Export the history of MQTT channels to CSV. Returns CSV as a string. Use it when the user wants to "save", "export", "dump to Excel".',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            channels: {
              type: 'array',
              description: 'Channels for the table. Each element is a pair [device_id, control_name].',
              items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
              minItems: 1,
            },
            period: { type: 'string', description: 'Period: number + unit (m/h/d/w/y).' },
            from: { type: 'number', description: 'Range start (unix timestamp).' },
            to: { type: 'number', description: 'Range end (unix timestamp).' },
            limit: { type: 'number', description: 'Maximum points per channel. Default 10000.' },
            min_interval: { type: 'number', description: 'Minimum interval between points in seconds. 0 — all points.' },
          },
          required: ['channels'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_hardware_config',
        description: 'Load the configuration of the controller hardware expansion modules (/etc/wb-hardware.conf) via confed RPC.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'save_hardware_config',
        description: 'Install a module into a controller slot and save the configuration (/etc/wb-hardware.conf).',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            slot_id: { type: 'string', description: 'Slot identifier from get_hardware_config (e.g. "mod1", "extio3").' },
            module: { type: 'string', description: 'Module identifier. An empty string removes the module from the slot.' },
            options: { type: 'object', description: 'Module settings (optional).' },
          },
          required: ['slot_id', 'module'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'audit_controller',
        description: 'Collect the current state of the controller: list of manually installed packages, enabled services, custom unit files, cron, files in /opt and /usr/local, modified system configs.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'save_state_for_diff',
        description: 'Save a JSON snapshot of the current controller state into /mnt/data/ai/wb-ai-helper/snapshots/. Used together with diff_snapshot.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'diff_snapshot',
        description: 'Compare the current controller state with the snapshot from save_state_for_diff and return what was added/removed.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            beforePath: { type: 'string', description: 'Absolute path to the JSON snapshot on the controller.' },
          },
          required: ['beforePath'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the controller (up to 64KB). Handy for configs in /etc/wb-* or /mnt/data.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            path: { type: 'string', description: 'Absolute path to the file.' },
            maxBytes: { type: 'number', description: 'default 64000' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fetch_from_controller',
        description: 'Download a file from the controller (via SFTP) and put it into the attachments of the current chat session. The user will see it in the UI as a chip with a download button. Use it to deliver a ready backup, a config archive, a log — anything the user wants to get. Limit 20MB; for large files first compress (tar czf) or split. The file name is taken from the path by default; override it with the name parameter if needed.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            path: { type: 'string', description: 'Absolute path to the file on the controller.' },
            name: { type: 'string', description: 'File name to save as (optional, default is the basename of the path).' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'upload_to_controller',
        description: 'Write a session attachment (a file the user uploaded to the chat) to the controller at an arbitrary path via SFTP. HITL: before the call, show the user which file -> which path it goes to, wait for confirmation. Do not overwrite critical system paths — avoid /etc/shadow, /etc/passwd, /etc/systemd/system/*.service without an explicit request.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            fileId: { type: 'string', description: 'Attachment ID from list_attachments.' },
            path: { type: 'string', description: 'Absolute path on the controller to save the file to.' },
          },
          required: ['fileId', 'path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_attachments',
        description: 'List of files attached by the user to the current chat session. The current list is also shown in the system message before each turn — usually no need to call it separately; call it if you need to double-check ids/sizes during the dialogue.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_rules',
        description: 'List of all wb-rules scripts with their enabled/disabled state and associated rules. A wrapper over wbrules/Editor/List — no need to know the RPC syntax.',
        parameters: { type: 'object', properties: { ...CONTROLLER_TARGET_PROPS }, required: [], additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'load_rule',
        description: 'Read the content of a wb-rules rule file. The name is without path and without extension (e.g. "wb-la-temp-relay"); .js is added automatically.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            name: { type: 'string', description: 'Rule file name without extension (e.g. "wb-la-temp-relay").' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'save_rule',
        description: 'Create or update a wb-rules rule file. The name is without path and without extension. The RPC validates the JS and reloads the engine atomically. Use it instead of a manual mqtt_rpc("wbrules","Editor","Save").',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            name: { type: 'string', description: 'File name without extension (e.g. "my-rule").' },
            content: { type: 'string', description: 'Full JS code of the file. ES5 (no let/const/arrow).' },
          },
          required: ['name', 'content'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_rule',
        description: 'Delete a wb-rules rule file. First tries wbrules/Editor/Remove; if the daemon replies "File not found" (cache desync) — does rm + reload-or-restart wb-rules over SSH. Requires explicit user confirmation.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            name: { type: 'string', description: 'File name without extension.' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'disable_rule',
        description: 'Disable a wb-rules rule via RPC `wbrules/Editor/ChangeState` (under the hood — renaming `<name>.js` -> `<name>.js.disabled`). Unlike `delete_rule` it is reversible: to enable it back, remove the `.disabled` suffix (via write_file/ssh_exec) and call reload. On stable firmware the reverse `enabled:true` via the same RPC returns `result:false` — this is a limitation of the wb-rules engine, not of our wrapper. A less aggressive path than delete: suitable for temporarily turning off a rule for debugging. HITL: check with the user whether it really should be turned off.',
        parameters: {
          type: 'object',
          properties: {
            ...CONTROLLER_TARGET_PROPS,
            name: { type: 'string', description: 'Rule file name without extension.' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_attachment',
        description: 'Read the content of a file attached to the session (up to ~200KB). fileId — from list_attachments or the system message about files. encoding="utf8" for text (configs, logs, json); "base64" for binary (archives, images — if you need to pass them along).',
        parameters: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'Attachment ID from list_attachments.' },
            encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Encoding: utf8 (default) or base64.' },
          },
          required: ['fileId'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_archive_contents',
        description: 'Show a listing of files inside an archive attached to the chat. zip, tar, tar.gz/tgz are supported (the format is detected automatically by magic-bytes). Returns an array of entries {path, size, isDir}. Use it to understand what is inside before extracting.',
        parameters: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'Archive ID from list_attachments.' },
          },
          required: ['fileId'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_from_archive',
        description: 'Read a single file from an archive (zip / tar / tar.gz / tgz) by path. encoding="utf8" for text, "base64" for binary. Limit ~200KB per file — for larger ones use extract_archive.',
        parameters: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'Archive ID.' },
            path: { type: 'string', description: 'File path inside the archive (as from list_archive_contents).' },
            encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Encoding: utf8 (default) or base64.' },
          },
          required: ['fileId', 'path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'extract_archive',
        description: 'Extract files from an archive (zip / tar / tar.gz / tgz) into the chat attachments as separate files — each gets its own fileId, available for read_attachment / upload_to_controller. The paths parameter is an array of specific paths to extract; if not set or empty — the whole archive is extracted. Returns an array {path, fileId, name, size, mime}.',
        parameters: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'Archive ID.' },
            paths: { type: 'array', items: { type: 'string' }, description: 'Optional: a subset of paths to extract. If not specified — everything is extracted.' },
          },
          required: ['fileId'],
          additionalProperties: false,
        },
      },
    },
  ]
}

type Ctx = {
  discovery: Discovery
  mqtt: MqttPool
  ssh: SshPool
  /** SNs selected in the current chat; if empty — array operations require an explicit sn. */
  contextSns: string[]
  db: DbHandle
  sessionId: string
  agentState: { checkpointSummary?: string }
  braveApiKey?: string
}

/** Unified record of a file in an archive: path, size, directory flag
 * and raw data (loaded on demand). */
export type ArchiveEntry = { path: string; size: number; isDir: boolean; data: () => Promise<Buffer> }

/** Opens an archive (zip / tar / tar.gz / tgz) and returns a list of entries.
 * Auto-detect by magic-bytes: ZIP — `PK\x03\x04`, gzip — `1f 8b`, otherwise we try
 * it as plain tar. */
export async function openArchive(buf: Buffer): Promise<ArchiveEntry[]> {
  // ZIP
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    const zip = await JSZip.loadAsync(buf)
    const out: ArchiveEntry[] = []
    for (const [path, file] of Object.entries(zip.files)) {
      const size = file.dir ? 0 : ((file as any)._data?.uncompressedSize ?? 0)
      out.push({
        path, size, isDir: file.dir,
        data: async () => Buffer.from(await file.async('uint8array')),
      })
    }
    return out
  }
  // gzip — decompress and process as tar
  let tarBuf = buf
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    tarBuf = gunzipSync(buf)
  }
  // tar
  return await new Promise<ArchiveEntry[]>((resolve, reject) => {
    const out: ArchiveEntry[] = []
    const ext = tarExtract()
    ext.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = []
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => {
        const body = Buffer.concat(chunks)
        out.push({
          path: header.name,
          size: header.size ?? body.length,
          isDir: header.type === 'directory',
          data: async () => body,
        })
        next()
      })
      stream.on('error', reject)
      stream.resume()
    })
    ext.on('finish', () => resolve(out))
    ext.on('error', reject)
    Readable.from(tarBuf).pipe(ext)
  })
}

export async function dispatch(name: string, argsJson: string, ctx: Ctx): Promise<string> {
  const args = parseArgs(argsJson)
  switch (name) {
    case 'list_controllers': {
      // If the cache is empty (e.g. fresh start, periodic scan still in flight),
      // kick off a refresh so the model never has to ask the user "rescan again".
      let list = ctx.discovery.list()
      if (!list.length) {
        await ctx.discovery.refresh().catch(() => {})
        list = ctx.discovery.list()
      }
      return JSON.stringify(list.map(toPublic), null, 2)
    }

    case 'probe_controller': {
      const c = resolve1(args, ctx)
      const r = await probe(c)
      c.reachable = r.reachable
      if (r.fw) c.fw = r.fw
      if (r.hostname) c.hostname = r.hostname
      return JSON.stringify(r, null, 2)
    }

    case 'list_devices': {
      const targets = resolveTargets(args, ctx)
      const out: Record<string, unknown> = {}
      await Promise.all(
        targets.map(async (c) => {
          try {
            out[c.sn] = await ctx.mqtt.listDevices(c)
          } catch (e: any) {
            out[c.sn] = { error: e?.message ?? String(e) }
          }
        }),
      )
      return JSON.stringify(out, null, 2)
    }

    case 'list_controls': {
      const c = resolve1(args, ctx)
      const device = String(args['device'] ?? '')
      const controls = await ctx.mqtt.listControls(c, device)
      return JSON.stringify(controls, null, 2)
    }

    case 'mqtt_inventory': {
      const c = resolve1(args, ctx)
      const filter = typeof args['device'] === 'string' ? (args['device'] as string) : undefined
      const timeoutSec = typeof args['timeout'] === 'number' ? Math.max(1, Math.min(15, args['timeout'] as number)) : 3
      const includeEmpty = args['includeEmpty'] === true
      const includeMeta = args['includeMeta'] === true
      const topics = await ctx.mqtt.listTopics(c, '/devices/#', timeoutSec * 1000)
      const inv = buildInventory(topics.entries(), { filter, includeEmpty, includeMeta })
      return JSON.stringify(inv, null, 2)
    }

    case 'mqtt_read': {
      const c = resolve1(args, ctx)
      const topic = String(args['topic'] ?? '')
      const value = await ctx.mqtt.readTopic(c, topic)
      return JSON.stringify({ topic, value }, null, 2)
    }

    case 'mqtt_write': {
      const targets = resolveTargets(args, ctx)
      const topic = String(args['topic'] ?? '')
      const payload = String(args['payload'] ?? '')
      const rawQos = args['qos']
      const qos: 0 | 1 | 2 | undefined =
        rawQos === 0 || rawQos === 1 || rawQos === 2 ? (rawQos as 0 | 1 | 2) : undefined
      const retain = typeof args['retain'] === 'boolean' ? (args['retain'] as boolean) : undefined
      const out: Record<string, string> = {}
      await Promise.all(
        targets.map(async (c) => {
          try {
            await ctx.mqtt.writeTopic(c, topic, payload, { qos, retain })
            out[c.sn] = 'ok'
          } catch (e: any) {
            out[c.sn] = `error: ${e?.message ?? String(e)}`
          }
        }),
      )
      return JSON.stringify(out, null, 2)
    }

    case 'ssh_exec': {
      const targets = resolveTargets(args, ctx)
      const command = String(args['command'] ?? '')
      const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : undefined
      if (!command) return JSON.stringify({ error: 'command required' })
      const blocked = isDestructiveCommand(command)
      if (blocked) return JSON.stringify({ error: blocked })
      if (isDockerComposeCommand(command)) {
        return JSON.stringify({ error: 'docker-compose is deprecated. Use "docker compose" (without the hyphen).' })
      }
      if (/\bapt(-get)?\s+(update|install|remove|purge|upgrade|dist-upgrade|full-upgrade)\b/.test(command) ||
          /\bwb-release\s+(-\w+\s+)*-t\b/.test(command) ||
          /\bdocker\s+(run|pull|build|compose)\b/.test(command)) {
        return JSON.stringify({ error: `Command "${command}" may take a long time. Use ssh_exec_async instead of ssh_exec.` })
      }
      const results: { sn: string; stdout: string; stderr: string; code: number | null; truncated: boolean; error?: string }[] = []
      await Promise.all(
        targets.map(async (c) => {
          try {
            const r = await ctx.ssh.exec(c, command, timeoutMs)
            results.push({ sn: c.sn, ...r })
          } catch (e: any) {
            results.push({ sn: c.sn, stdout: '', stderr: '', code: -1, truncated: false, error: e?.message ?? String(e) })
          }
        }),
      )
      // Hint when the model asks "are there updates" via `apt list
      // --upgradable` without a prior `apt-get update` — the list will be
      // stale. Load the controller-update skill — it covers this scenario.
      const isStaleAptCheck = /\bapt(?:-get)?\s+list\s+--upgradable\b/.test(command)
        || /\bapt-cache\s+(?:show|search|policy)\b/.test(command)
      const cleanedStderr = (s: string) =>
        // When called from a script, apt prints "WARNING: apt does not have
        // a stable CLI interface..." — known noise with no information useful
        // to the model, we filter it out so as not to clutter the context.
        s.replace(/^WARNING: apt does not have a stable CLI interface\..*$/gm, '').trim()
      if (results.length === 1) {
        const r = results[0]!
        if (r.error) return `[${r.sn}] error: ${r.error}`
        const parts: string[] = []
        if (r.stdout) parts.push(r.stdout)
        const stderr = cleanedStderr(r.stderr)
        if (stderr) parts.push(`[stderr]\n${stderr}`)
        if (r.truncated) parts.push('[output truncated]')
        parts.push(`[exit: ${r.code}]`)
        if (isStaleAptCheck && r.code === 0) {
          parts.push('[hint] The local apt cache may be stale. Before a final "updates available/not" answer, run `apt-get update -qq` via ssh_exec_async, then repeat this query. For detailed scenarios — load_skill("controller-update").')
        }
        return parts.join('\n')
      }
      // Multiple targets — group by SN
      return results.map((r) => {
        if (r.error) return `[${r.sn}]\nerror: ${r.error}`
        const parts: string[] = [`[${r.sn}]`]
        if (r.stdout) parts.push(r.stdout)
        const stderr = cleanedStderr(r.stderr)
        if (stderr) parts.push(`[stderr]\n${stderr}`)
        if (r.truncated) parts.push('[output truncated]')
        parts.push(`[exit: ${r.code}]`)
        if (isStaleAptCheck && r.code === 0) {
          parts.push('[hint] The local apt cache may be stale. Before a final answer, run `apt-get update -qq` via ssh_exec_async, then repeat this query.')
        }
        return parts.join('\n')
      }).join('\n---\n')
    }

    case 'ssh_read_file': {
      const c = resolve1(args, ctx)
      const filePath = String(args['path'] ?? '')
      const maxBytes = typeof args['maxBytes'] === 'number' ? args['maxBytes'] : undefined
      try {
        const r = await ctx.ssh.readFile(c, filePath, maxBytes)
        return JSON.stringify({ path: filePath, ...r }, null, 2)
      } catch (e: any) {
        return JSON.stringify({ error: e?.message ?? String(e) })
      }
    }

    case 'ssh_read_logs': {
      const c = resolve1(args, ctx)
      const unit = args['unit'] ? String(args['unit']) : undefined
      const lines = typeof args['lines'] === 'number' ? args['lines'] : undefined
      const priority = args['priority'] ? String(args['priority']) : undefined
      try {
        const text = await ctx.ssh.readLogs(c, unit, lines, priority)
        return text
      } catch (e: any) {
        return JSON.stringify({ error: e?.message ?? String(e) })
      }
    }
    case 'todo_write': {
      const raw = Array.isArray(args['todos']) ? args['todos'] : null
      if (!raw) return JSON.stringify({ error: 'todos required' })
      const allowed: TodoStatus[] = ['pending', 'in_progress', 'completed']
      const items: TodoItem[] = []
      for (const r of raw as Array<Record<string, unknown>>) {
        const content = typeof r?.['content'] === 'string' ? r['content'].trim() : ''
        const status = typeof r?.['status'] === 'string' ? r['status'] : ''
        if (!content) return JSON.stringify({ error: 'each item must have a non-empty content' })
        if (!allowed.includes(status as TodoStatus)) return JSON.stringify({ error: `status must be pending|in_progress|completed` })
        items.push({ content, status: status as TodoStatus })
      }
      const inProgress = items.filter((t) => t.status === 'in_progress').length
      if (inProgress > 1) return JSON.stringify({ error: `exactly one item may be in_progress, got ${inProgress}` })
      setTodos(ctx.sessionId, items)
      return JSON.stringify({ count: items.length, plan: formatTodos(items) })
    }

    case 'checkpoint': {
      const summary = String(args['summary'] ?? '').trim()
      if (!summary) return JSON.stringify({ error: 'summary required' })
      const currentTodos = getTodos(ctx.sessionId)
      const pending = currentTodos.filter((t) => t.status !== 'completed')
      const todosPart = pending.length ? `\nRemaining plan:\n${formatTodos(pending)}` : ''
      ctx.agentState.checkpointSummary = summary + todosPart
      // Auto-unload all loaded skills: if the model made a
      // checkpoint — the stage is finished, and the skills for the next phase
      // are most likely different. If they are still needed — the model will
      // reload them itself. Otherwise their content would keep being injected
      // into every turn and clutter the context.
      const loaded = getLoadedSkills(ctx.sessionId)
      const unloadedNames: string[] = []
      for (const s of loaded) {
        if (unloadSkillFromSession(ctx.sessionId, s.name)) unloadedNames.push(s.name)
      }
      const unloadedPart = unloadedNames.length
        ? ` Auto-unloaded skills: ${unloadedNames.join(', ')} — if they are needed for the next phase, reload them via load_skill.`
        : ''
      return JSON.stringify({ ok: true, message: `Checkpoint accepted. The context will be compacted after this turn.${unloadedPart}` })
    }

    case 'load_skill': {
      const name = String(args['name'] ?? '').trim()
      if (!SKILL_NAME_RE.test(name)) return JSON.stringify({ error: 'name must be kebab-case' })
      const skill = getSkill(ctx.db, name)
      if (!skill) return JSON.stringify({ error: `skill "${name}" not found` })
      trackLoadedSkill(ctx.sessionId, skill.name, skill.content)
      return JSON.stringify({ name: skill.name, content: skill.content })
    }

    case 'unload_skill': {
      const name = String(args['name'] ?? '').trim()
      if (!SKILL_NAME_RE.test(name)) return JSON.stringify({ error: 'name must be kebab-case' })
      const removed = unloadSkillFromSession(ctx.sessionId, name)
      if (!removed) return JSON.stringify({ error: `skill "${name}" was not loaded` })
      return JSON.stringify({ ok: true, message: `Skill "${name}" unloaded.` })
    }

    case 'create_skill': {
      const name = String(args['name'] ?? '').trim()
      const content = String(args['content'] ?? '').trim()
      if (!SKILL_NAME_RE.test(name)) return JSON.stringify({ error: 'name must be kebab-case (a-z, 0-9, "-"), 1-63 characters' })
      if (content.length < 100) return JSON.stringify({ error: 'content is too short (100+ characters)' })
      let description: string
      try {
        description = extractDescription(content, name)
      } catch (e: any) {
        return JSON.stringify({ error: e?.message ?? String(e) })
      }
      const r = upsertUserSkill(ctx.db, { name, description, content })
      if (!r.ok) return JSON.stringify({ error: r.error })
      return JSON.stringify({ name, description, status: 'saved' })
    }

    case 'delete_skill': {
      const name = String(args['name'] ?? '').trim()
      if (!SKILL_NAME_RE.test(name)) return JSON.stringify({ error: 'name must be kebab-case' })
      const r = deleteUserSkill(ctx.db, name)
      if (!r.ok) return JSON.stringify({ error: r.error })
      return JSON.stringify({ name, status: 'deleted' })
    }

    case 'get_controller': {
      const c = resolve1(args, ctx)
      return JSON.stringify(await ctx.ssh.getInfo(c), null, 2)
    }

    case 'get_metrics': {
      const c = resolve1(args, ctx)
      return JSON.stringify(await ctx.ssh.getMetrics(c), null, 2)
    }

    case 'failed_units': {
      const c = resolve1(args, ctx)
      const r = await ctx.ssh.exec(c, 'systemctl --failed --no-pager', 10000)
      return JSON.stringify({ output: r.stdout.trim() }, null, 2)
    }

    case 'systemd_unit': {
      const c = resolve1(args, ctx)
      const unit = String(args['unit'] ?? '')
      const action = (args['action'] ?? 'status') as string
      // Whitelist allowed unit-name characters before passing to systemctl.
      // Covers normal services (wb-mqtt-serial.service), templated units
      // (getty@tty1.service), timers, slices and paths.
      if (!/^[A-Za-z0-9@._:\-]+$/.test(unit)) {
        return JSON.stringify({ error: `Invalid unit name "${unit}". Allowed: A-Za-z0-9, @, ., _, :, -.` }, null, 2)
      }
      if (action === 'status') {
        const sh = `systemctl is-active '${unit}' 2>/dev/null || true; echo ===WB-SD===; systemctl show '${unit}' -p ActiveState,LoadState,SubState,UnitFileState,Result,ExecMainStatus,ExecMainExitTimestamp,ExecMainPID,ActiveEnterTimestamp --no-pager 2>/dev/null || true; echo ===WB-SD===; systemctl status '${unit}' --no-pager -n 5 2>&1 || true`
        const r = await ctx.ssh.exec(c, sh, 10000)
        const parts = r.stdout.split('===WB-SD===')
        const active = (parts[0] ?? '').trim()
        const props: Record<string, string> = {}
        for (const line of (parts[1] ?? '').split('\n')) {
          const eq = line.indexOf('=')
          if (eq > 0) props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
        }
        const tail = (parts[2] ?? '').trim()
        return JSON.stringify({
          unit,
          active,
          loadState: props['LoadState'],
          subState: props['SubState'],
          unitFileState: props['UnitFileState'],
          result: props['Result'],
          exitCode: props['ExecMainStatus'] ? Number(props['ExecMainStatus']) : undefined,
          mainPid: props['ExecMainPID'] && props['ExecMainPID'] !== '0' ? Number(props['ExecMainPID']) : undefined,
          activeSince: props['ActiveEnterTimestamp'],
          exitedAt: props['ExecMainExitTimestamp'],
          statusTail: tail,
        }, null, 2)
      }
      if (action === 'cat') {
        const r = await ctx.ssh.exec(c, `systemctl cat '${unit}' 2>&1`, 10000)
        return JSON.stringify({ unit, content: r.stdout, ok: r.code === 0 }, null, 2)
      }
      if (action === 'list-deps') {
        const r = await ctx.ssh.exec(c, `systemctl list-dependencies '${unit}' --no-pager 2>&1`, 10000)
        return JSON.stringify({ unit, dependencies: r.stdout, ok: r.code === 0 }, null, 2)
      }
      // start/stop/restart/reload/enable/disable/mask/unmask
      const r = await ctx.ssh.exec(c, `systemctl ${action} '${unit}' 2>&1; echo ===CODE=$?`, 30000)
      const m = r.stdout.match(/===CODE=(\d+)/)
      const code = m ? Number(m[1]) : -1
      const output = m ? r.stdout.slice(0, r.stdout.lastIndexOf('===CODE=')).trim() : r.stdout
      return JSON.stringify({ unit, action, exitCode: code, ok: code === 0, output }, null, 2)
    }

    case 'network_status': {
      const c = resolve1(args, ctx)
      // Whitelist hostname/IP characters before concatenating into the shell.
      // A safeguard on top of shellQuote: even if someone mistakenly passes
      // `; rm -rf ...` into pingTarget, the regex strips everything extra. We
      // allow a dot, colon (IPv6), hyphen, underscore (DNS) and letters/digits.
      const rawTarget = typeof args['pingTarget'] === 'string' ? (args['pingTarget'] as string) : ''
      const safeTarget = rawTarget.replace(/[^A-Za-z0-9.:_-]/g, '')
      const sh = [
        'echo ===IP===',
        'ip -j -4 addr show 2>/dev/null',
        'echo ===ROUTE===',
        'ip -j -4 route show default 2>/dev/null',
        'echo ===NM===',
        "nmcli -t -f NAME,UUID,TYPE,DEVICE,STATE connection show 2>/dev/null",
        'echo ===NM_DEV===',
        "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device 2>/dev/null",
        ...(safeTarget ? ['echo ===PING===', `ping -c1 -W2 '${safeTarget}' 2>&1 | tail -2`] : []),
      ].join('; ')
      const r = await ctx.ssh.exec(c, sh, 15000)
      let interfacesRaw: unknown[] = []
      try { interfacesRaw = JSON.parse(readMarkedSection(r.stdout, 'IP') || '[]') } catch {}
      let routesRaw: unknown[] = []
      try { routesRaw = JSON.parse(readMarkedSection(r.stdout, 'ROUTE') || '[]') } catch {}
      const out: Record<string, unknown> = {
        interfaces: interfacesRaw.map(normalizeInterface),
        defaultRoute: pickDefaultRoute(routesRaw),
        nmConnections: parseNmcliColons(readMarkedSection(r.stdout, 'NM'), ['name', 'uuid', 'type', 'device', 'state'] as const),
        nmDevices: parseNmcliColons(readMarkedSection(r.stdout, 'NM_DEV'), ['device', 'type', 'state', 'connection'] as const),
      }
      if (safeTarget) {
        const ping = readMarkedSection(r.stdout, 'PING')
        const lossPct = parsePingLossPct(ping)
        out['ping'] = { target: safeTarget, raw: ping, lossPct, reachable: lossPct === 0 }
      }
      return JSON.stringify(out, null, 2)
    }

    case 'cloud_status': {
      const c = resolve1(args, ctx)
      const sh = [
        'echo ===SVC===',
        'systemctl is-active wb-cloud-agent 2>/dev/null || true',
        'echo ===CONF===',
        'cat /etc/wb-cloud-agent.conf 2>/dev/null || true',
        'echo ===CERT===',
        'ls -1 /var/lib/wb-cloud-agent/device_bundle.crt.pem 2>/dev/null && echo cert-present || echo cert-missing',
        'echo ===PROVIDERS===',
        'ls /var/lib/wb-cloud-agent/providers/ 2>/dev/null || true',
        'echo ===MQTT===',
        // `system__wb-cloud-agent__+` is an invalid wildcard for mosquitto (+ must
        // occupy a whole level). We take all /devices/+/controls/+ and filter
        // on the TS side — otherwise mosquitto_sub returns an error.
        "timeout 3 mosquitto_sub -F '%t\\t%p' -t '/devices/+/controls/+' 2>/dev/null | grep '^/devices/system__wb-cloud-agent__' || true",
      ].join('; ')
      const r = await ctx.ssh.exec(c, sh, 15000)
      let conf: Record<string, unknown> | null = null
      try { conf = JSON.parse(readMarkedSection(r.stdout, 'CONF') || 'null') } catch {}
      return JSON.stringify({
        serviceActive: readMarkedSection(r.stdout, 'SVC').trim() === 'active',
        certPresent: readMarkedSection(r.stdout, 'CERT').includes('cert-present'),
        providers: readMarkedSection(r.stdout, 'PROVIDERS').split('\n').filter(Boolean),
        conf,
        mqtt: parseCloudMqttControls(readMarkedSection(r.stdout, 'MQTT')),
      }, null, 2)
    }

    case 'write_file': {
      const c = resolve1(args, ctx)
      const path = String(args['path'] ?? '')
      const content = String(args['content'] ?? '')
      if (!path.startsWith('/')) return JSON.stringify({ error: 'path must be absolute' })
      await ctx.ssh.writeFile(c, path, content)
      return JSON.stringify({ path, bytesWritten: content.length, status: 'written' }, null, 2)
    }

    case 'web_search': {
      const query = String(args['query'] ?? '').trim()
      if (!query) return JSON.stringify({ error: 'query is required' })
      if (!ctx.braveApiKey) {
        return JSON.stringify({
          error:
            'web_search is unavailable: BRAVE_SEARCH_API_KEY is not set. ' +
            'Use web_fetch directly: web_fetch("https://wirenboard.com/wiki/Special:Search?search=...") to search the wiki.'
        })
      }
      const apiUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`
      console.log(`[web_search] query="${query}"`)
      try {
        const res = await fetch(apiUrl, {
          headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': ctx.braveApiKey
          },
          signal: AbortSignal.timeout(15000)
        })
        const data = await res.json() as {
          web?: { results: Array<{ title: string; url: string; description: string }> }
          error?: { code: string; detail: string }
        }
        if (data.error) {
          console.error(`[web_search] Brave API error: ${data.error.code} ${data.error.detail}`)
          return JSON.stringify({ error: `web_search error: ${data.error.detail}. Use web_fetch directly.` })
        }
        const results = (data.web?.results ?? []).map(r => ({
          title: r.title,
          url: r.url,
          snippet: r.description
        }))
        console.log(`[web_search] ${results.length} results`)
        if (results.length === 0) {
          return JSON.stringify({
            error:
              `The search "${query}" returned no results. ` +
              'Do NOT repeat the search with a different wording. ' +
              'Use web_fetch directly: web_fetch("https://wirenboard.com/wiki/Special:Search?search=...") or web_fetch("https://wirenboard.com/wiki/<Model>").'
          })
        }
        return JSON.stringify({ query, count: results.length, results }, null, 2)
      } catch (e) {
        console.error(`[web_search] error:`, e)
        return JSON.stringify({ error: `web_search could not connect: ${e instanceof Error ? e.message : String(e)}. Use web_fetch directly.` })
      }
    }

    case 'web_fetch': {
      const url = String(args['url'] ?? '')
      if (!/^https?:\/\//i.test(url)) return JSON.stringify({ error: 'url must start with http(s)://' })
      const res = await fetch(url, {
        headers: { 'User-Agent': 'wb-ai-helper/1.0' },
        signal: AbortSignal.timeout(15000)
      })
      const ct = res.headers.get('content-type') ?? ''
      const raw = await res.text()
      const text = ct.includes('text/html')
        ? raw
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n\s*\n+/g, '\n\n')
            .trim()
        : raw
      const WEB_FETCH_MAX = 20_000
      const truncated = text.length > WEB_FETCH_MAX
        ? text.slice(0, WEB_FETCH_MAX) +
          `\n…[truncated: showing ${WEB_FETCH_MAX} of ${text.length} characters]`
        : text
      return JSON.stringify({ url, status: res.status, contentType: ct, body: truncated }, null, 2)
    }

    case 'mqtt_rpc': {
      const c = resolve1(args, ctx)
      const driver = String(args['driver'] ?? '')
      const service = String(args['service'] ?? '')
      const method = String(args['method'] ?? '')
      const params = (args['params'] as Record<string, unknown>) ?? {}
      const timeoutSec = typeof args['timeoutSec'] === 'number' ? args['timeoutSec'] : 5
      if (!driver || !service || !method) return JSON.stringify({ error: 'driver, service, method are required' })
      const blocked = checkBlockedRpc(driver, service, method, params)
      if (blocked) return JSON.stringify({ error: blocked })
      const result = await ctx.ssh.mqttRpc(c, driver, service, method, params, timeoutSec)
      return JSON.stringify(result, null, 2)
    }

    case 'mqtt_list_topics': {
      const c = resolve1(args, ctx)
      const prefix = args['prefix'] ? String(args['prefix']) : '#'
      const timeoutSec = typeof args['timeoutSec'] === 'number' ? args['timeoutSec'] : 2
      const limit = typeof args['limit'] === 'number' ? Math.min(2000, Math.max(1, args['limit'])) : 200
      const offset = typeof args['offset'] === 'number' ? Math.max(0, args['offset']) : 0
      const list = await ctx.ssh.mqttListTopics(c, prefix, timeoutSec)
      const total = list.length
      const page = list.slice(offset, offset + limit)
      return JSON.stringify({
        total,
        offset,
        limit,
        has_more: offset + limit < total,
        next_offset: offset + limit < total ? offset + limit : null,
        count: page.length,
        topics: page,
      }, null, 2)
    }

    case 'ssh_exec_async': {
      const c = resolve1(args, ctx)
      let command = String(args['command'] ?? '')
      const label = typeof args['label'] === 'string' ? args['label'] : undefined
      if (!command.trim()) return JSON.stringify({ error: 'ssh_exec_async: empty command' })
      const blocked = isDestructiveCommand(command)
      if (blocked) return JSON.stringify({ error: blocked })
      if (isDockerComposeCommand(command)) {
        return JSON.stringify({ error: 'docker-compose is deprecated. Use "docker compose" (without the hyphen).' })
      }
      const running = getRunningJobForSn(c.sn)
      if (running) {
        return JSON.stringify({ error: `Controller ${c.sn} already has a background job running: "${running.label}" (jobId=${running.jobId}). Wait for it to finish or cancel it via job_cancel (with user confirmation — interrupting apt/wb-release can break the system).` })
      }
      // Auto-normalize apt: DEBIAN_FRONTEND=noninteractive + -y. Details
      // and rationale — in src/server/apt-defaults.ts.
      command = normalizeAptCommand(command)
      const r = await ctx.ssh.jobStart(c, command, label)
      console.log(`[ssh_exec_async] jobId=${r.jobId}, sn=${c.sn}, session=${ctx.sessionId}`)
      if (r.jobId) {
        trackJob(ctx.sessionId, r.jobId, c.sn, label ?? command.slice(0, 60))
      }
      return JSON.stringify(r, null, 2)
    }

    case 'job_status': {
      const c = resolve1(args, ctx)
      const jobId = String(args['jobId'] ?? '')
      const result = await ctx.ssh.jobStatus(c, jobId)
      const state = result['state'] as 'running' | 'exited' | 'unknown'
      if (state === 'exited' || state === 'running') updateJobState(jobId, state)
      return JSON.stringify(result, null, 2)
    }

    case 'job_tail': {
      const c = resolve1(args, ctx)
      const jobId = String(args['jobId'] ?? '')
      const fromLine = typeof args['fromLine'] === 'number' ? args['fromLine'] : 1
      const maxLines = typeof args['maxLines'] === 'number' ? args['maxLines'] : 500
      const tail = await ctx.ssh.jobTail(c, jobId, fromLine, maxLines)
      const raw = (tail['lines'] as string[]).join('\n')
      const truncatedLog = truncateLog(raw)
      return JSON.stringify({ ...tail, lines: truncatedLog.split('\n'), _truncated: raw.length !== truncatedLog.length }, null, 2)
    }

    case 'job_cancel': {
      const c = resolve1(args, ctx)
      const jobId = String(args['jobId'] ?? '')
      await ctx.ssh.jobCancel(c, jobId)
      return JSON.stringify({ cancelled: jobId }, null, 2)
    }

    case 'job_list': {
      const c = resolve1(args, ctx)
      return JSON.stringify(await ctx.ssh.jobList(c), null, 2)
    }

    case 'serial_debug_collect': {
      const c = resolve1(args, ctx)
      const duration = typeof args['durationSec'] === 'number' ? Math.min(300, Math.max(10, args['durationSec'])) : 30
      const logPath = '/mnt/data/ai/wb-ai-helper/diag/debug-serial.log'
      // Important properties of this script (each one was a real bug in the previous && chain):
      //   - JSON edit via python3, not `sed`: stays correct if the file already has
      //     "debug": true (e.g. previous run crashed before restore) and preserves layout.
      //   - `trap restore_off EXIT INT TERM`: even if journalctl/systemctl fails halfway,
      //     debug is forced back to false. Otherwise debug:true would survive forever
      //     and flood the disk on a busy bus.
      //   - $START_TS captured BEFORE sleep, used as `journalctl --since "$START_TS"`:
      //     the previous `--since '$((duration+5)) seconds ago'` evaluated retroactively
      //     after sleep, so the window slipped if the system was busy.
      //   - No `-n 500`: at debug:true the driver writes ~25 lines/sec, so a 60-sec capture
      //     produces ~1500 lines — `-n 500` silently truncated to the last 500.
      const script = [
        'CONF=/etc/wb-mqtt-serial.conf',
        `LOGFILE=${logPath}`,
        'mkdir -p /mnt/data/ai/wb-ai-helper/diag',
        'restore_off() { python3 -c "import json; c=json.load(open(\\"$CONF\\")); c[\\"debug\\"]=False; json.dump(c,open(\\"$CONF\\",\\"w\\"),indent=2)" 2>/dev/null || true; systemctl restart wb-mqtt-serial >/dev/null 2>&1 || true; echo "[serial_debug_collect] restored debug:false"; }',
        'trap restore_off EXIT INT TERM',
        `python3 -c "import json; c=json.load(open('$CONF')); c['debug']=True; json.dump(c,open('$CONF','w'),indent=2)"`,
        'systemctl restart wb-mqtt-serial',
        'sleep 1',
        'START_TS=$(date -u +%Y-%m-%dT%H:%M:%S)',
        `echo "[serial_debug_collect] collecting ${duration}s from $START_TS"`,
        `sleep ${duration}`,
        'journalctl -u wb-mqtt-serial --since "$START_TS" --no-pager > "$LOGFILE"',
        'echo "[serial_debug_collect] saved $(wc -l < "$LOGFILE") lines to $LOGFILE"',
      ].join('; ')
      const r = await ctx.ssh.jobStart(c, script, `debug serial ${duration}s`)
      if (r.jobId) {
        trackJob(ctx.sessionId, r.jobId, c.sn, `debug serial ${duration}s`)
      }
      return JSON.stringify({ ...r, logPath, durationSec: duration }, null, 2)
    }

    case 'wb_bus_scan': {
      const c = resolve1(args, ctx)
      const explicitPort = typeof args['port'] === 'string' ? args['port'] : null
      const scanType = args['scan_type'] === 'standard' ? 'standard' : 'extended'
      const dataBits = typeof args['data_bits'] === 'number' ? args['data_bits'] : 8
      const parity = String(args['parity'] ?? 'N')

      const hasBaud = typeof args['baud_rate'] === 'number'
      const configs = hasBaud
        ? [{ baud_rate: args['baud_rate'] as number, data_bits: dataBits, parity, stop_bits: typeof args['stop_bits'] === 'number' ? args['stop_bits'] : 2 }]
        : [
            { baud_rate: 115200, data_bits: 8, parity: 'N', stop_bits: 2 },
            { baud_rate: 9600, data_bits: 8, parity: 'N', stop_bits: 2 },
          ]

      const diagDir = '/mnt/data/ai/wb-ai-helper/diag'
      const resultPath = `${diagDir}/bus-scan-result.json`
      const donePath = `${diagDir}/bus-scan-done`

      // Discover ports if not specified
      let ports: string[]
      if (explicitPort) {
        ports = [explicitPort]
      } else {
        try {
          const r = await ctx.ssh.exec(c, 'ls /dev/ttyRS485-* 2>/dev/null', 5000)
          ports = r.stdout.trim().split('\n').filter(Boolean)
          if (ports.length === 0) ports = ['/dev/ttyRS485-1']
        } catch {
          ports = ['/dev/ttyRS485-1']
        }
        console.log(`[wb_bus_scan] Auto-discovered ports: ${ports.join(', ')}`)
      }

      // Helper: read /wb-device-manager/state retain topic
      const readState = async (): Promise<{ scanning: boolean; progress: number; devices: unknown[] } | null> => {
        const raw = await ctx.mqtt.readTopic(c, '/wb-device-manager/state')
        if (!raw) return null
        try { return JSON.parse(raw) } catch { return null }
      }

      // Create a single shell job for the entire scan
      const cmd = [
        `mkdir -p ${diagDir}`,
        `rm -f ${donePath}`,
        `echo "Scanning bus..."`,
        `for i in $(seq 1 180); do [ -f ${donePath} ] && break; sleep 2; done`,
        `[ -f ${resultPath} ] && cat ${resultPath}`,
        `rm -f ${donePath}`,
      ].join(' && ')

      const r = await ctx.ssh.jobStart(c, cmd, `bus scan`)
      const jobId = r.jobId
      if (jobId) {
        trackJob(ctx.sessionId, jobId, c.sn, `bus scan`)
      }

      // Scan a single port with all baud configs
      const scanPort = async (port: string, isFirst: boolean) => {
        for (let ci = 0; ci < configs.length; ci++) {
          const cfg = configs[ci]!
          const preserve = !(isFirst && ci === 0)
          const startParams = {
            scan_type: scanType,
            preserve_old_results: preserve,
            port: { path: port, ...cfg }
          }
          for (let attempt = 0; attempt < 6; attempt++) {
            try {
              await ctx.ssh.mqttRpc(c, 'wb-device-manager', 'bus-scan', 'Start', startParams, 10)
              console.log(`[wb_bus_scan] ${port} Started ${cfg.baud_rate} ${cfg.data_bits}${cfg.parity}${cfg.stop_bits} preserve=${preserve}`)
              break
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              if (msg.includes('already executing') && attempt < 5) {
                console.log(`[wb_bus_scan] ${port} Busy, retry in 10s (attempt ${attempt + 1})`)
                await new Promise(resolve => setTimeout(resolve, 10000))
              } else {
                console.error(`[wb_bus_scan] ${port} Start failed: ${msg}`)
                break
              }
            }
          }
          for (let pi = 0; pi < 60; pi++) {
            await new Promise(resolve => setTimeout(resolve, 3000))
            try {
              const state = await readState()
              console.log(`[wb_bus_scan] ${port} Progress: scanning=${state?.scanning} progress=${state?.progress}`)
              if (state && state.scanning === false) break
            } catch {
              break
            }
          }
        }
      }

      // Background: scan all ports sequentially, then write result and signal job
      void (async () => {
        try {
          for (let pi = 0; pi < ports.length; pi++) {
            await scanPort(ports[pi]!, pi === 0)
          }
          const state = await readState()
          const json = JSON.stringify(state, null, 2)
          await ctx.ssh.writeFile(c, resultPath, json)
          await ctx.ssh.exec(c, `touch ${donePath}`, 5000)
          console.log(`[wb_bus_scan] All done, ${state?.devices?.length ?? 0} device(s) on ports: ${ports.join(', ')}`)
        } catch (e) {
          console.error(`[wb_bus_scan] Error: ${e}`)
          try { await ctx.ssh.exec(c, `touch ${donePath}`, 5000) } catch {}
        }
      })()

      return JSON.stringify({ jobId, ports, configs, scanType, note: `Scanning ${ports.length} port(s) × ${configs.length} baud rate(s) will take about 40 seconds. Tell the user about this.` }, null, 2)
    }

    case 'wb_add_devices': {
      const c = resolve1(args, ctx)

      // 1. Read scan results from /wb-device-manager/state
      const stateRaw = await ctx.mqtt.readTopic(c, '/wb-device-manager/state')
      if (!stateRaw) return JSON.stringify({ error: 'No scan data. Run wb_bus_scan first.' })
      const state = JSON.parse(stateRaw) as {
        devices: Array<{
          title: string; sn: string; device_signature: string; fw_signature: string;
          port: { path: string }; cfg: { slave_id: number; baud_rate: number; parity: string; data_bits: number; stop_bits: number };
          fw: { version: string }; bootloader_mode: boolean; online: boolean
        }>
      }
      // Deduplicate by slave_id+port (state may contain duplicates from multiple scans)
      const seen = new Set<string>()
      const scannedDevices = (state.devices ?? [])
        .filter(d => !d.bootloader_mode && d.device_signature)
        .filter(d => {
          const key = `${d.port.path}:${d.cfg.slave_id}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      if (scannedDevices.length === 0) return JSON.stringify({ error: 'The scan found no devices. Run wb_bus_scan first.' })

      // 2. Load current config
      const cfgResult = await ctx.ssh.mqttRpc(c, 'wb-mqtt-serial', 'config', 'Load', {}, 10) as {
        config: { ports: Array<{ path: string; baud_rate: number; parity: string; data_bits: number; stop_bits: number; enabled?: boolean; devices: Array<{ device_type: string; slave_id: string | number; enabled?: boolean }> }> }
      }
      const config = (cfgResult as Record<string, unknown>)['config']
        ? (cfgResult as { config: typeof cfgResult.config }).config
        : cfgResult.config
      const ports = config.ports ?? []

      // 3. Build set of already configured slave_ids per port
      const configuredIds = new Map<string, Set<number>>()
      for (const p of ports) {
        const ids = new Set<number>()
        for (const d of p.devices ?? []) {
          ids.add(Number(d.slave_id))
        }
        configuredIds.set(p.path, ids)
      }

      // 4. Resolve device_type from templates via hw[].signature
      const templateMapRaw = await ctx.ssh.exec(
        c,
        `python3 -c "
import json,glob
m={}
for f in glob.glob('/usr/share/wb-mqtt-serial/templates/*.json'):
    try:
        d=json.load(open(f))
        dt=d.get('device_type','')
        dep='deprecated' in f
        for h in d.get('hw',[]):
            sig=h.get('signature','')
            fw=h.get('fw','')
            if sig:
                if sig not in m or (not dep and 'deprecated' in m[sig].get('file','')):
                    m[sig]={'device_type':dt,'fw':fw,'file':f.split('/')[-1],'deprecated':dep}
    except: pass
import json as j; print(j.dumps(m))
"`, 10000)
      const templateMap: Record<string, { device_type: string; fw: string; file: string }> = JSON.parse(templateMapRaw.stdout.trim())

      // 5. Process each scanned device
      const added: string[] = []
      const skipped: string[] = []
      const setupErrors: string[] = []

      for (const dev of scannedDevices) {
        const portPath = dev.port.path
        const port = ports.find(p => p.path === portPath)
        if (!port) {
          skipped.push(`${dev.title} slave=${dev.cfg.slave_id}: port ${portPath} not in config`)
          continue
        }

        // Check if already configured
        const ids = configuredIds.get(portPath) ?? new Set()
        if (ids.has(dev.cfg.slave_id)) {
          skipped.push(`${dev.title} slave=${dev.cfg.slave_id}: already in config`)
          continue
        }

        // Resolve device_type
        const tmpl = templateMap[dev.device_signature]
        if (!tmpl) {
          skipped.push(`${dev.title} slave=${dev.cfg.slave_id}: template for ${dev.device_signature} not found`)
          continue
        }

        // Resolve slave_id collision with other scanned devices being added
        let targetSlaveId = dev.cfg.slave_id
        if (ids.has(targetSlaveId)) {
          // Find next free id
          for (let candidate = 1; candidate <= 247; candidate++) {
            if (!ids.has(candidate)) { targetSlaveId = candidate; break }
          }
        }

        // Setup device: change baud/parity/stop_bits/slave_id to match port config
        const needsSetup =
          dev.cfg.baud_rate !== port.baud_rate ||
          dev.cfg.parity !== (port.parity ?? 'N') ||
          dev.cfg.stop_bits !== (port.stop_bits ?? 2) ||
          targetSlaveId !== dev.cfg.slave_id
        if (needsSetup) {
          const setupCfg: Record<string, unknown> = {}
          if (dev.cfg.baud_rate !== port.baud_rate) setupCfg['baud_rate'] = port.baud_rate
          if (dev.cfg.parity !== (port.parity ?? 'N')) setupCfg['parity'] = port.parity ?? 'N'
          if (dev.cfg.stop_bits !== (port.stop_bits ?? 2)) setupCfg['stop_bits'] = port.stop_bits ?? 2
          if (targetSlaveId !== dev.cfg.slave_id) setupCfg['slave_id'] = targetSlaveId
          try {
            await ctx.ssh.mqttRpc(c, 'wb-mqtt-serial', 'port', 'Setup', {
              path: portPath,
              items: [{
                slave_id: dev.cfg.slave_id,
                baud_rate: dev.cfg.baud_rate,
                parity: dev.cfg.parity,
                stop_bits: dev.cfg.stop_bits,
                cfg: setupCfg
              }]
            }, 15)
          } catch (e) {
            setupErrors.push(`${dev.title} slave=${dev.cfg.slave_id}: port/Setup failed: ${e instanceof Error ? e.message : String(e)}`)
            continue
          }
        }

        // Load device parameters from hardware via device/LoadConfig
        let deviceEntry: Record<string, unknown> = {
          device_type: tmpl.device_type,
          slave_id: String(targetSlaveId)
        }
        try {
          const lcResult = await ctx.ssh.mqttRpc(c, 'wb-mqtt-serial', 'device', 'LoadConfig', {
            path: portPath,
            slave_id: targetSlaveId,
            baud_rate: needsSetup ? port.baud_rate : dev.cfg.baud_rate,
            parity: needsSetup ? (port.parity ?? 'N') : dev.cfg.parity,
            data_bits: dev.cfg.data_bits,
            stop_bits: needsSetup ? (port.stop_bits ?? 2) : dev.cfg.stop_bits,
            device_type: tmpl.device_type
          }, 15) as { parameters?: Record<string, unknown> }
          const params = lcResult?.parameters ?? {}
          deviceEntry = { device_type: tmpl.device_type, slave_id: String(targetSlaveId), ...params }
          delete deviceEntry['baud_rate']
        } catch (e) {
          console.log(`[wb_add_devices] LoadConfig for ${dev.title} failed: ${e instanceof Error ? e.message : String(e)}, using minimal config`)
        }
        port.devices.push(deviceEntry as typeof port.devices[number])
        ids.add(targetSlaveId)
        added.push(`${dev.title} (${tmpl.device_type}) slave=${targetSlaveId} → ${portPath}`)
      }

      if (added.length === 0) {
        return JSON.stringify({ added: [], skipped, errors: setupErrors, message: 'Nothing to add — all devices are already in the config or were skipped.' }, null, 2)
      }

      // 6. Save config via confed/Editor/Save
      try {
        await ctx.ssh.mqttRpc(c, 'confed', 'Editor', 'Save', {
          path: '/etc/wb-mqtt-serial.conf',
          content: config
        }, 15)
      } catch (e) {
        return JSON.stringify({ error: `Error saving config: ${e instanceof Error ? e.message : String(e)}` })
      }

      return JSON.stringify({ added, skipped, errors: setupErrors, message: `Added ${added.length} device(s). wb-mqtt-serial restarted.` }, null, 2)
    }

    case 'modbus_device_info': {
      const c = resolve1(args, ctx)
      const params = buildLoadConfigParams({
        device_id: typeof args['device_id'] === 'string' ? (args['device_id'] as string) : undefined,
        path: typeof args['path'] === 'string' ? (args['path'] as string) : undefined,
        slave_id: typeof args['slave_id'] === 'number' ? (args['slave_id'] as number) : undefined,
        device_type: typeof args['device_type'] === 'string' ? (args['device_type'] as string) : undefined,
        baud_rate: typeof args['baud_rate'] === 'number' ? (args['baud_rate'] as number) : undefined,
        parity: typeof args['parity'] === 'string' ? (args['parity'] as string) : undefined,
        data_bits: typeof args['data_bits'] === 'number' ? (args['data_bits'] as number) : undefined,
        stop_bits: typeof args['stop_bits'] === 'number' ? (args['stop_bits'] as number) : undefined,
      })
      if (!params) {
        return JSON.stringify({ error: 'Need either device_id (the MQTT name, e.g. wb-mr6c_138), or explicit path + slave_id.' })
      }
      try {
        const r = await ctx.ssh.mqttRpc(c, 'wb-mqtt-serial', 'device', 'LoadConfig', params, 10)
        return JSON.stringify(r, null, 2)
      } catch (e: unknown) {
        return JSON.stringify({ error: enrichSerialRpcError(e, 'LoadConfig') })
      }
    }

    case 'modbus_probe': {
      const c = resolve1(args, ctx)
      const path = typeof args['path'] === 'string' ? (args['path'] as string) : ''
      const slave_id = typeof args['slave_id'] === 'number' ? (args['slave_id'] as number) : NaN
      if (!path || Number.isNaN(slave_id)) {
        return JSON.stringify({ error: 'path and slave_id are required.' })
      }
      const params: Record<string, unknown> = {
        path,
        slave_id,
        baud_rate: typeof args['baud_rate'] === 'number' ? args['baud_rate'] : 9600,
        parity: typeof args['parity'] === 'string' ? args['parity'] : 'N',
        data_bits: typeof args['data_bits'] === 'number' ? args['data_bits'] : 8,
        stop_bits: typeof args['stop_bits'] === 'number' ? args['stop_bits'] : 2,
        total_timeout: 10000,
      }
      try {
        const r = await ctx.ssh.mqttRpc(c, 'wb-mqtt-serial', 'device', 'Probe', params, 15)
        return JSON.stringify(r, null, 2)
      } catch (e: unknown) {
        return JSON.stringify({ error: enrichSerialRpcError(e, 'Probe') })
      }
    }

    case 'modbus_ports': {
      const c = resolve1(args, ctx)
      const r = await ctx.ssh.mqttRpc(c, 'wb-mqtt-serial', 'ports', 'Load', {}, 5)
      return JSON.stringify(r, null, 2)
    }

    case 'modbus_templates_list': {
      const c = resolve1(args, ctx)
      const filter = typeof args['filter'] === 'string' ? (args['filter'] as string) : ''
      const result = await ctx.ssh.mqttRpc(c, 'wb-mqtt-serial', 'config', 'Load', {}, 10) as { types?: unknown }
      const list = parseTemplatesList({ types: (result.types as any) ?? [] })
      if (filter.trim()) {
        const matched = filterTemplates(list, filter)
        return JSON.stringify({ filter, count: matched.length, templates: matched }, null, 2)
      }
      const groups = summarizeByGroup(list)
      return JSON.stringify({ totalCount: list.length, groups, hint: 'Without filter a summary by groups is returned. Pass filter (substring) to get a flat list of matches.' }, null, 2)
    }

    case 'modbus_template': {
      const c = resolve1(args, ctx)
      const deviceType = typeof args['device_type'] === 'string' ? (args['device_type'] as string).trim() : ''
      let mqttId = typeof args['mqtt_id'] === 'string' ? (args['mqtt_id'] as string).trim() : ''
      if (!deviceType && !mqttId) {
        return JSON.stringify({ error: 'Need device_type or mqtt_id.' })
      }
      // Resolve device_type -> mqtt-id via Load.types if mqtt_id is not set.
      if (!mqttId) {
        const result = await ctx.ssh.mqttRpc(c, 'wb-mqtt-serial', 'config', 'Load', {}, 10) as { types?: unknown }
        const list = parseTemplatesList({ types: (result.types as any) ?? [] })
        const target = deviceType.toLowerCase()
        const match = list.find((t) => t.type.toLowerCase() === target || t.mqttId.toLowerCase() === target)
        if (!match) {
          // Hint with close matches: substring filter
          const close = filterTemplates(list, deviceType).slice(0, 5).map((t) => t.type)
          return JSON.stringify({ error: `Template not found: ${deviceType}`, hint: close.length ? `Maybe you meant: ${close.join(', ')}` : 'Get the full list via modbus_templates_list.' })
        }
        mqttId = match.mqttId
      }
      // Read the template file. The standard wb-mqtt-serial path.
      const filePath = `/usr/share/wb-mqtt-serial/templates/config-${mqttId}.json`
      let raw: string
      try {
        // 1 MB — some templates (WB-MR6C, WB-MAP6S, WB-MCM8) are larger than 256KB
        // because of translations + multi-channel meta. We read deliberately more
        // so as not to run into truncated JSON.
        raw = (await ctx.ssh.readFile(c, filePath, 1024 * 1024)).content
      } catch (e: unknown) {
        return JSON.stringify({ error: `Could not read ${filePath}: ${e instanceof Error ? e.message : String(e)}. The template file for this device may have a legacy structure or a different mqtt-id — check modbus_templates_list.` })
      }
      let tmpl: Record<string, unknown>
      try {
        tmpl = JSON.parse(raw)
      } catch (e: unknown) {
        return JSON.stringify({ error: `Template ${filePath} does not parse as JSON: ${e instanceof Error ? e.message : String(e)}` })
      }
      const view = (typeof args['view'] === 'string' ? args['view'] : 'summary') as 'summary' | 'full' | 'channels-only' | 'meta-only'
      const enabledOnly = args['enabledOnly'] === true
      const channelFilter = typeof args['channelFilter'] === 'string' ? (args['channelFilter'] as string) : undefined
      return JSON.stringify(renderTemplate(tmpl as any, { view, enabledOnly, channelFilter }), null, 2)
    }

    case 'get_history': {
      const c = resolve1(args, ctx)
      const channels = args['channels'] as [string, string][]
      if (!Array.isArray(channels) || channels.length === 0) return JSON.stringify({ error: 'channels is required' })
      const { from, to } = resolveTimeRange(args)
      if (!from) return JSON.stringify({ error: 'specify period (e.g.: 2h, 6h, 24h, 7d) or from (unix timestamp)' })
      const validationErr = await validateHistoryChannels(ctx, c, channels)
      if (validationErr) return JSON.stringify({ error: validationErr })
      const result = await fetchHistory(ctx, c, channels, from, to)
      return JSON.stringify(result, null, 2)
    }

    case 'get_history_chart': {
      const c = resolve1(args, ctx)
      const channels = args['channels'] as [string, string][]
      if (!Array.isArray(channels) || channels.length === 0) return JSON.stringify({ error: 'channels is required' })
      const { from, to } = resolveTimeRange(args)
      if (!from) return JSON.stringify({ error: 'specify period (e.g.: 2h, 6h, 24h, 7d) or from (unix timestamp)' })
      const validationErr = await validateHistoryChannels(ctx, c, channels)
      if (validationErr) return JSON.stringify({ error: validationErr })
      const title = typeof args['title'] === 'string' ? args['title'] : ''
      const ylabel = typeof args['ylabel'] === 'string' ? args['ylabel'] : ''
      const allowedTypes = new Set(['line', 'bar', 'area', 'point', 'histogram', 'heatmap', 'boxplot'])
      const chartType = (typeof args['chart_type'] === 'string' && allowedTypes.has(args['chart_type'])) ? args['chart_type'] : 'line'
      const histData = await fetchHistory(ctx, c, channels, from, to)
      const totalPoints = histData.series.reduce((n, s) => n + s.points.length, 0)
      try {
        const svg = await renderHistoryChart(histData.series, from, to, title, ylabel, chartType as any)
        const fname = `chart-${c.sn}-${Date.now()}.svg`
        const r = saveAttachment(ctx.sessionId, fname, Buffer.from(svg, 'utf-8'), 'assistant')
        if (!r.ok) return JSON.stringify({ error: r.error })
        return JSON.stringify({
          fileId: r.meta.id,
          fileName: r.meta.name,
          mime: r.meta.mime,
          size: r.meta.size,
          channels: histData.series.map(s => ({
            label: s.label, units: s.units, points: s.points.length,
            min: s.min, max: s.max, avg: s.avg,
          })),
          total_points: totalPoints,
          note: 'The chart is saved as an SVG attachment. The user sees it in the chat as an image.',
        }, null, 2)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return JSON.stringify({ error: `Chart render error: ${msg}` })
      }
    }

    case 'get_history_table': {
      const c = resolve1(args, ctx)
      const channels = args['channels'] as [string, string][]
      if (!Array.isArray(channels) || channels.length === 0) return JSON.stringify({ error: 'channels is required' })
      const { from, to } = resolveTimeRange(args)
      if (!from) return JSON.stringify({ error: 'specify period (e.g.: 2h, 6h, 24h, 7d) or from (unix timestamp)' })
      const validationErr = await validateHistoryChannels(ctx, c, channels)
      if (validationErr) return JSON.stringify({ error: validationErr })
      const limitOverride = typeof args['limit'] === 'number' ? Math.max(1, Math.min(100000, Number(args['limit']))) : 10000
      const minIntervalOverride = typeof args['min_interval'] === 'number' ? Math.max(0, Number(args['min_interval'])) : 0
      const histData = await fetchHistory(ctx, c, channels, from, to, { limitOverride, minIntervalOverride })
      const csv = historyToCsv(histData)
      const truncatedCsv = csv.length > 50000 ? csv.slice(0, 50000) + '\n... (truncated)' : csv
      const totalPoints = histData.series.reduce((n, s) => n + s.points.length, 0)
      return JSON.stringify({
        csv: truncatedCsv,
        channels: histData.series.map(s => ({
          label: s.label,
          units: s.units,
          precision: s.precision,
          points: s.points.length,
          min: s.min,
          max: s.max,
          avg: s.avg
        })),
        total_points: totalPoints
      }, null, 2)
    }

    case 'get_hardware_config': {
      const c = resolve1(args, ctx)
      const result = await ctx.ssh.mqttRpc(c, 'confed', 'Editor', 'Load', { path: '/etc/wb-hardware.conf' }, 10)
      return JSON.stringify(result, null, 2)
    }

    case 'save_hardware_config': {
      const c = resolve1(args, ctx)
      const slotId = String(args['slot_id'] ?? '')
      const module = String(args['module'] ?? '')
      const options = (args['options'] && typeof args['options'] === 'object') ? args['options'] : {}
      if (!slotId) return JSON.stringify({ error: 'slot_id is required (e.g.: "mod1", "extio3", "rs485-1")' })
      const loaded = await ctx.ssh.mqttRpc(c, 'confed', 'Editor', 'Load', { path: '/etc/wb-hardware.conf' }, 10) as { content?: { slots?: Array<{ id: string; module: string; options: unknown }> } }
      const content = loaded?.content
      if (!content || !Array.isArray(content.slots)) return JSON.stringify({ error: 'Could not load the current wb-hardware.conf config' })
      const slot = content.slots.find((s) => s.id === slotId)
      if (!slot) return JSON.stringify({ error: `Slot "${slotId}" not found. Available: ${content.slots.map((s) => s.id).join(', ')}` })
      const prevModule = slot.module
      slot.module = module
      slot.options = options
      const result = await ctx.ssh.mqttRpc(c, 'confed', 'Editor', 'Save', { path: '/etc/wb-hardware.conf', content }, 10)
      return JSON.stringify({ ...result as object, applied: { slot: slotId, from: prevModule, to: module } }, null, 2)
    }

    case 'audit_controller': {
      const c = resolve1(args, ctx)
      return JSON.stringify(await runAudit(ctx.ssh, c), null, 2)
    }

    case 'save_state_for_diff': {
      const c = resolve1(args, ctx)
      return JSON.stringify(await runSnapshot(ctx.ssh, c), null, 2)
    }

    case 'diff_snapshot': {
      const c = resolve1(args, ctx)
      const beforePath = String(args['beforePath'] ?? '')
      if (!beforePath.startsWith('/')) return JSON.stringify({ error: 'beforePath must be an absolute path' })
      return JSON.stringify(await runDiffSnapshot(ctx.ssh, c, beforePath), null, 2)
    }

    case 'read_file': {
      const c = resolve1(args, ctx)
      const filePath = String(args['path'] ?? '')
      const maxBytes = typeof args['maxBytes'] === 'number' ? args['maxBytes'] : undefined
      try {
        const r = await ctx.ssh.readFile(c, filePath, maxBytes)
        return JSON.stringify({ path: filePath, ...r }, null, 2)
      } catch (e: any) {
        return JSON.stringify({ error: e?.message ?? String(e) })
      }
    }

    case 'fetch_from_controller': {
      const c = resolve1(args, ctx)
      const path = String(args['path'] ?? '')
      const name = args['name'] ? String(args['name']).trim() : ''
      if (!path.startsWith('/')) return JSON.stringify({ error: 'path must be absolute' })
      try {
        const buf = await ctx.ssh.downloadFile(c, path)
        const fileName = name || basename(path) || 'file'
        const r = saveAttachment(ctx.sessionId, fileName, buf, 'assistant')
        if (!r.ok) return JSON.stringify({ error: r.error })
        return JSON.stringify({ fileId: r.meta.id, fileName: r.meta.name, mime: r.meta.mime, size: r.meta.size, note: 'The file is saved as an attachment. The user sees it in the UI and can download it.' })
      } catch (e: any) {
        return JSON.stringify({ error: e?.message ?? String(e) })
      }
    }

    case 'upload_to_controller': {
      const c = resolve1(args, ctx)
      const fileId = String(args['fileId'] ?? '').trim()
      const path = String(args['path'] ?? '')
      if (!path.startsWith('/')) return JSON.stringify({ error: 'path must be absolute' })
      const meta = getAttachment(ctx.sessionId, fileId)
      if (!meta) return JSON.stringify({ error: `file ${fileId} not found in session — user must upload it first` })
      const buf = readAttachment(ctx.sessionId, fileId)
      if (!buf) return JSON.stringify({ error: `file ${fileId} data missing` })
      try {
        await ctx.ssh.writeFileBuffer(c, path, buf)
        return JSON.stringify({ sn: c.sn, path, bytesWritten: buf.length, source: meta.name, status: 'uploaded' })
      } catch (e: any) {
        return JSON.stringify({ error: e?.message ?? String(e) })
      }
    }

    case 'list_rules': {
      const c = resolve1(args, ctx)
      const r = await ctx.ssh.mqttRpc(c, 'wbrules', 'Editor', 'List', {}, 10)
      return JSON.stringify(r, null, 2)
    }

    case 'load_rule': {
      const c = resolve1(args, ctx)
      const name = ruleNameToPath(args['name'])
      if (!name) return JSON.stringify({ error: 'name is required' })
      const r = await ctx.ssh.mqttRpc(c, 'wbrules', 'Editor', 'Load', { path: name }, 10)
      return JSON.stringify(r, null, 2)
    }

    case 'save_rule': {
      const c = resolve1(args, ctx)
      const name = ruleNameToPath(args['name'])
      const content = String(args['content'] ?? '')
      if (!name) return JSON.stringify({ error: 'name is required' })
      if (!content) return JSON.stringify({ error: 'content is required' })
      try {
        const r = await ctx.ssh.mqttRpc(c, 'wbrules', 'Editor', 'Save', { path: name, content }, 15)
        return JSON.stringify({ ok: true, ...((r && typeof r === 'object') ? r : {}) }, null, 2)
      } catch (e: unknown) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
      }
    }

    case 'delete_rule': {
      const c = resolve1(args, ctx)
      const name = ruleNameToPath(args['name'])
      if (!name) return JSON.stringify({ error: 'name is required' })
      try {
        await ctx.ssh.mqttRpc(c, 'wbrules', 'Editor', 'Remove', { path: name }, 10)
        return JSON.stringify({ ok: true, via: 'wbrules.Editor.Remove', name }, null, 2)
      } catch (e: unknown) {
        // Common quirk: Editor.List shows the file but Editor.Remove says "File not found".
        // Fall back to plain rm + reload.
        const msg = e instanceof Error ? e.message : String(e)
        if (/file not found|EditorError/i.test(msg)) {
          const escaped = name.replace(/'/g, "'\\''")
          const r = await ctx.ssh.exec(c, `rm -f '/etc/wb-rules/${escaped}' && systemctl reload-or-restart wb-rules`, 15_000)
          if (r.code === 0) return JSON.stringify({ ok: true, via: 'ssh_rm', name, note: 'Editor.Remove replied File not found, deleted via rm + reload-or-restart wb-rules.' }, null, 2)
          return JSON.stringify({ error: `rm fallback failed: ${r.stderr.trim() || `exit ${r.code}`}` })
        }
        return JSON.stringify({ error: msg })
      }
    }

    case 'disable_rule': {
      const c = resolve1(args, ctx)
      const name = ruleNameToPath(args['name'])
      if (!name) return JSON.stringify({ error: 'name is required' })
      try {
        const r = await ctx.ssh.mqttRpc(
          c,
          'wbrules',
          'Editor',
          'ChangeState',
          { path: name, enabled: false },
          10,
        )
        return JSON.stringify(
          {
            ok: true,
            via: 'wbrules.Editor.ChangeState',
            name,
            disabledFile: `${name}.disabled`,
            note: 'The file was renamed to <name>.js.disabled. To enable it back — on stable firmware the reverse enabled:true via the same RPC returns result:false; remove the .disabled suffix via write_file/ssh_exec and do a reload-or-restart wb-rules.',
            ...((r && typeof r === 'object') ? r : {}),
          },
          null,
          2,
        )
      } catch (e: unknown) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
      }
    }

    case 'list_attachments': {
      const items = listAttachments(ctx.sessionId)
      return JSON.stringify({ items })
    }

    case 'read_attachment': {
      const fileId = String(args['fileId'] ?? '').trim()
      const encoding = args['encoding'] === 'base64' ? 'base64' : 'utf8'
      if (!fileId) return JSON.stringify({ error: 'fileId required' })
      const meta = getAttachment(ctx.sessionId, fileId)
      if (!meta) return JSON.stringify({ error: `file ${fileId} not found` })
      const MAX_READ = 200 * 1024
      if (meta.size > MAX_READ) return JSON.stringify({ error: `file too large for context (${meta.size} bytes, limit ${MAX_READ})` })
      const buf = readAttachment(ctx.sessionId, fileId)
      if (!buf) return JSON.stringify({ error: `file ${fileId} data missing` })
      const content = encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8')
      return JSON.stringify({ fileId, name: meta.name, mime: meta.mime, size: meta.size, encoding, content })
    }

    case 'list_archive_contents': {
      const fileId = String(args['fileId'] ?? '').trim()
      if (!fileId) return JSON.stringify({ error: 'fileId required' })
      const buf = readAttachment(ctx.sessionId, fileId)
      if (!buf) return JSON.stringify({ error: `file ${fileId} not found` })
      try {
        const entries = await openArchive(buf)
        return JSON.stringify({
          fileId,
          entries: entries.map(({ path, size, isDir }) => ({ path, size, isDir })),
        })
      } catch (e: any) {
        return JSON.stringify({ error: `Could not read the archive (zip, tar, tar.gz/tgz are supported): ${e?.message ?? String(e)}` })
      }
    }

    case 'read_from_archive': {
      const fileId = String(args['fileId'] ?? '').trim()
      const innerPath = String(args['path'] ?? '').trim()
      const encoding = args['encoding'] === 'base64' ? 'base64' : 'utf8'
      if (!fileId || !innerPath) return JSON.stringify({ error: 'fileId and path required' })
      const buf = readAttachment(ctx.sessionId, fileId)
      if (!buf) return JSON.stringify({ error: `file ${fileId} not found` })
      try {
        const entries = await openArchive(buf)
        const entry = entries.find((e) => e.path === innerPath && !e.isDir)
        if (!entry) return JSON.stringify({ error: `"${innerPath}" not found in the archive` })
        const data = await entry.data()
        const MAX_READ = 200 * 1024
        if (data.length > MAX_READ) return JSON.stringify({ error: `file too large for context (${data.length} bytes, limit ${MAX_READ}). Use extract_archive to pull it out as a separate attachment.` })
        const content = encoding === 'base64' ? data.toString('base64') : data.toString('utf8')
        return JSON.stringify({ fileId, path: innerPath, size: data.length, encoding, content })
      } catch (e: any) {
        return JSON.stringify({ error: `Could not read the archive: ${e?.message ?? String(e)}` })
      }
    }

    case 'extract_archive': {
      const fileId = String(args['fileId'] ?? '').trim()
      const wanted = Array.isArray(args['paths']) ? (args['paths'] as unknown[]).map(String) : null
      if (!fileId) return JSON.stringify({ error: 'fileId required' })
      const buf = readAttachment(ctx.sessionId, fileId)
      if (!buf) return JSON.stringify({ error: `file ${fileId} not found` })
      try {
        const entries = await openArchive(buf)
        const out: { path: string; fileId: string; name: string; size: number; mime: string }[] = []
        for (const entry of entries) {
          if (entry.isDir) continue
          if (wanted && wanted.length && !wanted.includes(entry.path)) continue
          const data = await entry.data()
          const baseName = entry.path.split('/').filter(Boolean).pop() || entry.path
          const r = saveAttachment(ctx.sessionId, baseName, data, 'assistant')
          if (r.ok) {
            out.push({ path: entry.path, fileId: r.meta.id, name: baseName, size: data.length, mime: r.meta.mime })
          } else {
            out.push({ path: entry.path, fileId: '', name: baseName, size: data.length, mime: 'error: ' + r.error } as any)
          }
        }
        if (!out.length) return JSON.stringify({ error: 'The archive is empty or the specified paths were not found.' })
        return JSON.stringify({ fileId, extracted: out })
      } catch (e: any) {
        return JSON.stringify({ error: `Could not read the archive: ${e?.message ?? String(e)}` })
      }
    }
  }
  return JSON.stringify({ error: `unknown tool ${name}` })
}

/** Resolve a single target controller from tool args. Accepts either `sn`
 *  (registry key — usually a WB serial from list_controllers) or `host`
 *  (IP/hostname/host:port for ad-hoc). Host wins if set, because the model uses
 *  it precisely when it explicitly wants to address something outside the
 *  registry (a non-standard port, a temporary IP in the chat). Falls back to the
 *  first `ctx.contextSns` if neither sn nor host is passed. */
function resolve1(args: Record<string, unknown>, ctx: Ctx): Controller {
  const target = pickTarget(args, ctx)
  if (!target) throw new Error('no controller specified: pass `sn` or `host`, or select a controller in the right panel')
  const c = ctx.discovery.get(target) ?? ctx.discovery.getOrCreate(target) ?? adHocController(target)
  if (!c) throw new Error(`controller ${target} not found (does not match as SN/IP/hostname)`)
  return c
}

function pickTarget(args: Record<string, unknown>, ctx: Ctx): string {
  const host = typeof args['host'] === 'string' ? args['host'].trim() : ''
  if (host) return host
  const sn = typeof args['sn'] === 'string' ? args['sn'].trim() : ''
  if (sn) return sn
  return ctx.contextSns[0] ?? ''
}

const BLOCKED_RPC_DRIVERS = new Set(['wb-connection-manager'])
const BLOCKED_RPC_WRITE_METHODS = new Set(['Save', 'Set', 'Apply', 'Write', 'Update', 'Delete', 'Remove'])

function checkBlockedRpc(
  driver: string,
  _service: string,
  method: string,
  params: Record<string, unknown>
): string | null {
  if (BLOCKED_RPC_DRIVERS.has(driver) && BLOCKED_RPC_WRITE_METHODS.has(method)) {
    return `RPC blocked — changing network settings via ${driver}/${_service}/${method} is not allowed. Viewing (Load, Get, List) is allowed.`
  }
  if (driver === 'confed' && method === 'Save') {
    const path = String(params['path'] ?? '')
    if (/wb-connection-manager|network/i.test(path)) {
      return `RPC blocked — saving the network config (${path}) is not allowed.`
    }
  }
  return null
}

export const READ_ONLY_PREFIXES = [
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'wc',
  'find',
  'stat',
  'ps',
  'top -b',
  'id',
  'hostname',
  'uname',
  'uptime',
  'free',
  'df',
  'mount',
  'lsblk',
  'date',
  'echo',
  'systemctl status',
  'systemctl list-units',
  'systemctl is-active',
  'systemctl is-enabled',
  'journalctl',
  'SYSTEMD_PAGER= journalctl',
  'mosquitto_sub',
  'wb-watch-update status',
  'wb-gen-serial',
  'wb-mqtt-db-cli',
  'dpkg',
  'dpkg-query',
  'apt policy',
  'apt list',
  'apt-cache',
  'apt update',
  'apt-get update',
  'wb-release',
  'SYSTEMD_PAGER= systemctl',
  'nmcli connection show',
  'nmcli con show',
  'nmcli device',
  'nmcli dev',
  'nmcli general',
  'nmcli networking connectivity',
  'networkctl',
  'networkctl status',
  'networkctl list',
  'ip addr',
  'ip address',
  'ip link show',
  'ip route',
  'ip route show',
  'ifconfig'
]

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[-\w]+\s+)*\/(\s|$|\*)/,
  /\brm\s+-[-\w]*[rR][-\w]*\s+(-[-\w]+\s+)*(--\s+)?\/[^\s/]+\/?(\s|$)/,
  /\brm\s+(-[-\w]+\s+)*\/(etc|usr|boot|bin|sbin|lib|lib64|dev|proc|sys|root|home|var)\/?(\s|$)/,
  /\brm\s+.*\/mnt\/data\s*$/,
  /\brm\s+.*\/mnt\/data\/\*\s*$/,
  /\brm\s+.*\/mnt\/data\/[^/]*\s*$/,
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\//,
  /\b(halt|poweroff|shutdown)\b/,
  />\s*\/dev\/[sv]d/,
  />\s*\/dev\/mmcblk/,
  /\bwipe/i,
  /\bformat\s+\/dev\//i,
  /\bfdisk\b/,
  /\bparted\b/,
  /\biptables\s+-F\b/,
  /\biptables\s+--flush\b/,
  /\bpasswd\b/,
  /\busermod\b/,
  /\buserdel\b/,
  /\bchown\s+-R\s+.*\s+\/\s*$/,
  /\bchmod\s+-R\s+.*\s+\/\s*$/,
  /\bkill\s+-9\s+-1\b/,
  /\bsystemctl\s+(stop|restart|mask|disable)\s+.*\bssh(d)?\b/,
  /\bapt(-get)?\s+(remove|purge)\s+.*\b(ssh|systemd|libc|linux-image)\b/,
  /\bapt(-get)?\s+(remove|purge)\s+.*\bwb-/,
  /\bdpkg\s+(-r|--remove|-P|--purge)\s+.*\bwb-/,
  /\bfork\s*bomb/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
  /\bnmcli\s+(connection|con|device|dev|general|networking)\s+(modify|mod|add|delete|del|down|up|edit)\b/,
  /\bnmcli\s+networking\s+off\b/,
  /\bnetworkctl\s+(up|down|renew|forcerenew|reconfigure|reload)\b/,
  /\bip\s+(addr|address|link|route)\s+(add|del|delete|change|replace|flush)\b/,
  /\bifconfig\s+\S+\s+(down|up|\d)/,
  /\bsystemctl\s+(stop|restart|disable|mask)\s+.*\b(NetworkManager|networking|wb-connection-manager)\b/,
  /\bwb-connection-manager\b.*\b(set|apply|save|write)\b/i,
  /\bwb-fw-update\b/,
  /\bwb-run-update\b/,
  /\bswupdate\b/,
]

export function isDestructiveCommand(command: string): string | null {
  const cmd = command.trim()
  for (const pat of DESTRUCTIVE_PATTERNS) {
    if (pat.test(cmd)) {
      return `Command blocked — a potentially destructive operation: "${cmd}". Such commands are forbidden even with user confirmation.`
    }
  }
  return null
}

export function isDockerComposeCommand(command: string): boolean {
  return /(?:^|[;&|]\s*|`|\$\()docker-compose\s+\w/.test(command)
}

// ─── History helpers ──────────────────────────────────────────────────────────

function parsePeriodSeconds(period: string): number | null {
  const m = period.trim().match(/^(\d+(?:\.\d+)?)(m|h|d|w|y)$/)
  if (!m) return null
  const n = parseFloat(m[1]!)
  const unit = m[2]!
  const mul = unit === 'm' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? 86400 : unit === 'w' ? 604800 : 31536000
  return Math.round(n * mul)
}

function resolveTimeRange(input: Record<string, unknown>): { from: number; to: number } {
  const nowSec = Math.floor(Date.now() / 1000)
  const to = typeof input['to'] === 'number' ? Number(input['to']) : nowSec
  if (typeof input['period'] === 'string') {
    const secs = parsePeriodSeconds(input['period'])
    if (secs && secs > 0) return { from: nowSec - secs, to: nowSec }
  }
  return { from: Number(input['from']) || 0, to }
}

interface HistoryPoint { v: number; t: number }
interface RawHistoryPoint { c: number; t: number; v: string }
export interface HistorySeries {
  label: string
  points: HistoryPoint[]
  min: number
  max: number
  avg: number
  units?: string
  precision?: number
}
interface HistoryResult { series: HistorySeries[]; from: number; to: number; durationSec: number }

function historyParams(durationSec: number): { min_interval: number; limit: number } {
  if (durationSec <= 3600)   return { min_interval: 0,   limit: 200  }
  if (durationSec <= 86400)  return { min_interval: 60,  limit: 500  }
  return                            { min_interval: 600, limit: 1000 }
}

/** Pure helper: build error message about missing devices/channels.
 * `requested` — what the caller asked for; `available` — what MQTT showed
 * (Map<device_id, control_names[]>). Empty/missing entries in `available`
 * mean the device has no controls under `/devices/<dev>/controls/+`,
 * which we treat as «device not found».
 * Returns null if all requested channels are valid, otherwise a concise
 * error string suitable for the model. Lists available controls only for
 * the *failing* device (bounded), never lists devices.
 */
export function diagnoseHistoryChannels(
  requested: [string, string][],
  available: Map<string, string[]>
): string | null {
  const byDevice = new Map<string, string[]>()
  for (const [d, ch] of requested) {
    const arr = byDevice.get(d) ?? []
    if (!arr.includes(ch)) arr.push(ch)
    byDevice.set(d, arr)
  }
  const errs: string[] = []
  for (const [device, requestedCtrls] of byDevice) {
    const avail = available.get(device) ?? []
    if (avail.length === 0) {
      errs.push(`device_id "${device}" not found on the controller. Check via mqtt_list_topics(prefix="/devices/+/meta/name") and retry.`)
      continue
    }
    const availSet = new Set(avail)
    const missing = requestedCtrls.filter(ch => !availSet.has(ch))
    if (missing.length) {
      errs.push(`channel(s) for "${device}" not found: [${missing.join(', ')}]. Available on this device: [${avail.join(', ')}]`)
    }
  }
  return errs.length ? errs.join(' | ') : null
}

/** Pre-flight validate that requested [device_id, control_name] pairs exist
 *  on the controller. One parallel mqtt_list_topics per unique device.
 *  Returns error string for the model, or null if all good.
 */
async function validateHistoryChannels(
  ctx: Ctx,
  c: Controller,
  channels: [string, string][]
): Promise<string | null> {
  const devices = [...new Set(channels.map(([d]) => d))]
  const lists = await Promise.all(
    devices.map(async (device) => {
      const prefix = `/devices/${device}/controls/`
      const topics = await ctx.ssh.mqttListTopics(c, `${prefix}+`, 2)
      const ctrls = topics
        .map(t => t.startsWith(prefix) ? t.slice(prefix.length) : '')
        .filter(s => s.length > 0)
      return [device, ctrls] as const
    })
  )
  return diagnoseHistoryChannels(channels, new Map(lists))
}

async function fetchHistory(
  ctx: Ctx,
  c: Controller,
  channels: [string, string][],
  from: number,
  to: number,
  opts: { limitOverride?: number; minIntervalOverride?: number } = {}
): Promise<HistoryResult> {
  const durationSec = to - from
  const defaults = historyParams(durationSec)
  const limit = opts.limitOverride ?? defaults.limit
  const min_interval = opts.minIntervalOverride ?? defaults.min_interval

  const series = await Promise.all(channels.map(async ([device, control]) => {
    const [rawAny, units, precisionRaw] = await Promise.all([
      ctx.ssh.mqttRpc(
        c,
        'db_logger', 'history', 'get_values',
        {
          channels: [[device, control]],
          timestamp: { gt: from, lt: to },
          ver: 1,
          limit,
          min_interval
        },
        15
      ),
      ctx.mqtt.readTopic(c, `/devices/${device}/controls/${control}/meta/units`).catch(() => null),
      ctx.mqtt.readTopic(c, `/devices/${device}/controls/${control}/meta/precision`).catch(() => null),
    ])

    const raw = rawAny as { values?: RawHistoryPoint[] } | null
    const flatValues: RawHistoryPoint[] = Array.isArray(raw?.values) ? raw!.values! : []
    const points: HistoryPoint[] = []
    for (const p of flatValues) {
      const v = parseFloat(p.v)
      if (isFinite(v)) points.push({ t: p.t, v })
    }
    const nums = points.map(p => p.v)
    const min = nums.length ? Math.min(...nums) : 0
    const max = nums.length ? Math.max(...nums) : 0
    const avg = nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : 0

    const precision = precisionRaw != null ? Number(precisionRaw) : NaN

    const s: HistorySeries = {
      label: `${device}/${control}`,
      points,
      min,
      max,
      avg: Math.round(avg * 100) / 100,
    }
    if (typeof units === 'string' && units) s.units = units
    if (Number.isFinite(precision)) s.precision = precision
    return s
  }))

  return { series, from, to, durationSec }
}

/** Normalise a wb-rule name to the `<name>.js` path that wbrules/Editor expects. */
function ruleNameToPath(raw: unknown): string {
  let s = String(raw ?? '').trim()
  if (!s) return ''
  // Strip any leading directory the model might have added
  s = s.replace(/^\/?(etc\/wb-rules\/)?/, '')
  // Reject path traversal
  if (s.includes('/') || s.includes('..')) return ''
  if (!s.endsWith('.js')) s += '.js'
  return s
}

function csvEscape(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return '"' + v.replace(/"/g, '""') + '"'
  }
  return v
}

function historyToCsv(result: HistoryResult): string {
  const timestamps = new Set<number>()
  for (const s of result.series) {
    for (const p of s.points) timestamps.add(p.t)
  }
  const allTs = Array.from(timestamps).sort((a, b) => a - b)
  const lookups = result.series.map(s => {
    const m = new Map<number, number>()
    for (const p of s.points) m.set(p.t, p.v)
    return m
  })
  const header = ['timestamp_unix', 'timestamp_iso']
  for (const s of result.series) {
    const u = s.units ? ` (${s.units})` : ''
    header.push(`${s.label}${u}`)
  }
  const lines = [header.map(csvEscape).join(',')]
  for (const t of allTs) {
    const iso = new Date(t * 1000).toISOString()
    const row: string[] = [String(t), iso]
    for (let i = 0; i < lookups.length; i++) {
      const v = lookups[i]!.get(t)
      if (v === undefined) {
        row.push('')
        continue
      }
      const precision = result.series[i]!.precision
      const formatted = typeof precision === 'number' && precision > 0
        ? v.toFixed(precision)
        : String(v)
      row.push(formatted)
    }
    lines.push(row.map(csvEscape).join(','))
  }
  return lines.join('\n') + '\n'
}

/** Multi-target version of resolve1. Accepts `sn`/`host` as string or array.
 *  Host array merges with sn array; if both are empty — fall back to ctx.contextSns. */
function resolveTargets(args: Record<string, unknown>, ctx: Ctx): Controller[] {
  const toKeys = (raw: unknown): string[] => {
    if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean)
    if (typeof raw === 'string' && raw.trim()) return [raw.trim()]
    return []
  }
  const fromHost = toKeys(args['host'])
  const fromSn = toKeys(args['sn'])
  const keys = (fromHost.length || fromSn.length) ? [...fromHost, ...fromSn] : ctx.contextSns
  return keys
    .map((k) => ctx.discovery.get(k) ?? ctx.discovery.getOrCreate(k) ?? adHocController(k))
    .filter((c): c is Controller => !!c)
}

function adHocController(input: string): Controller | null {
  // Allow bare IP / hostname that isn't in the registry yet. Supports an
  // optional ":port" suffix so the LLM can address controllers running ssh
  // on a non-default port without the user having to pre-add them.
  const { host, port } = parseHostPort(input)
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  const isHostname = host.includes('.') || host.includes('-')
  if (!isIp && !isHostname) return null
  return {
    sn: host.toUpperCase(),
    host,
    addresses: isIp ? [host] : [],
    port,
    lastSeen: Date.now(),
    source: 'manual',
    reachable: undefined,
  }
}

function parseArgs(json: string): Record<string, unknown> {
  if (!json) return {}
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

function toPublic(c: Controller) {
  return {
    sn: c.sn,
    host: c.host,
    addresses: c.addresses,
    reachable: c.reachable ?? null,
    source: c.source,
    lastSeen: new Date(c.lastSeen).toISOString(),
    hostname: c.hostname,
    fw: c.fw,
  }
}
