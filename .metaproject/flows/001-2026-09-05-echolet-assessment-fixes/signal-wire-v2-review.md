# Signal wire v2 independent review

STATUS: DONE. Verdict: APPROVE for T20/T21 bounded shared-schema and Node adapter scope.

Scope: strict shared schema and Node public bundle export/verified import against signal-wire-v2-spec.md. Relay routes, allocation and mobile integration excluded. Generic dispatch validated in dispatches/signal-wire-v2-review.json.

## Contract assessment

No blocking design issue identified in the fixed tuple transcript or separate native identity binding. Type/version/suite literals constrain omitted constant fields; nested DR/SPK/Kyber signatures are signed. Public Signal identity is distinct from existing Ed25519 identity and device keys. Import requires independently trusted expected identity/device, native signature checks, and does not itself approve trust.

Clarifications sent before implementation: v2 property-order independence does not imply reordering legacy DR capabilities preserves its old root signature; capabilities object is required with only optional known booleans; expected identities must not be copied from untrusted input; snapshot inputs before async work; consumed OTKs must not be republished by export. Direct exchange does not establish relay allocation semantics.

## Routing

Read root index and local review logic/security/testing skills in this task chain; wiki index empty. Graph found legacy canonicalJson before direct read; ctx used for spec/source/test inspection; raw_rg_used: no. No source edits.

## Final source review

Reviewed final protocol signalPreKeyBundleV2.ts/test.ts and exports; session-node wire.ts/test.ts and exports against the spec before quality checks. No remaining actionable findings. Base64url validation enforces decoded length through exact encoded length, alphabet and unused bits; EC/Kyber prefixes and schema literals constrain encodings. Strict nested objects reject unknown fields. The transcript binds all nested signatures while excluding its own signature.

The adapter copies credentials/record/times before awaiting publicBundle, validates the root-signed original DeviceRecord and device signature, checks trusted expectation and lifetime, validates native signatures and only then constructs the public native bundle. Import does not receive a store/client and cannot implicitly modify trust. Tests exercise independently expected identities, changed pins, native substitution even after outer resigning, ordering regression, pre-await input mutation and null OTK after consumption. Relay allocation remains explicitly outside scope.

Independent final workspace checks: 43 cases pass, including 4 new schema and 7 new adapter cases. Details: wire-v2-verification.md.
