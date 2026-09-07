# Echolet: MVP Protocol Flows & Implementation Specification (PROTOCOL-07)

## 1. Назначение документа
Этот документ описывает MVP-протокол Echolet на уровне, достаточном для реализации без догадок. Его задача — убрать двусмысленность между продуктовой идеей и инженерной реализацией.

Документ покрывает:

* модель сущностей;
* обязательные структуры данных;
* lifecycle identity и устройства;
* публикацию `PreKey Bundle`;
* установление сессии;
* отправку и получение сообщений;
* mailbox authentication;
* receipts, retries, TTL и ошибки;
* поэтапный план реализации.

Этот документ намеренно описывает **relay-first MVP**. Он не включает multi-hop onion routing, anti-DPI transports и media pipeline.

---

## 2. Нормативные правила
В этом документе слова:

* **MUST** — обязательное поведение;
* **SHOULD** — рекомендуемое поведение, допустимы редкие исключения;
* **MAY** — опциональное поведение.

Если реализация расходится с пунктом `MUST`, она не считается совместимой с MVP-спецификацией.

---

## 3. Область MVP

### 3.1. Что делает MVP
MVP должен поддерживать:

* создание identity из seed-фразы;
* создание первого устройства;
* публикацию `Signed Device Record`;
* публикацию `PreKey Bundle`;
* обмен контактом через QR или invite;
* установление первой зашифрованной сессии;
* отправку E2EE-текстового сообщения через доверенный репитер;
* хранение сообщений в mailbox, если получатель оффлайн;
* получение mailbox через challenge-response;
* receipts и retry для текстовых сообщений.

### 3.2. Что не входит в MVP
MVP не покрывает:

* multi-hop onion routing;
* анонимный глобальный поиск по callsign;
* large media attachments;
* полноценную multi-device sync;
* anti-DPI transports;
* публичную federated relay-сеть со сложным consensus.

---

## 4. Сущности системы

### 4.1. Identity
Долгоживущая личность пользователя.

Поля:

* `identity_id`: строка, base58/base64url-представление публичного ключа identity;
* `identity_pubkey`: публичный ключ `Ed25519`;
* `callsign`: UX-алиас;
* `created_at_ms`.

### 4.2. Device
Конкретное устройство пользователя.

Поля:

* `device_id`: UUIDv4 или случайный 128-bit идентификатор;
* `device_pubkey`: публичный ключ устройства;
* `identity_id`;
* `device_label`: опционально (`iphone-16`, `macbook-air`);
* `created_at_ms`;
* `capabilities`.

### 4.3. Signed Device Record
Подписанный объект, связывающий устройство с личностью.

### 4.4. PreKey Bundle
Набор публичных prekeys, достаточный для инициализации первой шифрованной сессии.

### 4.5. Home Base Relay
Доверенный репитер, через который клиент публикует prekeys, получает mailbox и, при необходимости, отправляет offline-сообщения.

### 4.6. Mailbox
Очередь зашифрованных envelope-объектов, связанных с получателем.

### 4.7. Session
Криптографическое состояние device-to-device communication после `X3DH` bootstrap.

---

## 5. Канонические кодировки и правила сериализации

### 5.1. Формат обмена
Для MVP все сетевые сообщения MUST использовать HTTP JSON API через relay; сетевое развертывание MUST использовать TLS (HTTPS). Локальный HTTP допустим только для разработки. `libp2p`/QUIC и direct P2P не входят в этот transport-путь. См. [STACK-14](STACK-14_TECH_DECISIONS.md).

Причины:

* легко читать человеком;
* легко дебажить даже бесплатной моделью;
* не требует генерации protobuf/flatbuffers на старте.

### 5.2. Кодировка бинарных полей
Все бинарные поля MUST передаваться как `base64url` без padding.

### 5.3. Время
Все timestamps MUST храниться как `unix milliseconds UTC` в числовом поле `*_ms`.

### 5.4. Подпись
Для mailbox create-challenge/poll/ack действуют отдельные domain-separated UTF-8 строки из §9.6–9.8; правило JSON ниже к ним не применяется.

Подпись MUST считаться по **канонически сериализованному JSON без поля `signature`**.

Практическое правило канонизации:

1. удалить поле `signature`, если оно есть;
2. отсортировать ключи объекта по ASCII;
3. использовать `JSON.stringify` без лишних пробелов;
4. подписать полученную строку в UTF-8.

Это правило MUST быть одинаковым в клиенте и репитере.

### 5.5. Message IDs
`message_id`, `bundle_id`, `receipt_id`, `challenge_id` SHOULD быть UUIDv7 или криптографически случайной строкой длиной не меньше 128 бит энтропии.

---

## 6. Криптографические примитивы MVP

### 6.1. Identity и подписи
* **Identity Keys:** `Ed25519`.
* **Device Keys:** допустимо использовать `Ed25519` для подписи device records.

### 6.2. Session bootstrap
Для первой совместимой версии допускаются два режима:

1. **Предпочтительный:** готовая библиотека `X3DH + Double Ratchet`.
2. **Fallback MVP-compatible mode:** если библиотека X3DH недоступна, разрешается использовать проверенный готовый протокол из mature library, который предоставляет эквивалентный bootstrap + ratchet semantics.

Команда должна выбрать **один** конкретный стек и зафиксировать его в коде. Нельзя смешивать несколько несовместимых bootstrap-схем в пределах одного клиента.

### 6.3. Сессионные payloads
Encrypted payload MUST быть opaque blob для репитера. Репитер не должен знать plaintext message body.

---

## 7. Структуры данных

### 7.1. Signed Device Record

```json
{
  "type": "device_record",
  "version": 1,
  "identity_id": "base64url(identity_pubkey)",
  "device_id": "uuid-v7",
  "device_pubkey": "base64url(bytes)",
  "device_label": "iphone-main",
  "capabilities": {
    "mailbox_poll": true,
    "receipts": true,
    "attachments": false
  },
  "created_at_ms": 1770000000000,
  "signature": "base64url(signature-by-identity-key)"
}
```

Правила:

* `identity_id` MUST соответствовать публичному ключу identity.
* `signature` MUST проверяться identity public key.
* `version` MUST быть целым числом.

### 7.2. PreKey Bundle

```json
{
  "type": "prekey_bundle",
  "version": 1,
  "bundle_id": "uuid-v7",
  "identity_id": "base64url(identity_pubkey)",
  "device_id": "uuid-v7",
  "device_pubkey": "base64url(bytes)",
  "signed_prekey": {
    "key_id": "spk-001",
    "public_key": "base64url(bytes)",
    "created_at_ms": 1770000000000,
    "expires_at_ms": 1770604800000,
    "signature": "base64url(signature-by-device-or-identity)"
  },
  "one_time_prekeys": [
    {
      "key_id": "otk-001",
      "public_key": "base64url(bytes)"
    },
    {
      "key_id": "otk-002",
      "public_key": "base64url(bytes)"
    }
  ],
  "created_at_ms": 1770000000000,
  "signature": "base64url(signature-by-identity-key)"
}
```

Правила:

* `signed_prekey.expires_at_ms` MUST быть больше `created_at_ms`.
* число `one_time_prekeys` в MVP SHOULD быть не меньше 20 и не больше 200.
* bundle MUST быть подписан identity key.

### 7.3. Contact Record

```json
{
  "type": "contact_record",
  "version": 1,
  "identity_id": "base64url(identity_pubkey)",
  "callsign": "AD-77-SKY",
  "display_name": "Sky",
  "trust_state": "verified",
  "added_via": "qr",
  "added_at_ms": 1770000000000,
  "safety_number": "482991"
}
```

### 7.4. Mailbox Envelope

```json
{
  "type": "mailbox_envelope",
  "version": 1,
  "envelope_id": "uuid-v7",
  "message_id": "uuid-v7",
  "sender_identity_id": "base64url(identity_pubkey)",
  "sender_device_id": "uuid-v7",
  "recipient_identity_id": "base64url(identity_pubkey)",
  "recipient_device_id": "uuid-v7",
  "recipient_mailbox_id": "base64url(bytes)",
  "payload_type": "ciphertext_message",
  "ciphertext": "base64url(bytes)",
  "created_at_ms": 1770000000000,
  "expires_at_ms": 1770604800000,
  "size_bytes": 1024,
  "sender_signature": "base64url(ed25519_signature)"
}
```

Правила:

* `recipient_mailbox_id` MUST быть детерминированно вычислим клиентом получателя.
* `ciphertext` MUST включать все нужные session headers внутри зашифрованного или внешнего transport-compatible формата.
* `sender_signature` MUST присутствовать в запросе `POST /v1/messages/send`: это подпись Ed25519 ключом устройства отправителя (base64url без padding, не длиннее 256 байт) над транскриптом

  ```
  echolet-mailbox-envelope:v1:<recipient_mailbox_id>:<envelope_id>:<sender_identity_id>:<sender_device_id>:<base64url_raw(SHA-256(utf8(ciphertext)))>:<created_at_ms>:<expires_at_ms>
  ```

  Relay находит отправителя по той же неизменяемой связке `(mailbox identity, device UUID)`, что и для challenge/poll/ack, но применённой к `deriveMailboxId(sender_identity_id)`, и проверяет подпись по `device_pubkey` уже опубликованного Device Record. Конверт с отсутствующей, некорректной, слишком длинной или неверифицируемой подписью, равно как и от отправителя без опубликованного Device Record, отклоняется ограниченным 4xx **до** сохранения в mailbox. Подпись детерминирована, поэтому побайтово идентичный повтор остаётся идемпотентным. В ответе poll поле возвращается как есть и опускается (никогда не пустая строка) для записей, сохранённых до появления поля.

### 7.5. Chat Message Plaintext Schema
До шифрования прикладной payload SHOULD иметь такой JSON:

```json
{
  "type": "chat_message",
  "version": 1,
  "message_id": "uuid-v7",
  "conversation_id": "deterministic-or-random-id",
  "sender_identity_id": "base64url(identity_pubkey)",
  "sender_device_id": "uuid-v7",
  "created_at_ms": 1770000000000,
  "body": "hello world",
  "reply_to_message_id": null
}
```

### 7.6. Receipt Plaintext Schema

```json
{
  "type": "receipt",
  "version": 1,
  "receipt_id": "uuid-v7",
  "message_id": "uuid-v7",
  "status": "delivered",
  "created_at_ms": 1770000005000
}
```

Допустимые статусы в MVP:

* `queued` — локально поставлено в исходящую очередь;
* `relayed` — принято Home Base;
* `delivered` — получено устройством адресата;
* `read` MAY быть добавлен позже.

---

## 8. Локальное хранение в клиенте

### 8.1. Обязательные таблицы / коллекции
Клиент MUST иметь следующие logical stores:

* `identity_profile`
* `devices`
* `contacts`
* `prekey_bundles_cache`
* `sessions`
* `messages`
* `outbox`
* `receipts`
* `relay_config`

### 8.2. Минимальная схема messages

| Поле | Тип | Назначение |
| :--- | :--- | :--- |
| `message_id` | string | идентификатор сообщения |
| `conversation_id` | string | идентификатор диалога |
| `direction` | enum | `incoming` / `outgoing` |
| `status` | enum | `queued` / `relayed` / `delivered` / `failed` |
| `ciphertext` | string nullable | зашифрованная версия |
| `plaintext_body` | string nullable | локально доступный текст |
| `sender_identity_id` | string | кто отправил |
| `recipient_identity_id` | string | кому отправлено |
| `created_at_ms` | number | время создания |
| `updated_at_ms` | number | время обновления |

### 8.3. Seed storage
Seed-фраза MUST храниться только в OS-protected secure storage. Она MUST NOT записываться в обычную SQLite-таблицу в открытом виде.

---

## 9. API репитера

### 9.1. Общие правила
Для MVP репитер MAY предоставить `HTTP JSON API` поверх TLS или транспорт, эквивалентный по смыслу. Чтобы упростить реализацию, ниже описан HTTP-вариант.

Все ответы MUST возвращать JSON:

```json
{
  "ok": true,
  "data": {}
}
```

или

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_SIGNATURE",
    "message": "signature verification failed"
  }
}
```

### 9.2. `POST /v1/device-records/publish`
Назначение: публикация или обновление `Signed Device Record`.

Request body:

```json
{
  "device_record": {"...": "..."}
}
```

Проверки репитера:

* валидный JSON;
* `type == device_record`;
* валидная подпись identity key;
* размер не превышает лимит.

Response:

```json
{
  "ok": true,
  "data": {
    "stored": true,
    "device_id": "uuid-v7"
  }
}
```

### 9.3. `POST /v1/prekeys/publish`
Назначение: публикация `PreKey Bundle`.

Request body:

```json
{
  "bundle": {"...": "..."}
}
```

Проверки репитера:

* bundle signature valid;
* `device_id` существует в опубликованном `Signed Device Record`;
* `signed_prekey.expires_at_ms` не истек;
* число prekeys в допустимом диапазоне.

Response:

```json
{
  "ok": true,
  "data": {
    "stored": true,
    "bundle_id": "uuid-v7",
    "one_time_prekeys_count": 50
  }
}
```

### 9.4. `GET /v1/prekeys/:identityId`
Назначение: получить активный bundle для первого устройства контакта или список bundle-ов.

Упрощение MVP:

* если у контакта одно устройство — вернуть один bundle;
* если устройств несколько — вернуть список.

Response:

```json
{
  "ok": true,
  "data": {
    "bundles": [
      {"type": "prekey_bundle", "...": "..."}
    ]
  }
}
```

### 9.5. `POST /v1/messages/send`
Назначение: положить зашифрованный envelope в mailbox адресата.

Request body:

```json
{
  "envelope": {"...": "..."}
}
```

Проверки:

* валидный envelope schema;
* `expires_at_ms > created_at_ms`;
* `size_bytes <= MAX_MESSAGE_BYTES`;
* `size_bytes` совпадает с фактической длиной `ciphertext`: поле не декларативное, relay измеряет реальную длину и отвергает расхождение `400 INVALID_SCHEMA`, иначе им можно было бы занизить размер полезной нагрузки относительно лимита;
* `sender_signature` присутствует, не длиннее 256 байт и верифицируется по `device_pubkey` опубликованного Device Record отправителя (см. 7.4); иначе `400 INVALID_SCHEMA`, `403 INVALID_SIGNATURE` или `403 UNAUTHORIZED_MAILBOX_ACCESS` до записи в mailbox;
* mailbox quota не превышена;
* per-sender quota не превышена: один `sender_identity_id` держит не более `ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER` (по умолчанию 16) живых (неистекших) envelope в одном `recipient_mailbox_id`; иначе `403 SENDER_QUOTA_EXCEEDED` до записи в mailbox. Код неретраебельный и намеренно не `429` (клиент классифицирует 429 как retryable и теряет код). Квота освобождается при ack и при истечении срока; побайтно идентичный повтор уже сохранённого `envelope_id` квоту не расходует и остаётся `200`. Квота ограничивает одного отправителя, а не занятость mailbox целиком: публикация Device Record не аутентифицирована, поэтому атакующий поднимает цену wedge с 1 личности до 4 (byte-bounded режим) или 50 (count-bounded), но класс не закрывается. Число 4 измерено на реальном relay-бинарнике и реальном CLI: 48 максимальных poison-конвертов ещё доставляют легитимное сообщение, 49 — заклинивают, а 3 × 16 = 48 попадает на сторону доставки (`t55-final-verification.md`, часть 1). Ранее в репозитории стояла оценка 3, полученная как `ceil(48/16)`; она ошибалась на единицу.

Response:

```json
{
  "ok": true,
  "data": {
    "accepted": true,
    "envelope_id": "uuid-v7",
    "status": "relayed"
  }
}
```

### 9.6. `POST /v1/mailbox/challenge`
Назначение: инициировать mailbox authentication.

Все три mailbox-операции используют подпись Ed25519 ключом устройства; подпись передается как base64url без padding. Relay получает опубликованный Device Record по `device_id`, выводит mailbox из `record.identity_id` и требует совпадение с `recipient_mailbox_id`. Неизвестное устройство/чужой mailbox: HTTP 403 `UNAUTHORIZED_MAILBOX_ACCESS`; неверная подпись: HTTP 403 `INVALID_SIGNATURE`; отсутствующие обязательные поля: HTTP 400 `INVALID_SCHEMA`.

Создание challenge подписывает точные UTF-8 байты строки (без кавычек, пробелов или завершающего перевода строки):

```text
echolet-mailbox-create-challenge:v1:{recipient_mailbox_id}:{device_id}
```

В этом входе нет timestamp/nonce: подпись создания challenge сама по себе не защищена от повторного предъявления. TLS и лимиты обязательны; не следует обещать одноразовость этой операции.


Request body:

```json
{
  "recipient_mailbox_id": "base64url(bytes)",
  "device_id": "uuid-v7",
  "signature": "base64url(signature-over-create-challenge-message)"
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "challenge_id": "uuid-v7",
    "nonce": "base64url(bytes)",
    "expires_at_ms": 1770000010000
  }
}
```

### 9.7. `POST /v1/mailbox/poll`
Назначение: получить mailbox после challenge-response.

Подписывается точная UTF-8 строка:

```text
echolet-mailbox-challenge:v1:{challenge_id}:{recipient_mailbox_id}:{device_id}:{nonce}
```

Если запрос несёт `read_through` (durable read position получателя, см.
[API-11 §10](API-11_JSON_SCHEMAS.md)), подписывается вместо неё строка `v2`:

```text
echolet-mailbox-challenge:v2:{challenge_id}:{recipient_mailbox_id}:{device_id}:{nonce}:{read_through}
```

Позиция обязана быть внутри подписи: она решает, что получателю выдадут дальше, и
значение, продвинувшее метку за конверт, делает этот конверт недостижимым до конца
его жизни. Отсутствие и присутствие поля — разные подписываемые строки.

`nonce` берется дословно из ответа, не декодируется и не нормализуется. Текущий Go relay возвращает nonce в padded base64url — исключение из §5.2, которое клиент обязан сохранить при подписи. Challenge ID текущего relay — UUIDv4, хотя примеры используют условный UUIDv7.


Request body:

```json
{
  "challenge_id": "uuid-v7",
  "recipient_mailbox_id": "base64url(bytes)",
  "device_id": "uuid-v7",
  "signature": "base64url(signature-over-challenge)",
  "batch_size": 50,
  "cursor": "48",
  "read_through": "48"
}
```

`batch_size` (необязательное целое 1..`ECHOLET_MAX_MAILBOX_BATCH`) — запрошенная клиентом верхняя граница числа конвертов в ответе. Это предпочтение, а не авторитет: сверху всегда применяются серверный лимит и совокупный бюджет байт ответа (1 MiB, совпадает с жестким лимитом ответа у клиента). Один конверт максимального размера выдается всегда, поэтому бюджет байт не может заблокировать выдачу.

`cursor` (необязательная строка) — токен продолжения, полученный предыдущим poll в поле `next_cursor` и возвращаемый дословно; выборка возобновляется **строго после** названной им позиции. Отсутствие или пустая строка означают «возобновить с сохранённой позиции чтения этого устройства» (см. `read_through`), то есть с головы mailbox, пока устройство ничего не рассудило; явный `"0"` поэтому всегда означает полный повторный обход. Токен, который этот relay не мог выдать, — ошибка клиента: HTTP 400 `INVALID_SCHEMA`. Challenge потребляется тем poll, который его использует, поэтому каждая страница обхода требует своего challenge.

`read_through` (необязательная строка) — **устойчивая позиция чтения** получателя: наибольшая выданная сервером позиция, которую это устройство рассудило — приняло *или окончательно отвергло*. Это тот же непрозрачный десятичный токен, что и `cursor`, с тем же правилом формы, и дополнительно отвергается HTTP 400 `INVALID_SCHEMA`, если она выше любой позиции, когда-либо выделенной этому mailbox. Значение входит в подписываемую строку (`v2`, см. выше). Relay хранит её на пару `(mailbox, device)` и двигает **только вперёд**: меньшее значение игнорируется, отката не существует. Восстановление после слишком далеко ушедшей метки — явный `cursor`, а не откат.

Получатель сообщает позицию страницы *k* в запросе страницы *k+1*, поэтому прогресс переживает прерванный обход — `429` от лимитера, таймаут запроса, Ctrl-C оператора, убитый процесс — ценой не более одной повторно прочитанной страницы. Поле едет на poll, а не на ack, чтобы обход, ничего не принявший, записал рассуженное, не делая ack-запроса, который запрещён гарантией «ничего не подтверждается».

Проверки:

* challenge существует, не использован и не истек (иначе HTTP 400 `CHALLENGE_EXPIRED`);
* mailbox/device запроса совпадают с сохраненными в challenge (иначе HTTP 403 `UNAUTHORIZED_MAILBOX_ACCESS`);
* подпись корректна;
* опубликованное устройство принадлежит identity, из которой выводится запрашиваемый mailbox.

После успешной проверки подписи handler атомарно потребляет challenge перед чтением очереди: транзакция повторно проверяет существование, used и expiry и удаляет запись. При конкурентном poll ровно один запрос может потребить challenge; проигравший получает HTTP 400 `CHALLENGE_EXPIRED`. Ошибки хранения возвращаются как HTTP 500 `INTERNAL_ERROR`. Клиент получает новый challenge для следующего poll, в том числе после ошибки чтения очереди.

Response:

```json
{
  "ok": true,
  "data": {
    "envelopes": [
      {"type": "mailbox_envelope", "...": "..."}
    ],
    "next_cursor": null
  }
}
```

`next_cursor` имеет тип `string | null`. Значение не-null означает, что ответ был обрезан лимитом батча или бюджетом байт и в mailbox остались невыданные конверты; `null` означает, что mailbox опустошен. Токен непрозрачен и формируется сервером.

Это одновременно сигнал «есть ещё» **и позиция возобновления**: значение равно **назначенной relay позиции последнего конверта на этой странице**, поэтому poll, вернувший его в поле `cursor` (или в `read_through`), продолжает строго после него. Пока `next_cursor` не был позицией возобновления, каждый poll заново выбирал конверты с головы префикса, а поскольку окончательно отвергнутый конверт сознательно никогда не подтверждается, отправитель, заполнивший одно окно выборки, удерживал его, и легитимные конверты за ним не выдавались никогда (round-2 finding R2-001, путь B).

**Порядок выдачи принадлежит relay, а не отправителю.** Конверты выдаются в том порядке, в каком relay их принял, по индексу порядка на mailbox, который пишется внутри той же транзакции хранения. Вторая половина ключа хранения — присланный отправителем `envelope_id`, а правило формы идентификатора допускает ~10²⁸ значений, сортирующихся раньше любого случайного UUIDv4, поэтому обход по байтовому порядку ключа позволял отправителю выбрать себе место в очереди — в том числе впереди конверта, который mailbox уже хранил (finding T5-F-001). Позиция никогда не выводится из значения, присланного отправителем.

Два следствия, оба сознательные:

* выдается **позиция**, а не ключ: курсор, выведенный из ключа, вернул бы в протокол строку, выбранную атакующим. Поскольку позиция — это собственное место конверта в mailbox, а не счетчик выданных конвертов, подтверждение или истечение конверта между двумя страницами одного обхода больше не сдвигает последующие позиции, и прежнее окно пропуска/повтора закрыто. Это существенно теперь, когда poll без курсора возобновляется с сохраненной позиции чтения: пропущенный конверт иначе был бы пропущен навсегда;
* курсор находится **вне подписываемой строки challenge** (`read_through`, способный сдвинуть метку, — внутри неё), а синтаксически корректная позиция за пределами очереди отвечается пустой финальной страницей, а не ограниченным 4xx. Курсоры ограничены на сервере (15 десятичных цифр), нечисловые и слишком длинные токены отвергаются HTTP 400 `INVALID_SCHEMA`.

### 9.8. `POST /v1/mailbox/ack`
Назначение: подтвердить успешную обработку выданных envelope.

Подписывается точная UTF-8 строка:

```text
echolet-mailbox-ack:v1:{recipient_mailbox_id}:{device_id}:{sorted_envelope_ids_joined_with_comma}
```

Если запрос несёт необязательное поле `read_through` (та же устойчивая позиция чтения, что и в §9.7), подписывается вместо неё строка `v2`:

```text
echolet-mailbox-ack:v2:{recipient_mailbox_id}:{device_id}:{sorted_envelope_ids_joined_with_comma}:{read_through}
```

Правила формы, верхняя граница и хранение метки — те же, что в §9.7. CLI сообщает позицию на poll, а не здесь, чтобы обход, ничего не принявший, не делал ack-запроса.

Envelope IDs сортируются лексикографически и соединяются запятой без пробелов; дубликаты не удаляются при построении подписи. Relay проверяет ownership устройства и подпись, затем удаляет указанные IDs в этом mailbox. Связь с ранее выданной poll-порцией не проверяется. В ack нет challenge, nonce или timestamp; повторный запрос допустим, `acked` равен длине переданного списка, а не числу фактически удаленных записей. Это не E2EE receipt о доставке собеседнику.


Request body:

```json
{
  "recipient_mailbox_id": "base64url(bytes)",
  "device_id": "uuid-v7",
  "envelope_ids": ["uuid-v7", "uuid-v7"],
  "signature": "base64url(signature-over-ack-message)"
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "acked": 2
  }
}
```

---

## 10. Flow 1: создание identity и первого устройства

### 10.1. Цель
Создать identity, локально сохранить seed и подготовить первое устройство к публикации на репитере.

### 10.2. Шаги клиента
1. Сгенерировать 24-word seed.
2. Показать seed пользователю и заставить подтвердить сохранение.
3. Вывести `Identity Key Pair`.
4. Сгенерировать `device_id`.
5. Сгенерировать `Device Key Pair`.
6. Создать `Signed Device Record`.
7. Сгенерировать callsign.
8. Сохранить все локально.

### 10.3. Acceptance criteria
* identity pubkey стабилен при повторном импорте той же seed;
* device record проходит локальную проверку подписи;
* seed отсутствует в незашифрованной app database.

---

## 11. Flow 2: подключение к Home Base и публикация device record

### 11.1. Входные данные
* `relay_base_url`;
* `relay_pubkey` или relay fingerprint, если используется pinning;
* локальный `Signed Device Record`.

### 11.2. Шаги клиента
1. Сохранить relay config.
2. Выполнить health-check к репитеру.
3. Отправить `POST /v1/device-records/publish`.
4. Проверить `ok == true`.
5. Пометить устройство как `published`.

### 11.3. Ошибки
* `INVALID_SIGNATURE`
* `RELAY_UNAVAILABLE`
* `PAYLOAD_TOO_LARGE`

### 11.4. Acceptance criteria
* устройство видно как опубликованное локально;
* повторная публикация idempotent или безопасно обновляет запись.

---

## 12. Flow 3: публикация prekey bundle

### 12.1. Шаги клиента
1. Сгенерировать `signed_prekey`.
2. Сгенерировать пул `one_time_prekeys`.
3. Собрать `PreKey Bundle`.
4. Подписать bundle identity key.
5. Отправить `POST /v1/prekeys/publish`.
6. Сохранить локально `published_bundle_id` и count prekeys.

### 12.2. Ротация
Клиент SHOULD перепубликовывать bundle если:

* `signed_prekey` скоро истечет;
* число доступных `one_time_prekeys` стало меньше порога, например 10;
* устройство было переинициализировано.

### 12.3. Acceptance criteria
* репитер возвращает число сохраненных prekeys;
* клиент умеет определить, что bundle надо обновить.

---

## 13. Flow 4: добавление контакта через QR

### 13.1. Содержимое QR
QR MUST включать минимум:

```json
{
  "type": "echolet_contact_qr",
  "version": 1,
  "identity_id": "base64url(identity_pubkey)",
  "callsign": "AD-77-SKY",
  "relay_hint": "https://relay.example.com",
  "device_record": {"...": "..."}
}
```

### 13.2. Шаги получателя
1. Сканировать QR.
2. Проверить схему.
3. Проверить подпись `device_record`.
4. Вычислить safety number.
5. Показать UI подтверждения.
6. После подтверждения сохранить контакт.

### 13.3. Acceptance criteria
* контакт получает `trust_state = verified` только после явного подтверждения пользователя;
* нельзя silently импортировать неподписанный `device_record`.

---

## 14. Flow 5: добавление контакта через invite

### 14.1. Упрощение MVP
Invite flow MUST быть проще QR, но безопаснее, чем ввод одного callsign.

Invite MAY содержать:

* `identity_id`;
* `callsign`;
* `relay_hint`;
* `device_record`;
* короткий invite token.

### 14.2. Правило безопасности
Клиент MUST показывать identity fingerprint и просить пользователя подтвердить импорт контакта. Автоматическое доверие invite запрещено.

---

## 15. Flow 6: получение prekey bundle контакта

### 15.1. Шаги
1. Выбрать контакт.
2. Определить `relay_hint` контакта.
3. Запросить `GET /v1/prekeys/:identityId`.
4. Проверить signature bundle.
5. Проверить, что `device_record` контакта известен или может быть импортирован безопасно.
6. Сохранить bundle в cache.

### 15.2. Failure handling
Если bundle недоступен:

* клиент SHOULD показать статус `contact unavailable`;
* клиент MAY поставить сообщение в локальную pending-очередь;
* клиент MUST NOT создавать fake session без валидного bootstrap.

---

## 16. Flow 7: создание первой session

### 16.1. Шаги отправителя
1. Взять `PreKey Bundle` получателя.
2. Выполнить `X3DH` или библиотечный эквивалент.
3. Создать session state.
4. Сохранить session локально.
5. Сформировать первое encrypted message.

### 16.2. Шаги получателя
1. Получить envelope.
2. Извлечь bootstrap data.
3. Использовать подходящий prekey.
4. Создать session state.
5. Подтвердить успешную расшифровку.

### 16.3. Consumption rule
Если использован `one_time_prekey`, он MUST быть помечен как consumed и не должен использоваться второй раз.

---

## 17. Flow 8: отправка текстового сообщения

### 17.1. Шаги отправителя
1. Создать plaintext `chat_message`.
2. Выбрать активную сессию с `recipient_device_id`.
3. Зашифровать plaintext.
4. Собрать `Mailbox Envelope`.
5. Сохранить сообщение локально со статусом `queued`.
6. Отправить `POST /v1/messages/send`.
7. При успешном ответе обновить статус на `relayed`.

### 17.2. Envelope expiration
Для текстовых сообщений `expires_at_ms` SHOULD быть `created_at_ms + 7 days`.

### 17.3. Retry policy
Если отправка не удалась по сети:

* попытка 1: сразу повторить;
* попытка 2: через 5 секунд;
* попытка 3: через 30 секунд;
* дальше — экспоненциальный backoff до разумного лимита.

После превышения лимита сообщение MUST получить статус `failed`, но оставаться доступным для ручного повтора.

---

## 18. Flow 9: mailbox challenge и poll

### 18.1. Вычисление mailbox id
Для MVP допускается простая детерминированная схема:

```text
recipient_mailbox_id = base64url_no_padding(SHA256(UTF8(identity_id + ":mailbox:v1")))
```

Хешируется строковое представление identity key, не декодированные байты. Дополнительного salt в текущем v1 нет; его добавление изменит адреса и требует отдельной миграции протокола.

### 18.2. Шаги клиента
1. Вычислить `recipient_mailbox_id`.
2. Подписать create-challenge строку из §9.6 ключом устройства и передать `signature` в `POST /v1/mailbox/challenge`.
3. Получить `challenge_id`, `nonce`, `expires_at_ms`.
4. Подписать строку вида:

`echolet-mailbox-challenge:v1:{challenge_id}:{recipient_mailbox_id}:{device_id}:{nonce}`

5. Вызвать `POST /v1/mailbox/poll`.
6. Получить список envelope.
7. Расшифровать каждый envelope локально.
8. Для успешно обработанных элементов подписать ack строку из §9.8 ключом устройства и вызвать `POST /v1/mailbox/ack`.

### 18.3. Репитер MUST
* инвалидировать challenge после использования или истечения TTL;
* не выдавать mailbox без валидной подписи;
* ограничивать частоту challenge-запросов.

---

## 19. Flow 10: обработка входящего сообщения

### 19.1. Шаги клиента
1. Получить envelope из mailbox.
2. Проверить schema и TTL.
3. Найти или инициализировать session.
4. Расшифровать payload.
5. Провалидировать plaintext schema.
6. Записать сообщение в локальную БД как `incoming`.
7. Отправить зашифрованный receipt `delivered` обратно отправителю.

### 19.2. Ошибки обработки
Если envelope невозможно расшифровать:

* клиент MUST записать локальный diagnostic event;
* envelope MAY не ack-аться сразу, если есть шанс повторной обработки;
* после лимита неудачных попыток envelope SHOULD быть помечен как poisoned и не должен бесконечно ломать polling.

---

## 20. Flow 11: receipts

### 20.1. Delivered receipt
После успешной расшифровки и записи входящего сообщения клиент SHOULD отправить `receipt` со статусом `delivered`.

### 20.2. Read receipt
`read` не обязателен для MVP. Если добавляется, он MUST быть отдельным зашифрованным payload и иметь пользовательскую настройку отключения.

### 20.3. Idempotency
Повторный receipt с тем же `receipt_id` MUST безопасно игнорироваться.

---

## 21. Ошибки и коды отказов

### 21.1. Стандартные коды API репитера
* `INVALID_JSON`
* `INVALID_SCHEMA`
* `INVALID_SIGNATURE`
* `UNKNOWN_DEVICE`
* `UNAUTHORIZED_MAILBOX_ACCESS`
* `PREKEY_BUNDLE_NOT_FOUND`
* `PREKEY_BUNDLE_UNAVAILABLE`
* `MAILBOX_NOT_FOUND`
* `CHALLENGE_EXPIRED`
* `RATE_LIMITED`
* `QUOTA_EXCEEDED`
* `SENDER_QUOTA_EXCEEDED`
* `PAYLOAD_TOO_LARGE`
* `INTERNAL_ERROR`

Три из них CLI-прототип сообщает оператору под собственным именем, а не сводит к общему `PROTOCOL_REJECTED`, потому что ни один из них не является нарушением доверия. Код выхода у всех трёх — **3**; различается только сообщаемый код:

| Код | HTTP | Маршрут | Смысл для оператора |
|---|---|---|---|
| `PREKEY_BUNDLE_UNAVAILABLE` | 404 | `POST /v2/prekeys/claim` | Нет доступного bundle для этого получателя: он уже востребован (один опубликованный bundle обслуживает ровно одного первого отправителя), никогда не публиковался, вышел из окна действия, либо селектор `device_id` не совпал ни с одним доступным bundle. |
| `UNAUTHORIZED_MAILBOX_ACCESS` | 403 | `send`, `poll`, `ack` | Relay не хранит опубликованный Device Record для этого отправителя или получателя. `send` предполагает предварительный `relay publish`. |
| `SENDER_QUOTA_EXCEEDED` | 403 | `send` | Отправитель уже занял всю свою квоту неподтверждённых конвертов в этом mailbox. Состояние временное и принадлежит получателю: освобождается при ack или истечении срока. |

### 21.2. Клиентские статусы
Клиент SHOULD различать:

* `network_error`
* `relay_unreachable`
* `invalid_contact_data`
* `crypto_init_failed`
* `decrypt_failed`
* `session_missing`

---

## 22. Минимальные ограничения и лимиты MVP

### 22.1. Рекомендуемые лимиты
* `MAX_MESSAGE_BYTES = 256 KB`
* `MAILBOX_TTL = 7 days`
* `CHALLENGE_TTL = 60 seconds`
* `PREKEY_MIN_COUNT = 20`
* `PREKEY_REFILL_THRESHOLD = 10`
* `MAX_MAILBOX_BATCH = 100 envelopes`

### 22.2. Почему лимиты важны
Они MUST быть захардкожены или вынесены в config, чтобы бесплатная модель не оставляла их недоопределенными.

---

## 23. Минимальный план реализации по модулям

### 23.1. Порядок разработки
Реализация должна идти в таком порядке:

1. `shared/types` — все JSON-схемы и валидаторы.
2. `client/identity` — seed, keys, callsign, device record.
3. `relay/device-records` — publish device record.
4. `relay/prekeys` — publish/get bundle.
5. `client/contacts` — QR import/export.
6. `client/sessions` — bootstrap + local session store.
7. `relay/messages` — send envelope.
8. `relay/mailbox` — challenge, poll, ack.
9. `client/inbox-outbox` — send, poll, decrypt, receipts.
10. `client/ui` — onboarding, contacts, chat, terminal.

### 23.2. Definition of done для каждого модуля
Каждый модуль считается завершенным, если у него есть:

* входные и выходные типы;
* happy-path unit test;
* минимум один failure test;
* лог-события для диагностики.

---

## 24. Разбиение задач для слабой модели

### 24.1. Atomic task template
Любая реализация должна браться маленькими задачами. Формат одной задачи:

* **Цель** — что именно делаем;
* **Файлы** — какие файлы создать/изменить;
* **Входы** — какие типы и функции уже существуют;
* **Шаги** — последовательность действий;
* **Проверка** — какие тесты или ручные проверки доказуют готовность.

### 24.2. Пример atomic task
**Задача:** реализовать валидатор `Signed Device Record`.

* Создать `shared/types/deviceRecord.ts`.
* Описать TypeScript type `DeviceRecord`.
* Добавить функцию `validateDeviceRecord(input): Result`.
* Проверять обязательные поля, `type`, `version`, непустой `device_id`, наличие `signature`.
* Добавить unit tests для valid и invalid payload.

### 24.3. Запрет на большие прыжки
Команда MUST не давать слабой модели задачи вида "реализуй весь messaging stack". Правильный масштаб — 1 файл, 1 модуль, 1 flow, 1 тестовый набор.

---

## 25. План работ по спринтам

### Sprint 1: Foundations
* типы и валидаторы;
* identity generation;
* device record creation;
* local storage abstractions.

### Sprint 2: Relay bootstrap
* publish device record;
* publish/get prekey bundle;
* relay health endpoint;
* базовые error codes.

### Sprint 3: Contacts + first session
* QR export/import;
* contact store;
* bootstrap первой сессии;
* session persistence.

### Sprint 4: Messaging
* send envelope;
* outbox;
* mailbox challenge/poll/ack;
* inbox decrypt flow.

### Sprint 5: Reliability
* receipts;
* retry/backoff;
* poisoned envelope handling;
* terminal diagnostics.

### Sprint 6: Hardening
* quotas;
* rate limits;
* TTL cleanup;
* key rotation reminders.

---

## 26. Тестовый план MVP

### 26.1. Обязательные e2e сценарии
1. Новый пользователь создает identity.
2. Публикует device record и prekey bundle.
3. Второй пользователь импортирует контакт по QR.
4. Отправляет первое сообщение.
5. Получатель забирает сообщение через mailbox poll.
6. Отправитель получает `delivered` receipt.

### 26.2. Negative tests
* invalid signature на device record;
* invalid signature на bundle;
* challenge expired;
* oversize message rejected;
* missing prekey bundle;
* decrypt failure не ломает polling loop.

### 26.3. Manual verification checklist
* seed не виден в обычной БД;
* mailbox не читается без challenge подписи;
* relay не видит plaintext message body;
* повторный `ack` не ломает состояние;
* одноразовый prekey не используется повторно.

---

## 27. Итоговая реализационная позиция
Если команда реализует все MUST-пункты этого документа, получится совместимый relay-first MVP Echolet.

Если нужно упростить еще сильнее, упрощать разрешается только так:

* один relay на пользователя;
* одно устройство на пользователя;
* только QR contact exchange;
* только текстовые сообщения;
* только `delivered` receipt.

Нельзя упрощать за счет следующих свойств:

* подписи device records;
* публикации prekey bundle;
* challenge-response на mailbox;
* E2EE payload;
* локального безопасного хранения seed.
