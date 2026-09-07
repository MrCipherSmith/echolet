# Official Signal Node reference

This package implements a local Node reference session runtime with official `@signalapp/libsignal-client@0.102.0` and encrypted SQLite persistence. It is **not imported by the mobile app**, does not implement the existing relay bundle wire format, and does not establish mobile or production readiness. Requires Node >=22.13 with SQLite and a matching libsignal native prebuild. Host evidence currently covers Node 26.5.0 on macOS arm64.

## Use

```ts
import { EncryptedSqliteStore, SignalClient } from '@echolet/session-node';

// Supply a separately protected 32-byte key. Do not save it beside the database.
const store = new EncryptedSqliteStore('/private/device.sqlite', encryptionKey);
const local = { name: localDeviceIdentity, deviceId: 1 };
const client = await SignalClient.create(store, local);
const bundle = await client.publicBundle();

// Verify and approve the exact remote identity out of band before establishing.
await client.approveRemote(remote, verifiedRemoteIdentityBytes);
await client.establish(remote, verifiedRemoteBundle);
const outgoing = await client.encrypt(remote, messageId, 'Synthetic test message');
// Send only after encrypt resolves: session state and exact outbox committed.
// On uncertain delivery, reuse these bytes, without encrypting again:
const retry = await client.retry(remote, messageId);
const text = await receivingClient.decrypt(local, outgoing);
await store.close();
```

`publicBundle()` returns the official opaque PreKeyBundle object for an in-process/native integration. It is not JSON or an Echolet v1 PreKeyBundle. Future wire integration must version the schema and bind the Signal identity to verified Echolet identity/device records. This reference has no relay/network calls.

## Persistence and trust

One device identity per store. Reopening preserves native key/session records; using a different local address fails. Explicit approvals pin a serialized public key to the entire remote address. Unapproved keys, changed approvals and implicit session resets reject. Key-change UI/reset policy is deliberately not implemented.

All libsignal callbacks run in a serialized transaction. Native records are serialized immediately rather than retaining mutable objects across operations. Sending advances the session and stores exact ciphertext in one commit; same id/different content rejects. Retrying returns stored bytes and requires approval. Receiving commits session/prekey changes and authenticated inbox text together. Tampering, replay, message-id mismatch and failed commits reject. The authenticated payload binds messageId to plaintext. A transport may ack only after successful decrypt commit. Already received messages reject; an ack-retry API remains future work.

The single generated EC one-time prekey is removed when consumed. Later bundles omit it; the signed EC and Kyber records remain. Kyber usage is tracked by key-id/signed-key-id/base-key tuple. Prekey pool replenishment, signed-key rotation, contact reset, outbox/inbox retention and mobile background behavior remain outside this reference. Never treat publishing the same prekey bundle to multiple consumers as atomic server-side one-time prekey allocation.

The SQLite store uses an authenticated encrypted snapshot and caller-supplied key. Snapshot size grows with records; it is not a production-scale mobile database. Rollback of the whole file to an older valid snapshot is not prevented. Protect the encryption key separately; storage does not manage OS Keychain/keystore.

## Verification

```sh
pnpm --filter @echolet/session-node test
pnpm --filter @echolet/session-node typecheck
```

Tests use real temporary encrypted SQLite files and native official primitives. They cover reopening, replies, out-of-order/crossed traffic, exact durable retries, rejected identities, replay/tamper, transaction failures and concurrent sends. They do not replace a security audit, real-phone testing or relay integration.

Official source: https://github.com/signalapp/libsignal. Package license metadata is AGPL-3.0-only. External use is unsupported upstream and API changes require Echolet-owned maintenance; versions are pinned deliberately.

## Identity-bound JSON exchange

`exportSignedSignalBundleV2(client, { deviceRecord, deviceSecretKey, createdAtMs?, expiresAtMs? })` exports the current public native bundle in a strict versioned JSON object. Create the client with `signalAddressForDevice(identityId, deviceId)` from `@echolet/protocol`. Supply a root-signed DeviceRecord; the device signing key authenticates the complete v2 transcript. Inputs are copied before asynchronous work.

`importVerifiedSignalBundleV2(input, { identityId, deviceId }, now?)` validates against an independently trusted contact and returns `{address, bundle}`. It checks the root/device/native prekey signatures and lifetime. It does not approve a key or create a session. Explicitly call `approveRemote(address, bundle.identityKey().serialize())` and then `establish(address, bundle)` only after your contact trust decision; an existing different pin still rejects.

The expected contact must not be copied automatically from the untrusted bundle. The legacy DeviceRecord signature is verified on its original nested property ordering; the separate v2 transcript has fixed field order. JSON roundtrip is tested, including non-schema-order capabilities. This is direct client exchange only: relay allocation of one-time keys and mobile transport are not implemented. See [wire contract](../../docs/PROTOCOL-30_SIGNAL_BUNDLE_V2.md).
