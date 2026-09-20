#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "=== Инициализация демо-среды Echolet ==="

# 1. Проверяем / создаем .env.demo
if [ ! -f .env.demo ]; then
  echo "Генерация случайных ключей шифрования базы..."
  ALICE_KEY=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')
  BOB_KEY=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')
  cat <<EOF > .env.demo
export URL="https://depr.tail5a88fb.ts.net:8443"
export ALICE_KEY="$ALICE_KEY"
export BOB_KEY="$BOB_KEY"
EOF
  echo "Ключи сохранены в .env.demo"
fi

source .env.demo

CLI="$DIR/apps/cli/dist/cli.js"
DEMO_DIR="$DIR/.tmp/demo-data"
mkdir -p "$DEMO_DIR/alice" "$DEMO_DIR/bob"

echo "1. Инициализация профилей..."
ECHOLET_STORE_KEY="$ALICE_KEY" node "$CLI" init --relay-url "$URL" --store-key-env ECHOLET_STORE_KEY --profile "$DEMO_DIR/alice" --json > /dev/null
ECHOLET_STORE_KEY="$BOB_KEY" node "$CLI" init --relay-url "$URL" --store-key-env ECHOLET_STORE_KEY --profile "$DEMO_DIR/bob" --json > /dev/null

echo "2. Экспорт и обмен карточками контактов..."
ECHOLET_STORE_KEY="$ALICE_KEY" node "$CLI" contact export --out "$DEMO_DIR/alice-card.json" --profile "$DEMO_DIR/alice" > /dev/null
ECHOLET_STORE_KEY="$BOB_KEY" node "$CLI" contact export --out "$DEMO_DIR/bob-card.json" --profile "$DEMO_DIR/bob" > /dev/null

ECHOLET_STORE_KEY="$ALICE_KEY" node "$CLI" contact import --from "$DEMO_DIR/bob-card.json" --yes --profile "$DEMO_DIR/alice" > /dev/null
ECHOLET_STORE_KEY="$BOB_KEY" node "$CLI" contact import --from "$DEMO_DIR/alice-card.json" --yes --profile "$DEMO_DIR/bob" > /dev/null

echo "3. Публикация prekey bundles на релей ($URL)..."
ECHOLET_STORE_KEY="$ALICE_KEY" node "$CLI" relay publish --profile "$DEMO_DIR/alice" > /dev/null
ECHOLET_STORE_KEY="$BOB_KEY" node "$CLI" relay publish --profile "$DEMO_DIR/bob" > /dev/null

echo ""
echo "=== Всё готово! ==="
echo "Откройте два окна терминала:"
echo "  1) В первом окне:  ./scripts/run-alice.sh"
echo "  2) Во втором окне: ./scripts/run-bob.sh"
