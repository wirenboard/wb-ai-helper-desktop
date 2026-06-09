# wb-notifications

Sending notifications from the controller to external channels — Telegram, email, SMS — from `wb-rules` (`Notify.*`) or via the alarms service (`alarms.conf`).

Load on: "send Telegram when ...", "set up email", "SMS on alarm", "notifications not arriving", "alarms.conf", "Notify.sendTelegramMessage", "email relay", "Telegram bot for the controller".

## Channels

| Channel | wb-rules API | Requires |
|---|---|---|
| Telegram | `Notify.sendTelegramMessage(token, chatId, text)` | Bot token from `@BotFather`, chat_id (your own, of a group, or of a channel) |
| Email | `Notify.sendEmail(to, subject, body)` | A local MTA (`exim4`/`msmtp`) with a configured relay |
| SMS | `Notify.sendSMS(phone, body)` | Built-in GSM modem + SIM with balance + working ModemManager |

`Notify.*` is synchronous from the wb-rules point of view: called — forgotten. Delivery is asynchronous, **there is no delivery check** — for critical notifications add retry/fallback in the rule code.

## Telegram

### Creating a bot

1. In Telegram → `@BotFather` → `/newbot` → name/username → you get a **bot token** (`123456:ABC...`).
2. **chat_id for personal chats** — send the bot any message, then `curl https://api.telegram.org/bot<TOKEN>/getUpdates | jq '.result[].message.chat.id'`. The number is your chat_id.
3. **For a group** — add the bot to the group, send a message, then go through `getUpdates`. The group chat_id will be negative (`-123456`).
4. **For a channel** — add the bot as an admin, ask someone to post in the channel (or forward), `getUpdates`.

### From wb-rules

```js
defineRule("alert_on_overheat", {
  asSoonAs: function () { return dev["wb-msw-v4_20/Temperature"] > 40; },
  then: function () {
    Notify.sendTelegramMessage(
      "123456:ABC...",
      "987654321",
      "Overheat: " + dev["wb-msw-v4_20/Temperature"] + "°C"
    );
  }
});
```

**DO NOT hardcode the token** in production. Better via PersistentStorage:

```js
var ps = new PersistentStorage("notify_creds", {global: true});
// once, via the console or an init script:
// ps["telegram_token"] = "123456:ABC...";
// ps["telegram_chat"] = "987654321";

defineRule("alert", {
  whenChanged: "wb-mwac_25/F1",
  then: function (newValue) {
    if (newValue) Notify.sendTelegramMessage(ps["telegram_token"], ps["telegram_chat"], "Leak!");
  }
});
```

### Direct curl (without wb-rules)

For scripts, timers, systemd units:

```bash
ssh root@<HOST> 'curl -s -m10 -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" \
  -d "chat_id=<CHAT_ID>" \
  -d "text=Message from the controller"'
```

A `{"ok":true,"result":...}` response means success.

## Email

### Local MTA via msmtp (recommended)

`msmtp-mta` — lightweight, installed via apt:

```bash
ssh root@<HOST> 'apt-get install msmtp-mta'
```

(the server itself will add `-y` on ssh_exec_async — don't write it by hand)

Config `/etc/msmtprc`:

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

For Gmail you need an **App Password** (not the regular account password); enable 2FA and generate an app password.

Test:

```bash
ssh root@<HOST> 'echo -e "Subject: test\n\nbody" | msmtp recipient@example.com'
```

### From wb-rules

```js
Notify.sendEmail("user@example.com", "Alarm", "The basement light won't turn off");
```

`Notify.sendEmail` uses the system `sendmail`/`mail` — msmtp-mta intercepts it.

## SMS

Via the built-in GSM modem (`mmcli`) — a SIM with balance is needed. On WB7/WB8 — a built-in modem, on older ones — an external WB-MOD-MODEM.

### From wb-rules

```js
Notify.sendSMS("+71234567890", "Up to 70 Cyrillic chars per single SMS");
```

### Direct mmcli

```bash
ssh root@<HOST> 'mmcli -m 0 --messaging-create-sms="text=\"Hello\",number=\"+71234567890\""'
# returns a path like /org/freedesktop/ModemManager1/SMS/123
ssh root@<HOST> 'mmcli -s /org/freedesktop/ModemManager1/SMS/123 --send'
```

**Cyrillic in SMS** = 70 characters per single message, Latin = 160. Long SMS are split into parts (multipart) — each part is billed separately.

## alarms.conf — centralized alarms

`/etc/wb-rules/alarms.conf` — JSON with a declarative description of alarms. Loaded from a rule:

```js
Alarms.load("/etc/wb-rules/alarms.conf");
```

Format:

```json
{
  "deviceName": "alarms",
  "deviceTitle": "Alarms",
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
      "alarmMessage": "Basement leak!",
      "noAlarmMessage": "Leak resolved",
      "interval": 600
    }
  ]
}
```

`interval` — seconds between repeated notifications while the alarm is active. Without it — a single notification when it occurs.

`expectedValueParameter` — the normal value, the alarm fires when the value is **not equal** to it. Alternatively `minValueParameter`/`maxValueParameter` for thresholds.

After editing `alarms.conf` — `systemctl restart wb-rules`.

## Pitfalls

- **Hardcoded token** — will end up in git/backup. Use `PersistentStorage` or `wb_read_file` of a secret file.
- **Telegram chat_id for a channel** — negative, starts with `-100`. Don't confuse it with a personal one.
- **Gmail without an App Password** — the regular password doesn't work with 2FA, an app password is needed.
- **MTA not configured** — `Notify.sendEmail` will silently swallow it. `journalctl -u wb-rules -p err` (or `wb_logs unit=wb-rules priority=err`) will show if sendmail is not found.
- **Cyrillic SMS** — 70 characters per single SMS, exceeding it = multipart, billing ×N.
- **No internet** — Telegram and email fail. SMS works (via GSM), but if the modem is the uplink, packets are lost while the SMS is being sent.
- **alarms.conf without restarting wb-rules** — changes won't be picked up.
- **Several alarms without `interval`** — spam.

## Documentation

- Telegram Bot API: https://core.telegram.org/bots/api
- msmtp: https://marlam.de/msmtp/
- ModemManager SMS: https://www.freedesktop.org/wiki/Software/ModemManager/
- WB wiki — alarms: https://wirenboard.com/wiki/Wb-rules#Alarms
