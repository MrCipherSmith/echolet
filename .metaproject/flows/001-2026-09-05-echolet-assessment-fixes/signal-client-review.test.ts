import { it, expect } from "../../../packages/session-node/node_modules/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SignalClient } from "../../../packages/session-node/src/SignalClient";
import { EncryptedSqliteStore } from "../../../packages/session-node/src/EncryptedSqliteStore";

it("rejects same ID with distinct lone surrogate strings", async () => {
 const path = mkdtempSync(join(tmpdir(), "echolet-review-"));
 const aStore = new EncryptedSqliteStore(join(path,"a.sqlite"),randomBytes(32));
 const bStore = new EncryptedSqliteStore(join(path,"b.sqlite"),randomBytes(32));
 try {
  const aAddr = {name:"a",deviceId:1}, bAddr={name:"b",deviceId:1};
  const a=await SignalClient.create(aStore,aAddr), b=await SignalClient.create(bStore,bAddr);
  const bundle=await b.publicBundle();
  await a.approveRemote(bAddr,bundle.identityKey().serialize());
  await a.establish(bAddr,bundle);
  await a.encrypt(bAddr,"id","\ud800");
  await expect(a.encrypt(bAddr,"id","\ud801")).rejects.toThrow("different content");
 } finally { await aStore.close(); await bStore.close(); rmSync(path,{recursive:true,force:true}); }
});

it("owns queued input bytes/addresses and serializes duplicate IDs without extra ratchet advances", async () => {
 const path = mkdtempSync(join(tmpdir(), "echolet-review-"));
 const aStore = new EncryptedSqliteStore(join(path,"a.sqlite"),randomBytes(32));
 const bStore = new EncryptedSqliteStore(join(path,"b.sqlite"),randomBytes(32));
 try {
  const aAddr={name:"a",deviceId:1}, bAddr={name:"b",deviceId:1};
  const a=await SignalClient.create(aStore,aAddr), b=await SignalClient.create(bStore,bAddr);
  const bb=await b.publicBundle(), ab=await a.publicBundle();
  const trustAddress={...bAddr}, trustBytes=Uint8Array.from(bb.identityKey().serialize());
  const approval=a.approveRemote(trustAddress,trustBytes);
  trustAddress.name="mutated"; trustBytes.fill(0); await approval;
  await b.approveRemote(aAddr,ab.identityKey().serialize());
  await a.establish(bAddr,bb);
  const remote={...bAddr};
  const pending=a.encrypt(remote,"same","one"); remote.name="mutated";
  const concurrent=a.encrypt(bAddr,"same","one");
  const [first,duplicate]=await Promise.all([pending,concurrent]);
  expect(duplicate).toEqual(first);
  const pristine=Uint8Array.from(first.body);
  const receiveAddress={...aAddr};
  const receiving=b.decrypt(receiveAddress,first);
  first.body.fill(0); first.messageId="mutated"; receiveAddress.name="mutated";
  expect(await receiving).toBe("one");
  expect((await a.retry(bAddr,"same")).body).toEqual(pristine);
  await expect(b.decrypt(aAddr,duplicate)).rejects.toThrow("already received");
  expect(await b.decrypt(aAddr,await a.encrypt(bAddr,"next","two"))).toBe("two");
 } finally { await aStore.close(); await bStore.close(); rmSync(path,{recursive:true,force:true}); }
});
