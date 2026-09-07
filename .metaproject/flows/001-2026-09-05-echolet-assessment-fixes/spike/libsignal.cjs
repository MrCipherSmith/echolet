// Feasibility only. In-memory store is not application persistence or security approval.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const lib = createRequire(resolve('packages/crypto-core/package.json'))('@privacyresearch/libsignal-protocol-typescript');
lib.setWebCrypto(require('node:crypto').webcrypto);

class Store {
  constructor(state = {}) { this.state = state; }
  async getIdentityKeyPair() { return this.state.identity; }
  async getLocalRegistrationId() { return this.state.registration; }
  async isTrustedIdentity(id, key) {
    const old = this.state[`identity:${id}`];
    return !old || Buffer.from(old).equals(Buffer.from(key));
  }
  async saveIdentity(id, key) { this.state[`identity:${id.replace(/\.\d+$/, "")}`] = key; return false; }
  async loadPreKey(id) { return this.state[`pre:${id}`]; }
  async storePreKey(id, key) { this.state[`pre:${id}`] = key; }
  async removePreKey(id) { delete this.state[`pre:${id}`]; }
  async loadSignedPreKey(id) { return this.state[`signed:${id}`]; }
  async storeSignedPreKey(id, key) { this.state[`signed:${id}`] = key; }
  async removeSignedPreKey(id) { delete this.state[`signed:${id}`]; }
  async loadSession(id) { return this.state[`session:${id}`]; }
  async storeSession(id, record) { this.state[`session:${id}`] = record; }
  reload() {
    const serialized = JSON.stringify(this.state, (_, value) => value instanceof ArrayBuffer ? { bytes: Buffer.from(value).toString('base64') } : value);
    return new Store(JSON.parse(serialized, (_, value) => value && typeof value.bytes === 'string' ? Uint8Array.from(Buffer.from(value.bytes, 'base64')).buffer : value));
  }
}
async function participant() {
  const store = new Store();
  store.state.identity = await lib.KeyHelper.generateIdentityKeyPair();
  store.state.registration = lib.KeyHelper.generateRegistrationId();
  const signed = await lib.KeyHelper.generateSignedPreKey(store.state.identity, 1);
  const pre = await lib.KeyHelper.generatePreKey(2);
  await store.storeSignedPreKey(1, signed.keyPair);
  await store.storePreKey(2, pre.keyPair);
  return { store, bundle: { identityKey: store.state.identity.pubKey, registrationId: store.state.registration,
    signedPreKey: { keyId: 1, publicKey: signed.keyPair.pubKey, signature: signed.signature },
    preKey: { keyId: 2, publicKey: pre.keyPair.pubKey } } };
}
async function main() {
  const a = await participant(); const b = await participant();
  const aa = new lib.SignalProtocolAddress('alice', 1), ba = new lib.SignalProtocolAddress('bob', 1);
  await new lib.SessionBuilder(a.store, ba).processPreKey(b.bundle);
  let ac = new lib.SessionCipher(a.store, ba), bc = new lib.SessionCipher(b.store, aa);
  const enc = (c, s) => c.encrypt(new TextEncoder().encode(s).buffer);
  const dec = async (c, m) => new TextDecoder().decode(await (m.type === 3 ? c.decryptPreKeyWhisperMessage(m.body, 'binary') : c.decryptWhisperMessage(m.body, 'binary')));
  const first = await enc(ac, 'first'); assert.equal(first.type, 3);
  assert.equal(await dec(bc, first), 'first');
  assert.equal(await dec(ac, await enc(bc, 'reply')), 'reply');
  // Round-trip every key/session record through JSON, then create new store/cipher objects.
  a.store = a.store.reload(); b.store = b.store.reload();
  ac = new lib.SessionCipher(a.store, ba); bc = new lib.SessionCipher(b.store, aa);
  const delayed = await enc(ac, 'delayed'), later = await enc(ac, 'later');
  assert.equal(await dec(bc, later), 'later'); assert.equal(await dec(bc, delayed), 'delayed');
  await assert.rejects(() => dec(bc, delayed));
  const crossedA = await enc(ac, 'crossed-a'), crossedB = await enc(bc, 'crossed-b');
  assert.equal(await dec(ac, crossedB), 'crossed-b'); assert.equal(await dec(bc, crossedA), 'crossed-a');
  const bad = await enc(ac, 'tamper');
  const bytes = Buffer.from(bad.body, 'binary'); bytes[bytes.length - 1] ^= 1;
  await assert.rejects(() => dec(bc, { ...bad, body: bytes.toString('binary') }));
  const impostor = await participant();
  await assert.rejects(() => new lib.SessionBuilder(a.store, ba).processPreKey(impostor.bundle));
  // A receiver explicitly rejects the sender identity before its first inbound prekey.
  const rejecting = await participant(), sender = await participant();
  rejecting.store.isTrustedIdentity = async () => false;
  await new lib.SessionBuilder(sender.store, ba).processPreKey(rejecting.bundle);
  const rejectedMessage = await enc(new lib.SessionCipher(sender.store, ba), 'must reject');
  let inboundTrustBypassed = false;
  try { inboundTrustBypassed = (await dec(new lib.SessionCipher(rejecting.store, aa), rejectedMessage)) === 'must reject'; }
  catch { /* Correct rejection would make this reproduction fail. */ }
  assert.equal(inboundTrustBypassed, true, 'Installed 0.0.16 no longer reproduces inbound trust bypass; reassess report');
  console.log(JSON.stringify({ blocker: 'inbound identity trust bypass reproduced', expectedTrust: false, decrypted: inboundTrustBypassed }));
  console.log(JSON.stringify({ result: 'VERIFIED_WITH_SECURITY_BLOCKER', runtime: process.version, library: '0.0.16', checks: ['prekey bootstrap', 'reply', 'JSON store reload', 'out-of-order delivery', 'duplicate rejection', 'crossed sends', 'tamper rejection', 'outbound identity change rejection'], limitations: ['Node only', 'synthetic identities', 'no device or relay integration', 'no durable atomic encrypted storage', 'not a security audit'] }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
