#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

if [ ! -f .env.demo ]; then
  echo "Ошибка: файл .env.demo не найден. Сначала запустите ./scripts/demo-init.sh"
  exit 1
fi

source .env.demo
export ECHOLET_STORE_KEY="$BOB_KEY"

echo "Запуск TUI-консоли для Боба..."
node ./apps/cli/dist/tui.js \
  --profile "$DIR/.tmp/demo-data/bob" \
  --label "Bob" \
  --relay-url "$URL" \
  --store-key-env ECHOLET_STORE_KEY \
  --card "$DIR/.tmp/demo-data/alice-card.json"
