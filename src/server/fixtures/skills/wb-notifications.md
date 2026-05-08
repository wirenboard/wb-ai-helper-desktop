# wb-notifications

Отправка уведомлений с контроллера во внешние каналы — Telegram, email, SMS — из `wb-rules` (`Notify.*`) или через сервис alarms (`alarms.conf`).

Подгружай на: «отправь Telegram при ...», «настрой email», «SMS на тревогу», «уведомления не приходят», «alarms.conf», «Notify.sendTelegramMessage», «email relay», «Telegram-бот для контроллера».

## Каналы

| Канал | wb-rules API | Требует |
|---|---|---|
| Telegram | `Notify.sendTelegramMessage(token, chatId, text)` | Bot-токен от `@BotFather`, chat_id (свой, группы или канала) |
| Email | `Notify.sendEmail(to, subject, body)` | Локальный MTA (`exim4`/`msmtp`) с настроенным relay |
| SMS | `Notify.sendSMS(phone, body)` | Встроенный GSM-модем + SIM с балансом + работающий ModemManager |

`Notify.*` синхронный с точки зрения wb-rules: вызвал — забыл. Доставка асинхронная, **проверки доставки нет** — для критичных уведомлений добавляй retry/fallback в код правила.

## Telegram

### Создание бота

1. В Telegram → `@BotFather` → `/newbot` → имя/username → получаешь **bot token** (`123456:ABC...`).
2. **chat_id для личных** — отправь боту любое сообщение, потом `curl https://api.telegram.org/bot<TOKEN>/getUpdates | jq '.result[].message.chat.id'`. Число — твой chat_id.
3. **Для группы** — добавь бота в группу, отправь сообщение, дальше через `getUpdates`. chat_id группы будет отрицательным (`-123456`).
4. **Для канала** — добавь бота как админа, попроси кого-то написать в канал (или forward), `getUpdates`.

### Из wb-rules

```js
defineRule("alert_on_overheat", {
  asSoonAs: function () { return dev["wb-msw-v4_20/Temperature"] > 40; },
  then: function () {
    Notify.sendTelegramMessage(
      "123456:ABC...",
      "987654321",
      "Перегрев: " + dev["wb-msw-v4_20/Temperature"] + "°C"
    );
  }
});
```

**НЕ хардкодь токен** в продакшне. Лучше через PersistentStorage:

```js
var ps = new PersistentStorage("notify_creds", {global: true});
// один раз через консоль или init-скрипт:
// ps["telegram_token"] = "123456:ABC...";
// ps["telegram_chat"] = "987654321";

defineRule("alert", {
  whenChanged: "wb-mwac_25/F1",
  then: function (newValue) {
    if (newValue) Notify.sendTelegramMessage(ps["telegram_token"], ps["telegram_chat"], "Протечка!");
  }
});
```

### Прямой curl (без wb-rules)

Для скриптов, таймеров, systemd-юнитов:

```bash
ssh root@<HOST> 'curl -s -m10 -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" \
  -d "chat_id=<CHAT_ID>" \
  -d "text=Сообщение от контроллера"'
```

Ответ `{"ok":true,"result":...}` — успех.

## Email

### Локальный MTA через msmtp (рекомендую)

`msmtp-mta` — лёгкий, ставится через apt:

```bash
ssh root@<HOST> 'apt-get install msmtp-mta'
```

(сервер сам добавит `-y` при ssh_exec_async — не пиши руками)

Конфиг `/etc/msmtprc`:

```bash
ssh root@<HOST> 'cat > /etc/msmtprc' <<'EOF'
defaults
auth on
tls on
tls_trust_file /etc/ssl/certs/ca-certificates.crt
logfile /var/log/msmtp.log

account default
host smtp.gmail.com
port 587
from controller@example.com
user controller@example.com
password <app password>
EOF
ssh root@<HOST> 'chmod 0600 /etc/msmtprc'
```

Для Gmail нужен **App Password** (не обычный пароль аккаунта); включи 2FA и сгенери app password.

Тест:

```bash
ssh root@<HOST> 'echo -e "Subject: test\n\nbody" | msmtp recipient@example.com'
```

### Из wb-rules

```js
Notify.sendEmail("user@example.com", "Тревога", "В подвале не выключается свет");
```

`Notify.sendEmail` использует системный `sendmail`/`mail` — msmtp-mta перехватывает.

## SMS

Через встроенный GSM-модем (`mmcli`) — нужна SIM с балансом. На WB7/WB8 — встроенный модем, на старых — внешний WB-MOD-MODEM.

### Из wb-rules

```js
Notify.sendSMS("+71234567890", "Текст до 70 символов на одну SMS в кириллице");
```

### Прямой mmcli

```bash
ssh root@<HOST> 'mmcli -m 0 --messaging-create-sms="text=\"Hello\",number=\"+71234567890\""'
# возвращает путь типа /org/freedesktop/ModemManager1/SMS/123
ssh root@<HOST> 'mmcli -s /org/freedesktop/ModemManager1/SMS/123 --send'
```

**Кириллица в SMS** = 70 символов на одно сообщение, латиница = 160. Длинные SMS бьются на части (multipart) — каждая часть тарифицируется отдельно.

## alarms.conf — централизованные тревоги

`/etc/wb-rules/alarms.conf` — JSON с декларативным описанием тревог. Загружается из правила:

```js
Alarms.load("/etc/wb-rules/alarms.conf");
```

Формат:

```json
{
  "deviceName": "alarms",
  "deviceTitle": "Тревоги",
  "recipients": [
    {"type": "telegram", "token": "<TOKEN>", "chatId": "<CHAT_ID>"},
    {"type": "email", "to": "user@example.com"},
    {"type": "sms", "phone": "+71234567890"}
  ],
  "alarms": [
    {
      "name": "leak",
      "cell": "wb-mwac_25/F1",
      "expectedValueParameter": false,
      "alarmMessage": "Протечка в подвале!",
      "noAlarmMessage": "Протечка устранена",
      "interval": 600
    }
  ]
}
```

`interval` — секунды между повторными уведомлениями пока тревога активна. Без него — одно уведомление при возникновении.

`expectedValueParameter` — нормальное значение, тревога когда **не равно** ему. Альтернативно `minValueParameter`/`maxValueParameter` для порогов.

После правки `alarms.conf` — `systemctl restart wb-rules`.

## Грабли

- **Захардкоденный токен** — попадёт в git/бэкап. Используй `PersistentStorage` или `wb_read_file` файла-секрета.
- **Telegram chat_id для канала** — отрицательный, начинается с `-100`. Не путай с личным.
- **Gmail без App Password** — обычный пароль не работает с 2FA, нужен app-password.
- **MTA не настроен** — `Notify.sendEmail` молча проглотит. `journalctl -u wb-rules -p err` (или `wb_logs unit=wb-rules priority=err`) покажет если sendmail не найден.
- **Кириллица SMS** — 70 символов на одно SMS, превышение = multipart, биллинг ×N.
- **Нет интернета** — Telegram и email падают. SMS работает (через GSM), но если модем — uplink, пакеты теряются пока SMS отправляется.
- **alarms.conf без рестарта wb-rules** — изменения не подхватятся.
- **Несколько тревог без `interval`** — спам.

## Документация

- Telegram Bot API: https://core.telegram.org/bots/api
- msmtp: https://marlam.de/msmtp/
- ModemManager SMS: https://www.freedesktop.org/wiki/Software/ModemManager/
- WB wiki — alarms: https://wirenboard.com/wiki/Wb-rules#Alarms
