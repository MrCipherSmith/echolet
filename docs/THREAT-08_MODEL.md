# Echolet: Threat Model & Security Boundaries (THREAT-08)

## 1. Назначение документа
Этот документ фиксирует формальную threat model для MVP Echolet. Его задача — не обещать больше, чем система реально защищает, и дать разработчику конкретный список угроз и защит.

Документ предназначен для:

* архитекторов;
* разработчиков клиента;
* разработчиков репитера;
* авторов тестов;
* даже слабых моделей, которым нужен четкий список security-требований.

---

## 2. Security goals MVP

Это целевые требования, а не подтверждение готовности прототипа. HTTP JSON over TLS — транспорт MVP; локальный HTTP допускается только для разработки. TLS скрывает JSON от сетевого наблюдателя, но не от оператора relay. Свой relay меняет сторону доверия, не доказывает сравнительное уменьшение утечки метаданных.


### 2.1. Цели
MVP должен обеспечивать:

* конфиденциальность содержимого сообщений;
* аутентичность identity и устройств контакта;
* защиту mailbox от неавторизованного чтения;
* ограничение replay и spam-abuse в базовых сценариях;
* безопасное локальное хранение seed и session secrets.

### 2.2. Нецели
MVP не обязан обеспечивать:

* сильную сетевую анонимность;
* сокрытие факта использования Echolet;
* устойчивость к глобальному активному противнику с полной сетевой видимостью;
* невидимость для OS push provider;
* безопасность украденного разблокированного устройства.

---

## 3. Активы, которые нужно защищать

### 3.1. Критические активы
* `seed phrase`
* `identity private key`
* `device private key`
* session state / ratchet state
* plaintext messages
* prekeys до публикации

### 3.2. Важные активы
* список контактов
* trust state контактов
* метаданные локальной БД
* mailbox contents в зашифрованном виде
* relay config и relay fingerprint

### 3.3. Менее чувствительные, но значимые активы
* callsign
* device labels
* telemetry logs без plaintext
* delivery timestamps

---

## 4. Противники

### 4.1. Passive Network Observer
Видит сетевые подключения, время, объем трафика, IP и частоту запросов, но не может модифицировать трафик.

### 4.2. Active Network Attacker
Может пытаться:

* подменять ответы;
* повторно проигрывать пакеты;
* ломать соединение;
* навязывать downgrade-поведение;
* flood'ить relay/API.

### 4.3. Malicious Relay Operator
Контролирует репитер, через который идут prekey и mailbox операции.

Он может:

* видеть время обращений;
* видеть размеры сообщений;
* видеть открытые identity/device IDs отправителя и получателя и связывать стороны передачи;
* выводить mailbox из публичного identity key (суффикс `mailbox:v1` не секретен);
* удалять, задерживать или не отдавать сообщения;
* читать хранимые ciphertext и открытые поля envelope без прохождения собственного API;
* пытаться подсовывать неверные bundle при отсутствии проверки подписей.

Он не должен иметь возможность:

* расшифровать содержимое сообщений;
* подделать identity при корректной проверке подписей клиентом.

### 4.4. Malicious Contact
Валидный пользователь, который хочет:

* спамить invites и messages;
* подсовывать некорректные payloads;
* ломать UI или хранилище oversized/invalid данными.

### 4.5. Lost or Stolen Device Attacker
Получает физический доступ к устройству.

Различаются два режима:

* устройство заблокировано;
* устройство уже разблокировано и приложение доступно.

### 4.6. Compromised Mobile OS / Malware
Если устройство полностью скомпрометировано, MVP не гарантирует безопасность plaintext и session state. Это должно быть явно признано как ограничение модели.

---

## 5. Границы доверия

### 5.1. Trusted boundary
Доверенными считаются только:

* локальное приложение на контролируемом устройстве пользователя;
* OS secure storage / Keychain / Keystore в нормальном состоянии;
* локальная проверка криптографических подписей;
* выбранные и проверенные криптобиблиотеки.

### 5.2. Semi-trusted boundary
`Home Base` считается операционно доверенным для доступности, но **не доверенным для plaintext и identity truth**.

То есть:

* relay может хранить сообщения;
* relay не должен быть источником истины для личности;
* relay нельзя доверять содержимое в открытом виде.

### 5.3. Untrusted boundary
Недоверенными считаются:

* сеть;
* внешний transport;
* любые публичные relays;
* invite codes из внешних источников до верификации;
* callsign как строка без fingerprint-подтверждения.

---

## 6. Основные attack surfaces

### 6.1. Client onboarding
Риски:

* seed показан небезопасно;
* seed случайно сохраняется в логах;
* слабая генерация случайности;
* пользователь не понимает важность backup.

### 6.2. Contact exchange
Риски:

* подмена QR/invite;
* phishing через похожий callsign;
* доверие к alias без fingerprint.

### 6.3. PreKey publication and fetch
Риски:

* подмена bundle;
* истекшие или повторно используемые prekeys;
* нехватка one-time prekeys.

### 6.4. Mailbox API
Риски:

* угадывание mailbox id;
* чтение чужого mailbox;
* replay challenge;
* flood mailbox большими payload.

### 6.5. Message processing
Риски:

* decrypt crash;
* poisoned payload;
* repeated delivery;
* некорректные receipts.

### 6.6. Local storage
Риски:

* plaintext messages в открытой БД;
* ключи в незашифрованных prefs;
* debug logs с чувствительными данными.

---

## 7. Угрозы и обязательные митигации

## 7.1. T-001: Кража или утечка seed-фразы
**Сценарий:** seed попадает в логи, screenshot storage, обычную БД или clipboard.

**Последствия:** полный захват identity.

**Митигации:**
* seed MUST храниться только в secure storage;
* seed MUST NOT логироваться;
* seed SHOULD показываться пользователю минимальное время;
* экран seed SHOULD запрещать случайные аналитические события и debug print;
* clipboard export seed SHOULD быть запрещен в MVP.

## 7.2. T-002: Подмена контакта по callsign
**Сценарий:** злоумышленник использует похожий callsign и убеждает пользователя, что это нужный контакт.

**Последствия:** пользователь начинает защищенный чат не с тем человеком.

**Митигации:**
* callsign MUST считаться только UX-алиасом;
* контакт MUST отображать fingerprint;
* импорт invite MUST требовать явного подтверждения;
* verified state MUST выдаваться только после QR или safety number verification.

## 7.3. T-003: Подмена Signed Device Record
**Сценарий:** relay или сеть подсовывает фальшивый device record.

**Последствия:** hijack первой сессии.

**Митигации:**
* клиент MUST проверять подпись device record identity key;
* неподписанный или неверно подписанный record MUST быть отвергнут;
* identity pubkey MUST совпадать с ожидаемым contact identity.

## 7.4. T-004: Подмена PreKey Bundle
**Сценарий:** relay отдает подмененный bundle.

**Последствия:** злоумышленник пытается перехватить bootstrap session.

**Митигации:**
* bundle MUST быть подписан identity key;
* клиент MUST проверять подпись до использования;
* истекший bundle MUST быть отвергнут;
* device_id из bundle SHOULD совпадать с известным `device_record` или безопасно импортироваться.

## 7.5. T-005: Неавторизованное чтение mailbox
**Сценарий:** злоумышленник угадывает mailbox id и вызывает poll.

**Последствия:** утечка ciphertext и метаданных.

**Митигации:**
* mailbox poll MUST требовать challenge-response;
* challenge MUST иметь короткий TTL;
* challenge MUST инвалидироваться после использования;
* poll MUST быть rate-limited;
* mailbox id SHOULD быть непредсказуемым без знания identity.

## 7.6. T-006: Replay mailbox challenge
**Сценарий:** ранее перехваченный challenge response воспроизводится повторно.

**Последствия:** потенциальный повторный доступ к mailbox.

**Митигации:**
* каждый challenge MUST иметь уникальный `challenge_id` и `nonce`;
* challenge MUST быть single-use;
* expired challenge MUST отклоняться;
* poll SHOULD фиксировать результат потребления challenge без секретов; ack в текущем API не использует challenge.

## 7.7. T-007: Replay message envelope
**Сценарий:** один и тот же envelope доставляется много раз.

**Последствия:** дубликаты, ломание состояния, UI spam.

**Митигации:**
* `message_id` MUST быть глобально уникальным;
* клиент MUST уметь deduplicate по `message_id`;
* повторный receipt SHOULD быть идемпотентным.

### Текущие границы mailbox auth
Create-challenge, poll и ack требуют подписи ключом опубликованного устройства и совпадения mailbox с derivation из его identity. Это защищает API от других клиентов, но не скрывает ciphertext от владельца сервера. Точные строки подписи приведены в [PROTOCOL-07 §9.6–9.8](PROTOCOL-07_MVP_MESSAGE_FLOW.md#96-post-v1mailboxchallenge).

Create-challenge и ack не содержат nonce/timestamp; повторное предъявление не запрещено. Poll после проверки подписи/ownership атомарно повторно проверяет used/expiry и потребляет challenge в транзакции Badger. Конкурентный повтор не получает очередь: только одна транзакция успешна, остальные возвращают `CHALLENGE_EXPIRED`. Ack разрешает владельцу удалять указанные IDs своего mailbox без доказательства предыдущего poll; счетчик `acked` не подтверждает обработку/расшифровку.

## 7.8. T-008: Oversized payload / resource exhaustion
**Сценарий:** злоумышленник шлет гигантские payloads или flood запросов.

**Последствия:** relay DoS, memory pressure, battery drain клиента.

**Митигации:**
* relay MUST ограничивать `MAX_MESSAGE_BYTES`;
* relay MUST иметь rate limits и quota;
* клиент MUST валидировать размер до обработки;
* mailbox batch size MUST быть ограничен.

## 7.9. T-009: Poisoned ciphertext crash
**Сценарий:** приходит поврежденный или намеренно crafted ciphertext.

**Последствия:** crash клиента или зацикливание inbox processing.

**Митигации:**
* decrypt ошибки MUST обрабатываться без падения процесса;
* envelope SHOULD помечаться как failed attempt;
* после лимита попыток envelope SHOULD quarantine'иться;
* mailbox poll loop MUST продолжать работу для остальных сообщений.

## 7.10. T-010: Утечка plaintext в локальной БД
**Сценарий:** база приложения читается локально без аутентификации.

**Последствия:** раскрытие переписки.

**Митигации:**
* app DB SHOULD быть encrypted at rest;
* seed и private keys MUST храниться отдельно в secure storage;
* автолок приложения SHOULD быть включен;
* plaintext retention SHOULD быть настраиваемым.

## 7.11. T-011: Компрометация репитера
**Сценарий:** оператор репитера злонамерен или сервер взломан.

**Последствия:** удаление, задержка, корреляция, попытки подмены metadata.

**Митигации:**
* relay MUST не иметь plaintext;
* клиент MUST проверять все подписи локально;
* relay MUST быть replaceable без потери identity;
* пользователь SHOULD иметь возможность сменить `Home Base`.

## 7.12. T-012: Потеря устройства
**Сценарий:** устройство потеряно.

**Последствия:** доступ к локальным сессиям и истории, если устройство разблокировано.

**Митигации:**
* biometric app lock SHOULD быть доступен;
* device roster и revoke flow SHOULD быть запланированы во 2-й фазе;
* пользователь MUST иметь recovery path через seed.

---

## 8. Метаданные: что все еще утекает

### 8.1. Что может видеть сеть или relay
Даже при корректном E2EE MVP не скрывает полностью:

* факт использования приложения;
* время подключения к relay;
* приблизительный размер и частоту обмена;
* то, что определенный mailbox регулярно опрашивается.

### 8.2. Почему это допустимо для MVP
Потому что главная цель первой версии — безопасное содержимое и корректная identity/authentication модель. Метаданные будут уменьшаться отдельными фазами позже.

---

## 9. Security requirements checklist

### 9.1. Клиент MUST
* проверять подписи device records;
* проверять подписи prekey bundles;
* не хранить seed в обычной БД;
* не доверять callsign как identity proof;
* делать deduplication по `message_id`;
* переживать decrypt failures без crash.

### 9.2. Репитер MUST
* валидировать схему входящих payloads;
* не отдавать mailbox без challenge-response;
* инвалидировать challenge после использования;
* ограничивать размер payload;
* применять quota и rate limiting;
* очищать записи по TTL.

### 9.3. Команда SHOULD
* использовать mature crypto libraries;
* не писать самодельную криптографию;
* иметь unit tests на negative paths;
* иметь manual checklist на секреты и логи.

---

## 10. Логирование и observability

### 10.1. Что можно логировать
* технические event ids;
* device id;
* envelope id;
* error codes;
* длительность операций;
* количество envelope в batch.

### 10.2. Что нельзя логировать
* seed;
* private keys;
* plaintext message body;
* полные safety numbers, если это не debug-only local mode;
* незащищенные invite payloads с чувствительными данными.

---

## 11. План проверки threat model

### 11.1. Unit tests
* invalid signature rejects;
* expired challenge rejects;
* duplicate `message_id` dedup works;
* oversized payload rejected;
* decrypt failure does not crash.

### 11.2. Integration tests
* malicious relay returns fake bundle -> client rejects;
* mailbox poll without signature -> denied;
* replayed challenge -> denied;
* repeated envelope -> single visible message.

### 11.3. Manual checks
* grep по проекту на вывод seed/private key;
* проверка local DB на отсутствие seed;
* запуск relay с лимитами и проверка quota exhaustion.

---

## 12. Риск-матрица MVP

| Угроза | Вероятность | Ущерб | Приоритет |
| :--- | :--- | :--- | :--- |
| Утечка seed | Средняя | Критический | P0 |
| Подмена контакта | Высокая | Высокий | P0 |
| Подмена prekey bundle | Средняя | Высокий | P0 |
| Чтение mailbox без auth | Средняя | Высокий | P0 |
| Flood/DoS relay | Высокая | Средний | P1 |
| Replay envelope | Средняя | Средний | P1 |
| Crash на poisoned payload | Средняя | Средний | P1 |
| Метаданные у relay | Высокая | Средний | Accepted MVP limitation |
| Компрометация разблокированного устройства | Средняя | Высокий | Accepted OS limitation |

---

## 13. Открытые вопросы после MVP
Следующие темы должны стать отдельными RFC после завершения relay-first версии:

* onion routing threat model;
* direct transport и NAT traversal threat model;
* media capability abuse model;
* multi-device sync consistency model;
* push gateway metadata analysis;
* public relay federation and trust model.

---

## 14. Итог
Если команда придерживается этого документа, Echolet MVP будет честно защищать содержимое сообщений и identity/bootstrap слой без ложных обещаний о полной анонимности.

Для слабой модели главный принцип такой:

* сначала реализуй все `MUST`-митигации из раздела 7 и checklist из раздела 9;
* только потом добавляй UX, discovery и экспериментальные transports.
