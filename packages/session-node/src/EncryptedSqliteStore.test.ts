import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { EncryptedSqliteStore } from "./EncryptedSqliteStore";
import type { StoreTransaction } from "./store";

const directories: string[] = [];
const stores: EncryptedSqliteStore[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "echolet-store-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite");
  const key = randomBytes(32);
  const open = () => {
    const store = new EncryptedSqliteStore(path, key);
    stores.push(store);
    return store;
  };
  return { path, key, open };
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

test("session and outbox survive reopen together; failed callback rolls both back", async () => {
  const { open } = setup();
  const store = open();
  await store.transaction((tx) => tx.set("session", new Uint8Array([1])));
  await expect(store.transaction((tx) => {
    tx.set("session", new Uint8Array([2]));
    tx.set("outbox", new Uint8Array([3]));
    throw new Error("crash before commit");
  })).rejects.toThrow("crash before commit");
  await store.close();
  await open().transaction((tx) => {
    expect(tx.get("session")).toEqual(new Uint8Array([1]));
    expect(tx.get("outbox")).toBeUndefined();
  });
});

test("serializes overlapping async updates and copies all byte buffers", async () => {
  const store = setup().open();
  const bytes = new Uint8Array([0]);
  await store.transaction((tx) => { tx.set("counter", bytes); bytes[0] = 99; });
  await Promise.all(Array.from({ length: 20 }, () => store.transaction(async (tx) => {
    const value = tx.get("counter")!;
    await Promise.resolve();
    tx.set("counter", new Uint8Array([value[0]! + 1]));
    value[0] = 99;
  })));
  expect(await store.transaction((tx) => tx.get("counter"))).toEqual(new Uint8Array([20]));
});

test("rejects a competing connection promptly without overwriting committed state", async () => {
  const { open } = setup();
  const first = open();
  const second = open();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const write = first.transaction(async (tx) => {
    tx.set("winner", new Uint8Array([1]));
    entered();
    await barrier;
  });
  await ready;
  try { await expect(second.transaction((tx) => tx.delete("winner"))).rejects.toThrow(); }
  finally { release(); }
  await write;
  expect(await second.transaction((tx) => tx.get("winner"))).toEqual(new Uint8Array([1]));
});

test("hides record names and values on disk, rejects wrong keys and tampering", async () => {
  const { path, open } = setup();
  const store = open();
  await store.transaction((tx) => tx.set("SECRET_RECORD_MARKER", Buffer.from("SECRET_VALUE_MARKER")));
  await store.close();
  const before = readFileSync(path);
  expect(before.includes(Buffer.from("SECRET_RECORD_MARKER"))).toBe(false);
  expect(before.includes(Buffer.from("SECRET_VALUE_MARKER"))).toBe(false);
  expect(() => new EncryptedSqliteStore(path, randomBytes(32))).toThrow();
  expect(readFileSync(path)).toEqual(before);
  const db = new DatabaseSync(path);
  db.exec("UPDATE encrypted_state SET ciphertext = randomblob(length(ciphertext))");
  db.close();
  expect(open).toThrow();
});

test("missing persisted state is corruption, never a fresh session", async () => {
  const { open, path } = setup();
  await open().close();
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM encrypted_state");
  db.close();
  expect(open).toThrow();
});

test("COMMIT failure rolls back a successful callback and the queue remains usable", async () => {
  const { open, path } = setup();
  const store = open();
  await store.transaction((tx) => tx.set("session", new Uint8Array([1])));
  const reader = new DatabaseSync(path);
  reader.exec("BEGIN");
  reader.prepare("SELECT * FROM encrypted_state").get();
  try {
    await expect(store.transaction((tx) => {
      tx.set("session", new Uint8Array([2]));
      tx.set("outbox", new Uint8Array([3]));
      return "must not escape failed commit";
    })).rejects.toThrow();
  } finally { reader.exec("ROLLBACK"); reader.close(); }
  await store.transaction((tx) => {
    expect(tx.get("session")).toEqual(new Uint8Array([1]));
    expect(tx.get("outbox")).toBeUndefined();
    tx.set("recovered-queue", new Uint8Array([9]));
  });
  await store.close();
  const reopened = open();
  await reopened.transaction((tx) => {
    expect(tx.get("session")).toEqual(new Uint8Array([1]));
    expect(tx.get("outbox")).toBeUndefined();
    expect(tx.get("recovered-queue")).toEqual(new Uint8Array([9]));
    tx.set("next", new Uint8Array([4]));
  });
  expect(await reopened.transaction((tx) => tx.get("next"))).toEqual(new Uint8Array([4]));
});

test("rejects nested operations and expired transactions, closes after pending work", async () => {
  const store = setup().open();
  let escaped!: StoreTransaction;
  await store.transaction(async (tx) => {
    escaped = tx;
    await expect(store.transaction(() => undefined)).rejects.toThrow("Nested");
    await expect(store.close()).rejects.toThrow("transaction");
  });
  expect(() => escaped.set("late", new Uint8Array())).toThrow();
  const pending = store.transaction((tx) => tx.set("final", new Uint8Array([1])));
  await store.close();
  await pending;
  await expect(store.transaction(() => undefined)).rejects.toThrow("closed");
});
