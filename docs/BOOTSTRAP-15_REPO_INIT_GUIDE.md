# Echolet: Repository Bootstrap & Local Development Guide (BOOTSTRAP-15)

## 1. Назначение документа
Этот документ описывает пошаговую инициализацию репозитория Echolet MVP. Он нужен для того, чтобы проект можно было поднять с нуля без догадок.

Цель:

* создать монорепу;
* подготовить packages и apps;
* запустить mobile app skeleton;
* запустить relay skeleton;
* создать минимальную рабочую локальную среду.

---

## 2. Предварительные требования

### 2.1. Необходимое ПО
На машине должны быть установлены:

* `Node.js >= 22`
* `pnpm >= 10`
* `Go >= 1.24`
* `Git`
* `Docker` и `Docker Compose` — желательно, но не строго обязательно для первого локального запуска

### 2.2. Для mobile разработки
Нужно одно из:

* iOS Simulator + Xcode
* Android Studio + Emulator
* Expo Go / development build для реального устройства

---

## 3. Целевой начальный результат
После выполнения этого guide в проекте должно быть:

* корневой workspace;
* созданные `apps/` и `packages/`;
* компилирующийся `packages/protocol`;
* запускаемый `apps/relay` с `/health` endpoint;
* запускаемый `apps/mobile` с экраном-заглушкой.

---

## 4. Шаг 1 — Создать корневой workspace

### Создать корневые файлы
Нужно создать:

* `package.json`
* `pnpm-workspace.yaml`
* `.gitignore`
* `.editorconfig`
* `tsconfig.base.json`

### Минимальный `package.json`

```json
{
  "name": "echolet",
  "private": true,
  "packageManager": "pnpm@10",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "test": "pnpm -r test",
    "mobile:start": "pnpm --filter @echolet/mobile start",
    "relay:dev": "go run ./apps/relay/cmd/relay"
  },
  "devDependencies": {
    "typescript": "5.8.x",
    "eslint": "9.x",
    "prettier": "3.x",
    "vitest": "3.x"
  }
}
```

### Минимальный `pnpm-workspace.yaml`

```yaml
packages:
  - apps/*
  - packages/*
```

---

## 5. Шаг 2 — Создать структуру папок

Создать директории:

```text
apps/mobile
apps/relay
packages/protocol
packages/crypto-core
packages/client-db
packages/client-core
docs/specs
docs/plans
docs/rfc
```

Если документы пока лежат в корне, переносить их можно позже. Для старта кода это не blocker.

---

## 6. Шаг 3 — Инициализировать `packages/protocol`

### Создать файлы
* `packages/protocol/package.json`
* `packages/protocol/tsconfig.json`
* `packages/protocol/src/index.ts`
* каталоги `constants`, `types`, `schemas`, `validators`

### Минимальный `package.json`

```json
{
  "name": "@echolet/protocol",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "4.x",
    "uuid": "11.x"
  }
}
```

### Первый результат
После этого package должен хотя бы typecheck'иться с пустым `index.ts`.

---

## 7. Шаг 4 — Инициализировать `packages/crypto-core`

### Создать файлы
* `packages/crypto-core/package.json`
* `packages/crypto-core/tsconfig.json`
* `packages/crypto-core/src/index.ts`

### Зависимости

```json
{
  "dependencies": {
    "tweetnacl": "1.0.x",
    "bip39": "3.x",
    "@noble/hashes": "1.x",
    "@echolet/protocol": "workspace:*"
  }
}
```

### Важно
На этом шаге не писать crypto-логику целиком. Только каркас и package wiring.

---

## 8. Шаг 5 — Инициализировать `packages/client-db`

### Создать файлы
* `packages/client-db/package.json`
* `packages/client-db/tsconfig.json`
* `packages/client-db/src/index.ts`

### Назначение
Пока только структура и exports. Реальные schema/repositories появятся позже по backlog.

---

## 9. Шаг 6 — Инициализировать `packages/client-core`

### Создать файлы
* `packages/client-core/package.json`
* `packages/client-core/tsconfig.json`
* `packages/client-core/src/index.ts`

### Зависимости

```json
{
  "dependencies": {
    "@echolet/protocol": "workspace:*",
    "@echolet/crypto-core": "workspace:*",
    "@echolet/client-db": "workspace:*"
  }
}
```

---

## 10. Шаг 7 — Инициализировать `apps/mobile`

### Вариант запуска
Для MVP рекомендуется создать Expo app и затем привести ее к структуре из `ARCH-09_REPOSITORY_STRUCTURE.md`.

### Практический путь
1. Создать Expo app в `apps/mobile`.
2. Подключить workspace dependencies.
3. Перестроить каталог `src/` под нужную архитектуру.

### Минимальные зависимости

```json
{
  "name": "@echolet/mobile",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "expo start",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "expo": "53.x",
    "react": "19.x",
    "react-native": "0.79.x",
    "zustand": "5.x",
    "@tanstack/react-query": "5.x",
    "@react-navigation/native": "7.x",
    "expo-sqlite": "~15.x",
    "expo-secure-store": "~14.x",
    "expo-local-authentication": "~16.x",
    "expo-camera": "~16.x",
    "nativewind": "4.x",
    "react-native-qrcode-svg": "6.x",
    "@echolet/protocol": "workspace:*",
    "@echolet/crypto-core": "workspace:*",
    "@echolet/client-core": "workspace:*",
    "@echolet/client-db": "workspace:*"
  }
}
```

### Минимальный результат
Приложение должно запускаться и показывать один базовый экран.

---

## 11. Шаг 8 — Инициализировать `apps/relay`

### Создать файлы
* `apps/relay/go.mod`
* `apps/relay/cmd/relay/main.go`
* `apps/relay/internal/config/config.go`
* `apps/relay/internal/api/router/router.go`

### Минимальный `go.mod`

```go
module echolet/apps/relay

go 1.24

require (
  github.com/caarlos0/env/v11 v11.3.1
  github.com/dgraph-io/badger/v4 v4.8.0
  github.com/go-chi/chi/v5 v5.2.2
  github.com/google/uuid v1.6.0
)
```

### Минимальный результат
`go run ./apps/relay/cmd/relay` должен поднимать HTTP server с `GET /health`.

---

## 12. Шаг 9 — Проверить workspace wiring

### Выполнить проверки
Нужно добиться, чтобы выполнялись:

* `pnpm install`
* `pnpm typecheck`
* `go test ./...` внутри `apps/relay`

### Что считать успехом
Если все packages распознаются, import paths не ломаются, а relay стартует — bootstrap выполнен корректно.

---

## 13. Шаг 10 — Первый локальный mobile + relay run

### Запустить relay
Команда:

```bash
go run ./apps/relay/cmd/relay
```

Ожидаемый результат:

* сервер слушает локальный порт;
* `GET /health` отвечает `200`.

### Запустить mobile app
Команда:

```bash
pnpm mobile:start
```

Ожидаемый результат:

* Metro/Expo стартует;
* приложение открывается на симуляторе или устройстве;
* отображается базовый стартовый экран.

---

## 14. Что делать сразу после bootstrap
После успешной инициализации нельзя сразу писать сложный messaging flow. Следующий порядок строго такой:

1. `TASKS-10_IMPLEMENTATION_BACKLOG.md` — этап B
2. затем этап C
3. затем этап D
4. затем relay foundation and API
5. только потом client-core messaging

---

## 15. Частые ошибки при bootstrap

### Ошибка 1. Сразу писать UI экраны
Неправильно, потому что еще нет protocol contracts.

### Ошибка 2. Сразу подключать сложную crypto library без isolation layer
Неправильно, потому что потом все приложение придется переписывать.

### Ошибка 3. Копировать JSON types вручную в mobile и relay
Неправильно, потому что быстро начнется рассинхрон.

### Ошибка 4. Делать relay как один файл на 1000 строк
Неправильно, потому что это противоречит `ARCH-09_REPOSITORY_STRUCTURE.md`.

---

## 16. Bootstrap readiness checklist
Bootstrap считается завершенным, если:

* есть root workspace;
* есть все `apps/` и `packages/`;
* `packages/protocol` typecheck'ится;
* `apps/relay` запускается локально;
* `apps/mobile` запускается локально;
* нет дублирования общих типов между пакетами.

---

## 17. Итог
После выполнения этого guide проект готов не к “релизу”, а к **дисциплинированной реализации MVP по backlog**.

Если bootstrap не завершен полностью, нельзя переходить к message flow и security-critical задачам.
