import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateIdentityKeyPair, signCanonicalJson, signUtf8Message, encodeBase64Url, decodeBase64Url } from '@echolet/crypto-core';
import { signalAddressForDevice, signalBundleV2SigningText, type DeviceRecord, type SignalPreKeyBundleV2 } from '@echolet/protocol';
import { SignalClient } from './SignalClient';
import { EncryptedSqliteStore } from './EncryptedSqliteStore';
import { exportSignedSignalBundleV2, importVerifiedSignalBundleV2 } from './wire';
// Use existing crypto-core's installed primitives for synthetic Ed25519 credentials.
const keyPair = () => { const keys = generateIdentityKeyPair(); return { publicKey: decodeBase64Url(keys.publicKey), secretKey: decodeBase64Url(keys.secretKey) }; };
const resources:Array<{path:string;store:EncryptedSqliteStore}>=[];
afterEach(async()=>{for(const r of resources.splice(0)){await r.store.close();rmSync(r.path,{recursive:true,force:true});}});
const now=1800000000000;
async function participant() {
  const root=keyPair(),device=keyPair();
  const record:DeviceRecord={type:'device_record',version:1,identity_id:encodeBase64Url(root.publicKey),device_id:randomUUID(),device_pubkey:encodeBase64Url(device.publicKey),capabilities:{receipts:true,mailbox_poll:true,attachments:false},created_at_ms:now-10,signature:''};
  record.signature=signCanonicalJson(record,root.secretKey);
  const path=mkdtempSync(join(tmpdir(),'echolet-wire-')),store=new EncryptedSqliteStore(join(path,'state.sqlite'),randomBytes(32));resources.push({path,store});
  const client=await SignalClient.create(store,signalAddressForDevice(record.identity_id,record.device_id));
  const wire=await exportSignedSignalBundleV2(client,{deviceRecord:record,deviceSecretKey:device.secretKey,createdAtMs:now,expiresAtMs:now+1000});
  return {client,wire,record,secret:device.secretKey,rootSecret:root.secretKey,expected:{identityId:record.identity_id,deviceId:record.device_id}};
}
const clone=(wire:SignalPreKeyBundleV2):SignalPreKeyBundleV2=>JSON.parse(JSON.stringify(wire));
const resign=(wire:SignalPreKeyBundleV2,secret:Uint8Array)=>{wire.signature=signUtf8Message(signalBundleV2SigningText(wire),secret);return wire;};
describe('identity-bound Signal wire v2',()=>{
  it('snapshots signing inputs before awaiting public records', async () => {
    const p = await participant();
    const original = p.client.publicBundle.bind(p.client);
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(p.client, 'publicBundle').mockImplementationOnce(async () => { await pause; return original(); });
    const record = JSON.parse(JSON.stringify(p.record)) as DeviceRecord;
    const signingKey = Uint8Array.from(p.secret);
    const options = { deviceRecord: record, deviceSecretKey: signingKey, createdAtMs: now, expiresAtMs: now + 1000 };
    const pending = exportSignedSignalBundleV2(p.client, options);
    record.device_id = randomUUID();
    signingKey.fill(0);
    options.expiresAtMs = now - 1;
    release();
    const wire = await pending;
    expect(importVerifiedSignalBundleV2(wire, p.expected, now).address).toEqual(p.client.address);
    expect(wire.expires_at_ms).toBe(now + 1000);
  });
  it('exports null after one-time key consumption and preserves legacy signature semantics', async () => {
    const a = await participant(), b = await participant();
    const imported = importVerifiedSignalBundleV2(b.wire, b.expected, now);
    await a.client.approveRemote(imported.address, imported.bundle.identityKey().serialize());
    await b.client.approveRemote(a.client.address, (await a.client.publicBundle()).identityKey().serialize());
    await a.client.establish(imported.address, imported.bundle);
    await b.client.decrypt(a.client.address, await a.client.encrypt(b.client.address, 'consume', 'hello'));
    const next = await exportSignedSignalBundleV2(b.client, { deviceRecord: b.record, deviceSecretKey: b.secret, createdAtMs: now, expiresAtMs: now + 1000 });
    expect(next.one_time_prekey).toBeNull();
    const reordered = clone(b.wire);
    reordered.device_record.capabilities = { attachments: false, mailbox_poll: true, receipts: true };
    expect(signalBundleV2SigningText(reordered)).toBe(signalBundleV2SigningText(b.wire));
    expect(() => importVerifiedSignalBundleV2(reordered, b.expected, now)).toThrow('root signature');
  });
  it('roundtrips JSON, preserves legacy capabilities ordering, requires explicit trust, then exchanges replies',async()=>{
    const a=await participant(),b=await participant();
    const ba=importVerifiedSignalBundleV2(clone(b.wire),b.expected,now),ab=importVerifiedSignalBundleV2(clone(a.wire),a.expected,now);
    await expect(a.client.establish(ba.address,ba.bundle)).rejects.toThrow();
    await a.client.approveRemote(ba.address,ba.bundle.identityKey().serialize());
    await b.client.approveRemote(ab.address,ab.bundle.identityKey().serialize());
    await a.client.establish(ba.address,ba.bundle);
    expect(await b.client.decrypt(ab.address,await a.client.encrypt(ba.address,'first','first'))).toBe('first');
    expect(await a.client.decrypt(ba.address,await b.client.encrypt(ab.address,'reply','reply'))).toBe('reply');
  });
  it('rejects wrong caller expectations, lifetime errors and forged root record',async()=>{
    const p=await participant();
    expect(()=>importVerifiedSignalBundleV2(p.wire,{...p.expected,deviceId:randomUUID()},now)).toThrow();
    expect(()=>importVerifiedSignalBundleV2(p.wire,{...p.expected,identityId:encodeBase64Url(randomBytes(32))},now)).toThrow();
    expect(()=>importVerifiedSignalBundleV2(p.wire,p.expected,now-1)).toThrow();
    expect(()=>importVerifiedSignalBundleV2(p.wire,p.expected,now+1000)).toThrow();
    const forged=clone(p.wire);forged.device_record.device_label='forged';resign(forged,p.secret);
    expect(()=>importVerifiedSignalBundleV2(forged,p.expected,now)).toThrow();
  });
  it('rejects substituted native keys and signatures even with valid outer device signature',async()=>{
    const a=await participant(),b=await participant();
    for(const mutate of [
      (wire:SignalPreKeyBundleV2)=>{wire.signal_identity_key=b.wire.signal_identity_key;},
      (wire:SignalPreKeyBundleV2)=>{wire.signed_prekey.public_key=b.wire.signed_prekey.public_key;},
      (wire:SignalPreKeyBundleV2)=>{wire.signed_prekey.signature=encodeBase64Url(new Uint8Array(64));},
      (wire:SignalPreKeyBundleV2)=>{wire.kyber_prekey.public_key=b.wire.kyber_prekey.public_key;},
      (wire:SignalPreKeyBundleV2)=>{wire.kyber_prekey.signature=encodeBase64Url(new Uint8Array(64));},
    ]){const wire=clone(a.wire);mutate(wire);resign(wire,a.secret);expect(()=>importVerifiedSignalBundleV2(wire,a.expected,now)).toThrow();}
    const altered=clone(a.wire);altered.signed_prekey.signature=b.wire.signed_prekey.signature;
    expect(()=>importVerifiedSignalBundleV2(altered,a.expected,now)).toThrow();
  });
  it('rejects shape/base64/prefix corruption and unknown fields',async()=>{
    const p=await participant();
    for(const wire of [{...p.wire,extra:true},{...p.wire,version:1},{...p.wire,signal_identity_key:p.wire.signal_identity_key+'='},{...p.wire,signal_identity_key:encodeBase64Url(new Uint8Array(33))},{...p.wire,signal_identity_key:encodeBase64Url(new Uint8Array(32))}])expect(()=>importVerifiedSignalBundleV2(wire,p.expected,now)).toThrow();
    const bad=clone(p.wire),key=decodeBase64Url(bad.kyber_prekey.public_key);key[0]=7;bad.kyber_prekey.public_key=encodeBase64Url(key);
    expect(()=>importVerifiedSignalBundleV2(bad,p.expected,now)).toThrow();
  });
  it('rejects local address/signing-key mismatches and cannot overwrite approved Signal identity',async()=>{
    const a=await participant(),b=await participant();
    await expect(exportSignedSignalBundleV2(a.client,{deviceRecord:b.record,deviceSecretKey:b.secret,createdAtMs:now,expiresAtMs:now+1000})).rejects.toThrow();
    await expect(exportSignedSignalBundleV2(a.client,{deviceRecord:a.record,deviceSecretKey:b.secret,createdAtMs:now,expiresAtMs:now+1000})).rejects.toThrow();
    const verified=importVerifiedSignalBundleV2(a.wire,a.expected,now);
    await b.client.approveRemote(verified.address,verified.bundle.identityKey().serialize());
    const replacement=clone(a.wire);replacement.signal_identity_key=b.wire.signal_identity_key;replacement.signed_prekey=b.wire.signed_prekey;replacement.kyber_prekey=b.wire.kyber_prekey;replacement.one_time_prekey=b.wire.one_time_prekey;resign(replacement,a.secret);
    const imported=importVerifiedSignalBundleV2(replacement,a.expected,now);
    await expect(b.client.approveRemote(imported.address,imported.bundle.identityKey().serialize())).rejects.toThrow();
  });
});
