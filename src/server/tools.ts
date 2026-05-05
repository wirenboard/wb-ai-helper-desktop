import type { ChatCompletionTool } from 'openai/resources/chat/completions.mjs'
import type { Discovery, Controller } from './discovery.ts'
import type { MqttPool } from './mqtt-pool.ts'
import type { SshPool } from './ssh.ts'
import { probe } from './http-probe.ts'
import type { DbHandle } from './db.ts'
import { getTodos, setTodos, formatTodos, type TodoItem, type TodoStatus } from './todos.ts'
import {
  getSkill, upsertUserSkill, deleteUserSkill,
  trackLoadedSkill, unloadSkillFromSession, extractDescription, SKILL_NAME_RE,
} from './skills.ts'

export function toolSchemas(): ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'list_controllers',
        description:
          'Список всех контроллеров Wirenboard, найденных в локальной сети через mDNS, плюс добавленные вручную. Возвращает SN, hostname, доступность и время последнего ответа.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'probe_controller',
        description: 'Проверить доступность контроллера по HTTP (web UI) и обновить статус.',
        parameters: {
          type: 'object',
          properties: { sn: { type: 'string', description: 'Серийный номер контроллера' } },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_devices',
        description:
          'Список устройств на контроллерах (или группе). Опрашивает MQTT-топики /devices/+/meta/name. Если sn не указан — берётся текущий контекст чата.',
        parameters: {
          type: 'object',
          properties: {
            sn: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
              description: 'SN или массив SN. Если опущено — все контроллеры из контекста чата.',
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
        description: 'Список контролов конкретного устройства на контроллере (через MQTT).',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string' },
            device: { type: 'string', description: 'ID устройства, например `wb-mr6c_45`' },
          },
          required: ['sn', 'device'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mqtt_read',
        description: 'Прочитать значение MQTT-топика на контроллере.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string' },
            topic: { type: 'string', description: 'Полный путь к топику, например `/devices/wb-mr6c_45/controls/K1`' },
          },
          required: ['sn', 'topic'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mqtt_write',
        description:
          'Опубликовать значение в MQTT-топик. Для управления контролом WB пишите в `<topic>/on` (`controls/K1/on` ← `1` чтобы включить).',
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
          },
          required: ['sn', 'topic', 'payload'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ssh_exec',
        description:
          'Выполнить shell-команду по SSH на контроллере (или группе). Работает с дефолтным root@wirenboard или с настроенными кредами. Возвращает stdout/stderr/код. Опасные операции (rm/reboot/dpkg) — только при явном запросе пользователя.',
        parameters: {
          type: 'object',
          properties: {
            sn: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
              description: 'SN или массив SN. Если опущено — контроллеры из контекста чата.',
            },
            command: { type: 'string' },
            timeoutMs: { type: 'number', description: 'таймаут команды (по умолчанию 10000, максимум 120000)' },
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
        description: 'Прочитать файл с контроллера по SSH (через head -c, ограничение по размеру).',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string' },
            path: { type: 'string' },
            maxBytes: { type: 'number', description: 'по умолчанию 64000' },
          },
          required: ['sn', 'path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ssh_read_logs',
        description: 'journalctl tail на контроллере. unit опционален.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string' },
            unit: { type: 'string', description: 'systemd unit, например wb-mqtt-serial' },
            lines: { type: 'number', description: 'кол-во строк (по умолчанию 200, максимум 2000)' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'todo_write',
        description: 'Записать план подзадач для текущей сессии. Перезаписывает список ЦЕЛИКОМ. Используй на задачах в 3+ шага. Ровно один пункт может быть "in_progress". После каждого шага обновляй статус.',
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
        description: 'Зафиксировать итог этапа и сжать контекст. Вызывай когда: (1) выполнено 5-7+ инструментов, (2) завершён логический этап. summary — 3-7 предложений: что сделано, что нашли, что дальше.',
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
        description: 'Подгрузить скилл (markdown с инструкциями) ДО действий по профильной теме. Список скиллов — в системном промпте. После завершения задачи выгрузи через unload_skill.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Имя скилла из каталога, kebab-case.' },
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
        description: 'Выгрузить загруженный скилл из контекста сессии. Вызывай после завершения задачи.',
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
        description: 'Создать или обновить скилл в каталоге. Формат: `# skill-name` первой строкой, пустая строка, затем абзац-описание (>=20 символов), потом содержимое.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'kebab-case, 1-63 символа.' },
            content: { type: 'string', description: 'Markdown. Обязательно: # <name>, пустая строка, описание, содержимое.' },
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
        description: 'Удалить скилл из каталога.',
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
  ]
}

type Ctx = {
  discovery: Discovery
  mqtt: MqttPool
  ssh: SshPool
  /** SNs выбранные в текущем чате; если пусто — операции на массиве требуют явного sn. */
  contextSns: string[]
  db: DbHandle
  sessionId: string
  agentState: { checkpointSummary?: string }
}

export async function dispatch(name: string, argsJson: string, ctx: Ctx): Promise<string> {
  const args = parseArgs(argsJson)
  switch (name) {
    case 'list_controllers':
      return JSON.stringify(ctx.discovery.list().map(toPublic), null, 2)

    case 'probe_controller': {
      const sn = String(args['sn'] ?? '')
      const c = ctx.discovery.get(sn) ?? ctx.discovery.getOrCreate(sn) ?? adHocController(sn)
      if (!c) return notFound(sn)
      const r = await probe(c)
      c.reachable = r.reachable
      if (r.fw) c.fw = r.fw
      if (r.hostname) c.hostname = r.hostname
      return JSON.stringify(r, null, 2)
    }

    case 'list_devices': {
      const targets = resolveTargets(args['sn'], ctx)
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
      const sn = String(args['sn'] ?? '')
      const device = String(args['device'] ?? '')
      const c = ctx.discovery.get(sn) ?? ctx.discovery.getOrCreate(sn) ?? adHocController(sn)
      if (!c) return notFound(sn)
      const controls = await ctx.mqtt.listControls(c, device)
      return JSON.stringify(controls, null, 2)
    }

    case 'mqtt_read': {
      const sn = String(args['sn'] ?? '')
      const topic = String(args['topic'] ?? '')
      const c = ctx.discovery.get(sn) ?? ctx.discovery.getOrCreate(sn) ?? adHocController(sn)
      if (!c) return notFound(sn)
      const value = await ctx.mqtt.readTopic(c, topic)
      return JSON.stringify({ topic, value }, null, 2)
    }

    case 'mqtt_write': {
      const targets = resolveTargets(args['sn'], ctx)
      const topic = String(args['topic'] ?? '')
      const payload = String(args['payload'] ?? '')
      const out: Record<string, string> = {}
      await Promise.all(
        targets.map(async (c) => {
          try {
            await ctx.mqtt.writeTopic(c, topic, payload)
            out[c.sn] = 'ok'
          } catch (e: any) {
            out[c.sn] = `error: ${e?.message ?? String(e)}`
          }
        }),
      )
      return JSON.stringify(out, null, 2)
    }

    case 'ssh_exec': {
      const targets = resolveTargets(args['sn'], ctx)
      const command = String(args['command'] ?? '')
      const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : undefined
      if (!command) return JSON.stringify({ error: 'command required' })
      const out: Record<string, unknown> = {}
      await Promise.all(
        targets.map(async (c) => {
          try {
            out[c.sn] = await ctx.ssh.exec(c, command, timeoutMs)
          } catch (e: any) {
            out[c.sn] = { error: e?.message ?? String(e) }
          }
        }),
      )
      return JSON.stringify(out, null, 2)
    }

    case 'ssh_read_file': {
      const sn = String(args['sn'] ?? '')
      const filePath = String(args['path'] ?? '')
      const maxBytes = typeof args['maxBytes'] === 'number' ? args['maxBytes'] : undefined
      const c = ctx.discovery.get(sn) ?? ctx.discovery.getOrCreate(sn) ?? adHocController(sn)
      if (!c) return notFound(sn)
      try {
        const r = await ctx.ssh.readFile(c, filePath, maxBytes)
        return JSON.stringify({ path: filePath, ...r }, null, 2)
      } catch (e: any) {
        return JSON.stringify({ error: e?.message ?? String(e) })
      }
    }

    case 'ssh_read_logs': {
      const sn = String(args['sn'] ?? '')
      const unit = args['unit'] ? String(args['unit']) : undefined
      const lines = typeof args['lines'] === 'number' ? args['lines'] : undefined
      const c = ctx.discovery.get(sn) ?? ctx.discovery.getOrCreate(sn) ?? adHocController(sn)
      if (!c) return notFound(sn)
      try {
        const text = await ctx.ssh.readLogs(c, unit, lines)
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
        if (!content) return JSON.stringify({ error: 'каждый пункт должен иметь непустой content' })
        if (!allowed.includes(status as TodoStatus)) return JSON.stringify({ error: `status должен быть pending|in_progress|completed` })
        items.push({ content, status: status as TodoStatus })
      }
      const inProgress = items.filter((t) => t.status === 'in_progress').length
      if (inProgress > 1) return JSON.stringify({ error: `ровно один пункт может быть in_progress, получил ${inProgress}` })
      setTodos(ctx.sessionId, items)
      return JSON.stringify({ count: items.length, plan: formatTodos(items) })
    }

    case 'checkpoint': {
      const summary = String(args['summary'] ?? '').trim()
      if (!summary) return JSON.stringify({ error: 'summary required' })
      const currentTodos = getTodos(ctx.sessionId)
      const pending = currentTodos.filter((t) => t.status !== 'completed')
      const todosPart = pending.length ? `\nОставшийся план:\n${formatTodos(pending)}` : ''
      ctx.agentState.checkpointSummary = summary + todosPart
      return JSON.stringify({ ok: true, message: 'Чекпоинт принят. Контекст будет сжат после этого хода.' })
    }

    case 'load_skill': {
      const name = String(args['name'] ?? '').trim()
      if (!SKILL_NAME_RE.test(name)) return JSON.stringify({ error: 'name должен быть kebab-case' })
      const skill = getSkill(ctx.db, name)
      if (!skill) return JSON.stringify({ error: `скилл "${name}" не найден` })
      trackLoadedSkill(ctx.sessionId, skill.name, skill.content)
      return JSON.stringify({ name: skill.name, content: skill.content })
    }

    case 'unload_skill': {
      const name = String(args['name'] ?? '').trim()
      if (!SKILL_NAME_RE.test(name)) return JSON.stringify({ error: 'name должен быть kebab-case' })
      const removed = unloadSkillFromSession(ctx.sessionId, name)
      if (!removed) return JSON.stringify({ error: `скилл "${name}" не был загружен` })
      return JSON.stringify({ ok: true, message: `Скилл "${name}" выгружен.` })
    }

    case 'create_skill': {
      const name = String(args['name'] ?? '').trim()
      const content = String(args['content'] ?? '').trim()
      if (!SKILL_NAME_RE.test(name)) return JSON.stringify({ error: 'name должен быть kebab-case (a-z, 0-9, "-"), 1-63 символа' })
      if (content.length < 100) return JSON.stringify({ error: 'content слишком короткий (100+ символов)' })
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
      if (!SKILL_NAME_RE.test(name)) return JSON.stringify({ error: 'name должен быть kebab-case' })
      const r = deleteUserSkill(ctx.db, name)
      if (!r.ok) return JSON.stringify({ error: r.error })
      return JSON.stringify({ name, status: 'deleted' })
    }
  }
  return JSON.stringify({ error: `unknown tool ${name}` })
}

function resolveTargets(raw: unknown, ctx: Ctx): Controller[] {
  let keys: string[]
  if (Array.isArray(raw)) keys = raw.map(String)
  else if (typeof raw === 'string' && raw) keys = [raw]
  else keys = ctx.contextSns
  return keys
    .map((k) => ctx.discovery.get(k) ?? ctx.discovery.getOrCreate(k) ?? adHocController(k))
    .filter((c): c is Controller => !!c)
}

function adHocController(host: string): Controller | null {
  // Allow bare IP / hostname that isn't in the registry yet.
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  const isHostname = host.includes('.') || host.includes('-')
  if (!isIp && !isHostname) return null
  return {
    sn: host.toUpperCase(),
    host,
    addresses: isIp ? [host] : [],
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

function notFound(sn: string): string {
  return JSON.stringify({ error: `controller ${sn} not found` })
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
