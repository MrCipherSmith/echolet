#!/usr/bin/env bash
#
# Build the Echolet relay image and, optionally, save it as a tarball for
# transfer to a host that has no Go toolchain and no checkout.
#
# This script BUILDS AND SAVES. It never pushes, never ssh's and never touches a
# server. Getting the tarball onto a host is one documented command in
# docs/requirements/echolet-cli-prototype/deployment-runbook.md, run by a human
# who has decided to deploy.
#
#   ./build-image.sh                       # build linux/amd64, tag from git
#   ./build-image.sh --platform linux/arm64
#   ./build-image.sh --save out/relay.tar  # also write a `docker load` tarball
#   ./build-image.sh --mirror gcr          # pull base images from mirror.gcr.io
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTEXT="${REPO_ROOT}/apps/relay"
DOCKERFILE="${CONTEXT}/Dockerfile"

# Both servers are x86_64. The default target is therefore linux/amd64 even when
# you build on an arm64 laptop: the Dockerfile's build stage runs on the BUILD
# platform and cross-compiles, so this needs no emulation and takes the same
# time as a native build.
PLATFORM="linux/amd64"
SAVE_PATH=""
MIRROR=""
IMAGE_NAME="echolet-relay"
TAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --save)     SAVE_PATH="$2"; shift 2 ;;
    --mirror)   MIRROR="$2"; shift 2 ;;
    --tag)      TAG="$2"; shift 2 ;;
    --name)     IMAGE_NAME="$2"; shift 2 ;;
    -h|--help)  sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# The tag records WHICH SOURCE this image was built from. `-dirty` is not a
# warning to be silenced: an image built from an uncommitted tree cannot be
# reproduced from the repository, and a deployment you cannot reproduce is the
# thing this whole directory exists to prevent.
if [ -z "$TAG" ]; then
  SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
    SHA="${SHA}-dirty"
  fi
  TAG="$(date -u +%Y%m%d)-${SHA}"
fi
IMAGE="${IMAGE_NAME}:${TAG}"

BUILD_ARGS=()
case "$MIRROR" in
  "") ;;
  gcr)
    # Google's Docker Hub mirror. Same digests, different host — see the ARG
    # block in the Dockerfile. This is the mirror the local verification build
    # used, because Docker Hub stalled and public.ecr.aws answered
    # "toomanyrequests" on the same afternoon.
    BUILD_ARGS+=(--build-arg "GO_IMAGE=mirror.gcr.io/library/golang@sha256:07e91d24f6330432729082bb580983181809e0a48f0f38ecde26868d4568c6ac")
    BUILD_ARGS+=(--build-arg "RUNTIME_IMAGE=mirror.gcr.io/library/alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce")
    ;;
  ecr)
    BUILD_ARGS+=(--build-arg "GO_IMAGE=public.ecr.aws/docker/library/golang:1.26.1-alpine3.22@sha256:07e91d24f6330432729082bb580983181809e0a48f0f38ecde26868d4568c6ac")
    BUILD_ARGS+=(--build-arg "RUNTIME_IMAGE=public.ecr.aws/docker/library/alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce")
    ;;
  *) echo "unknown --mirror value: $MIRROR (known: gcr, ecr)" >&2; exit 2 ;;
esac

echo "==> building ${IMAGE} for ${PLATFORM}"
docker buildx build \
  --platform "$PLATFORM" \
  --load \
  "${BUILD_ARGS[@]}" \
  -t "$IMAGE" \
  -f "$DOCKERFILE" \
  "$CONTEXT"

echo "==> built ${IMAGE}"
docker image inspect "$IMAGE" \
  --format '    id={{.Id}}{{"\n"}}    arch={{.Os}}/{{.Architecture}}{{"\n"}}    size={{.Size}} bytes'

if [ -n "$SAVE_PATH" ]; then
  mkdir -p "$(dirname "$SAVE_PATH")"
  echo "==> saving to ${SAVE_PATH}"
  docker save "$IMAGE" -o "$SAVE_PATH"
  ls -l "$SAVE_PATH"
  echo "==> sha256 of the tarball (compare it after transfer):"
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$SAVE_PATH"; else sha256sum "$SAVE_PATH"; fi
fi

echo
echo "Put this tag in the host's env file:  ECHOLET_IMAGE=${IMAGE}"
