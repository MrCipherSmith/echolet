# Echolet: Security Review Script Before Demo or Milestone Acceptance (CHECK-26)

## 1. Назначение документа
Этот документ задает пошаговый security review script для Echolet MVP. Он нужен, чтобы перед demo или milestone acceptance проверять не только happy path, но и реальные security expectations из threat model.

Документ рассчитан на ручную или полуавтоматическую проверку.

---

## 2. Когда запускать этот script
Security review script должен запускаться обязательно:

* перед milestone `M4` acceptance;
* перед milestone `M5` acceptance;
* перед публичной demo;
* после любых изменений в crypto/session/mailbox flow;
* после изменений в relay validation, rate limits или storage.

---

## 3. Результат проверки
После выполнения script должен быть один из двух статусов:

* `PASS` — критичных проблем не найдено;
* `FAIL` — найден хотя бы один P0 issue.

Если найден P0 issue, demo или milestone acceptance блокируется.

---

## 4. Подготовка к security review

### 4.1. Нужные документы
Использовать как baseline:

* `THREAT-08_MODEL.md`
* `PROTOCOL-07_MVP_MESSAGE_FLOW.md`
* `TEST-16_ACCEPTANCE_CHECKLIST.md`
* `RUNBOOK-22_DEMO_DAY.md`
* `OPS-23_LOCAL_ENV_VARS.md`

### 4.2. Нужная среда
* локально запущенный relay;
* два клиента A и B;
* возможность смотреть relay logs;
* возможность запускать negative API requests.

---

## 5. Security review sequence

## Check 1. Seed handling

### Цель
Проверить, что seed не утекает в небезопасные места.

### Проверки
* seed не сохраняется в обычной БД;
* seed не выводится в логах;
* seed не попадает в debug telemetry;
* seed не хранится в env vars;
* seed display происходит только в onboarding/backup flow.

### PASS если
* seed есть только в secure storage.

### FAIL если
* seed найден в SQLite/JSON/local storage/logs.

---

## Check 2. Private key handling

### Цель
Проверить, что private keys не утекают.

### Проверки
* identity private key не логируется;
* device private key не логируется;
* session secrets не уходят в telemetry;
* private key material не попадает в relay request bodies кроме допустимого public material.

### FAIL если
* любой private key виден вне secure storage / expected memory flow.

---

## Check 3. Callsign trust misuse

### Цель
Проверить, что callsign не используется как security proof.

### Проверки
* contact verification требует fingerprint/safety number или QR-confirmed path;
* invite import не делает контакт автоматически verified;
* UI не скрывает identity mismatch под одинаковым callsign.

### FAIL если
* contact считается trusted только по callsign.

---

## Check 4. DeviceRecord signature validation

### Цель
Проверить, что `Signed Device Record` реально проверяется.

### Проверки
* valid `device_record` публикуется;
* modified `device_record` с той же signature отклоняется;
* invalid signature path не проходит.

### FAIL если
* relay или клиент принимает неподписанный/битый record.

---

## Check 5. PreKey Bundle signature validation

### Цель
Проверить, что `PreKey Bundle` не подменяется silently.

### Проверки
* valid bundle проходит;
* invalid signature rejected;
* expired bundle не используется для session bootstrap.

### FAIL если
* клиент использует bundle без local verification.

---

## Check 6. Mailbox challenge-response enforcement

### Цель
Проверить, что mailbox реально защищен challenge-response.

### Проверки
* poll без challenge невозможен;
* poll с invalid signature невозможен;
* poll с expired challenge невозможен;
* reused challenge невозможен.

### FAIL если
* mailbox можно читать без корректного challenge flow.

---

## Check 7. Relay plaintext exposure

### Цель
Проверить, что relay не видит plaintext сообщений.

### Проверки
* в request body на relay уходит ciphertext envelope, а не body текста;
* relay logs не содержат plaintext message body;
* storage dump relay не содержит plaintext chat messages.

### FAIL если
* найден plaintext message body на relay или в логах.

---

## Check 8. Oversized payload rejection

### Цель
Проверить, что relay не принимает message abuse через large payloads.

### Проверки
* oversized envelope rejected;
* response возвращает controlled error;
* relay process не падает.

### FAIL если
* relay принимает oversized payload или crash'ится.

---

## Check 9. Malformed ciphertext robustness

### Цель
Проверить устойчивость клиента к битым сообщениям.

### Проверки
* broken ciphertext не валит клиент;
* broken envelope не валит polling loop;
* after retry limit envelope quarantine'ится.

### FAIL если
* malformed payload вызывает reproducible crash.

---

## Check 10. Duplicate/replay robustness

### Цель
Проверить, что replay не создает неконтролируемых дублей.

### Проверки
* duplicate `message_id` не создает duplicate visible message;
* duplicate receipt не ломает status state;
* повторный ack не ломает mailbox state.

### FAIL если
* повторы создают неконсистентное состояние.

---

## Check 11. TTL and cleanup behavior

### Цель
Проверить, что expired data удаляется.

### Проверки
* expired challenge cleanup работает;
* expired mailbox envelopes cleanup работает;
* cleanup не удаляет свежие записи ошибочно.

### FAIL если
* TTL policy не исполняется или разрушает актуальные данные.

---

## Check 12. Logging hygiene

### Цель
Проверить, что в логах нет чувствительных данных.

### Проверки
* нет seed;
* нет private keys;
* нет plaintext body;
* terminal diagnostics не показывает секреты.

### FAIL если
* лог содержит любой критический секрет.

---

## 6. Review report format
После проверки заполнить отчет в формате:

```text
Security Review Target: <milestone/demo>
Date: <YYYY-MM-DD>
Status: PASS / FAIL

Checks:
- Seed handling: PASS/FAIL
- Private key handling: PASS/FAIL
- Callsign trust misuse: PASS/FAIL
- DeviceRecord signature validation: PASS/FAIL
- PreKey Bundle signature validation: PASS/FAIL
- Mailbox challenge-response: PASS/FAIL
- Relay plaintext exposure: PASS/FAIL
- Oversized payload rejection: PASS/FAIL
- Malformed ciphertext robustness: PASS/FAIL
- Duplicate/replay robustness: PASS/FAIL
- TTL and cleanup behavior: PASS/FAIL
- Logging hygiene: PASS/FAIL

Critical findings:
- ...

Non-critical findings:
- ...

Decision:
- approve milestone/demo
- block milestone/demo
```

---

## 7. P0 blockers
Следующие находки автоматически блокируют acceptance или demo:

* seed leakage;
* private key leakage;
* mailbox readable without valid challenge-response;
* invalid signature accepted on `DeviceRecord` or `PreKey Bundle`;
* relay plaintext exposure;
* reproducible crash on malformed ciphertext in common path.

---

## 8. P1 findings
Следующие проблемы не всегда блокируют внутренний demo, но должны быть исправлены до public MVP claim:

* duplicate receipts create inconsistent status UI;
* terminal leaks too much metadata;
* cleanup runs inconsistently;
* rate limits configured too loosely.

---

## 9. Quick pre-demo version
Если времени мало, минимально перед demo обязательно проверить 6 вещей:

1. seed not in DB/logs;
2. invalid `DeviceRecord` rejected;
3. invalid `PreKey Bundle` rejected;
4. mailbox poll without valid challenge rejected;
5. relay has no plaintext;
6. malformed envelope does not crash client.

Если хотя бы один из этих пунктов не проверен, demo считается неподготовленной.

---

## 10. Итог
Этот script нужен, чтобы Echolet демонстрировался как security-aware MVP, а не просто как чат с красивым UI.

Перед demo вопрос должен звучать не "работает ли отправка", а "работает ли отправка без нарушения наших own security assumptions".
