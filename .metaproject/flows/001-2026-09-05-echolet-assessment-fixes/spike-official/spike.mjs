import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import * as L from '@signalapp/libsignal-client';
const b64 = bytes => Buffer.from(bytes).toString('base64');
const bytes = text => Buffer.from(text, 'base64');
class Store {
  constructor(state) { this.state = state; this.deny = false; }
  async getIdentityKey() { return L.PrivateKey.deserialize(bytes(this.state.privateKey)); }
  async getIdentityKeyPair() { const key=await this.getIdentityKey(); return new L.IdentityKeyPair(key.getPublicKey(),key); }
  async getLocalRegistrationId() { return this.state.registration; }
  async getIdentity(address) { const key = this.state.trust[address.toString()]; return key ? L.PublicKey.deserialize(bytes(key)) : null; }
  async isTrustedIdentity(address, key) { const old = await this.getIdentity(address); return !this.deny && old !== null && old.equals(key); }
  async saveIdentity(address, key) {
    if (!await this.isTrustedIdentity(address, key)) throw new Error('unapproved identity');
    return L.IdentityChange.NewOrUnchanged;
  }
  async getSession(address) { const record = this.state.sessions[address.toString()]; return record ? L.SessionRecord.deserialize(bytes(record)) : null; }
  async getExistingSessions(addresses) { return Promise.all(addresses.map(async address => { const r = await this.getSession(address); if (!r) throw new Error('missing session'); return r; })); }
  async saveSession(address, record) { this.state.sessions[address.toString()] = b64(record.serialize()); }
  async getPreKey(id) { if (!this.state.pre[id]) throw new Error('missing prekey'); return L.PreKeyRecord.deserialize(bytes(this.state.pre[id])); }
  async savePreKey(id, record) { this.state.pre[id] = b64(record.serialize()); }
  async removePreKey(id) { delete this.state.pre[id]; }
  async getSignedPreKey(id) { return L.SignedPreKeyRecord.deserialize(bytes(this.state.signed[id])); }
  async saveSignedPreKey(id, record) { this.state.signed[id] = b64(record.serialize()); }
  async getKyberPreKey(id) { return L.KyberPreKeyRecord.deserialize(bytes(this.state.kyber[id])); }
  async saveKyberPreKey(id, record) { this.state.kyber[id] = b64(record.serialize()); }
  async markKyberPreKeyUsed(id, signedId, baseKey) { const tuple = `${id}:${signedId}:${b64(baseKey.serialize())}`; if (this.state.used.includes(tuple)) throw new Error('duplicate kyber use'); this.state.used.push(tuple); }
  reload() { return new Store(JSON.parse(JSON.stringify(this.state))); }
}
function participant() {
  const identity = L.PrivateKey.generate(), pre = L.PrivateKey.generate(), signed = L.PrivateKey.generate(), kyber = L.KEMKeyPair.generate();
  const signedSig = identity.sign(signed.getPublicKey().serialize()), kyberSig = identity.sign(kyber.getPublicKey().serialize());
  const registration = randomInt(1, 16380);
  const store = new Store({ privateKey: b64(identity.serialize()), registration, trust: {}, sessions: {}, pre: { 1: b64(L.PreKeyRecord.new(1, pre.getPublicKey(), pre).serialize()) }, signed: { 2: b64(L.SignedPreKeyRecord.new(2, Date.now(), signed.getPublicKey(), signed, signedSig).serialize()) }, kyber: { 3: b64(L.KyberPreKeyRecord.new(3, Date.now(), kyber, kyberSig).serialize()) }, used: [] });
  return { store, address: L.ProtocolAddress.new(randomUUID(), 1), identity: identity.getPublicKey(), bundle: L.PreKeyBundle.new(registration, 1, 1, pre.getPublicKey(), 2, signed.getPublicKey(), signedSig, identity.getPublicKey(), 3, kyber.getPublicKey(), kyberSig) };
}
const approve = (a,b) => { a.store.state.trust[b.address.toString()] = b64(b.identity.serialize()); };
const enc = async (a,b,text) => { const message = await L.signalEncrypt(Buffer.from(text), b.address, a.address, a.store, a.store); return {type: message.type(), body: message.serialize()}; };
const dec = async (a,b,message) => Buffer.from(await (message.type === L.CiphertextMessageType.PreKey ? L.signalDecryptPreKey(L.PreKeySignalMessage.deserialize(message.body), b.address, a.address, a.store, a.store, a.store, a.store, a.store) : L.signalDecrypt(L.SignalMessage.deserialize(message.body), b.address, a.address, a.store, a.store))).toString();
const a = participant(), b = participant(); approve(a,b); approve(b,a);
await L.processPreKeyBundle(b.bundle,b.address,a.address,a.store,a.store);
const first = await enc(a,b,'first'); assert.equal(first.type,L.CiphertextMessageType.PreKey);
assert.equal(await dec(b,a,first),'first');
assert.equal(await dec(a,b,await enc(b,a,'reply')),'reply');
a.store = a.store.reload(); b.store = b.store.reload();
const delayed = await enc(a,b,'delayed'), later = await enc(a,b,'later');
assert.equal(await dec(b,a,later),'later'); assert.equal(await dec(b,a,delayed),'delayed');
await assert.rejects(() => dec(b,a,delayed));
const crossedA = await enc(a,b,'cross-a'), crossedB = await enc(b,a,'cross-b');
assert.equal(await dec(a,b,crossedB),'cross-b'); assert.equal(await dec(b,a,crossedA),'cross-a');
const good = await enc(a,b,'tamper'); const bad = {...good,body:Uint8Array.from(good.body)}; bad.body[bad.body.length-1]^=1;
await assert.rejects(()=>dec(b,a,bad)); assert.equal(await dec(b,a,good),'tamper');
const c = participant(), d = participant(); approve(c,d); approve(d,c);
c.store.deny = true;
await assert.rejects(()=>L.processPreKeyBundle(d.bundle,d.address,c.address,c.store,c.store));
c.store.deny=false;
await L.processPreKeyBundle(d.bundle,d.address,c.address,c.store,c.store);
const rejected = await enc(c,d,'reject-inbound'); d.store.deny=true;
const before=JSON.stringify(d.store.state);
await assert.rejects(()=>dec(d,c,rejected)); assert.equal(JSON.stringify(d.store.state),before);
d.store.deny=false; assert.equal(await dec(d,c,rejected),'reject-inbound');
c.store.deny=true; await assert.rejects(()=>enc(c,d,'reject-outbound'));
console.log(JSON.stringify({result:'PASS',package:'@signalapp/libsignal-client',version:'0.102.0',node:process.version,platform:process.platform,arch:process.arch,checks:['PQ prekey bootstrap','reply','JSON store reload','out-of-order','duplicate rejection','crossed sends','tamper rejection and valid retry','untrusted outbound bundle','untrusted inbound prekey with unchanged state','untrusted established outbound'],limits:['Node native only','no actual persistence/crash transaction','no phones/relay integration','no audit']}));
