import type { ChatCompletionTool } from 'openai/resources/chat/completions.mjs'
import type { Discovery, Controller } from './discovery.ts'
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
        name: 'mqtt_inventory',
        description: 'Объединённый снимок MQTT-устройств одним вызовом: id, name, driver, error + список контролов с распакованным meta (value, type, units, readonly, order, min/max, precision, error). Заменяет связку `list_devices` + N×`list_controls`. Поле `error` парсится по [WB MQTT Conventions](https://github.com/wirenboard/conventions): `r` (read), `w` (write), `p` (period miss) и комбинации. **При `error.read=true` значение в value-топике — last-known-good (последний успешно прочитанный), а не текущий live-readout** — без этого знания модель часто делает неверный диагноз вида «датчик показывает 23°C, но устройство в офлайне». Дополнительно возвращает массив `errors` со сводкой всех проблем по контроллеру. По умолчанию `includeEmpty=false` (устройства без контролов скрыты).',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            device: { type: 'string', description: 'Фильтр по device_id (подстрока, регистронезависимо). Пусто — все устройства.' },
            timeout: { type: 'number', description: 'Окно сбора в секундах. По умолчанию 3.' },
            includeEmpty: { type: 'boolean', description: 'Включать устройства без контролов (только с meta). По умолчанию false.' },
            includeMeta: { type: 'boolean', description: 'Класть полный raw meta-объект в каждый control. По умолчанию false (только распакованные поля).' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mqtt_read',
        description: 'Прочитать одно retain-значение топика (mosquitto_sub -C 1 -W). Возвращает текущее значение или null если топик не retain.',
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
          'Опубликовать значение в MQTT-топик на контроллере (mosquitto_pub). Для управления используй суффикс /on (например /devices/wb-gpio/controls/A1_OUT/on). По умолчанию qos=1, retain=false — это нужно для команд `/on`. Для записи retained-конфига (например в системные топики или meta-настройки) укажи retain=true. HITL: перед вызовом объясни пользователю что делаешь и дождись подтверждения.',
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
            qos: { type: 'integer', enum: [0, 1, 2], description: 'MQTT QoS, по умолчанию 1.' },
            retain: { type: 'boolean', description: 'Опубликовать как retained, по умолчанию false.' },
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
          'Выполнить shell-команду на контроллере. Для моментальных команд (локальный кеш, без сети): ls, cat, dpkg -l, apt list, apt policy, wb-release, systemctl status, journalctl. Для сетевых/долгих (apt update/install/upgrade, wb-release -t, tar больших каталогов) — используй ssh_exec_async. Для опасных команд — сначала объясни пользователю, жди подтверждения.',
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
        description: 'Последние строки systemd-журнала. Если указан unit — только этот сервис; иначе общий журнал. Для диагностики используй priority="err" чтобы видеть только ошибки.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string' },
            unit: { type: 'string', description: 'systemd unit, например wb-mqtt-serial' },
            lines: { type: 'number', description: 'кол-во строк (по умолчанию 200, максимум 2000)' },
            priority: { type: 'string', description: 'фильтр приоритета journalctl: err, warning, info, debug. По умолчанию — все уровни.' },
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
        description: 'Записать план из подзадач для текущей сессии. Перезаписывает список ЦЕЛИКОМ — передавай весь набор пунктов каждый раз, включая уже завершённые. Используй на задачах с 3+ шагами, при анализе/оценке (audit, диагностика, сравнение контроллеров), многоэтапных апдейтах и бэкапах. После каждого шага сразу обновляй статус: ровно один пункт "in_progress", завершённые — "completed". Не используй для тривиальных задач в один шаг. Список видно модели в каждом ходе.',
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
        description: 'Зафиксировать промежуточный итог текущего этапа и сжать контекст. Вызывай когда: (1) выполнено 5-7+ инструментов подряд, (2) завершён логический этап (диагностика, сбор данных, установка), (3) все пункты текущей фазы todo_write помечены completed. Параметр summary — суммари в 3-7 предложениях: что исследовали/сделали, что обнаружили, что планируем дальше. Текущие pending-задачи из todo_write автоматически сохраняются в чекпоинте — не нужно их дублировать в summary. После чекпоинта старые tool results заменяются суммари, новая фаза начинается с чистого контекста.',
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
        description: 'Подгрузить содержимое специализированного скилла (markdown с инструкциями) ДО действий по профильной теме. Список доступных скиллов с описаниями — в системном промпте. После завершения задачи выгрузи скилл через unload_skill чтобы освободить контекст.',
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
        description: 'Выгрузить ранее загруженный скилл из активного контекста сессии. Вызывай после завершения задачи, для которой скилл был нужен — это освобождает контекст. Скилл остаётся в каталоге и может быть загружен заново через load_skill.',
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
        description: 'Создать или обновить пользовательский скилл в каталоге. Вызывай, когда пользователь просит «создай скилл», «обнови скилл X», «сделай из этого скилл», «запомни эту тему как скилл». Перед вызовом подгрузи skill-creator и следуй формату. Description для каталога сервер извлечёт сам из первого абзаца после заголовка `# <name>`. Системные скиллы этим тулом не перезаписываются.',
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
        description: 'Удалить пользовательский скилл из БД. Системные скиллы не удаляются.',
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
        description: 'Базовая информация о контроллере: hostname, uname, uptime, версия прошивки. Делается одним SSH-запросом.',
        parameters: {
          type: 'object',
          properties: { sn: { type: 'string', description: 'Серийный номер контроллера.' } },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_metrics',
        description: 'Системные метрики контроллера: load average, RAM, диски (/, /mnt/data). Сырые данные с cat /proc/loadavg, free -m, df -h.',
        parameters: {
          type: 'object',
          properties: { sn: { type: 'string', description: 'Серийный номер контроллера.' } },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'failed_units',
        description: 'Список упавших systemd-юнитов на контроллере (`systemctl --failed`). Один из первых шагов диагностики «что-то сломалось» — быстрее, чем читать journalctl целиком.',
        parameters: {
          type: 'object',
          properties: { sn: { type: 'string', description: 'Серийный номер контроллера.' } },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'systemd_unit',
        description: 'Управление systemd-юнитом и его инспекция. Действие `status` (по умолчанию) возвращает структурированный объект {active, sub, load, unitFileState, exitCode, mainPid, since, statusTail} — для большинства диагностических вопросов этого достаточно. `cat` (юнит со всеми drop-ins) и `list-deps` тоже read-only. Действия, изменяющие состояние, — `start`/`stop`/`restart`/`reload`/`enable`/`disable`/`mask`/`unmask`: HITL — перед вызовом объясни пользователю что делаешь и дождись подтверждения. Имя юнита допускает суффикс или нет (`wb-mqtt-serial` ≡ `wb-mqtt-serial.service`).',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            unit: { type: 'string', description: 'Имя юнита (wb-mqtt-serial.service, fstrim.timer, mosquitto). Суффикс .service можно опустить.' },
            action: {
              type: 'string',
              enum: ['status', 'start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask', 'cat', 'list-deps'],
              description: 'Действие. По умолчанию status.',
            },
          },
          required: ['sn', 'unit'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'network_status',
        description: 'Сетевая сводка контроллера в одном вызове: интерфейсы (ip -j addr) с IPv4-адресами и состоянием, default-маршрут (ip -j route), активные соединения NetworkManager (nmcli connection show / device) и опционально ping до целевого хоста. Типичный first-call для диагностики «нет интернета»/«не виден через VPN»/«отвалился uplink».',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            pingTarget: { type: 'string', description: 'Если задан — `ping -c1 -W2 <target>` (например 8.8.8.8). Иначе пинг пропускается.' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cloud_status',
        description: 'Состояние Wiren Board Cloud agent одним вызовом: активность сервиса wb-cloud-agent, наличие device-сертификата, список привязанных провайдеров, retained MQTT-контролы (status / activation_link / cloud_base_url) для каждого провайдера. По одному вызову видно, привязан ли контроллер к облаку и в каком статусе.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Записать содержимое в файл на контроллере (через SFTP). HITL: перед вызовом покажи пользователю diff или содержимое и дождись подтверждения.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            path: { type: 'string', description: 'Абсолютный путь к файлу.' },
            content: { type: 'string', description: 'Полное содержимое файла.' },
          },
          required: ['sn', 'path', 'content'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Поиск в интернете через Brave Search. Возвращает топ-10 результатов: {title, url, snippet}. Макс. 3 вызова на один ответ модели (счётчик обнуляется на каждом новом сообщении пользователя). Предпочитай прямой web_fetch на wiki.wirenboard.com. Используй web_search только когда не знаешь URL. Если результатов нет — НЕ повторяй, используй web_fetch.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поисковый запрос на русском или английском.' },
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
        description: 'Скачать содержимое веб-страницы по URL. Используй, когда не уверен в конвенциях/API/синтаксисе и хочешь свериться с документацией Wiren Board (github.com/wirenboard/*), README сторонних библиотек, конкретными файлами шаблонов и т.п. Возвращает text/plain (HTML конвертируется в читаемый текст; markdown/json/код — как есть). Лимит 20 000 символов.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Полный URL (http/https).' },
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
        description: 'Вызвать MQTT RPC на контроллере. Параметр `params` ВСЕГДА передавай явно — даже если RPC принимает {} — иначе вызов будет некорректным. Примеры: mqtt_rpc(sn, "wb-mqtt-serial", "device", "LoadConfig", params={port, slave_id, ...}); mqtt_rpc(sn, "wb-mqtt-serial", "config", "Load", params={}); mqtt_rpc(sn, "wbrules", "Editor", "Save", params={path: "имя.js", content: "..."}) — для Editor.Save оба поля path (с расширением .js) и content ОБЯЗАТЕЛЬНЫ; mqtt_rpc(sn, "wbrules", "Editor", "List", params={}); mqtt_rpc(sn, "wbrules", "Editor", "Load", params={path: "имя.js"}).',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            driver: { type: 'string', description: 'Имя RPC-драйвера: wb-mqtt-serial, confed, db_logger, wb-device-manager, wbrules.' },
            service: { type: 'string', description: 'Имя сервиса (device, config, Editor, history и т.д.)' },
            method: { type: 'string', description: 'Имя метода (LoadConfig, Load, Save, Start и т.д.)' },
            params: { type: 'object', description: 'Параметры вызова. Для пустых параметров — {}.' },
            timeoutSec: { type: 'integer', minimum: 1, maximum: 30, description: 'Таймаут ожидания ответа (по умолч. 5с).' },
          },
          required: ['sn', 'driver', 'service', 'method', 'params'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mqtt_list_topics',
        description: 'Перечислить MQTT-топики на контроллере. По умолчанию — все, можно ограничить prefix-ом (например "/devices/wb-gpio/#"). Поддерживает пагинацию: limit (дефолт 200) и offset. Если has_more=true — запроси следующую страницу с next_offset.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            prefix: { type: 'string', description: 'MQTT-фильтр, дефолт "#".' },
            timeoutSec: { type: 'integer', minimum: 1, maximum: 10 },
            limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Макс. топиков на страницу (дефолт 200).' },
            offset: { type: 'integer', minimum: 0, description: 'Пропустить N топиков (для пагинации, дефолт 0).' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ssh_exec_async',
        description: 'Запустить shell-команду на контроллере в фоне как transient systemd-unit. Возвращает {jobId, startedAt} мгновенно, SSH-соединение не держит. Команда переживает обрыв связи и продолжает работу под systemd. Используй для операций дольше пары минут: apt update/upgrade, wb-release -t testing, FIT-обновление, полный бэкап с tar, длинные bus-сканы. HITL как у ssh_exec: опасные команды — сначала подтверждение пользователя. После запуска проверяй прогресс через job_status/job_tail; не спамь polling-ом — достаточно раз в 10-30 сек.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            command: { type: 'string' },
            label: { type: 'string', description: 'Короткая метка для человека.' },
          },
          required: ['sn', 'command'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'job_status',
        description: 'Состояние фоновой задачи из ssh_exec_async: running / exited (+ exitCode), сколько идёт, сколько строк в логе, команда, label.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            jobId: { type: 'string', description: '8-символьный hex id из ssh_exec_async.' },
          },
          required: ['sn', 'jobId'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'job_tail',
        description: 'Последние строки лога фоновой задачи (stdout+stderr склеены). Инкрементально: в ответе nextFromLine — с какой строки запрашивать дальше.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            jobId: { type: 'string' },
            fromLine: { type: 'integer', minimum: 1, description: 'С какой строки читать (1-based). Дефолт 1.' },
            maxLines: { type: 'integer', minimum: 1, maximum: 1000, description: 'Сколько строк максимум вернуть. Дефолт 100.' },
          },
          required: ['sn', 'jobId'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'job_cancel',
        description: 'Прервать фоновую задачу: SIGTERM → SIGKILL. HITL: подтверди у пользователя перед прерыванием.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            jobId: { type: 'string' },
          },
          required: ['sn', 'jobId'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'job_list',
        description: 'Все фоновые задачи на контроллере, запущенные через ssh_exec_async: running и недавние exited (TTL 24ч).',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'serial_debug_collect',
        description: 'Собирает debug-лог wb-mqtt-serial с raw-пакетами за указанное время. Вызывай сразу при диагностике serial-ошибок.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            durationSec: { type: 'integer', minimum: 10, maximum: 300, description: 'Сколько секунд собирать debug-данные. По умолчанию 30.' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wb_bus_scan',
        description: 'Сканирование шины Fast Modbus — находит устройства Wiren Board и Onokom. Если port не указан — автоматически обнаружит все RS-485 порты. Быстрое сканирование занимает около 40 секунд.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            port: { type: 'string', description: 'Путь к порту, например "/dev/ttyRS485-1".' },
            baud_rate: { type: 'integer', description: 'Скорость, по умолчанию перебирает 115200 и 9600.' },
            data_bits: { type: 'integer', description: 'Биты данных, по умолчанию 8.' },
            parity: { type: 'string', description: '"N", "E" или "O". По умолчанию "N".' },
            stop_bits: { type: 'integer', description: '1 или 2. По умолчанию 2.' },
            scan_type: { type: 'string', enum: ['extended', 'standard'], description: '"extended" — Fast Modbus (по умолчанию). "standard" — обычный Modbus.' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wb_add_devices',
        description: 'Добавляет найденные сканером (wb_bus_scan) устройства в конфигурацию wb-mqtt-serial. Вызывай ПОСЛЕ wb_bus_scan. Требует подтверждения (HITL).',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'modbus_templates_list',
        description: 'Список доступных Modbus-шаблонов wb-mqtt-serial через RPC `wb-mqtt-serial/config/Load.types`. Без `filter` — сводка по группам {group: {count, deprecated}}, чтобы не переполнить контекст (на типичной прошивке 250+ шаблонов). С `filter` (подстрока, case-insensitive по type/mqtt-id/name) — плоский список matched.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            filter: { type: 'string', description: 'Подстрока для фильтрации (например "wb-mr6c", "dimmer", "MAI"). Регистронезависимо.' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'modbus_device_info',
        description: 'Прошивочные параметры конкретного Modbus-устройства: версия fw, model-строка, текущие значения всех parameters (debounce, modes, mappings и т.п.). RPC `wb-mqtt-serial/device/LoadConfig`. Это НЕ список каналов — для каналов и шаблона используй `modbus_template`. Два режима: (1) по `device_id` (имя в MQTT, например "wb-mr6c_138") — самый простой; (2) по явным `path` + `slave_id` (опционально с device_type/baud_rate/parity/data_bits/stop_bits) — для устройств не в конфиге.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            device_id: { type: 'string', description: 'Имя устройства в MQTT (wb-mr6c_138). Альтернатива path+slave_id.' },
            path: { type: 'string', description: 'Порт (/dev/ttyRS485-1) — если без device_id.' },
            slave_id: { type: 'number', description: 'Modbus slave-id — если без device_id.' },
            device_type: { type: 'string', description: 'Опционально: тип устройства из шаблонов (для устройств не в конфиге).' },
            baud_rate: { type: 'number' },
            parity: { type: 'string' },
            data_bits: { type: 'number' },
            stop_bits: { type: 'number' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'modbus_probe',
        description: 'Быстрый ping одного Modbus-устройства по slave_id на указанном порту. Не трогает конфиг wb-mqtt-serial — точечная проверка «оно вообще отвечает?». RPC `wb-mqtt-serial/device/Probe`. Полезно когда `wb_bus_scan` пропустил устройство (известный кейс с WB-MAP6S — сканер видит не всех, Probe видит).',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            path: { type: 'string', description: 'Порт (/dev/ttyRS485-1).' },
            slave_id: { type: 'number', description: 'Modbus slave-id.' },
            baud_rate: { type: 'number', description: 'Baud, по умолчанию 9600.' },
            parity: { type: 'string', description: 'Parity, по умолчанию "N".' },
            data_bits: { type: 'number', description: 'Data bits, по умолчанию 8.' },
            stop_bits: { type: 'number', description: 'Stop bits, по умолчанию 2.' },
          },
          required: ['sn', 'path', 'slave_id'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'modbus_ports',
        description: 'Параметры всех настроенных RS-485 портов wb-mqtt-serial: путь, baud_rate, parity, stop_bits, data_bits, тайм-ауты, enabled-флаг. RPC `wb-mqtt-serial/ports/Load`. Возвращает только АКТИВНЫЕ порты из конфига (не все `/dev/ttyRS485-*` существующие физически).',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'modbus_template',
        description: 'Содержимое одного Modbus-шаблона: каналы, параметры, группы. Резолвит `device_type` (например "WB-MR6C") в `mqtt-id` через RPC config/Load.types и читает `/usr/share/wb-mqtt-serial/templates/config-<mqtt-id>.json`. Views: `summary` (default — компактный список каналов с reg_type/address/format/type/units), `full` (весь шаблон), `channels-only` (только каналы), `meta-only` (без каналов и параметров — только заголовки). Опционально фильтрует каналы (`enabledOnly`, `channelFilter`).',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            device_type: { type: 'string', description: 'Тип устройства как в Load.types[].types[].type (например "WB-MR6C"). Альтернатива — mqtt_id.' },
            mqtt_id: { type: 'string', description: 'mqtt-id шаблона (например "wb-mr6c"). Если задан — резолв пропускается, читается файл config-<mqtt_id>.json напрямую.' },
            view: { type: 'string', enum: ['summary', 'full', 'channels-only', 'meta-only'], description: 'Представление. По умолчанию summary.' },
            enabledOnly: { type: 'boolean', description: 'Только enabled-каналы (default false).' },
            channelFilter: { type: 'string', description: 'Подстрока в имени канала (case-insensitive).' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_history',
        description: 'Получить историю значений MQTT-каналов из wb-mqtt-db. Возвращает массив точек {v, t}, статистику (min/max/avg), units и precision. Используй period вместо from/to.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            channels: {
              type: 'array',
              description: 'Каналы для запроса. Каждый элемент — пара [device_id, control_name].',
              items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
              minItems: 1,
            },
            period: { type: 'string', description: 'Период: число + единица (m/h/d/w/y). Примеры: "2h", "30m", "3d".' },
            from: { type: 'number', description: 'Начало диапазона (unix timestamp, секунды).' },
            to: { type: 'number', description: 'Конец диапазона (unix timestamp, секунды).' },
          },
          required: ['sn', 'channels'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_history_chart',
        description:
          'Построить график истории MQTT-каналов и сохранить как вложение (SVG). ' +
          'Использует wb-mqtt-db через RPC db_logger/history/get_values, рендерит через vega-lite. ' +
          'По умолчанию строит линейный график (chart_type=line). Меняй chart_type когда пользователь просит конкретный вид: ' +
          '«гистограмма» → histogram (распределение значений), «глазковая/тепловая карта/плотность» → heatmap, ' +
          '«ящики/разброс по дням» → boxplot, «столбики/события» → bar, «область/заливка» → area, «точки/выбросы» → point. ' +
          'Поддерживает несколько серий на одном графике, twin Y-axis при разных единицах.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            channels: {
              type: 'array',
              description: 'Каналы для графика. Каждый элемент — пара [device_id, control_name].',
              items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
              minItems: 1,
            },
            period: { type: 'string', description: 'Период: число + единица (m/h/d/w/y). Примеры: "2h", "30m", "3d", "1y".' },
            from: { type: 'number', description: 'Начало диапазона (unix timestamp, секунды). Используй только если period не подходит.' },
            to: { type: 'number', description: 'Конец диапазона (unix timestamp, секунды). По умолчанию — сейчас.' },
            title: { type: 'string', description: 'Заголовок графика (например: "CPU Temperature за сутки").' },
            ylabel: { type: 'string', description: 'Подпись оси Y (обычно — единица измерения, например "°C").' },
            chart_type: {
              type: 'string',
              enum: ['line', 'bar', 'area', 'point', 'histogram', 'heatmap', 'boxplot'],
              description:
                'Тип графика. line — обычный время-ряд (default). bar — столбики (для дискретных событий). area — заливка под линией. ' +
                'point — скаттер (выбросы). histogram — распределение значений (по бинам). ' +
                'heatmap — плотность во времени (рисует «глазковую» — видно типовой уровень и выбросы). ' +
                'boxplot — ящики с усами по периодам (час/день).',
            },
          },
          required: ['sn', 'channels'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_history_table',
        description: 'Выгрузить историю MQTT-каналов в CSV. Возвращает CSV строкой. Используй когда пользователь хочет "сохранить", "выгрузить", "скинуть в Excel".',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            channels: {
              type: 'array',
              description: 'Каналы для таблицы. Каждый элемент — пара [device_id, control_name].',
              items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
              minItems: 1,
            },
            period: { type: 'string', description: 'Период: число + единица (m/h/d/w/y).' },
            from: { type: 'number', description: 'Начало диапазона (unix timestamp).' },
            to: { type: 'number', description: 'Конец диапазона (unix timestamp).' },
            limit: { type: 'number', description: 'Максимум точек на канал. По умолчанию 10000.' },
            min_interval: { type: 'number', description: 'Минимальный интервал между точками в секундах. 0 — все точки.' },
          },
          required: ['sn', 'channels'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_hardware_config',
        description: 'Загрузить конфигурацию аппаратных модулей расширения контроллера (/etc/wb-hardware.conf) через confed RPC.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'save_hardware_config',
        description: 'Установить модуль в слот контроллера и сохранить конфигурацию (/etc/wb-hardware.conf).',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            slot_id: { type: 'string', description: 'Идентификатор слота из get_hardware_config (например: "mod1", "extio3").' },
            module: { type: 'string', description: 'Идентификатор модуля. Пустая строка — убрать модуль из слота.' },
            options: { type: 'object', description: 'Настройки модуля (опционально).' },
          },
          required: ['sn', 'slot_id', 'module'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'audit_controller',
        description: 'Собрать текущее состояние контроллера: список manual-пакетов, enabled-сервисы, кастомные unit-файлы, cron, файлы в /opt и /usr/local, изменённые системные конфиги.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'save_state_for_diff',
        description: 'Сохранить JSON-слепок текущего состояния контроллера в /mnt/data/ai/wb-ai-helper/snapshots/. Используется в паре с diff_snapshot.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
          },
          required: ['sn'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'diff_snapshot',
        description: 'Сравнить текущее состояние контроллера со слепком от save_state_for_diff и вернуть, что прибавилось/убавилось.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            beforePath: { type: 'string', description: 'Абсолютный путь к JSON-слепку на контроллере.' },
          },
          required: ['sn', 'beforePath'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Прочитать файл с контроллера (до 64KB). Удобно для конфигов в /etc/wb-* или /mnt/data.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            path: { type: 'string', description: 'Абсолютный путь к файлу.' },
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
        name: 'fetch_from_controller',
        description: 'Скачать файл с контроллера (через SFTP) и положить в вложения текущей сессии чата. Пользователь увидит его в UI как чип с кнопкой скачать. Используй для выгрузки готового бэкапа, архива конфигов, лога — всего, что пользователь хочет получить себе. Лимит 20MB; для больших файлов сначала сожми (tar czf) или раздели. Имя файла по умолчанию берётся из пути; при нужде переопредели параметром name.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            path: { type: 'string', description: 'Абсолютный путь к файлу на контроллере.' },
            name: { type: 'string', description: 'Имя файла для сохранения (опционально, по умолчанию basename пути).' },
          },
          required: ['sn', 'path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'upload_to_controller',
        description: 'Записать вложение сессии (файл, который пользователь загрузил в чат) на контроллер в произвольный путь через SFTP. HITL: перед вызовом покажи пользователю, какой файл → в какой путь пойдёт, дождись подтверждения. Не перезаписывай критичные системные пути — избегай /etc/shadow, /etc/passwd, /etc/systemd/system/*.service без явной просьбы.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            fileId: { type: 'string', description: 'ID вложения из list_attachments.' },
            path: { type: 'string', description: 'Абсолютный путь на контроллере для сохранения файла.' },
          },
          required: ['sn', 'fileId', 'path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_attachments',
        description: 'Список файлов, прикреплённых пользователем к текущей сессии чата. Актуальный перечень также показан в системном сообщении перед каждым ходом — обычно отдельно звать не нужно; вызывай, если по ходу диалога нужно свериться с id/размерами.',
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
        description: 'Список всех wb-rules скриптов с состоянием enabled/disabled и привязанными правилами. Обёртка над wbrules/Editor/List — не нужно знать RPC-синтаксис.',
        parameters: { type: 'object', properties: { sn: { type: 'string', description: 'Серийный номер контроллера.' } }, required: ['sn'], additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'load_rule',
        description: 'Прочитать содержимое файла правила wb-rules. Имя — без пути и без расширения (например "wb-la-temp-relay"); .js добавится автоматически.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            name: { type: 'string', description: 'Имя файла правила без расширения (например "wb-la-temp-relay").' },
          },
          required: ['sn', 'name'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'save_rule',
        description: 'Создать или обновить файл правила wb-rules. Имя — без пути и без расширения. RPC валидирует JS и перезагружает движок атомарно. Используй вместо ручного mqtt_rpc("wbrules","Editor","Save").',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            name: { type: 'string', description: 'Имя файла без расширения (например "my-rule").' },
            content: { type: 'string', description: 'Полный JS-код файла. ES5 (без let/const/arrow).' },
          },
          required: ['sn', 'name', 'content'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_rule',
        description: 'Удалить файл правила wb-rules. Сначала пробует wbrules/Editor/Remove; если демон отвечает "File not found" (рассинхрон кэша) — делает rm + reload-or-restart wb-rules через SSH. Требует явного подтверждения пользователя.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            name: { type: 'string', description: 'Имя файла без расширения.' },
          },
          required: ['sn', 'name'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'disable_rule',
        description: 'Отключить правило wb-rules через RPC `wbrules/Editor/ChangeState` (под капотом — переименование `<name>.js` → `<name>.js.disabled`). В отличие от `delete_rule` обратимо: чтобы включить обратно, удали суффикс `.disabled` (через write_file/ssh_exec) и вызови reload. На стабильных прошивках обратный `enabled:true` через тот же RPC возвращает `result:false` — это ограничение wb-rules engine, не нашей обёртки. Менее агрессивный путь, чем delete: подходит, чтобы временно вырубить правило для отладки. HITL: уточни у пользователя, действительно ли надо выключить.',
        parameters: {
          type: 'object',
          properties: {
            sn: { type: 'string', description: 'Серийный номер контроллера.' },
            name: { type: 'string', description: 'Имя файла правила без расширения.' },
          },
          required: ['sn', 'name'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_attachment',
        description: 'Прочитать содержимое файла, прикреплённого к сессии (до ~200KB). fileId — из list_attachments или системного сообщения про файлы. encoding="utf8" для текстовых (конфиги, логи, json); "base64" для бинарных (архивы, картинки — если нужно передать дальше).',
        parameters: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'ID вложения из list_attachments.' },
            encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Кодировка: utf8 (по умолчанию) или base64.' },
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
        description: 'Показать листинг файлов внутри архива, прикреплённого к чату. Поддерживаются zip, tar, tar.gz/tgz (формат определяется автоматически по magic-bytes). Возвращает массив записей {path, size, isDir}. Используй чтобы понять что внутри прежде чем извлекать.',
        parameters: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'ID архива из list_attachments.' },
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
        description: 'Прочитать один файл из архива (zip / tar / tar.gz / tgz) по path. encoding="utf8" для текста, "base64" для бинарного. Лимит ~200KB на файл — для больших используй extract_archive.',
        parameters: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'ID архива.' },
            path: { type: 'string', description: 'Путь файла внутри архива (как из list_archive_contents).' },
            encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Кодировка: utf8 (по умолчанию) или base64.' },
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
        description: 'Извлечь файлы из архива (zip / tar / tar.gz / tgz) в attachments чата как отдельные файлы — каждый получает свой fileId, доступный для read_attachment / upload_to_controller. Параметр paths — массив конкретных путей для извлечения; если не задан или пуст — извлекается весь архив. Возвращает массив {path, fileId, name, size, mime}.',
        parameters: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'ID архива.' },
            paths: { type: 'array', items: { type: 'string' }, description: 'Опционально: подмножество путей для извлечения. Если не указано — извлекается всё.' },
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
  /** SNs выбранные в текущем чате; если пусто — операции на массиве требуют явного sn. */
  contextSns: string[]
  db: DbHandle
  sessionId: string
  agentState: { checkpointSummary?: string }
  braveApiKey?: string
}

/** Унифицированная запись о файле в архиве: путь, размер, флаг директории
 * и raw-данные (загружаются по требованию). */
export type ArchiveEntry = { path: string; size: number; isDir: boolean; data: () => Promise<Buffer> }

/** Открывает архив (zip / tar / tar.gz / tgz) и возвращает список записей.
 * Автодетект по magic-bytes: ZIP — `PK\x03\x04`, gzip — `1f 8b`, иначе пробуем
 * как plain tar. */
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
  // gzip — распаковываем и обрабатываем как tar
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

    case 'mqtt_inventory': {
      const c = resolve1(args['sn'], ctx)
      const filter = typeof args['device'] === 'string' ? (args['device'] as string) : undefined
      const timeoutSec = typeof args['timeout'] === 'number' ? Math.max(1, Math.min(15, args['timeout'] as number)) : 3
      const includeEmpty = args['includeEmpty'] === true
      const includeMeta = args['includeMeta'] === true
      const topics = await ctx.mqtt.listTopics(c, '/devices/#', timeoutSec * 1000)
      const inv = buildInventory(topics.entries(), { filter, includeEmpty, includeMeta })
      return JSON.stringify(inv, null, 2)
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
      const targets = resolveTargets(args['sn'], ctx)
      const command = String(args['command'] ?? '')
      const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : undefined
      if (!command) return JSON.stringify({ error: 'command required' })
      const blocked = isDestructiveCommand(command)
      if (blocked) return JSON.stringify({ error: blocked })
      if (isDockerComposeCommand(command)) {
        return JSON.stringify({ error: 'docker-compose устарел. Используй «docker compose» (без дефиса).' })
      }
      if (/\bapt(-get)?\s+(update|install|remove|purge|upgrade|dist-upgrade|full-upgrade)\b/.test(command) ||
          /\bwb-release\s+(-\w+\s+)*-t\b/.test(command) ||
          /\bdocker\s+(run|pull|build|compose)\b/.test(command)) {
        return JSON.stringify({ error: `Команда "${command}" может выполняться долго. Используй ssh_exec_async вместо ssh_exec.` })
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
      // Hint когда модель спрашивает «есть ли обновления» через `apt list
      // --upgradable` без предварительного `apt-get update` — список будет
      // устаревший. Загрузить controller-update скилл — он покрывает сценарий.
      const isStaleAptCheck = /\bapt(?:-get)?\s+list\s+--upgradable\b/.test(command)
        || /\bapt-cache\s+(?:show|search|policy)\b/.test(command)
      const cleanedStderr = (s: string) =>
        // apt при вызове из скрипта печатает «WARNING: apt does not have
        // a stable CLI interface...» — известный шум, в нём нет полезной
        // для модели информации, фильтруем чтобы не засорять контекст.
        s.replace(/^WARNING: apt does not have a stable CLI interface\..*$/gm, '').trim()
      if (results.length === 1) {
        const r = results[0]!
        if (r.error) return `[${r.sn}] error: ${r.error}`
        const parts: string[] = []
        if (r.stdout) parts.push(r.stdout)
        const stderr = cleanedStderr(r.stderr)
        if (stderr) parts.push(`[stderr]\n${stderr}`)
        if (r.truncated) parts.push('[вывод обрезан]')
        parts.push(`[exit: ${r.code}]`)
        if (isStaleAptCheck && r.code === 0) {
          parts.push('[hint] Локальный кэш apt мог устареть. Перед итоговым ответом «есть/нет обновления» запусти `apt-get update -qq` через ssh_exec_async, потом повтори этот запрос. Для развёрнутых сценариев — load_skill("controller-update").')
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
        if (r.truncated) parts.push('[вывод обрезан]')
        parts.push(`[exit: ${r.code}]`)
        if (isStaleAptCheck && r.code === 0) {
          parts.push('[hint] Локальный кэш apt мог устареть. Перед итоговым ответом запусти `apt-get update -qq` через ssh_exec_async, потом повтори этот запрос.')
        }
        return parts.join('\n')
      }).join('\n---\n')
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
      const priority = args['priority'] ? String(args['priority']) : undefined
      const c = ctx.discovery.get(sn) ?? ctx.discovery.getOrCreate(sn) ?? adHocController(sn)
      if (!c) return notFound(sn)
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
      // Авто-выгрузка всех загруженных скиллов: если модель сделала
      // checkpoint — этап завершён, скиллы для следующей фазы скорее всего
      // другие. Если они всё ещё нужны — модель сама перезагрузит. Иначе
      // их content продолжал бы инжектиться в каждый turn и засорять контекст.
      const loaded = getLoadedSkills(ctx.sessionId)
      const unloadedNames: string[] = []
      for (const s of loaded) {
        if (unloadSkillFromSession(ctx.sessionId, s.name)) unloadedNames.push(s.name)
      }
      const unloadedPart = unloadedNames.length
        ? ` Авто-выгружены скиллы: ${unloadedNames.join(', ')} — если они нужны для следующей фазы, перезагрузи через load_skill.`
        : ''
      return JSON.stringify({ ok: true, message: `Чекпоинт принят. Контекст будет сжат после этого хода.${unloadedPart}` })
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

    case 'get_controller': {
      const c = resolve1(args['sn'], ctx)
      return JSON.stringify(await ctx.ssh.getInfo(c), null, 2)
    }

    case 'get_metrics': {
      const c = resolve1(args['sn'], ctx)
      return JSON.stringify(await ctx.ssh.getMetrics(c), null, 2)
    }

    case 'failed_units': {
      const c = resolve1(args['sn'], ctx)
      const r = await ctx.ssh.exec(c, 'systemctl --failed --no-pager', 10000)
      return JSON.stringify({ output: r.stdout.trim() }, null, 2)
    }

    case 'systemd_unit': {
      const c = resolve1(args['sn'], ctx)
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
      const c = resolve1(args['sn'], ctx)
      // Whitelist hostname/IP-символы перед склейкой в shell. Защита поверх
      // shellQuote: даже если кто-то по ошибке передаст `; rm -rf …` в
      // pingTarget, regex обнулит всё лишнее. Допускаем точку, двоеточие
      // (IPv6), дефис, подчёркивание (DNS) и буквы/цифры.
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
      const c = resolve1(args['sn'], ctx)
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
        // `system__wb-cloud-agent__+` невалидный wildcard для mosquitto (+ должен
        // занимать целый level). Берём все /devices/+/controls/+ и фильтруем
        // на стороне TS — иначе mosquitto_sub возвращает ошибку.
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
      const c = resolve1(args['sn'], ctx)
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
            'web_search недоступен: не задан BRAVE_SEARCH_API_KEY. ' +
            'Используй web_fetch напрямую: web_fetch("https://wirenboard.com/wiki/Special:Search?search=...") для поиска по вики.'
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
          return JSON.stringify({ error: `web_search ошибка: ${data.error.detail}. Используй web_fetch напрямую.` })
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
              `Поиск «${query}» не дал результатов. ` +
              'НЕ повторяй поиск с другой формулировкой. ' +
              'Используй web_fetch напрямую: web_fetch("https://wirenboard.com/wiki/Special:Search?search=...") или web_fetch("https://wirenboard.com/wiki/<Модель>").'
          })
        }
        return JSON.stringify({ query, count: results.length, results }, null, 2)
      } catch (e) {
        console.error(`[web_search] error:`, e)
        return JSON.stringify({ error: `web_search не смог подключиться: ${e instanceof Error ? e.message : String(e)}. Используй web_fetch напрямую.` })
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
          `\n…[обрезано: показано ${WEB_FETCH_MAX} из ${text.length} символов]`
        : text
      return JSON.stringify({ url, status: res.status, contentType: ct, body: truncated }, null, 2)
    }

    case 'mqtt_rpc': {
      const c = resolve1(args['sn'], ctx)
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
      const c = resolve1(args['sn'], ctx)
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
      const c = resolve1(args['sn'], ctx)
      let command = String(args['command'] ?? '')
      const label = typeof args['label'] === 'string' ? args['label'] : undefined
      if (!command.trim()) return JSON.stringify({ error: 'ssh_exec_async: пустая команда' })
      const blocked = isDestructiveCommand(command)
      if (blocked) return JSON.stringify({ error: blocked })
      if (isDockerComposeCommand(command)) {
        return JSON.stringify({ error: 'docker-compose устарел. Используй «docker compose» (без дефиса).' })
      }
      const running = getRunningJobForSn(c.sn)
      if (running) {
        return JSON.stringify({ error: `На контроллере ${c.sn} уже выполняется фоновая задача: "${running.label}" (jobId=${running.jobId}). Дождись её завершения или отмени через job_cancel (с подтверждением пользователя — прерывание apt/wb-release может сломать систему).` })
      }
      // Auto-нормализация apt: DEBIAN_FRONTEND=noninteractive + -y. Подробности
      // и причина — в src/server/apt-defaults.ts.
      command = normalizeAptCommand(command)
      const r = await ctx.ssh.jobStart(c, command, label)
      console.log(`[ssh_exec_async] jobId=${r.jobId}, sn=${c.sn}, session=${ctx.sessionId}`)
      if (r.jobId) {
        trackJob(ctx.sessionId, r.jobId, c.sn, label ?? command.slice(0, 60))
      }
      return JSON.stringify(r, null, 2)
    }

    case 'job_status': {
      const c = resolve1(args['sn'], ctx)
      const jobId = String(args['jobId'] ?? '')
      const result = await ctx.ssh.jobStatus(c, jobId)
      const state = result['state'] as 'running' | 'exited' | 'unknown'
      if (state === 'exited' || state === 'running') updateJobState(jobId, state)
      return JSON.stringify(result, null, 2)
    }

    case 'job_tail': {
      const c = resolve1(args['sn'], ctx)
      const jobId = String(args['jobId'] ?? '')
      const fromLine = typeof args['fromLine'] === 'number' ? args['fromLine'] : 1
      const maxLines = typeof args['maxLines'] === 'number' ? args['maxLines'] : 500
      const tail = await ctx.ssh.jobTail(c, jobId, fromLine, maxLines)
      const raw = (tail['lines'] as string[]).join('\n')
      const truncatedLog = truncateLog(raw)
      return JSON.stringify({ ...tail, lines: truncatedLog.split('\n'), _truncated: raw.length !== truncatedLog.length }, null, 2)
    }

    case 'job_cancel': {
      const c = resolve1(args['sn'], ctx)
      const jobId = String(args['jobId'] ?? '')
      await ctx.ssh.jobCancel(c, jobId)
      return JSON.stringify({ cancelled: jobId }, null, 2)
    }

    case 'job_list': {
      const c = resolve1(args['sn'], ctx)
      return JSON.stringify(await ctx.ssh.jobList(c), null, 2)
    }

    case 'serial_debug_collect': {
      const c = resolve1(args['sn'], ctx)
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
      const c = resolve1(args['sn'], ctx)
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

      return JSON.stringify({ jobId, ports, configs, scanType, note: `Сканирование ${ports.length} порт(ов) × ${configs.length} скорост(ей) займёт около 40 секунд. Скажи об этом пользователю.` }, null, 2)
    }

    case 'wb_add_devices': {
      const c = resolve1(args['sn'], ctx)

      // 1. Read scan results from /wb-device-manager/state
      const stateRaw = await ctx.mqtt.readTopic(c, '/wb-device-manager/state')
      if (!stateRaw) return JSON.stringify({ error: 'Нет данных сканирования. Сначала выполни wb_bus_scan.' })
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
      if (scannedDevices.length === 0) return JSON.stringify({ error: 'Скан не нашёл устройств. Сначала выполни wb_bus_scan.' })

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
          skipped.push(`${dev.title} slave=${dev.cfg.slave_id}: порт ${portPath} не в конфиге`)
          continue
        }

        // Check if already configured
        const ids = configuredIds.get(portPath) ?? new Set()
        if (ids.has(dev.cfg.slave_id)) {
          skipped.push(`${dev.title} slave=${dev.cfg.slave_id}: уже в конфиге`)
          continue
        }

        // Resolve device_type
        const tmpl = templateMap[dev.device_signature]
        if (!tmpl) {
          skipped.push(`${dev.title} slave=${dev.cfg.slave_id}: шаблон для ${dev.device_signature} не найден`)
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
        return JSON.stringify({ added: [], skipped, errors: setupErrors, message: 'Нечего добавлять — все устройства уже в конфиге или пропущены.' }, null, 2)
      }

      // 6. Save config via confed/Editor/Save
      try {
        await ctx.ssh.mqttRpc(c, 'confed', 'Editor', 'Save', {
          path: '/etc/wb-mqtt-serial.conf',
          content: config
        }, 15)
      } catch (e) {
        return JSON.stringify({ error: `Ошибка сохранения конфига: ${e instanceof Error ? e.message : String(e)}` })
      }

      return JSON.stringify({ added, skipped, errors: setupErrors, message: `Добавлено ${added.length} устройств. wb-mqtt-serial перезапущен.` }, null, 2)
    }

    case 'modbus_device_info': {
      const c = resolve1(args['sn'], ctx)
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
        return JSON.stringify({ error: 'Нужен либо device_id (имя в MQTT, например wb-mr6c_138), либо явные path + slave_id.' })
      }
      try {
        const r = await ctx.ssh.mqttRpc(c, 'wb-mqtt-serial', 'device', 'LoadConfig', params, 10)
        return JSON.stringify(r, null, 2)
      } catch (e: unknown) {
        return JSON.stringify({ error: enrichSerialRpcError(e, 'LoadConfig') })
      }
    }

    case 'modbus_probe': {
      const c = resolve1(args['sn'], ctx)
      const path = typeof args['path'] === 'string' ? (args['path'] as string) : ''
      const slave_id = typeof args['slave_id'] === 'number' ? (args['slave_id'] as number) : NaN
      if (!path || Number.isNaN(slave_id)) {
        return JSON.stringify({ error: 'path и slave_id обязательны.' })
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
      const c = resolve1(args['sn'], ctx)
      const r = await ctx.ssh.mqttRpc(c, 'wb-mqtt-serial', 'ports', 'Load', {}, 5)
      return JSON.stringify(r, null, 2)
    }

    case 'modbus_templates_list': {
      const c = resolve1(args['sn'], ctx)
      const filter = typeof args['filter'] === 'string' ? (args['filter'] as string) : ''
      const result = await ctx.ssh.mqttRpc(c, 'wb-mqtt-serial', 'config', 'Load', {}, 10) as { types?: unknown }
      const list = parseTemplatesList({ types: (result.types as any) ?? [] })
      if (filter.trim()) {
        const matched = filterTemplates(list, filter)
        return JSON.stringify({ filter, count: matched.length, templates: matched }, null, 2)
      }
      const groups = summarizeByGroup(list)
      return JSON.stringify({ totalCount: list.length, groups, hint: 'Без filter возвращается сводка по группам. Передай filter (подстрока) чтобы получить плоский список matched.' }, null, 2)
    }

    case 'modbus_template': {
      const c = resolve1(args['sn'], ctx)
      const deviceType = typeof args['device_type'] === 'string' ? (args['device_type'] as string).trim() : ''
      let mqttId = typeof args['mqtt_id'] === 'string' ? (args['mqtt_id'] as string).trim() : ''
      if (!deviceType && !mqttId) {
        return JSON.stringify({ error: 'Нужен device_type или mqtt_id.' })
      }
      // Резолв device_type → mqtt-id через Load.types если mqtt_id не задан.
      if (!mqttId) {
        const result = await ctx.ssh.mqttRpc(c, 'wb-mqtt-serial', 'config', 'Load', {}, 10) as { types?: unknown }
        const list = parseTemplatesList({ types: (result.types as any) ?? [] })
        const target = deviceType.toLowerCase()
        const match = list.find((t) => t.type.toLowerCase() === target || t.mqttId.toLowerCase() === target)
        if (!match) {
          // Подсказка с близкими: substring-фильтр
          const close = filterTemplates(list, deviceType).slice(0, 5).map((t) => t.type)
          return JSON.stringify({ error: `Шаблон не найден: ${deviceType}`, hint: close.length ? `Возможно вы имели в виду: ${close.join(', ')}` : 'Получи полный список через modbus_templates_list.' })
        }
        mqttId = match.mqttId
      }
      // Чтение файла шаблона. Стандартный путь wb-mqtt-serial.
      const filePath = `/usr/share/wb-mqtt-serial/templates/config-${mqttId}.json`
      let raw: string
      try {
        // 1 МБ — некоторые шаблоны (WB-MR6C, WB-MAP6S, WB-MCM8) больше 256КБ
        // из-за translations + многоканальной meta. Вычитаем заведомо больше,
        // чтобы не упереться в truncate'нутый JSON.
        raw = (await ctx.ssh.readFile(c, filePath, 1024 * 1024)).content
      } catch (e: unknown) {
        return JSON.stringify({ error: `Не удалось прочитать ${filePath}: ${e instanceof Error ? e.message : String(e)}. Возможно для этого устройства файл шаблона устаревшей структуры или с другим mqtt-id — посмотри modbus_templates_list.` })
      }
      let tmpl: Record<string, unknown>
      try {
        tmpl = JSON.parse(raw)
      } catch (e: unknown) {
        return JSON.stringify({ error: `Шаблон ${filePath} не парсится как JSON: ${e instanceof Error ? e.message : String(e)}` })
      }
      const view = (typeof args['view'] === 'string' ? args['view'] : 'summary') as 'summary' | 'full' | 'channels-only' | 'meta-only'
      const enabledOnly = args['enabledOnly'] === true
      const channelFilter = typeof args['channelFilter'] === 'string' ? (args['channelFilter'] as string) : undefined
      return JSON.stringify(renderTemplate(tmpl as any, { view, enabledOnly, channelFilter }), null, 2)
    }

    case 'get_history': {
      const c = resolve1(args['sn'], ctx)
      const channels = args['channels'] as [string, string][]
      if (!Array.isArray(channels) || channels.length === 0) return JSON.stringify({ error: 'channels обязателен' })
      const { from, to } = resolveTimeRange(args)
      if (!from) return JSON.stringify({ error: 'укажи period (например: 2h, 6h, 24h, 7d) или from (unix timestamp)' })
      const validationErr = await validateHistoryChannels(ctx, c, channels)
      if (validationErr) return JSON.stringify({ error: validationErr })
      const result = await fetchHistory(ctx, c, channels, from, to)
      return JSON.stringify(result, null, 2)
    }

    case 'get_history_chart': {
      const c = resolve1(args['sn'], ctx)
      const channels = args['channels'] as [string, string][]
      if (!Array.isArray(channels) || channels.length === 0) return JSON.stringify({ error: 'channels обязателен' })
      const { from, to } = resolveTimeRange(args)
      if (!from) return JSON.stringify({ error: 'укажи period (например: 2h, 6h, 24h, 7d) или from (unix timestamp)' })
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
          note: 'График сохранён как вложение SVG. Пользователь видит его в чате как картинку.',
        }, null, 2)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return JSON.stringify({ error: `Ошибка рендера графика: ${msg}` })
      }
    }

    case 'get_history_table': {
      const c = resolve1(args['sn'], ctx)
      const channels = args['channels'] as [string, string][]
      if (!Array.isArray(channels) || channels.length === 0) return JSON.stringify({ error: 'channels обязателен' })
      const { from, to } = resolveTimeRange(args)
      if (!from) return JSON.stringify({ error: 'укажи period (например: 2h, 6h, 24h, 7d) или from (unix timestamp)' })
      const validationErr = await validateHistoryChannels(ctx, c, channels)
      if (validationErr) return JSON.stringify({ error: validationErr })
      const limitOverride = typeof args['limit'] === 'number' ? Math.max(1, Math.min(100000, Number(args['limit']))) : 10000
      const minIntervalOverride = typeof args['min_interval'] === 'number' ? Math.max(0, Number(args['min_interval'])) : 0
      const histData = await fetchHistory(ctx, c, channels, from, to, { limitOverride, minIntervalOverride })
      const csv = historyToCsv(histData)
      const truncatedCsv = csv.length > 50000 ? csv.slice(0, 50000) + '\n... (обрезано)' : csv
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
      const c = resolve1(args['sn'], ctx)
      const result = await ctx.ssh.mqttRpc(c, 'confed', 'Editor', 'Load', { path: '/etc/wb-hardware.conf' }, 10)
      return JSON.stringify(result, null, 2)
    }

    case 'save_hardware_config': {
      const c = resolve1(args['sn'], ctx)
      const slotId = String(args['slot_id'] ?? '')
      const module = String(args['module'] ?? '')
      const options = (args['options'] && typeof args['options'] === 'object') ? args['options'] : {}
      if (!slotId) return JSON.stringify({ error: 'slot_id обязателен (например: "mod1", "extio3", "rs485-1")' })
      const loaded = await ctx.ssh.mqttRpc(c, 'confed', 'Editor', 'Load', { path: '/etc/wb-hardware.conf' }, 10) as { content?: { slots?: Array<{ id: string; module: string; options: unknown }> } }
      const content = loaded?.content
      if (!content || !Array.isArray(content.slots)) return JSON.stringify({ error: 'Не удалось загрузить текущий конфиг wb-hardware.conf' })
      const slot = content.slots.find((s) => s.id === slotId)
      if (!slot) return JSON.stringify({ error: `Слот "${slotId}" не найден. Доступные: ${content.slots.map((s) => s.id).join(', ')}` })
      const prevModule = slot.module
      slot.module = module
      slot.options = options
      const result = await ctx.ssh.mqttRpc(c, 'confed', 'Editor', 'Save', { path: '/etc/wb-hardware.conf', content }, 10)
      return JSON.stringify({ ...result as object, applied: { slot: slotId, from: prevModule, to: module } }, null, 2)
    }

    case 'audit_controller': {
      const c = resolve1(args['sn'], ctx)
      return JSON.stringify(await runAudit(ctx.ssh, c), null, 2)
    }

    case 'save_state_for_diff': {
      const c = resolve1(args['sn'], ctx)
      return JSON.stringify(await runSnapshot(ctx.ssh, c), null, 2)
    }

    case 'diff_snapshot': {
      const c = resolve1(args['sn'], ctx)
      const beforePath = String(args['beforePath'] ?? '')
      if (!beforePath.startsWith('/')) return JSON.stringify({ error: 'beforePath должен быть абсолютным путём' })
      return JSON.stringify(await runDiffSnapshot(ctx.ssh, c, beforePath), null, 2)
    }

    case 'read_file': {
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

    case 'fetch_from_controller': {
      const sn = String(args['sn'] ?? '')
      const path = String(args['path'] ?? '')
      const name = args['name'] ? String(args['name']).trim() : ''
      if (!path.startsWith('/')) return JSON.stringify({ error: 'path must be absolute' })
      const c = ctx.discovery.get(sn) ?? ctx.discovery.getOrCreate(sn) ?? adHocController(sn)
      if (!c) return notFound(sn)
      try {
        const buf = await ctx.ssh.downloadFile(c, path)
        const fileName = name || basename(path) || 'file'
        const r = saveAttachment(ctx.sessionId, fileName, buf, 'assistant')
        if (!r.ok) return JSON.stringify({ error: r.error })
        return JSON.stringify({ fileId: r.meta.id, fileName: r.meta.name, mime: r.meta.mime, size: r.meta.size, note: 'Файл сохранён как вложение. Пользователь видит его в UI и может скачать.' })
      } catch (e: any) {
        return JSON.stringify({ error: e?.message ?? String(e) })
      }
    }

    case 'upload_to_controller': {
      const sn = String(args['sn'] ?? '')
      const fileId = String(args['fileId'] ?? '').trim()
      const path = String(args['path'] ?? '')
      if (!path.startsWith('/')) return JSON.stringify({ error: 'path must be absolute' })
      const c = ctx.discovery.get(sn) ?? ctx.discovery.getOrCreate(sn) ?? adHocController(sn)
      if (!c) return notFound(sn)
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
      const c = resolve1(args['sn'], ctx)
      const r = await ctx.ssh.mqttRpc(c, 'wbrules', 'Editor', 'List', {}, 10)
      return JSON.stringify(r, null, 2)
    }

    case 'load_rule': {
      const c = resolve1(args['sn'], ctx)
      const name = ruleNameToPath(args['name'])
      if (!name) return JSON.stringify({ error: 'name обязателен' })
      const r = await ctx.ssh.mqttRpc(c, 'wbrules', 'Editor', 'Load', { path: name }, 10)
      return JSON.stringify(r, null, 2)
    }

    case 'save_rule': {
      const c = resolve1(args['sn'], ctx)
      const name = ruleNameToPath(args['name'])
      const content = String(args['content'] ?? '')
      if (!name) return JSON.stringify({ error: 'name обязателен' })
      if (!content) return JSON.stringify({ error: 'content обязателен' })
      try {
        const r = await ctx.ssh.mqttRpc(c, 'wbrules', 'Editor', 'Save', { path: name, content }, 15)
        return JSON.stringify({ ok: true, ...((r && typeof r === 'object') ? r : {}) }, null, 2)
      } catch (e: unknown) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
      }
    }

    case 'delete_rule': {
      const c = resolve1(args['sn'], ctx)
      const name = ruleNameToPath(args['name'])
      if (!name) return JSON.stringify({ error: 'name обязателен' })
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
          if (r.code === 0) return JSON.stringify({ ok: true, via: 'ssh_rm', name, note: 'Editor.Remove ответил File not found, удалил через rm + reload-or-restart wb-rules.' }, null, 2)
          return JSON.stringify({ error: `rm fallback failed: ${r.stderr.trim() || `exit ${r.code}`}` })
        }
        return JSON.stringify({ error: msg })
      }
    }

    case 'disable_rule': {
      const c = resolve1(args['sn'], ctx)
      const name = ruleNameToPath(args['name'])
      if (!name) return JSON.stringify({ error: 'name обязателен' })
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
            note: 'Файл переименован в <name>.js.disabled. Чтобы включить обратно — на стабильных прошивках обратный enabled:true через тот же RPC возвращает result:false; убери суффикс .disabled через write_file/ssh_exec и сделай reload-or-restart wb-rules.',
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
        return JSON.stringify({ error: `Не удалось прочитать архив (поддерживаются zip, tar, tar.gz/tgz): ${e?.message ?? String(e)}` })
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
        if (!entry) return JSON.stringify({ error: `«${innerPath}» в архиве не найден` })
        const data = await entry.data()
        const MAX_READ = 200 * 1024
        if (data.length > MAX_READ) return JSON.stringify({ error: `file too large for context (${data.length} bytes, limit ${MAX_READ}). Используй extract_archive чтобы вытащить как отдельный attachment.` })
        const content = encoding === 'base64' ? data.toString('base64') : data.toString('utf8')
        return JSON.stringify({ fileId, path: innerPath, size: data.length, encoding, content })
      } catch (e: any) {
        return JSON.stringify({ error: `Не удалось прочитать архив: ${e?.message ?? String(e)}` })
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
        if (!out.length) return JSON.stringify({ error: 'Архив пуст или указанные paths не найдены.' })
        return JSON.stringify({ fileId, extracted: out })
      } catch (e: any) {
        return JSON.stringify({ error: `Не удалось прочитать архив: ${e?.message ?? String(e)}` })
      }
    }
  }
  return JSON.stringify({ error: `unknown tool ${name}` })
}

function resolve1(raw: unknown, ctx: Ctx): Controller {
  const sn = typeof raw === 'string' && raw ? raw : (ctx.contextSns[0] ?? '')
  const c = ctx.discovery.get(sn) ?? ctx.discovery.getOrCreate(sn) ?? adHocController(sn)
  if (!c) throw new Error(`контроллер ${sn} не найден`)
  return c
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
    return `RPC заблокирован — изменение сетевых настроек через ${driver}/${_service}/${method} запрещено. Просмотр (Load, Get, List) разрешён.`
  }
  if (driver === 'confed' && method === 'Save') {
    const path = String(params['path'] ?? '')
    if (/wb-connection-manager|network/i.test(path)) {
      return `RPC заблокирован — сохранение сетевого конфига (${path}) запрещено.`
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
      return `Команда заблокирована — потенциально деструктивная операция: "${cmd}". Такие команды запрещены даже с подтверждением пользователя.`
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
      errs.push(`device_id "${device}" не найден на контроллере. Проверь через mqtt_list_topics(prefix="/devices/+/meta/name") и повтори.`)
      continue
    }
    const availSet = new Set(avail)
    const missing = requestedCtrls.filter(ch => !availSet.has(ch))
    if (missing.length) {
      errs.push(`канал(ы) у "${device}" не найден(ы): [${missing.join(', ')}]. Доступные у этого устройства: [${avail.join(', ')}]`)
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
