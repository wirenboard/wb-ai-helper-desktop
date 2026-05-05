# documentation-search

Поиск в документации Wiren Board — порядок источников (вики → GitHub → web_search), прямой `web_fetch` без гугления, обход CAPTCHA. Подгружай, когда пользователь просит «почитай доки/вики/README», или ты сам сомневаешься в синтаксисе / имени топика / RPC-методе / поле шаблона.

Не лезь в интернет на каждый чих: если ответ есть на контроллере (`device/LoadConfig`, `dpkg -l`, локальный файл) — иди туда, не в доки.

## Wiki напрямую через web_fetch, не через web_search

`web_search` — последняя инстанция. Угадал URL — сразу `web_fetch`. Не угадал — `web_fetch` на поиск по самой вики. Только если и это пусто — `web_search`. Лучше один лишний `web_fetch`, чем уверенный неверный ответ.

## Источники

### 1. Wiki — главный

Базовый URL: `https://wirenboard.com/wiki/<Страница>`. Имена страниц — `Snake_Case`/`CamelCase`, пробелы → `_`. Редиректит на `wiki.wirenboard.com` — это один и тот же сайт.

- Модуль: `web_fetch('https://wirenboard.com/wiki/WB-MR6C')`, `WB-MSW_v.4`, `WB-MAP12E`.
- Тема: `Wb-rules`, `Rule_Examples`, `MQTT_Devices_and_Controls`, `How_to_diagnose`.
- Поиск по вики (если не знаешь точный URL): `web_fetch('https://wirenboard.com/wiki/Special:Search?search=<запрос>')`.

### 2. GitHub — исходники, шаблоны, README

Базовый URL: `https://github.com/wirenboard/<repo>/...`.

- README: `web_fetch('https://github.com/wirenboard/wb-rules/blob/master/README.md')`.
- Raw-файл (без HTML-обёртки, компактнее): `web_fetch('https://raw.githubusercontent.com/wirenboard/wb-mqtt-serial/main/templates/config-wb-mr6c.json')`.
- Листинг каталога: `web_fetch('https://github.com/wirenboard/wb-mqtt-serial/tree/main/templates')`.

`web_fetch` обрезает по 64KB — для больших страниц читай по частям через более конкретный URL.

### 3. web_search — когда вики и GitHub не помогли

Лимит **3 вызова** на один ответ модели, обнуляется на новом сообщении пользователя.

1. `web_search('<запрос>')` → возьми URL из топа.
2. `web_fetch('<URL>')` → читай.

Если первый `web_search` вернул 0 результатов — **не переформулируй**, переключайся на `web_fetch` напрямую (даже на угаданный URL). Переформулировка почти никогда не помогает.

## CAPTCHA от Brave

`web_search` иногда возвращает CAPTCHA / rate-limit. Тогда бюджет обнуляется, новые вызовы не дёргай. Иди на `https://wirenboard.com/wiki/Special:Search?search=<запрос>` через `web_fetch` — это поиск по самой вики, без сторонних движков.

## Грабли

- Сразу `web_search` вместо `web_fetch` на вики — сжигаешь лимит, получаешь нерелевантную выдачу.
- Тянуть шаблоны устройств с GitHub — на контроллере актуальный шаблон под прошивку доступен через `mqtt_rpc(sn, "wb-mqtt-serial", "device", "LoadConfig", ...)` (см. скилл `wb-mqtt-serial`).
- `github.com/.../blob/...` для чтения кода — это HTML-обёртка. Для чистого содержимого — `raw.githubusercontent.com/...`.
- Повторный `web_search` с переформулировкой — смени стратегию (другой источник, прямой URL), а не фразу.

## Документация

- Wiki Wiren Board: <https://wirenboard.com/wiki/>
- GitHub Wiren Board: <https://github.com/wirenboard>
