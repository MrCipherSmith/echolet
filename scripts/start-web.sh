#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "=== 📻 Echolet Web Client Launcher ==="

# 1. Проверка node_modules
if [ ! -d "node_modules" ]; then
  echo "📦 Установка зависимостей (pnpm install)..."
  pnpm install
fi

# 2. Проверка сборки клиента
if [ ! -f "apps/web/dist/server.js" ] || [ ! -f "apps/web/dist/client/bundle.js" ]; then
  echo "🔨 Сборка Echolet Web (node apps/web/build.mjs)..."
  node apps/web/build.mjs
fi

# 3. Проверка профилей Алисы и Боба
if [ ! -f ".env.demo" ] || [ ! -d ".tmp/demo-data/alice" ]; then
  echo "🔑 Инициализация криптографических профилей (Alice & Bob)..."
  sh scripts/demo-init.sh
fi

source .env.demo

# Очистка при завершении (Ctrl+C)
cleanup() {
  echo ""
  echo "🛑 Остановка серверов Echolet Web..."
  kill $(jobs -p) 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

echo "🚀 Запуск узла Алисы (Alice) на http://localhost:3001 ..."
export ECHOLET_STORE_KEY="$ALICE_KEY"
node ./apps/web/dist/server.js \
  --port 3001 \
  --profile "$DIR/.tmp/demo-data/alice" \
  --label "Alice" \
  --relay-url "$URL" \
  --store-key-env ECHOLET_STORE_KEY &
PID_ALICE=$!

echo "🚀 Запуск узла Боба (Bob) на http://localhost:3002 ..."
export ECHOLET_STORE_KEY="$BOB_KEY"
node ./apps/web/dist/server.js \
  --port 3002 \
  --profile "$DIR/.tmp/demo-data/bob" \
  --label "Bob" \
  --relay-url "$URL" \
  --store-key-env ECHOLET_STORE_KEY &
PID_BOB=$!

sleep 1

echo ""
echo "=========================================================="
echo "✅ Echolet Web успешно запущен!"
echo "   📻 Alice (станция 1): http://localhost:3001"
echo "   📻 Bob   (станция 2): http://localhost:3002"
echo "=========================================================="
echo "Открываю браузер..."

if command -v open >/dev/null 2>&1; then
  open "http://localhost:3001"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:3001"
fi

echo "Нажмите Ctrl+C для остановки серверов."
wait
