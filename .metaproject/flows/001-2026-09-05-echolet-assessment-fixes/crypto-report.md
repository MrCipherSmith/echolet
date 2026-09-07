# Session feasibility report

Version: 1.0.0. Date: 2026-09-06 (Asia/Muscat). Author: crypto worker, flow 001.

## Decision

Do not replace the prototype with the installed community Signal library unchanged. A bounded Node spike confirms basic functionality but reproduces an inbound identity-trust bypass in installed `@privacyresearch/libsignal-protocol-typescript@0.0.16`. This is concrete blocker evidence for AC5, not a production-security approval. No application/runtime files were changed by this worker.

## Executable evidence

From project root:

```sh
node .metaproject/flows/001-2026-09-05-echolet-assessment-fixes/spike/libsignal.cjs
```

Executed using Node v26.5.0 and existing dependencies, without installing or changing packages. Checks: prekey bootstrap; reply; JSON round-trip of identity/prekey/session records into new store and cipher objects; delayed/out-of-order delivery; replay rejection; crossed sends; tamper rejection; outbound changed-identity rejection.

The final case deliberately sets receiver `isTrustedIdentity` to an asynchronous function returning false. The first incoming prekey message nevertheless decrypts. The script exits zero only when the expected functional results AND this installed-version blocker are reproduced; its output is `VERIFIED_WITH_SECURITY_BLOCKER`, not a health/security gate pass. No secrets are printed.

Source cause: installed `packages/crypto-core/node_modules/@privacyresearch/libsignal-protocol-typescript/lib/session-builder.js:230` invokes asynchronous `storage.isTrustedIdentity` without awaiting it in `processV3`. A Promise is truthy. `session-cipher.js` explicitly relies on that check when decrypting a prekey message. The public `StorageType` contract declares `Promise<boolean>`.

The store example must also normalize the encoded `name.deviceId` passed to `saveIdentity` to the name used by `isTrustedIdentity`; the spike does this for synthetic identities. This mapping must be designed explicitly for Echolet identity/device trust.

## Existing runtime findings (pre-fix snapshot)

- `packages/crypto-core/src/session/session.ts`: static X25519 shared secret plus custom HKDF chain; no ephemeral DH ratchet or one-time-prekey bootstrap. Reset with the same two static keys recreates identical root/chain and deterministic message-key/nonce sequences. A sessionId timestamp is not included in derivation. This is not a safe replacement for a mature protocol.
- `packages/client-core/src/identity/createSignedPreKeyBundle.ts`: signed prekey is the stable `profile.sessionPubKey`; one-time prekeys are published but unused by the custom session bootstrap.
- `apps/mobile/src/screens/MessagingScreen.tsx`: sessions reside in React state, not a durable store. Restart therefore loses progression. Sending updates local state only after relay success, so an ambiguous network failure can also cause reuse on a different next plaintext.
- The same screen fetches `bundles[0]` and uses its key without client verification against trusted identity/device records; inbound selection does not select the sender device by ID. Relay validation is not a substitute for client trust.
- Shared `counter` in session state cannot correctly handle simultaneous sends in a single bidirectional state. The screen's separate inbound/outbound maps sidestep that particular API issue, but do not solve persistence or authenticated bootstrap.

Immediate recommendation to parent: restrict prototype messaging to development builds and label its limitations. Keep genuine-session integration open; repairing individual custom-ratchet details cannot establish production readiness.

## Integration path and remaining blockers

The installed community package documents asynchronous `SessionBuilder`/`SessionCipher`, durable identity/prekey/session stores and injectable WebCrypto; it is GPL-3.0-only. It is based on the older Signal JavaScript implementation. The isolated spike uses Node WebCrypto explicitly; it does not demonstrate Hermes, Android, iOS or app cryptographic randomness. [Maintainer documentation](https://github.com/privacyresearchgroup/libsignal-protocol-typescript).

Official libsignal exposes Java, Swift and TypeScript wrappers over Rust; its maintainers explicitly do not support use outside Signal and allow API changes. Its published native Android and Swift paths are candidates for an Echolet-owned React Native bridge, not an existing supported drop-in integration. License metadata is AGPLv3. [Official libsignal documentation](https://github.com/signalapp/libsignal). Sources checked 2026-09-06; license compatibility and maintenance ownership remain selection inputs, not legal conclusions.

Before selecting a production implementation:

1. Choose a maintained implementation/version with inbound/outbound identity rejection verified, and record security review provenance. Do not silently patch installed dependency files or claim the community fork audited.
2. Define separate protocol identity binding, numeric registration/device/prekey identifiers, typed initial/subsequent ciphertext, and wire-version migration. Current Ed25519-signed Echolet bundle is not the library's Signal bundle shape.
3. Make the adapter asynchronous; implement encrypted durable records and atomic session/outbox updates, including retry-after-ambiguous-send and crash recovery. JSON round-trip in this spike does not establish those properties.
4. Implement trusted contact/device verification and explicit key-change handling before accepting remote bundles.
5. Run the same scenarios on two real target phones, including relaunch, disconnect/reconnect and background delivery. Obtain independent security review before sensitive use.

These are bounded follow-up tasks. No real-device or independent-review evidence exists from this worker. No user-pilot result was produced.

## Routing audit

`graph_used`: affected session module; `wiki_used`: index read, no pages available; `ctx_used`: compact reads, searches and spike run; `raw_rg_used: no`. Exact targeted source excerpts were read after compact output omitted implementation details. Local context-collector skill's SUBAGENT-STOP explicitly instructed this worker to skip its orchestrator workflow and execute the assigned task. Testing skill/context read before spike; this is an isolated executable investigation, not a full project testing/health claim.
