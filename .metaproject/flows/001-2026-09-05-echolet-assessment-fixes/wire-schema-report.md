# Signal wire v2 shared schema

Implemented new protocol schema/type and helpers exactly for the scoped wire-v2 spec. V1 exports and behavior retained, only new index export added. No Node/native imports in production helper.

## Changes
- packages/protocol/src/types/signalPreKeyBundleV2.ts: strict v2 root, strict legacy DeviceRecord validation with original object order/reference preserved, strict EC/SPK/Kyber/OTK objects; canonical unpadded base64url byte lengths/prefixes/unused-bit checks; safe timestamps, <=7-day positive lifetime, uint32 key IDs, lowercase UUIDs, registration range.
- signalAddressForDevice validates root/device IDs and returns deterministic JSON pair name + literal native deviceId 1.
- signalBundleV2SigningText validates full bundle and builds fixed tuple with null optional values and every nested signature; outer signature excluded only. Not signature or current-time validation.
- packages/protocol/src/types/signalPreKeyBundleV2.test.ts: four cases cover valid/raw ordering, all unknown-field boundaries, invalid encodings/numeric/time/ID constraints, exact fixed transcript/reordering and nested signature coverage.
- packages/protocol/src/index.ts: additive export.

## TDD and verification
RED: tests added before module existed, expected import failure (08-38-41-753Z_run.log). GREEN: protocol suite 6/6 passed, including 2 existing v1 tests (08-39-26-301Z_run.log). Typecheck initially identified an unused test callback parameter, corrected to _key; final typecheck passed. No dependencies, v1 source edits, commits, flow-state changes or mobile/relay readiness claims.

## Integration notes
Crypto worker informed of exact exports and original-record preservation. Adapter should still snapshot unknown input before async work and verify original strict DeviceRecord, because the v1 signature is ordering-sensitive. Full typed bundle including a structural 64-byte outer signature placeholder required when producing unsigned signing text. Import performs current-time/signature validation; schema does not claim those checks. Shared schema result does not itself satisfy Node exchange acceptance, owned by crypto worker.

## Routing audit
Read index and validated generic dispatch; existing task-implementer Git/issue schema cannot apply without fabricating absent metadata, so generic flow worker contract used as directed. graph_used: gdgraph find DeviceRecord; wiki_used: prior empty index; ctx_used: targeted context and test/typecheck captures; raw_rg_used: no. Testing skill/context read earlier in this task, related-test query returned no entries; existing protocol suite used. New files require graph rebuild before current graph answers.
