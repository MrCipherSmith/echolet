# Echolet relay — container image.
#
# Build context is THIS directory (apps/relay), not the repository root. The Go
# module `echolet/apps/relay` has no `replace` directive pointing outside itself,
# so nothing above this directory is needed to build the binary — and keeping the
# context here keeps `node_modules/`, `.gocache/` and the pnpm workspace out of
# the build entirely.
#
#   docker buildx build --platform linux/amd64 \
#     -t echolet-relay:<tag> -f apps/relay/Dockerfile apps/relay
#
# Both base images are pinned BY DIGEST (see the ARGs below). A rebuild six
# months from now resolves to the same bytes; a floating `golang:1.26-alpine`
# would not, and a runbook whose first step is unreproducible is not a runbook.
#
# Runtime base is Alpine rather than distroless-static for one deliberate
# reason: the container HEALTHCHECK needs an HTTPS client, and distroless has no
# binaries at all. The cost is ~8 MB and a shell; the benefit is that
# `docker ps` reports whether the relay is actually answering, which is the
# first question an operator asks. Swap the final stage for
# `gcr.io/distroless/static-debian12:nonroot` and drop the HEALTHCHECK if you
# would rather have the smaller surface.

# Both base images are named by tag AND digest, and both are overridable with a
# --build-arg. The digest is the pin; the registry prefix is not. Docker Hub
# refuses or stalls anonymous pulls once a network is rate-limited, and a
# deployment that cannot be rebuilt on a bad Hub day is a deployment you do not
# control. Any mirror that serves the SAME digest produces the same image:
#
#   docker buildx build \
#     --build-arg GO_IMAGE=mirror.gcr.io/library/golang@sha256:07e91d24f6330432729082bb580983181809e0a48f0f38ecde26868d4568c6ac \
#     --build-arg RUNTIME_IMAGE=mirror.gcr.io/library/alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce \
#     ...
#
# (`deploy/relay/build-image.sh --mirror gcr` passes exactly those two.)
#
# Changing the digest is a different image and must be a deliberate, recorded
# change. Changing only the host in front of it is not.
ARG GO_IMAGE=golang:1.26.1-alpine3.22@sha256:07e91d24f6330432729082bb580983181809e0a48f0f38ecde26868d4568c6ac
ARG RUNTIME_IMAGE=alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

# --- stage 1: build ----------------------------------------------------------
# golang 1.26.1-alpine3.22 — go.mod declares `go 1.26.1`, so the toolchain is
# pinned to the exact version the module was developed and tested against.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build

# TARGETARCH is supplied by buildx. The build stage always runs on the BUILD
# platform and cross-compiles, so producing the linux/amd64 image the two
# servers need from an arm64 laptop costs nothing and needs no QEMU emulation.
ARG TARGETOS=linux
ARG TARGETARCH

WORKDIR /src

# Dependency layer first: it changes only when go.mod/go.sum change.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO_ENABLED=0 — badger, chi and the rest of the tree are pure Go, and a static
# binary is what lets the runtime stage carry nothing but the binary.
# -trimpath and `-buildid=` strip the absolute build path and the build id, the
# two things that otherwise make two builds of identical source differ.
ENV CGO_ENABLED=0
RUN GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
    go build -mod=readonly -trimpath -ldflags='-s -w -buildid=' \
      -o /out/relay ./cmd/relay

# --- stage 2: runtime --------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runtime

# 10001:10001 is a fixed, documented pair because the certificate files and the
# data directory are bind-mounted from the host and must be readable by exactly
# this uid. The runbook chowns them to 10001 rather than making the private key
# world-readable.
RUN addgroup -g 10001 -S echolet \
 && adduser -u 10001 -S -G echolet -H -s /sbin/nologin echolet \
 && mkdir -p /var/lib/echolet /etc/echolet/tls \
 && chown -R 10001:10001 /var/lib/echolet

COPY --from=build --chown=root:root --chmod=0555 /out/relay /usr/local/bin/relay

# Defaults only. Every one of these is overridden per host by the compose env
# file; none of them contains, or may ever contain, key material.
ENV ECHOLET_HTTP_ADDR=0.0.0.0:8443 \
    ECHOLET_DATA_DIR=/var/lib/echolet \
    ECHOLET_LOG_LEVEL=info

USER 10001:10001
WORKDIR /var/lib/echolet
EXPOSE 8443
VOLUME ["/var/lib/echolet"]

# Liveness, not certificate validation: --no-check-certificate is correct here
# because the certificate is issued for the host's MagicDNS name and this probe
# dials the loopback address from inside the container. That the TLS handshake
# completes and /health answers 200 is what this checks. The certificate chain
# is verified from another tailnet machine instead — see the deployment runbook,
# §"Verify from a second machine", which is the check that actually matters.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --no-check-certificate -O /dev/null "https://127.0.0.1:8443/health" \
   || wget -q -O /dev/null "http://127.0.0.1:8443/health" \
   || exit 1

ENTRYPOINT ["/usr/local/bin/relay"]

LABEL org.opencontainers.image.title="echolet-relay" \
      org.opencontainers.image.description="Echolet relay — unaudited prototype, tailnet-only deployment" \
      org.opencontainers.image.source="https://github.com/MrCipherSmith/echolet" \
      org.opencontainers.image.licenses="UNLICENSED"
