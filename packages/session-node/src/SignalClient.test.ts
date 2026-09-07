import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";
import { SignalClient } from "./SignalClient";
import { EncryptedSqliteStore } from "./EncryptedSqliteStore";
import type { StoreTransaction, TransactionalStore } from "./store";
const resources: Array<{ path: string; store: EncryptedSqliteStore }> = [];
afterEach(async () => {
  for (const r of resources.splice(0)) {
    await r.store.close();
    rmSync(r.path, { recursive: true, force: true });
  }
});
async function participant() {
  const path = mkdtempSync(join(tmpdir(), "echolet-session-")),
    key = randomBytes(32);
  const address = { name: randomUUID(), deviceId: 1 };
  const store = new EncryptedSqliteStore(join(path, "state.sqlite"), key);
  const resource = { path, store };
  resources.push(resource);
  return {
    client: await SignalClient.create(store, address),
    store,
    resource,
    key,
    address,
  };
}
async function pair() {
  const a = await participant(),
    b = await participant();
  const ab = await a.client.publicBundle(),
    bb = await b.client.publicBundle();
  await a.client.approveRemote(b.address, bb.identityKey().serialize());
  await b.client.approveRemote(a.address, ab.identityKey().serialize());
  await a.client.establish(b.address, bb);
  return { a, b };
}

describe("official durable Signal reference", () => {
  it("restores keys and sessions across close/reopen, replies, delayed and crossed sends", async () => {
    const { a, b } = await pair();
    expect(
      await b.client.decrypt(
        a.address,
        await a.client.encrypt(b.address, "first", "hello"),
      ),
    ).toBe("hello");
    expect(
      await a.client.decrypt(
        b.address,
        await b.client.encrypt(a.address, "reply", "reply"),
      ),
    ).toBe("reply");
    const before = (await a.client.publicBundle()).identityKey().serialize();
    await a.store.close();
    a.resource.store = new EncryptedSqliteStore(
      join(a.resource.path, "state.sqlite"),
      a.key,
    );
    a.client = await SignalClient.create(a.resource.store, a.address);
    expect((await a.client.publicBundle()).identityKey().serialize()).toEqual(
      before,
    );
    const early = await a.client.encrypt(b.address, "early", "early"),
      late = await a.client.encrypt(b.address, "late", "late");
    expect(await b.client.decrypt(a.address, late)).toBe("late");
    expect(await b.client.decrypt(a.address, early)).toBe("early");
    await expect(b.client.decrypt(a.address, early)).rejects.toThrow();
    const crossA = await a.client.encrypt(b.address, "crossA", "crossA"),
      crossB = await b.client.encrypt(a.address, "crossB", "crossB");
    expect(await a.client.decrypt(b.address, crossB)).toBe("crossB");
    expect(await b.client.decrypt(a.address, crossA)).toBe("crossA");
  });
  it("reuses persisted ciphertext for retries and refuses id/content collisions", async () => {
    const { a, b } = await pair();
    const encrypted = await a.client.encrypt(b.address, "same", "hello");
    expect(await a.client.retry(b.address, "same")).toEqual(encrypted);
    expect(await a.client.encrypt(b.address, "same", "hello")).toEqual(
      encrypted,
    );
    await expect(
      a.client.encrypt(b.address, "same", "different"),
    ).rejects.toThrow();
    expect(await b.client.decrypt(a.address, encrypted)).toBe("hello");
    expect(
      await b.client.decrypt(
        a.address,
        await a.client.encrypt(b.address, "next", "next"),
      ),
    ).toBe("next");
  });
  it("rejects unapproved and changed identity on outbound/inbound bootstrap", async () => {
    const a = await participant(),
      b = await participant(),
      impostor = await participant();
    const bundle = await b.client.publicBundle();
    await expect(a.client.establish(b.address, bundle)).rejects.toThrow();
    await a.client.approveRemote(b.address, bundle.identityKey().serialize());
    await expect(
      a.client.approveRemote(
        b.address,
        (await impostor.client.publicBundle()).identityKey().serialize(),
      ),
    ).rejects.toThrow();
    await a.client.establish(b.address, bundle);
    const message = await a.client.encrypt(b.address, "trust", "trust");
    await expect(b.client.decrypt(a.address, message)).rejects.toThrow();
    await b.client.approveRemote(
      a.address,
      (await a.client.publicBundle()).identityKey().serialize(),
    );
    expect(await b.client.decrypt(a.address, message)).toBe("trust");
  });
  it("rolls back a rejected tamper and refuses unauthenticated transport-id changes", async () => {
    const { a, b } = await pair();
    const good = await a.client.encrypt(b.address, "tamper", "hello");
    const body = Uint8Array.from(good.body);
    body[body.length - 1] = body[body.length - 1]! ^ 1;
    await expect(
      b.client.decrypt(a.address, { ...good, body }),
    ).rejects.toThrow();
    await expect(
      b.client.decrypt(a.address, { ...good, messageId: "modified" }),
    ).rejects.toThrow();
    expect(await b.client.decrypt(a.address, good)).toBe("hello");
  });
  it("does not expose ciphertext or consume receiver state on failed commit", async () => {
    const { a, b } = await pair();
    let fail = true;
    const failing: TransactionalStore = {
      transaction: (fn) =>
        a.store.transaction(async (tx: StoreTransaction) => {
          const value = await fn(tx);
          if (fail) throw new Error("injected commit failure");
          return value;
        }),
    };
    fail = false;
    const client = await SignalClient.create(failing, a.address);
    fail = true;
    await expect(client.encrypt(b.address, "failed", "hello")).rejects.toThrow(
      "injected",
    );
    await expect(a.client.retry(b.address, "failed")).rejects.toThrow();
    fail = false;
    const valid = await client.encrypt(b.address, "failed", "hello");
    let failReceive = true;
    const receiveStore: TransactionalStore = {
      transaction: (fn) =>
        b.store.transaction(async (tx) => {
          const result = await fn(tx);
          if (failReceive) throw new Error("receive commit failed");
          return result;
        }),
    };
    failReceive = false;
    const receiver = await SignalClient.create(receiveStore, b.address);
    failReceive = true;
    await expect(receiver.decrypt(a.address, valid)).rejects.toThrow(
      "receive commit failed",
    );
    failReceive = false;
    expect(await receiver.decrypt(a.address, valid)).toBe("hello");
  });
  it("serializes concurrent sends and preserves exact retry after reopen", async () => {
    const { a, b } = await pair();
    const messages = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        a.client.encrypt(b.address, `m${i}`, `body${i}`),
      ),
    );
    for (const message of messages.reverse())
      expect(await b.client.decrypt(a.address, message)).toBe(
        `body${message.messageId.slice(1)}`,
      );
    await a.store.close();
    a.resource.store = new EncryptedSqliteStore(
      join(a.resource.path, "state.sqlite"),
      a.key,
    );
    const reopened = await SignalClient.create(a.resource.store, a.address);
    expect(await reopened.retry(b.address, "m0")).toEqual(
      messages.find((m) => m.messageId === "m0"),
    );
  });
  it("rejects revoked trust for established incoming and outgoing traffic", async () => {
    const { a, b } = await pair();
    expect(
      await b.client.decrypt(
        a.address,
        await a.client.encrypt(b.address, "first", "first"),
      ),
    ).toBe("first");
    expect(
      await a.client.decrypt(
        b.address,
        await b.client.encrypt(a.address, "reply", "reply"),
      ),
    ).toBe("reply");
    const message = await a.client.encrypt(b.address, "after", "after");
    await b.store.transaction((tx) =>
      tx.delete(
        `trust:${JSON.stringify([a.address.name, a.address.deviceId])}`,
      ),
    );
    await expect(b.client.decrypt(a.address, message)).rejects.toThrow();
    await expect(
      b.client.encrypt(a.address, "blocked", "blocked"),
    ).rejects.toThrow();
    await b.client.approveRemote(
      a.address,
      (await a.client.publicBundle()).identityKey().serialize(),
    );
    expect(await b.client.decrypt(a.address, message)).toBe("after");
  });
  it("restores committed outbox after SIGKILL and rolls back precommit SIGKILL", async () => {
    const { a, b } = await pair();
    const dbPath = join(a.resource.path, "state.sqlite");
    await a.store.close();
    const libraryUrl = pathToFileURL(
      createRequire(import.meta.url).resolve("@signalapp/libsignal-client"),
    ).href;
    for (const name of ["SignalClient", "EncryptedSqliteStore"]) {
      const source = readFileSync(
        join(process.cwd(), `src/${name}.ts`),
        "utf8",
      ).replace('"@signalapp/libsignal-client"', JSON.stringify(libraryUrl));
      const output = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      writeFileSync(join(a.resource.path, `${name}.mjs`), output);
    }
    const script = `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { SignalClient } from ${JSON.stringify(pathToFileURL(join(a.resource.path, "SignalClient.mjs")).href)};
      import { EncryptedSqliteStore } from ${JSON.stringify(pathToFileURL(join(a.resource.path, "EncryptedSqliteStore.mjs")).href)};
      const input=JSON.parse(readFileSync(0,'utf8'));
      const store=new EncryptedSqliteStore(input.path,Buffer.from(input.key,'base64'));
      let active=false;
      const wrapped={transaction:fn=>store.transaction(async tx=>{
        const value=await fn(tx);
        if(active && input.precommit)process.kill(process.pid,'SIGKILL');
        return value;
      })};
      const client=await SignalClient.create(wrapped,input.local);active=true;
      const encrypted=await client.encrypt(input.remote,input.id,'crash message');
      writeFileSync(1,JSON.stringify({...encrypted,body:Buffer.from(encrypted.body).toString('base64')}));
      process.kill(process.pid,'SIGKILL');
    `;
    const crash = (precommit: boolean, id: string) =>
      spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        input: JSON.stringify({
          path: dbPath,
          key: a.key.toString("base64"),
          local: a.address,
          remote: b.address,
          precommit,
          id,
        }),
        encoding: "utf8",
        timeout: 10000,
      });
    const committed = crash(false, "committed");
    expect(committed.signal, committed.stderr).toBe("SIGKILL");
    const wire = JSON.parse(committed.stdout) as {
      messageId: string;
      type: number;
      body: string;
    };
    a.resource.store = new EncryptedSqliteStore(dbPath, a.key);
    a.client = await SignalClient.create(a.resource.store, a.address);
    const retry = await a.client.retry(b.address, "committed");
    expect(Buffer.from(retry.body).toString("base64")).toBe(wire.body);
    expect(await b.client.decrypt(a.address, retry)).toBe("crash message");
    await a.resource.store.close();
    const uncommitted = crash(true, "uncommitted");
    expect(uncommitted.signal, uncommitted.stderr).toBe("SIGKILL");
    expect(uncommitted.stdout).toBe("");
    a.resource.store = new EncryptedSqliteStore(dbPath, a.key);
    a.client = await SignalClient.create(a.resource.store, a.address);
    await expect(a.client.retry(b.address, "uncommitted")).rejects.toThrow();
    expect(
      await b.client.decrypt(
        a.address,
        await a.client.encrypt(b.address, "uncommitted", "crash message"),
      ),
    ).toBe("crash message");
  });
  it("rejects a changed sender key presented under an already approved address", async () => {
    const { a, b } = await pair();
    expect(
      await b.client.decrypt(
        a.address,
        await a.client.encrypt(b.address, "original", "original"),
      ),
    ).toBe("original");
    const impostor = await participant();
    // A separate device store deliberately claims the approved sender address.
    const impersonated = await impostor.store.transaction((tx) => {
      tx.set(
        "device",
        new TextEncoder().encode(
          JSON.stringify({ address: a.address, registrationId: 123 }),
        ),
      );
      return true;
    });
    expect(impersonated).toBe(true);
    const attacker = await SignalClient.create(impostor.store, a.address);
    await attacker.approveRemote(
      b.address,
      (await b.client.publicBundle()).identityKey().serialize(),
    );
    await attacker.establish(b.address, await b.client.publicBundle());
    await expect(
      b.client.decrypt(
        a.address,
        await attacker.encrypt(b.address, "forged", "forged"),
      ),
    ).rejects.toThrow();
    expect(
      await b.client.decrypt(
        a.address,
        await a.client.encrypt(b.address, "still-valid", "still-valid"),
      ),
    ).toBe("still-valid");
  });
  it("rejects distinct lone-surrogate content under the same message id", async () => {
    const { a, b } = await pair();
    const first = await a.client.encrypt(b.address, "unicode", "\ud800");
    await expect(
      a.client.encrypt(b.address, "unicode", "\ud801"),
    ).rejects.toThrow("different content");
    expect(await a.client.encrypt(b.address, "unicode", "\ud800")).toEqual(
      first,
    );
    expect(await b.client.decrypt(a.address, first)).toBe("\ud800");
  });
});
