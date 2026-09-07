import { describe, expect, it } from "vitest";
import { createPublicKey, verify } from "node:crypto";
import { SignalPreKeyBundleV2Schema, signalAddressForDevice, signalBundleV2SigningText } from "./signalPreKeyBundleV2";
import relayV2Fixtures from "./fixtures/relay-v2.json";

const bytes = (size: number, prefix = 0) => {
 const value = Buffer.alloc(size); value[0] = prefix; return value.toString("base64url");
};
function bundle() {
 return {
  type: "signal_prekey_bundle", version: 2, suite: "libsignal-pq-v1",
  bundle_id: "f841b845-e677-4bce-b18e-d1d3bf745e67", created_at_ms: 1000, expires_at_ms: 2000,
  device_record: { type:"device_record", version:1, identity_id:bytes(32), device_id:"110a486a-e330-43dd-8383-b1aa8b1cc353", device_pubkey:bytes(32), capabilities:{receipts:true,mailbox_poll:false}, created_at_ms:0, signature:bytes(64) },
  registration_id: 12, signal_identity_key:bytes(33,5),
  signed_prekey:{key_id:0,public_key:bytes(33,5),signature:bytes(64)},
  kyber_prekey:{key_id:4294967295,public_key:bytes(1569,8),signature:bytes(64)},
  one_time_prekey:null, signature:bytes(64),
 };
}

type Mutation = { path: string; value: unknown };

function applyMutations<T>(input: T, mutations: Mutation[]): T {
 const output = structuredClone(input) as Record<string, unknown>;
 for (const mutation of mutations) {
  const parts = mutation.path.split(".");
  let target = output;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  target[parts.at(-1)!] = mutation.value;
 }
 return output as T;
}

function canonicalJson(value: unknown): string {
 if (value === null || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
 const object = value as Record<string, unknown>;
 return JSON.stringify(Object.keys(object).sort().reduce<Record<string, unknown>>((sorted, key) => {
  sorted[key] = object[key];
  return sorted;
 }, {}));
}

function verifyEd25519(message: string, signature: string, publicKey: string): boolean {
 const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
 const key = createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(publicKey, "base64url")]), format: "der", type: "spki" });
 return verify(null, Buffer.from(message), key, Buffer.from(signature, "base64url"));
}

function relayBoundaryAccepts(request: unknown, nowMs: number): boolean {
 try {
  const parsedRequest = request as { bundle: unknown };
  const parsed = SignalPreKeyBundleV2Schema.parse(parsedRequest.bundle);
  if (parsed.one_time_prekey === null || parsed.created_at_ms > nowMs || parsed.expires_at_ms <= nowMs) return false;
  const { signature: deviceSignature, ...unsignedDevice } = parsed.device_record;
  if (!verifyEd25519(canonicalJson(unsignedDevice), deviceSignature, parsed.device_record.identity_id)) return false;
  return verifyEd25519(signalBundleV2SigningText(parsed), parsed.signature, parsed.device_record.device_pubkey);
 } catch {
  return false;
 }
}
describe("Signal v2 wire structure", () => {
 it("accepts the shared relay fixture with non-schema capabilities order", () => {
  const request = relayV2Fixtures.valid_publish_request;
 expect(Object.keys(request.bundle.device_record.capabilities)).toEqual(["receipts", "mailbox_poll", "attachments"]);
 expect(relayBoundaryAccepts(request, relayV2Fixtures.now_ms)).toBe(true);
  for (const fixture of relayV2Fixtures.valid_variants) {
   const variant = applyMutations(request, fixture.mutations);
   const validationTime = fixture.name === "expired_tombstone_reuse" ? relayV2Fixtures.now_ms + 2 * 24 * 60 * 60 * 1000 : relayV2Fixtures.now_ms;
   expect(relayBoundaryAccepts(variant, validationTime), fixture.name).toBe(true);
  }
 });
 it("rejects every shared invalid relay fixture", () => {
  for (const fixture of relayV2Fixtures.invalid_publish_requests) {
   const request = applyMutations(relayV2Fixtures.valid_publish_request, fixture.mutations);
   expect(relayBoundaryAccepts(request, relayV2Fixtures.now_ms), fixture.name).toBe(false);
  }
 });
 it("accepts exact shape and preserves original legacy signed record order", () => {
  const input=bundle(), parsed=SignalPreKeyBundleV2Schema.parse(input);
  expect(parsed.device_record).toBe(input.device_record);
  expect(Object.keys(parsed.device_record.capabilities)).toEqual(["receipts","mailbox_poll"]);
  expect(signalAddressForDevice(input.device_record.identity_id,input.device_record.device_id)).toEqual({name:JSON.stringify([input.device_record.identity_id,input.device_record.device_id]),deviceId:1});
 });
 it("rejects unknown fields at every object boundary", () => {
  const input=bundle();
  for (const value of [
   {...input,extra:1}, {...input,device_record:{...input.device_record,extra:1}},
   {...input,device_record:{...input.device_record,capabilities:{...input.device_record.capabilities,extra:true}}},
   {...input,signed_prekey:{...input.signed_prekey,extra:1}}, {...input,kyber_prekey:{...input.kyber_prekey,extra:1}},
   {...input,one_time_prekey:{key_id:1,public_key:bytes(33,5),extra:1}},
  ]) expect(SignalPreKeyBundleV2Schema.safeParse(value).success).toBe(false);
 });
 it("rejects invalid encodings, sizes, prefixes, IDs and time bounds", () => {
  const input=bundle();
  for (const patch of [
   {version:1},{suite:"unknown"},{bundle_id:input.bundle_id.toUpperCase()},
   {created_at_ms:-1},{created_at_ms:1.5},{created_at_ms:Number.MAX_SAFE_INTEGER+1},
   {expires_at_ms:1000},{expires_at_ms:1000+7*24*60*60*1000+1},
   {registration_id:0},{registration_id:16381},
   {signal_identity_key:bytes(32,5)},{signal_identity_key:bytes(33,6)},
   {signature:bytes(64)+"="},{signature:bytes(64).slice(0,-1)+"B"},
   {kyber_prekey:{...input.kyber_prekey,public_key:bytes(1569,5)}},
   {signed_prekey:{...input.signed_prekey,key_id:-1}},
   {one_time_prekey:{key_id:4294967296,public_key:bytes(33,5)}},
   {device_record:{...input.device_record,device_label:"x".repeat(257)}},
   {device_record:{...input.device_record,identity_id:bytes(31)}},
  ]) expect(SignalPreKeyBundleV2Schema.safeParse({...input,...patch}).success).toBe(false);
  expect(()=>signalAddressForDevice("invalid",input.device_record.device_id)).toThrow();
  expect(()=>signalBundleV2SigningText({...input,version:1} as never)).toThrow();
 });
 it("uses exact fixed transcript independent of object order and covers nested signatures", () => {
  const input=SignalPreKeyBundleV2Schema.parse(bundle());
  const tuple=["echolet.signal.prekey_bundle.v2",input.bundle_id,input.suite,
   ["device_record",1,input.device_record.identity_id,input.device_record.device_id,input.device_record.device_pubkey,null,[false,true,null],0,input.device_record.signature],
   1000,2000,12,input.signal_identity_key,[0,input.signed_prekey.public_key,input.signed_prekey.signature],
   [4294967295,input.kyber_prekey.public_key,input.kyber_prekey.signature],null];
  expect(signalBundleV2SigningText(input)).toBe(JSON.stringify(tuple));
  const reordered=JSON.parse(JSON.stringify(input,(_key,value)=>value&&typeof value==="object"&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value));
  expect(signalBundleV2SigningText(reordered)).toBe(signalBundleV2SigningText(input));
  expect(signalBundleV2SigningText({...input,signature:bytes(64,1)})).toBe(signalBundleV2SigningText(input));
  for (const patch of [
   {device_record:{...input.device_record,signature:bytes(64,1)}},
   {signed_prekey:{...input.signed_prekey,signature:bytes(64,1)}},
   {kyber_prekey:{...input.kyber_prekey,signature:bytes(64,1)}},
   {one_time_prekey:{key_id:5,public_key:bytes(33,5)}},
  ]) expect(signalBundleV2SigningText({...input,...patch})).not.toBe(signalBundleV2SigningText(input));
 });
});
