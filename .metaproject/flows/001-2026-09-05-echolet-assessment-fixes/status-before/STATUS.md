# Echolet MVP - Статус реализации

## Реально реализовано сейчас

### 1. Монорепа и пакеты

- ✅ `pnpm` workspace и TypeScript base config
- ✅ `packages/protocol` с типами, схемами и валидаторами
- ✅ `packages/client-db` со schema/interface контрактами
- ✅ `packages/client-core` с deterministic identity profile generation и signing helpers
- ✅ `packages/crypto-core` с canonical signatures, mailbox auth helpers и рабочим symmetric session encryption поверх derived shared secret

### 2. Relay

- ✅ Go relay API для device records, prekeys, mailbox, challenge/poll/ack
- ✅ BadgerDB storage layer
- ✅ Криптографическая проверка `device_record` signatures
- ✅ Криптографическая проверка `prekey_bundle` и `signed_prekey` signatures
- ✅ Mailbox ownership checks: `device_id` должен соответствовать mailbox владельца
- ✅ Mailbox `challenge` теперь тоже требует валидную Ed25519 подпись клиента
- ✅ Mailbox `poll` и `ack` требуют валидную Ed25519 подпись запроса
- ✅ Replayed/expired challenge по-прежнему отклоняются

### 3. Mobile

- ✅ `OnboardingScreen` использует один и тот же identity profile для показа seed и relay publish
- ✅ Recovery path через уже существующий seed
- ✅ `App.tsx` теперь реально монтирует onboarding и terminal flow
- ✅ `MessagingScreen` публикует prekey bundle, отправляет encrypted envelope, делает poll/ack и decrypt в mobile runtime
- ✅ `useTerminalStore` и relay API остаются подключенными к экранному flow

### 4. Автотесты

- ✅ Vitest покрывает deterministic identity derivation
- ✅ Vitest покрывает mailbox auth helpers
- ✅ Vitest покрывает session encrypt/decrypt path
- ✅ Vitest покрывает protocol/client-db packages, чтобы workspace test pipeline не падал на пустых пакетах
- ✅ Go tests покрывают relay signature validation и mailbox auth flow

## Что еще НЕ завершено

- ❌ Session layer больше не placeholder, но это все еще не полноценный Signal/libsignal double ratchet
- ❌ Нет полноценного multi-contact UI для contacts/conversations/message sending
- ❌ Нет production-grade bootstrap/session orchestration для реального peer-to-peer chat beyond current demo flow

## Проверки

- ✅ `pnpm typecheck`
- ✅ `pnpm test`
- ✅ `env GOCACHE=/Users/Goodea/goodea/projects/echolet/.gocache go test ./...` из `apps/relay`

## Следующие шаги

1. Довести session/bootstrap до выбранной production-grade library из RFC.
2. Довести demo messaging flow до полноценного multi-contact UX.
3. Добавить integration/e2e tests для первого зашифрованного сообщения в mobile runtime.
4. Расширить negative tests на prekey fetch/send/poll pipeline.
