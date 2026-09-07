# Signal bundle v2 — implementation specification

Date: 2026-09-06. Authorized continuation of flow001. Scope: strict shared wire contract and Node export/verified import with executable identity binding. No relay route or mobile acceptance in this increment.

## Motivation and compatibility

Official libsignal needs serialized EC identity/SPK keys and mandatory Kyber keys, which do not fit v1. Introduce a separate `SignalPreKeyBundleV2Schema` and exports without changing v1 validators, PROTOCOL_VERSION or routes. Existing root/device Ed25519 keys remain distinct from native Signal identity keys. No new cryptographic algorithm is introduced.

## JSON shape

Strict objects throughout; reject extra fields rather than silently dropping signed data. Base64url is canonical unpadded, with decoded byte length checked without Node dependencies in protocol package.

- type: `signal_prekey_bundle`; version: 2; suite: `libsignal-pq-v1`.
- bundle_id: canonical lowercase UUID; created_at_ms, expires_at_ms: nonnegative safe integers, expiry later than creation and lifetime at most seven days. Import checks created <= now < expires (explicit now for deterministic tests).
- device_record: existing v1 signed DeviceRecord shape with strict fields; identity_id and device_pubkey canonical base64url32, signature base64url64, device_id lowercase UUID, created_at_ms nonnegative safe integer; optional label <=256 characters and optional known boolean capabilities. Keep the legacy signed object ordering for its legacy signature verification; do not verify a reconstructed/stripped object.
- registration_id: integer 1..16380. Native address is NEVER supplied in wire: name = JSON.stringify([verified identity_id, device_id]), native deviceId = 1. Full Echolet device UUID is included in name.
- signal_identity_key: base64url serialized EC key33 with leading byte0x05.
- signed_prekey: {key_id:uint32, public_key:EC33, signature:base64url64}.
- kyber_prekey: {key_id:uint32, public_key:base64url1569 with leading byte0x08, signature:base64url64} for pinned libsignal0.102.0.
- one_time_prekey: null or {key_id:uint32, public_key:EC33}. This optional key is for direct exchange ONLY until atomic relay allocation is implemented; publishing/reusing this wire object is not one-time allocation.
- signature: base64url64, device Ed25519 signature over exact v2 transcript.

## Signed transcript

Use JSON.stringify of the fixed tuple below, encoded UTF-8, rather than v1 canonicalJson. Include ALL nested signatures; exclude only outer signature. Missing optional values become null. Tuple is a transport signing contract, not custom session cryptography.

```text
[
 "echolet.signal.prekey_bundle.v2", bundle_id, suite,
 [device_record.type, device_record.version, identity_id, device_id,
  device_pubkey, device_label ?? null,
  [capabilities.mailbox_poll ?? null, capabilities.receipts ?? null,
   capabilities.attachments ?? null], device_record.created_at_ms,
  device_record.signature],
 created_at_ms, expires_at_ms, registration_id, signal_identity_key,
 [signed_prekey.key_id, signed_prekey.public_key, signed_prekey.signature],
 [kyber_prekey.key_id, kyber_prekey.public_key, kyber_prekey.signature],
 one_time_prekey === null ? null : [one_time_prekey.key_id, one_time_prekey.public_key]
]
```

Provide protocol `signalBundleV2SigningText(bundle)` as shared deterministic encoding and `signalAddressForDevice(identityId,deviceId)` mapping. Both validate before encoding. Schema structural checks do not claim signature validation.

## Node adapter and trust

The capabilities object is required; its three known boolean fields are optional. Property-order invariance applies to the v2 transcript, not the legacy DeviceRecord root signature: reordering its nested capabilities invalidates that legacy signature. Expected identity/device must come from an independent trusted contact input, never copied from the candidate bundle as an automatic approval.

Export snapshots the supplied DeviceRecord, signing bytes and options before its first await. Use the current publicBundle result: after an EC one-time prekey has been consumed, export null rather than reconstructing its old ID. Import must return owned values, not caller-mutable references.

New wire module exports a local public bundle using SignalClient.publicBundle and device credentials. It must check local client address matches deterministic identity/device mapping, root signature of the supplied DeviceRecord, device signing key matches device_pubkey, and timestamp coherence. Root secret key is not needed at export; supply previously root-signed DeviceRecord. Never export private Signal records.

Import takes unknown input plus caller-supplied expected identity_id/device_id from a trusted contact decision. Verify exact expected identity/device, valid root Ed25519 signature of original strict DeviceRecord, device Ed25519 signature over v2 transcript, current lifetime and device-record creation <= bundle creation. Verify native EC and Kyber key signatures with native Signal identity key before returning native PreKeyBundle. Return deterministic address and native bundle for an EXPLICIT approveRemote + establish call; import itself must not modify trust or sessions. Changed pinned Signal identity is still rejected by existing SignalClient.

## Acceptance/tests

- JSON roundtrip between two independent clients establishes native sessions and decrypts a reply after explicit trust approval; each party bound to expected root/device.
- Wrong root/device, forged DeviceRecord, substituted Signal identity, SPK/Kyber/signatures, invalid lengths/prefix/base64, unknown fields and expired/future bundle reject before native session mutation.
- Fixed transcript stable under JSON property reordering; nested signatures authenticated. DeviceRecord legacy signature checked on original object, including capabilities insertion order.
- Key rotation/replacement cannot overwrite an existing pin. Export rejects mismatched local address/device key.
- v1 test suite remains green. No mobile/relay integration readiness claim.

## Follow-on relay work

Use separate v2 storage/routes and current-time checks. Allocate one-time keys transactionally and preserve signed payload: never remove a signed array member and return the modified bundle with its old signature. Existing Go recursive signature-stripping helper is unsuitable for v2. Relay network implementation follows this tested contract rather than being inferred from v1.
