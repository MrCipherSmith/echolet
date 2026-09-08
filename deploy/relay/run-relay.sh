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
# ---------------------------------------------------------------------------
# TWO MODES, AND THE SECOND ONE IS NOT A FALLBACK
# ---------------------------------------------------------------------------
#
#   TLS (default)  — the intended production shape. The container is handed
#                    ECHOLET_TLS_CERT_FILE and ECHOLET_TLS_KEY_FILE, and if
#                    either file is missing or malformed the relay exits
#                    non-zero at startup. That is unchanged by this script and
#                    must stay that way: the relay never degrades to plain HTTP
#                    because a certificate went missing.
#
#   INSECURE LOOPBACK — plain HTTP, published on 127.0.0.1 only. Reached ONLY
#                    by setting ECHOLET_INSECURE_LOOPBACK_ONLY to the exact
#                    acknowledgement string below. It is never entered by
#                    omission, never entered by a missing certificate, and
#                    never entered by a typo. The publish address is checked
#                    against a loopback allowlist and the script refuses to
#                    start on anything else, so the insecure mode cannot be
#                    pointed at a tailnet or public address.
#
# The two are mutually exclusive by construction: asking for the insecure mode
# while ECHOLET_TLS_DIR is still set is an error, not a preference order.
#
set -euo pipefail

# The exact string ECHOLET_INSECURE_LOOPBACK_ONLY must hold. Long and awkward on
# purpose: it is meant to be typed by someone who has read this file, and it is
# meant to be conspicuous in a diff of an env file.
readonly INSECURE_ACK="yes-plain-http-on-loopback-only"

ENV_FILE="${1:?usage: run-relay.sh <env-file> [--print]}"
PRINT="${2:-}"

[ -f "$ENV_FILE" ] || { echo "env file not found: $ENV_FILE" >&2; exit 2; }

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

die() { echo "$@" >&2; exit 2; }

require() {
  eval "v=\${$1:-}"
  [ -n "$v" ] || die "$1 is not set in $ENV_FILE"
  case "$v" in REPLACE_WITH_*) die "$1 still holds the placeholder '$v'" ;; esac
}
require ECHOLET_IMAGE
require ECHOLET_BIND_ADDR
require ECHOLET_NODE_CALLSIGN

# --- mode selection ---------------------------------------------------------
#
# Unset or empty => TLS. Set to exactly $INSECURE_ACK => insecure loopback.
# Set to anything else => hard failure naming the value, because a half-typed
# acknowledgement is exactly the case that must not quietly pick a mode.
INSECURE="${ECHOLET_INSECURE_LOOPBACK_ONLY:-}"
if [ -n "$INSECURE" ] && [ "$INSECURE" != "$INSECURE_ACK" ]; then
  echo "ECHOLET_INSECURE_LOOPBACK_ONLY is set to '$INSECURE', which is not a recognised value." >&2
  echo "It must be exactly:  $INSECURE_ACK" >&2
  echo "Leave it unset for the normal TLS deployment. There is no third mode." >&2
  exit 2
fi

if [ -n "$INSECURE" ]; then
  # ---- insecure loopback mode ---------------------------------------------

  # Structural confinement. Docker publishes ports with its own DNAT rules,
  # evaluated BEFORE ufw's INPUT chain, so a publish address is the access
  # control and a firewall will not rescue a wrong one. In this mode the ONLY
  # acceptable publish addresses are the host's own loopback: nothing outside
  # the host may ever reach a plain-HTTP relay.
  case "$ECHOLET_BIND_ADDR" in
    127.0.0.1|"[::1]") ;;
    *)
      echo "REFUSING TO START." >&2
      echo "ECHOLET_INSECURE_LOOPBACK_ONLY serves PLAIN HTTP, so it is confined to loopback." >&2
      echo "ECHOLET_BIND_ADDR=$ECHOLET_BIND_ADDR is not a loopback address." >&2
      echo "Allowed in this mode: 127.0.0.1 or [::1] — nothing else, not a tailnet address." >&2
      echo "To publish on $ECHOLET_BIND_ADDR, unset ECHOLET_INSECURE_LOOPBACK_ONLY and deploy with TLS." >&2
      exit 2 ;;
  esac

  # Both-or-neither, enforced here as well as in the relay. A TLS directory in
  # an insecure-mode env file means the two halves of the file disagree about
  # what is being deployed; refuse rather than silently pick one.
  if [ -n "${ECHOLET_TLS_DIR:-}" ]; then
    die "ECHOLET_TLS_DIR=$ECHOLET_TLS_DIR is set while ECHOLET_INSECURE_LOOPBACK_ONLY is on. Choose one: TLS, or plain HTTP on loopback."
  fi
else
  # ---- TLS mode (default) --------------------------------------------------
  require ECHOLET_TLS_DIR

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
fi

# --- data directory or named volume -----------------------------------------
#
# Exactly one. A host bind mount needs the path created and chowned to the
# container uid, which needs root; a named Docker volume is seeded from the
# image's already-chowned /var/lib/echolet and needs no root at all. The second
# is what makes a whole deployment possible inside the `docker` group.
DATA_MOUNT=""
if [ -n "${ECHOLET_DATA_VOLUME:-}" ] && [ -n "${ECHOLET_HOST_DATA_DIR:-}" ]; then
  die "set ECHOLET_DATA_VOLUME or ECHOLET_HOST_DATA_DIR in $ENV_FILE, not both."
elif [ -n "${ECHOLET_DATA_VOLUME:-}" ]; then
  case "$ECHOLET_DATA_VOLUME" in REPLACE_WITH_*) die "ECHOLET_DATA_VOLUME still holds the placeholder '$ECHOLET_DATA_VOLUME'" ;; esac
  DATA_MOUNT="${ECHOLET_DATA_VOLUME}:/var/lib/echolet"
elif [ -n "${ECHOLET_HOST_DATA_DIR:-}" ]; then
  case "$ECHOLET_HOST_DATA_DIR" in REPLACE_WITH_*) die "ECHOLET_HOST_DATA_DIR still holds the placeholder '$ECHOLET_HOST_DATA_DIR'" ;; esac
  DATA_MOUNT="${ECHOLET_HOST_DATA_DIR}:/var/lib/echolet"
else
  die "neither ECHOLET_DATA_VOLUME nor ECHOLET_HOST_DATA_DIR is set in $ENV_FILE"
fi

CONTAINER="${ECHOLET_CONTAINER_NAME:-echolet-relay}"
PORT="${ECHOLET_PORT:-8443}"
UID_GID="${ECHOLET_UID:-10001}:${ECHOLET_GID:-10001}"

# Hardening, identical in both modes. Read-only root filesystem, a small tmpfs
# for /tmp, no new privileges, every capability dropped, an unprivileged uid, a
# restart policy and capped json-file logs.
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
  --log-opt "max-file=${ECHOLET_LOG_MAX_FILE:-5}")

if [ -n "$INSECURE" ]; then
  # Visible in `docker ps --filter label=…` and `docker inspect`, not only in
  # this script's own stdout, which scrolls away.
  CMD+=(--label "echolet.tls=disabled-insecure-loopback-only")
else
  CMD+=(--label "echolet.tls=enabled")
fi

CMD+=(-p "${ECHOLET_BIND_ADDR}:${PORT}:8443")

if [ -z "$INSECURE" ]; then
  CMD+=(-v "${ECHOLET_TLS_DIR}:/etc/echolet/tls:ro")
fi

CMD+=(-v "$DATA_MOUNT"
  -e ECHOLET_HTTP_ADDR=0.0.0.0:8443)

if [ -z "$INSECURE" ]; then
  CMD+=(-e ECHOLET_TLS_CERT_FILE=/etc/echolet/tls/cert.pem
    -e ECHOLET_TLS_KEY_FILE=/etc/echolet/tls/key.pem
    -e "ECHOLET_TLS_RELOAD_INTERVAL_SECONDS=${ECHOLET_TLS_RELOAD_INTERVAL_SECONDS:-60}")
fi
# In insecure mode NEITHER TLS variable is passed. That is the relay's
# documented both-or-neither contract: both set => HTTPS, neither set => plain
# HTTP, exactly one set => refuse to start. Passing an empty string for one of
# them would be a different and much worse thing to write here.

CMD+=(-e ECHOLET_DATA_DIR=/var/lib/echolet
  -e "ECHOLET_LOG_LEVEL=${ECHOLET_LOG_LEVEL:-info}"
  -e "ECHOLET_NODE_CALLSIGN=${ECHOLET_NODE_CALLSIGN}"
  -e "ECHOLET_MAILBOX_TTL_HOURS=${ECHOLET_MAILBOX_TTL_HOURS:-168}"
  -e "ECHOLET_MAX_MESSAGE_BYTES=${ECHOLET_MAX_MESSAGE_BYTES:-262144}"
  -e "ECHOLET_MAX_MAILBOX_BATCH=${ECHOLET_MAX_MAILBOX_BATCH:-100}"
  -e "ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER=${ECHOLET_MAX_UNACKED_ENVELOPES_PER_SENDER:-16}"
  -e "ECHOLET_RATE_LIMIT_PER_MINUTE=${ECHOLET_RATE_LIMIT_PER_MINUTE:-120}"
  -e "ECHOLET_CHALLENGE_TTL_SECONDS=${ECHOLET_CHALLENGE_TTL_SECONDS:-60}"
  # No cleanup interval is passed. Envelope retention is the store's own TTL —
  # Badger expires records at ECHOLET_MAILBOX_TTL_HOURS above — and needs no sweep
  # interval; the relay's cleanup ticker deletes nothing (flow 003, T28).
  -e "ECHOLET_MAX_STORAGE_BYTES=${ECHOLET_MAX_STORAGE_BYTES:-2147483648}"
  "$ECHOLET_IMAGE")

if [ "$PRINT" = "--print" ]; then
  if [ -n "$INSECURE" ]; then
    echo "# MODE: INSECURE LOOPBACK — plain HTTP, published on ${ECHOLET_BIND_ADDR}:${PORT} only, no TLS." >&2
  fi
  printf '%q ' "${CMD[@]}"; printf '\n'
  exit 0
fi

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "==> replacing existing container $CONTAINER"
  # `docker rm` on a stopped container removes the container, never the volumes:
  # a host bind mount and a named volume both survive untouched.
  docker stop "$CONTAINER" >/dev/null
  docker rm "$CONTAINER" >/dev/null
fi

if [ -n "$INSECURE" ]; then
  echo "############################################################"
  echo "## INSECURE MODE: the relay will serve PLAIN HTTP, no TLS. ##"
  echo "## Published on ${ECHOLET_BIND_ADDR}:${PORT} — loopback only."
  echo "## Nothing off this host can reach it. Anything on this    ##"
  echo "## host can read every request in the clear.               ##"
  echo "############################################################"
fi

"${CMD[@]}"
echo "==> started $CONTAINER from $ECHOLET_IMAGE on ${ECHOLET_BIND_ADDR}:${PORT}"
if [ -n "$INSECURE" ]; then
  echo "==> scheme: http (INSECURE, loopback only). Confirm the relay agrees:"
  echo "    docker logs $CONTAINER | grep 'Starting relay server'"
  echo "    expect:  scheme=http tls_cert_file=\"\" tls_key_file=\"\""
else
  echo "==> scheme: https. Confirm the relay agrees:"
  echo "    docker logs $CONTAINER | grep 'Starting relay server'"
  echo "    expect:  scheme=https tls_cert_file=/etc/echolet/tls/cert.pem"
fi
