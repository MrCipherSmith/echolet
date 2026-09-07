# Echolet: JSON Schemas & API Contracts (API-11)

## 1. Назначение документа
Этот документ собирает в одном месте все основные JSON-контракты MVP. Он нужен как copy-paste reference для реализации клиента и репитера.

Если между этим документом и кодом есть расхождение, код должен быть приведен в соответствие со спецификацией или спецификация должна быть обновлена осознанно.

---

## 2. Общие правила

### 2.1. Формат
Все запросы и ответы — `application/json`.

### 2.2. Кодировка бинарных полей
Бинарные поля кодируются как `base64url`.

### 2.3. Время
Все timestamps — `unix milliseconds UTC`.

### 2.4. Версия
Каждый domain object MUST содержать поле `version`.

---

## 3. Domain objects

### 3.1. `DeviceRecord`

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

Обязательные поля:

* `type`
* `version`
* `identity_id`
* `device_id`
* `device_pubkey`
* `capabilities`
* `created_at_ms`
* `signature`

### 3.2. `PreKeyBundle`

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
    "signature": "base64url(signature)"
  },
  "one_time_prekeys": [
    {
      "key_id": "otk-001",
      "public_key": "base64url(bytes)"
    }
  ],
  "created_at_ms": 1770000000000,
  "signature": "base64url(signature-by-identity-key)"
}
```

### 3.3. `MailboxEnvelope`

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

`sender_signature` is the sender's ed25519 signature, base64url without padding and
bounded at 256 bytes, over the plain UTF-8 transcript

```
echolet-mailbox-envelope:v1:<recipient_mailbox_id>:<envelope_id>:<sender_identity_id>:<sender_device_id>:<base64url_raw(SHA-256(utf8(ciphertext)))>:<created_at_ms>:<expires_at_ms>
```

`POST /v1/messages/send` requires it and verifies it against the `device_pubkey`
of the sender's already-published, root-signed `DeviceRecord`, resolved through
the same `(mailbox identity, device UUID)` binding the mailbox challenge, poll and
ack routes use. An envelope whose sender cannot be authenticated is refused with a
bounded 4xx before storage. The field is optional in the parsing schema and is
omitted, never empty, for records stored before it existed.

`size_bytes` is not advisory. The relay measures the actual `ciphertext` length
and refuses `size_bytes != len(ciphertext)` with `400 INVALID_SCHEMA`, so the
field cannot be used to understate a payload against the message-size bound.

### 3.4. `ChatMessage`

```json
{
  "type": "chat_message",
  "version": 1,
  "message_id": "uuid-v7",
  "conversation_id": "conversation-id",
  "sender_identity_id": "base64url(identity_pubkey)",
  "sender_device_id": "uuid-v7",
  "created_at_ms": 1770000000000,
  "body": "hello world",
  "reply_to_message_id": null
}
```

### 3.5. `Receipt`

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

Допустимые `status`:

* `queued`
* `relayed`
* `delivered`
* `read`

### 3.6. `ContactQrPayload`

```json
{
  "type": "echolet_contact_qr",
  "version": 1,
  "identity_id": "base64url(identity_pubkey)",
  "callsign": "AD-77-SKY",
  "relay_hint": "https://relay.example.com",
  "device_record": {
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
    "signature": "base64url(signature)"
  }
}
```

---

## 4. API response envelope

### 4.1. Success

```json
{
  "ok": true,
  "data": {}
}
```

### 4.2. Error

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_SIGNATURE",
    "message": "signature verification failed"
  }
}
```

---

## 5. `POST /v1/device-records/publish`

### Request

```json
{
  "device_record": {
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
    "signature": "base64url(signature)"
  }
}
```

### Success response

```json
{
  "ok": true,
  "data": {
    "stored": true,
    "device_id": "uuid-v7"
  }
}
```

---

## 6. `POST /v1/prekeys/publish`

### Request

```json
{
  "bundle": {
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
      "signature": "base64url(signature)"
    },
    "one_time_prekeys": [
      {
        "key_id": "otk-001",
        "public_key": "base64url(bytes)"
      }
    ],
    "created_at_ms": 1770000000000,
    "signature": "base64url(signature)"
  }
}
```

### Success response

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

---

## 7. `GET /v1/prekeys/:identityId`

### Success response

```json
{
  "ok": true,
  "data": {
    "bundles": [
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
          "signature": "base64url(signature)"
        },
        "one_time_prekeys": [
          {
            "key_id": "otk-001",
            "public_key": "base64url(bytes)"
          }
        ],
        "created_at_ms": 1770000000000,
        "signature": "base64url(signature)"
      }
    ]
  }
}
```

---

## 8. `POST /v1/messages/send`

### Request

```json
{
  "envelope": {
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
}
```

`sender_signature` is required on this route (section 3.3). A missing, malformed,
over-long or non-verifying signature, and a sender the relay holds no published
`DeviceRecord` for, are all refused with a bounded 4xx — `400 INVALID_SCHEMA`,
`403 INVALID_SIGNATURE` or `403 UNAUTHORIZED_MAILBOX_ACCESS` — before anything is
written to the recipient's mailbox.

The route also enforces a **per-sender unacked-envelope quota**: one
`sender_identity_id` may hold at most `ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER`
(default **16**) envelopes that are still live in one `recipient_mailbox_id`.
Beyond that the send is refused with `403 SENDER_QUOTA_EXCEEDED` — a
**non-retryable** 4xx, deliberately not `429`, because a retryable status is
classified by the CLI before the error code is read — and nothing is stored. The
count is of live, non-expired envelopes, so it frees again both when the recipient
acknowledges and when an envelope expires unacknowledged; a byte-identical replay
of an `envelope_id` already stored in that mailbox is exempt and stays a `200`
idempotent replay. The quota is scoped to one recipient mailbox, so a sender at
its allowance with one contact can still write to every other contact.

The default of 16 is chosen against the recipient's bounded drain walk: at the
default `ECHOLET_MAX_MESSAGE_BYTES` the ~1 MiB poll budget admits 3 maximum-size
envelopes per page and the client walks 16 pages, so the walk covers 48 envelopes
and no single identity can fill it. **What the quota does not do:** it bounds one
*sender*, not total mailbox occupancy, and `POST /v1/device-records/publish` is
unauthenticated, so an attacker mints another identity per request. It raises the
cost of the flooding wedge from 1 identity to **4** (byte-bounded) or 50
(count-bounded) — a linear price increase, not a structural fix.

The byte-bounded figure was measured against the relay binary and the real CLI
drain walk: 48 maximum-size poison envelopes still deliver the legitimate message
and 49 wedge, and 3 × 16 = 48 lands on the delivering side, so a 4th identity is
required (`t55-final-verification.md`, Part 1). Earlier text in this repository
said 3; that figure came from `ceil(48/16)` and was off by one.

### Success response

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

---

## 9. `POST /v1/mailbox/challenge`

Транспорт: HTTP JSON over TLS; локальный HTTP — только для разработки. Все mailbox-запросы подписываются Ed25519 ключом опубликованного устройства. Relay выводит mailbox из identity устройства и проверяет совпадение с запросом во всех трех операциях.

Точные UTF-8 входы подписи (без завершающего перевода строки):

```text
create:  echolet-mailbox-create-challenge:v1:{recipient_mailbox_id}:{device_id}
poll:    echolet-mailbox-challenge:v1:{challenge_id}:{recipient_mailbox_id}:{device_id}:{nonce}
poll v2: echolet-mailbox-challenge:v2:{challenge_id}:{recipient_mailbox_id}:{device_id}:{nonce}:{read_through}
ack:     echolet-mailbox-ack:v1:{recipient_mailbox_id}:{device_id}:{sorted_envelope_ids_joined_with_comma}
ack v2:  echolet-mailbox-ack:v2:{recipient_mailbox_id}:{device_id}:{sorted_envelope_ids_joined_with_comma}:{read_through}
```

Версия `v2` подписывается **тогда и только тогда**, когда запрос несёт поле
`read_through` — durable read position получателя (§9.9). Отсутствующее и
присутствующее поле дают разные подписываемые строки, поэтому позицию нельзя
добавить, убрать или изменить в подписанном получателем запросе. Запрос без
`read_through` подписывает `v1` в точности как раньше.

Метки `create:`, `poll:`, `ack:` не входят в подписываемые строки. Список ack сортируется лексикографически, разделитель — запятая без пробелов, дубликаты сохраняются. Подписи кодируются base64url без padding; nonce подписывается дословно из ответа (текущий Go relay использует padded base64url). Реальный challenge ID — UUIDv4, примеры UUIDv7 иллюстративны.

Create и ack не содержат nonce/timestamp и допускают повторное предъявление. Poll проверяет срок, used и привязку challenge к mailbox/device, атомарно повторно проверяет и потребляет его после успешной подписи перед чтением очереди. Только один конкурентный poll может потребить challenge; остальные получают HTTP 400 `CHALLENGE_EXPIRED`. `acked` — длина запрошенного списка, а не число удаленных записей; ack не привязан к предыдущей poll-порции.

Нормативные детали и ограничения: [PROTOCOL-07 §9.6–9.8](PROTOCOL-07_MVP_MESSAGE_FLOW.md#96-post-v1mailboxchallenge).


### Request

```json
{
  "recipient_mailbox_id": "base64url(bytes)",
  "device_id": "uuid-v7",
  "signature": "base64url(signature-over-create-challenge-message)"
}
```

### Success response

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

---

## 10. `POST /v1/mailbox/poll`

### Request

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

`batch_size` (optional, integer 1..`ECHOLET_MAX_MAILBOX_BATCH`) is the client's
requested upper bound on the number of envelopes in this response. It is a
preference: the server cap and an aggregate response-byte budget (1 MiB, matched
to the client's hard response bound) are applied on top of it. A single envelope
at the configured maximum message size is always delivered, so the byte budget
can never starve the mailbox.

`cursor` (optional string) is the `next_cursor` a previous poll returned, echoed
back verbatim, and selection resumes **strictly after** the position it names.
Omitted or empty means "resume at this device's stored read position" (see
`read_through`), which is the head of the mailbox until the device has judged
anything; an explicit `"0"` therefore always requests a full re-walk. A token this
relay could not have issued is a client error: `400 INVALID_SCHEMA`.

`read_through` (optional string) is the recipient's **durable read position**: the
highest server-issued position this device has judged — committed *or permanently
refused*. It is the same opaque, server-issued decimal token `cursor` is, it takes
the same shape rule, and it is additionally refused with `400 INVALID_SCHEMA` when
it is above any position the relay ever allocated for that mailbox. It is
**inside the signed transcript** (`:v2:`, §9), because it decides what the
recipient is offered next: a value that advances the mark past an envelope makes
that envelope unreachable for the rest of its lifetime. The relay stores it per
`(mailbox, device)` and moves it **forward only**; a lower value is ignored, never
a rewind. Recovery from a mark that is too far ahead is an explicit `cursor`, not
a rewind.

The recipient reports the position of page *k* on the request for page *k+1*, so
progress survives an interrupted walk — a rate-limit `429`, a request timeout, an
operator's Ctrl-C, or a process kill — at a cost of at most one repeated page. It
rides on the poll rather than on the ack so that a walk which accepted nothing
still records what it judged without making an ack request, which the
"acknowledges nothing" guarantee forbids.

Every poll needs its own challenge — a challenge is consumed by the poll that
uses it — so a client walking several pages creates one challenge per page.

### Success response

```json
{
  "ok": true,
  "data": {
    "envelopes": [
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
    ],
    "next_cursor": null
  }
}
```

`sender_signature` is served back exactly as accepted, so the recipient can see
which sender the relay admitted. It is omitted — never served as an empty string —
for records stored before the field existed, because the client parses the whole
batch under one strict schema in which it is a non-empty bounded string.

`next_cursor` is `string | null`. It is non-null when the response was cut short
by the batch or byte bound and undelivered envelopes remain, and null when the
mailbox is drained. The token is opaque and server-controlled.

It is both the remaining-work signal **and a resume position**: the value is the
**relay-assigned ordering position of the last envelope on this page**, and a poll
that sends it back as `cursor` (or as `read_through`) resumes *strictly after* it.
Before this became a resume position, every poll re-selected from the head of the
mailbox prefix, and because a permanently rejected envelope is deliberately never
acknowledged, a sender who filled one selection window monopolised it and the
legitimate envelopes behind it were never delivered (round-2 finding
R2-001 path B).

**Selection order is the relay's, not the sender's.** Envelopes are handed out in
the order the relay accepted them, from a per-mailbox ordering index written inside
the store transaction. The storage key's second half is the *sender-supplied*
`envelope_id`, and the identifier rule admits ~10²⁸ values that sort ahead of every
random v4 UUID a client mints, so a byte-order scan over that key let a sender
choose its own queue position — including ahead of an envelope the mailbox already
held. Positions are never derived from any sender-supplied value.

Two consequences the client must accept, both deliberate:

- A **position**, not a key, is issued, because a key-derived cursor would put an
  attacker-chosen string back on the wire. Because the position is the envelope's
  own place in the mailbox rather than a count of envelopes handed out, an
  acknowledgement or an expiry between two pages of one walk no longer shifts
  later positions, so the earlier skip/repeat window is closed. That matters now
  that a cursorless poll resumes at a stored mark: a skipped envelope would
  otherwise be skipped permanently.
- The cursor is **outside the signed challenge transcript** (`read_through`, which
  can move the stored mark, is inside it), and a syntactically valid but
  out-of-range position is answered with an empty final page rather than a bounded
  4xx. Cursors are bounded server-side (15 decimal digits) and non-numeric or
  over-long tokens are refused `400 INVALID_SCHEMA`.

---

## 11. `POST /v1/mailbox/ack`

### Request

```json
{
  "recipient_mailbox_id": "base64url(bytes)",
  "device_id": "uuid-v7",
  "envelope_ids": ["uuid-v7", "uuid-v7"],
  "signature": "base64url(signature-over-ack-message)",
  "read_through": "48"
}
```

`read_through` (optional string) is the same durable read position §10 documents,
carried here for the case where an acknowledgement and a read position are one
signed statement. Same shape rule, same upper bound, same forward-only store, and
the same transcript rule: present means the `:v2:` ack string, absent means the
`:v1:` string unchanged. The CLI reports its position on the **poll** instead, so
that a walk which accepted nothing makes no ack request at all.

### Success response

```json
{
  "ok": true,
  "data": {
    "acked": 2
  }
}
```

---

## 12. `POST /v2/prekeys/publish` and `POST /v2/prekeys/claim`

The v2 Signal bundle routes used by the CLI prototype. The bundle object itself
is specified in [PROTOCOL-30](PROTOCOL-30_SIGNAL_BUNDLE_V2.md); only the request
and response envelopes are contracted here.

### 12.1. Publish request

```json
{
  "bundle": { "type": "signal_prekey_bundle", "version": 2, "...": "..." }
}
```

### 12.2. Publish success response

```json
{
  "ok": true,
  "data": {
    "stored": true,
    "bundle_id": "uuid-v7",
    "claimable": true
  }
}
```

`claimable` is a **required** boolean on every successful publish response. It
reports whether the stored publication is still available for a first-contact
claim: it is the negation of the stored bundle's `claimed` flag, set by
`/v2/prekeys/claim` in the same transaction that removes the availability entry.

It exists because a publish is idempotent, and a repeated publish of an
already-claimed bundle succeeds while restoring nothing: the response is
otherwise byte-identical on the first-store and the re-store paths, so without
this field a client cannot tell a real publication from a recovery attempt that
restored no availability. A re-publish after a claim therefore returns
`"stored": true` with the same `bundle_id` and `"claimable": false`.

Expiry does not enter into the value — validation refuses an out-of-window bundle
before publication reaches storage.

The CLI parses this response under a strict schema in which `claimable` is
required, so a CLI from this tree against a relay predating the field fails with
its own `INVALID_RELAY_RESPONSE`, which reaches the operator as exit 3
`PROTOCOL_REJECTED` (open finding R2-I-003).

### 12.3. Claim

`POST /v2/prekeys/claim` takes `{ "claim_id": uuid, "identity_id": string,
"device_id": uuid|null }` and returns `{ "ok": true, "data": { "bundle": … } }`
with the stored bundle bytes served back unmodified. Behaviour, idempotency and
one-time-prekey reservation are contracted in the CLI prototype
[specification](requirements/echolet-cli-prototype/specification.md).

`404 PREKEY_BUNDLE_UNAVAILABLE` is returned when the availability scan finds no
unexpired, unclaimed bundle for the selector. That covers four conditions, not
only the first: the recipient's published bundle was already claimed, the
recipient never published one, every published bundle is outside its validity
window, or the requested `device_id` selector matches no available bundle. None
of the four is a trust violation.

---

## 13. Standard error codes

```json
[
  "INVALID_JSON",
  "INVALID_SCHEMA",
  "INVALID_SIGNATURE",
  "UNKNOWN_DEVICE",
  "UNAUTHORIZED_MAILBOX_ACCESS",
  "PREKEY_BUNDLE_NOT_FOUND",
  "PREKEY_BUNDLE_UNAVAILABLE",
  "MAILBOX_NOT_FOUND",
  "CHALLENGE_EXPIRED",
  "RATE_LIMITED",
  "QUOTA_EXCEEDED",
  "SENDER_QUOTA_EXCEEDED",
  "PAYLOAD_TOO_LARGE",
  "INTERNAL_ERROR"
]
```

### 13.1. Codes the CLI reports under their own name

Most relay refusals reach the CLI operator flattened into `PROTOCOL_REJECTED`.
Three do not, because flattening them would name a trust violation where there is
none. All three keep **exit code 3**; the distinction is the reported code, not
the exit status.

| Code | HTTP | Route | Reported as | Exit | Meaning for the operator |
|---|---|---|---|---|---|
| `PREKEY_BUNDLE_UNAVAILABLE` | 404 | `/v2/prekeys/claim` | `PREKEY_BUNDLE_UNAVAILABLE` | 3 | No claimable bundle for this recipient — already claimed, never published, expired, or no such device. |
| `UNAUTHORIZED_MAILBOX_ACCESS` | 403 | `/v1/messages/send`, `/v1/mailbox/poll`, `/v1/mailbox/ack` | `UNAUTHORIZED_MAILBOX_ACCESS` | 3 | The relay holds no published device record for this sender or poller. `send` presupposes a prior `relay publish`. |
| `SENDER_QUOTA_EXCEEDED` | 403 | `/v1/messages/send` | `SENDER_QUOTA_EXCEEDED` | 3 | This sender already holds its full unacked allowance in that one recipient mailbox. Temporary and owned by the recipient: it clears on ack or expiry. |

`SENDER_QUOTA_EXCEEDED` is deliberately **403, not 429**: the client classifies a
retryable status before it reads the error code, so a 429 would be reported as a
generic retryable relay outage at exit 4 and the code would be discarded.

---

## 14. Message status model

### Client-side statuses
* `queued`
* `relayed`
* `delivered`
* `failed`

### Rules
* сообщение создается как `queued`;
* после успешного `POST /v1/messages/send` становится `relayed`;
* после входящего `receipt(delivered)` становится `delivered`;
* после превышения retry limit становится `failed`.

---

## 15. Copy-paste verification checklist
Перед реализацией каждого API handler или client request проверь:

1. Есть ли type в `packages/protocol/src/types`.
2. Есть ли schema в `packages/protocol/src/schemas`.
3. Есть ли validator в `packages/protocol/src/validators`.
4. Совпадает ли JSON с этим документом.
5. Есть ли negative test на invalid payload.
