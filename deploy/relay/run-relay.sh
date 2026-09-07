#!/usr/bin/env bash
#
# Start the Echolet relay with plain `docker run`, from the same env file
# docker-compose.yml consumes.
#
# This exists because the compose plugin is not guaranteed on either host —
# Ubuntu's `docker.io` package ships the engine without `docker compose`, and a
# runbook whose first host command may not exist is not a runbook. If
# `docker compose version` answers, prefer compose; the two produce the same
# container.
#
#   ./run-relay.sh env/geekom.env            # start (or replace) the container
#   ./run-relay.sh env/geekom.env --print    # print the command, run nothing
#
# It never pulls, never pushes and never touches a certificate's contents.
#
set -euo pipefail

ENV_FILE="${1:?usage: run-relay.sh <env-file> [--print]}"
PRINT="${2:-}"

[ -f "$ENV_FILE" ] || { echo "env file not found: $ENV_FILE" >&2; exit 2; }

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

require() {
  eval "v=\${$1:-}"
  [ -n "$v" ] || { echo "$1 is not set in $ENV_FILE" >&2; exit 2; }
  case "$v" in REPLACE_WITH_*) echo "$1 still holds the placeholder '$v'" >&2; exit 2 ;; esac
}
require ECHOLET_IMAGE
require ECHOLET_BIND_ADDR
require ECHOLET_NODE_CALLSIGN
require ECHOLET_TLS_DIR
require ECHOLET_HOST_DATA_DIR

# The single most consequential line in this file. Docker publishes ports with
# its own DNAT rules, evaluated BEFORE ufw's INPUT chain: a container published
# on 0.0.0.0 is reachable on every interface of a host whose firewall denies the
# port. On this deployment the bind address IS the access control.
case "$ECHOLET_BIND_ADDR" in
  0.0.0.0|""|"*")
    echo "ECHOLET_BIND_ADDR=$ECHOLET_BIND_ADDR would publish the relay on every interface." >&2
    echo "Set it to this host's tailnet address (tailscale ip -4)." >&2
    exit 2 ;;
esac

CONTAINER="${ECHOLET_CONTAINER_NAME:-echolet-relay}"
PORT="${ECHOLET_PORT:-8443}"
UID_GID="${ECHOLET_UID:-10001}:${ECHOLET_GID:-10001}"

CMD=(docker run -d
  --name "$CONTAINER"
  --restart unless-stopped
  --user "$UID_GID"
  --read-only
  --tmpfs /tmp:size=16m,mode=1777
  --security-opt no-new-privileges:true
  --cap-drop ALL
  --log-driver json-file
  --log-opt "max-size=${ECHOLET_LOG_MAX_SIZE:-20m}"
  --log-opt "max-file=${ECHOLET_LOG_MAX_FILE:-5}"
  -p "${ECHOLET_BIND_ADDR}:${PORT}:8443"
  -v "${ECHOLET_TLS_DIR}:/etc/echolet/tls:ro"
  -v "${ECHOLET_HOST_DATA_DIR}:/var/lib/echolet"
  -e ECHOLET_HTTP_ADDR=0.0.0.0:8443
  -e ECHOLET_TLS_CERT_FILE=/etc/echolet/tls/cert.pem
  -e ECHOLET_TLS_KEY_FILE=/etc/echolet/tls/key.pem
  -e "ECHOLET_TLS_RELOAD_INTERVAL_SECONDS=${ECHOLET_TLS_RELOAD_INTERVAL_SECONDS:-60}"
  -e ECHOLET_DATA_DIR=/var/lib/echolet
  -e "ECHOLET_LOG_LEVEL=${ECHOLET_LOG_LEVEL:-info}"
  -e "ECHOLET_NODE_CALLSIGN=${ECHOLET_NODE_CALLSIGN}"
  -e "ECHOLET_MAILBOX_TTL_HOURS=${ECHOLET_MAILBOX_TTL_HOURS:-168}"
  -e "ECHOLET_MAX_MESSAGE_BYTES=${ECHOLET_MAX_MESSAGE_BYTES:-262144}"
  -e "ECHOLET_MAX_MAILBOX_BATCH=${ECHOLET_MAX_MAILBOX_BATCH:-100}"
  -e "ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER=${ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER:-16}"
  -e "ECHOLET_RATE_LIMIT_PER_MINUTE=${ECHOLET_RATE_LIMIT_PER_MINUTE:-120}"
  -e "ECHOLET_CHALLENGE_TTL_SECONDS=${ECHOLET_CHALLENGE_TTL_SECONDS:-60}"
  -e "ECHOLET_CLEANUP_INTERVAL_SECONDS=${ECHOLET_CLEANUP_INTERVAL_SECONDS:-60}"
  -e "ECHOLET_MAX_STORAGE_BYTES=${ECHOLET_MAX_STORAGE_BYTES:-2147483648}"
  "$ECHOLET_IMAGE")

if [ "$PRINT" = "--print" ]; then
  printf '%q ' "${CMD[@]}"; printf '\n'
  exit 0
fi

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "==> replacing existing container $CONTAINER"
  # `docker rm` on a stopped container removes the container, never the volumes:
  # ECHOLET_HOST_DATA_DIR is a host bind mount and survives untouched.
  docker stop "$CONTAINER" >/dev/null
  docker rm "$CONTAINER" >/dev/null
fi

"${CMD[@]}"
echo "==> started $CONTAINER from $ECHOLET_IMAGE on ${ECHOLET_BIND_ADDR}:${PORT}"
