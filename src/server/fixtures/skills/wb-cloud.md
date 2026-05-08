# wb-cloud

`wb-cloud-agent` — сервис на контроллере, который держит туннель к Wiren Board Cloud (`https://wirenboard.cloud`) для удалённого доступа к веб-UI и API. У каждого контроллера есть криптографический сертификат в защищённой памяти (`ATECCx08`), которым подписывается активация.

Подгружай на: «привязать контроллер к облаку», «активировать в wirenboard.cloud», «не открывается через облако», «отвязать от аккаунта», «свой бэкенд облака», «статус облака», «удалённый доступ через wirenboard.cloud».

## Архитектура

```
Web UI (wirenboard.cloud)
      ↑ (long-poll / websocket)
      │
      ▼
wb-cloud-agent  ──читает──▶  /etc/wb-cloud-agent.conf  (LOG_LEVEL, CLIENT_CERT_ENGINE_KEY, CLOUD_BASE_URL)
      │
      ├── /var/lib/wb-cloud-agent/device_bundle.crt.pem      (device certificate)
      ├── /var/lib/wb-cloud-agent/providers/<provider>/       (per-provider state)
      │
      └── публикует в MQTT:
          /devices/system__wb-cloud-agent__<provider>/controls/status
                                                           /activation_link
                                                           /cloud_base_url
```

Provider — конкретное облако. По умолчанию `wirenboard.cloud`. Можно поднять своё — см. ниже.

## Базовая диагностика

Используй tool `cloud_status` — он одним вызовом возвращает: активность сервиса, наличие device-сертификата, список привязанных провайдеров, retained MQTT-контролы (status / activation_link / cloud_base_url) для каждого. Это first-call для проверки «привязан ли контроллер к облаку и в каком статусе».

Возможные значения `status`:
- `unknown` — агент только запустился, ещё не подключился.
- `ok` (или `active`) — туннель установлен, контроллер виден из облака.
- `not_activated` — сертификат есть, но устройство не привязано к аккаунту.
- `error` — смотри логи.

## Активация (привязка к аккаунту)

1. Убедись что сервис запущен и есть интернет:
   ```bash
   ssh root@<HOST> 'systemctl is-active wb-cloud-agent && curl -s -m5 https://wirenboard.cloud >/dev/null && echo ok'
   ```

2. Если `inactive` — `systemctl enable --now wb-cloud-agent`.

3. Получи `activation_link` из MQTT:
   ```bash
   ssh root@<HOST> "mosquitto_sub -t '/devices/system__wb-cloud-agent__wirenboard.cloud/controls/activation_link' -C 1 -W 5"
   ```

4. Открой ссылку в браузере, авторизуйся в `wirenboard.cloud`, привяжи к аккаунту.

5. После привязки `status` меняется на `active` — проверь через `cloud_status` или mosquitto_sub.

## Отвязка / сброс активации

```bash
ssh root@<HOST> 'systemctl stop wb-cloud-agent'
ssh root@<HOST> 'rm -rf /var/lib/wb-cloud-agent/providers/wirenboard.cloud/'
ssh root@<HOST> 'systemctl start wb-cloud-agent'
```

После этого агент выдаёт новый `activation_link`. Старая привязка в аккаунте `wirenboard.cloud` остаётся, но указывает в никуда — удали вручную через веб-UI облака.

## Свой бэкенд облака

`CLOUD_BASE_URL` в `/etc/wb-cloud-agent.conf` указывает на адрес облака. Default — `https://wirenboard.cloud/`. Чтобы переключить:

```bash
ssh root@<HOST> 'cat > /etc/wb-cloud-agent.conf' <<'EOF'
{
    "LOG_LEVEL": "INFO",
    "CLIENT_CERT_ENGINE_KEY": "ATECCx08:00:02:C0:00",
    "CLOUD_BASE_URL": "https://my.cloud.example/"
}
EOF
ssh root@<HOST> 'systemctl restart wb-cloud-agent'
```

Свой бэкенд должен реализовать API совместимый с `wirenboard.cloud`. Это редкий кейс — обычно для self-hosted деплоев или тестовых стендов. ATECC-сертификат всё равно подписан Wiren Board, но его можно проверить против твоего CA если доверяешь WB root.

## Диагностика «не подключается к облаку»

1. **Сервис активен?** `cloud_status` — `serviceActive`. Если `false` → `enable --now`.
2. **Сертификат есть?** `cloud_status` — `certPresent`. Нет — контроллер не Wiren Board или ATECC сломан.
3. **Интернет наружу?** `curl -s -m5 https://wirenboard.cloud >/dev/null && echo ok`. Нет — см. `wb-network` (failover, DNS).
4. **Логи**: `wb_logs unit=wb-cloud-agent lines=100`. Типичные ошибки:
   - `connection refused` / `timeout` — проблема с сетью.
   - `Certificate verification failed` — кривая дата на контроллере (`date`), синхронизируй NTP.
   - `Authentication failed` — сертификат отозван / устройство удалено из облака.
5. **MQTT публикуется?** `cloud_status` → `mqtt`. Пусто — агент не дошёл до публикации, смотри логи.

## Связанные скиллы

- `wb-network` — если облако недоступно из-за интернета.
- `wb-services` — `wb-cloud-agent` это systemd-юнит, override-conf и mask/unmask — там.
- `controller-backup` — `/etc/wb-cloud-agent.conf` уже в core-tar; `/var/lib/wb-cloud-agent/providers/` обычно НЕ бэкапим (новая активация даст новый providers state, это нормально).
- `troubleshooting-general` — общая диагностика, kernel mismatch, место на диске.

## Грабли

- **Время сильно расходится** — TLS handshake к облаку упадёт. NTP должен работать (`systemctl is-active ntp` или `systemd-timesyncd`).
- **VPN на контроллере с default route** — может перекрыть доступ к облаку, если VPN-сервер блокирует outbound `wirenboard.cloud`. Проверь маршрут: `ip route get $(getent hosts wirenboard.cloud | awk "{print \$1}")`.
- **`CLIENT_CERT_ENGINE_KEY`** — НЕ редактируется руками. Это адрес сертификата в ATECC, заводская настройка.
- **Удалили контроллер в веб-UI без локального сброса** — локальный агент продолжит долбиться с `Authentication failed`. Сделай локально cleanup `providers/` + рестарт.
- **Activation link одноразовая** — если кликнул но не довёл активацию до конца, агент генерирует новую при следующем запросе/рестарте.

## Документация

- WB Cloud: https://wirenboard.com/wiki/Wiren_Board_Cloud
- Remote access: https://wirenboard.com/wiki/Remote_access
