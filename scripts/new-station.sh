#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

NAME="${1:-RadioOperator}"
PORT="${2:-3003}"

echo "=== 📻 Создание и запуск новой станции Echolet Web ==="
echo "Позывной: $NAME"
echo "Порт:     $PORT"

# 1. Проверяем URL релея
if [ -f .env.demo ]; then
  source .env.demo
fi
URL="${URL:-https://depr.tail5a88fb.ts.net:8443}"

# 2. Проверяем сборку
if [ ! -f "apps/web/dist/server.js" ]; then
  echo "🔨 Сборка Echolet Web..."
  node apps/web/build.mjs
fi

PROFILE_DIR="$DIR/.tmp/profiles/$NAME"
mkdir -p "$PROFILE_DIR"

CLI="$DIR/apps/cli/dist/cli.js"
KEY_FILE="$PROFILE_DIR/.key"

# 3. Создаем ключ шифрования хранилища, если его нет
if [ ! -f "$KEY_FILE" ]; then
  USER_KEY=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')
  echo "$USER_KEY" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  echo "🔑 Сгенерирован мастер-ключ хранилища для $NAME"
fi
USER_KEY=$(cat "$KEY_FILE")

# 4. Инициализация профиля, если базы еще нет
if [ ! -f "$PROFILE_DIR/client.sqlite" ]; then
  echo "⚙️ Инициализация криптографического профиля..."
  ECHOLET_STORE_KEY="$USER_KEY" node "$CLI" init \
    --relay-url "$URL" \
    --store-key-env ECHOLET_STORE_KEY \
    --profile "$PROFILE_DIR" \
    --json > /dev/null

  echo "📡 Публикация PreKey связок на релей..."
  ECHOLET_STORE_KEY="$USER_KEY" node "$CLI" relay publish \
    --profile "$PROFILE_DIR" > /dev/null
  echo "✅ Профиль успешно создан и зарегистрирован в сети!"
fi

echo ""
echo "🚀 Запуск веб-станции $NAME на http://localhost:$PORT ..."
export ECHOLET_STORE_KEY="$USER_KEY"
node ./apps/web/dist/server.js \
  --port "$PORT" \
  --profile "$PROFILE_DIR" \
  --label "$NAME" \
  --relay-url "$URL" \
  --store-key-env ECHOLET_STORE_KEY
