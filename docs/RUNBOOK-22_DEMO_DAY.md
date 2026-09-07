# Echolet: Demo Day Runbook (RUNBOOK-22)

## 1. Назначение документа
Этот документ описывает точный сценарий демонстрации Echolet MVP. Он нужен, чтобы любой человек или модель могли воспроизвести demo без импровизации.

Runbook рассчитан на локальную демонстрацию relay-first MVP с двумя клиентами:

* пользователь A;
* пользователь B;
* один локальный relay.

---

## 2. Что считается успешной demo
Demo считается успешной, если зритель видит полный рабочий путь:

1. создание identity;
2. публикация identity/device/prekeys;
3. добавление контакта по QR;
4. отправка первого encrypted message;
5. получение сообщения через mailbox poll;
6. получение `delivered` receipt;
7. подтверждение, что relay не видит plaintext;
8. подтверждение, что mailbox нельзя читать без challenge-response.

---

## 3. Минимальная среда для demo

### 3.1. Процессы
Нужно поднять:

* relay server;
* mobile app instance A;
* mobile app instance B.

### 3.2. Устройства
Допустимые варианты:

* два эмулятора;
* один эмулятор и одно реальное устройство;
* два реальных устройства.

### 3.3. Данные
Перед demo желательно иметь чистую среду:

* пустой relay storage;
* очищенные локальные базы клиентов;
* свежий запуск процессов.

---

## 4. Подготовка до начала demo

### 4.1. Проверить окружение
Убедиться, что доступны:

* `Node >= 22`
* `pnpm >= 10`
* `Go >= 1.24`
* mobile runtime / simulator

### 4.2. Подготовить конфигурацию
Убедиться, что:

* relay слушает локальный порт;
* mobile app знает `relay_base_url`;
* secure storage и local db очищены.

### 4.3. Очистка перед демонстрацией
Сделать:

* очистку relay data directory;
* очистку локальных app storage для A и B;
* рестарт relay и mobile apps.

---

## 5. Шаги запуска demo

## Шаг 1. Запустить relay

### Команда
```bash
go run ./apps/relay/cmd/relay
```

### Ожидаемый результат
* relay стартует без crash;
* `GET /health` отвечает успешно.

### Что показать зрителю
* лог запуска relay;
* успешный health-check.

---

## Шаг 2. Запустить mobile app A и B

### Команда
```bash
pnpm mobile:start
```

### Ожидаемый результат
* A и B открываются на стартовом экране;
* оба клиента подключаются к локальной конфигурации.

### Что показать
* оба клиента открыты и готовы к onboarding.

---

## Шаг 3. Создать identity на клиенте A

### Действия
1. На A пройти onboarding.
2. Сгенерировать seed.
3. Подтвердить сохранение seed.
4. Завершить создание profile.

### Ожидаемый результат
* у A есть callsign;
* создан `Identity Key` и `Device Key`;
* device record подготовлен к публикации.

### Что показать
* экран onboarding завершен;
* UI показывает callsign и/или profile summary.

---

## Шаг 4. Опубликовать данные A на relay

### Действия
1. На A сохранить `Home Base` config.
2. Опубликовать `Signed Device Record`.
3. Опубликовать `PreKey Bundle`.

### Ожидаемый результат
* relay принимает оба объекта;
* terminal/log показывает публикацию.

### Что показать
* terminal screen на A;
* relay log без plaintext и без секретов.

---

## Шаг 5. Создать identity на клиенте B

### Действия
Повторить onboarding для B.

### Ожидаемый результат
* у B есть свой callsign и identity.

---

## Шаг 6. Добавить A как контакт на B через QR

### Действия
1. На A открыть `Contacts` и показать QR.
2. На B открыть импорт контакта.
3. B сканирует QR A.
4. B подтверждает fingerprint/safety number.

### Ожидаемый результат
* B видит A как verified contact.

### Что показать
* QR scan;
* UI подтверждения;
* verified state после импорта.

---

## Шаг 7. Отправить первое сообщение с B на A

### Действия
1. На B открыть чат с A.
2. Написать короткое сообщение.
3. Нажать send.

### Ожидаемый результат
* клиент B получает bundle A;
* создается первая session;
* plaintext шифруется;
* на relay уходит `MailboxEnvelope`.

### Что показать
* terminal на B: `bundle fetched`, `session created`, `message sealed`, `queued/relayed`;
* relay log: только envelope/ciphertext metadata, без plaintext body.

---

## Шаг 8. Получить сообщение на A через mailbox poll

### Действия
1. На A выполнить mailbox poll автоматически или вручную.
2. A проходит challenge-response flow.
3. A получает envelope.
4. A дешифрует сообщение.

### Ожидаемый результат
* сообщение появляется в UI на A;
* terminal показывает `challenge requested`, `mailbox polled`, `message decrypted`.

### Что показать
* новое сообщение в чате A;
* terminal flow на A.

---

## Шаг 9. Проверить delivered receipt на B

### Действия
1. A автоматически отправляет `delivered` receipt.
2. B получает receipt.

### Ожидаемый результат
* статус сообщения у B меняется на `delivered`.

### Что показать
* обновление статуса в чате B;
* terminal событие про receipt.

---

## Шаг 10. Показать security assertions

### Проверка A — relay не видит plaintext
Показать:

* relay logs;
* relay storage dump или debug output, если есть безопасный dev tool;
* отсутствие plaintext body в логах.

### Проверка B — mailbox без challenge не читается
Показать:

* запрос без подписи или с невалидной подписью;
* controlled error response.

### Проверка C — oversize payload отклоняется
Показать:

* тестовый oversized request;
* rejection error.

---

## 6. Demo checklist
Перед началом live demo проставить галочки:

* relay стартует;
* mobile app A стартует;
* mobile app B стартует;
* onboarding A работает;
* onboarding B работает;
* device/prekeys publish работает;
* QR import работает;
* send message работает;
* mailbox poll работает;
* delivered receipt работает;
* invalid mailbox access fails;
* no plaintext leaks in relay logs.

---

## 7. Failure handling during demo

### 7.1. Если relay не стартует
План действий:
1. проверить env vars;
2. проверить порт;
3. очистить relay data dir;
4. рестартовать relay.

### 7.2. Если message delivery не проходит
План действий:
1. проверить publish device record;
2. проверить publish prekeys;
3. проверить fetch bundle;
4. проверить mailbox challenge;
5. посмотреть terminal events A и B.

### 7.3. Если UI не обновляет статус
План действий:
1. проверить receipt generation;
2. проверить receipt processing;
3. проверить local messages repository state.

---

## 8. Что не обещать на demo
На MVP demo нельзя обещать то, чего нет:

* full onion anonymity;
* media transfer;
* global callsign discovery;
* stable background delivery на всех платформах;
* anti-DPI transports.

Нужно показывать только relay-first secure text messaging flow.

---

## 9. Evidence to capture
После demo желательно сохранить:

* скрин onboarding A;
* скрин verified contact import на B;
* скрин отправленного и доставленного сообщения;
* лог relay health start;
* лог отрицательного теста mailbox access.

---

## 10. Итог
Этот runbook делает demo воспроизводимой.

Если все шаги проходят по порядку без ручного вмешательства в базу или код, MVP можно считать реально работающим, а не только документированным.
