#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

if [ ! -f .env.demo ]; then
  echo "Ошибка: файл .env.demo не найден. Сначала запустите ./scripts/demo-init.sh"
  exit 1
fi

source .env.demo
export ECHOLET_STORE_KEY="$ALICE_KEY"

echo "Запуск TUI-консоли для Алисы..."
node ./apps/cli/dist/tui.js \
  --profile "$DIR/.tmp/demo-data/alice" \
  --label "Alice" \
  --relay-url "$URL" \
  --store-key-env ECHOLET_STORE_KEY \
  --card "$DIR/.tmp/demo-data/bob-card.json"
