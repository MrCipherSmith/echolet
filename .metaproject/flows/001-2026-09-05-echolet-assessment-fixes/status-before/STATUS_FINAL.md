# Echolet MVP - Итоговый статус на текущий момент

## Закрыто в коде

- ✅ seed-based identity recovery реализован
- ✅ duplicate identity generation в onboarding устранен
- ✅ relay проверяет подписи `device_record`
- ✅ relay проверяет подписи `prekey_bundle` и `signed_prekey`
- ✅ mailbox `challenge` выдается только устройству, которое реально соответствует mailbox owner
- ✅ mailbox `challenge` теперь требует валидную подпись клиента
- ✅ mailbox `poll` и `ack` отклоняются без валидной подписи
- ✅ app entry больше не заглушка
- ✅ mobile runtime умеет publish prekey bundle, send encrypted envelope, poll mailbox и decrypt message в demo flow
- ✅ критичные TS и Go тесты добавлены и проходят

## Частично закрыто

- ⚠️ Session layer больше не placeholder и умеет шифровать/расшифровывать сообщения, но это еще не финальная production-grade реализация из RFC.

## Не закрыто

- ❌ полноценный multi-contact mobile chat UX
- ❌ финальная session/bootstrap library integration

## Финальные проверки

- `pnpm typecheck` — pass
- `pnpm test` — pass
- `env GOCACHE=/Users/Goodea/goodea/projects/echolet/.gocache go test ./...` — pass
