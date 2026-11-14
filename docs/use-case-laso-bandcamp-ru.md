# Почему проверка покупки на Bandcamp картой Laso остановилась

> [English](use-case-laso-bandcamp.md) · **Русский** · [Español](use-case-laso-bandcamp-es.md) · [Français](use-case-laso-bandcamp-fr.md) · [中文](use-case-laso-bandcamp-zh.md)

14 ноября 2026 года проверили, можно ли купить трек **Cash** исполнителя Blockhead на Bandcamp уже выпущенной американской непополняемой картой Laso. При оформлении без аккаунта Bandcamp показал вариант оплаты картой и позволил ввести **$1,00**, указанную минимальную цену. В браузере дошли до кнопки **Proceed to payment**. Итоговую сумму ещё не подтвердили. [Трек на Bandcamp](https://blockheadnyc.bandcamp.com/track/cash) · [Данные проверки оформления](../../artifacts/argus-bandcamp-preflight-2026-11-14/verified.json)

## Проверка совместимости с продавцом

```mermaid
sequenceDiagram
    participant T as Проверка покупки
    participant B as Bandcamp
    participant L as Laso
    T->>B: Открыть оформление трека Cash и ввести $1,00
    B-->>T: Показать оплату картой и Proceed to payment
    T->>L: Проверить совместимость Bandcamp и состояние карты
    L-->>T: not_accepted, карта ready, доступно $5,00, списаний Bandcamp нет
    T->>T: Остановиться до отправки платежа и запроса подтверждения в Telegram
```

Запрос совместимости вернул HTTP `200` и результат `not_accepted` для Bandcamp и карты типа `Non-Reloadable U.S.`. Laso использует этот статус, если у продавца уже был отказ по этому типу карты. Отдельный запрос состояния карты вернул HTTP `200`, статус `ready`, **$5,00 доступного остатка** и **ноль списаний Bandcamp**. [Проверка совместимости в Laso](https://docs.laso.finance/guides/usa-prepaid-card#check-the-merchant-first) · [Результаты запросов](../../artifacts/argus-bandcamp-preflight-2026-11-14/verified.json)

Проверка завершилась до отправки платежа. Квитанции о покупке и файла для скачивания не было. В Telegram не отправляли запрос подтверждения или файл. Транзакция Base из кейса Laso относится к выпуску карты. Проверка на Bandcamp не создала транзакции в Base. [Выпуск карты и список транзакций Base](use-case-laso-prepaid-card-ru.md)
