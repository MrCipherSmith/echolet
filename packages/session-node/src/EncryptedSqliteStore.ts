import { AsyncLocalStorage } from "node:async_hooks";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { StoreTransaction, TransactionalStore } from "./store";

const aad = Buffer.from("Echolet/session-node/state/v1");

/** Node reference store: one encrypted snapshot, one local device, independently supplied key. */
export class EncryptedSqliteStore implements TransactionalStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly context = new AsyncLocalStorage<{ active: boolean }>();
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(path: string, key: Uint8Array) {
    if (key.length !== 32) throw new Error("Storage key must be 32 bytes");
    this.key = Buffer.from(key);
    const isNew = !existsSync(path);
    if (isNew) closeSync(openSync(path, "wx", 0o600));
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL");
      if (isNew) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec("CREATE TABLE encrypted_state (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL CHECK(version = 1), nonce BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL) STRICT");
          this.write(new Map());
          this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      } else {
        this.read();
      }
    } catch (error) {
      this.db.close();
      this.key.fill(0);
      throw error;
    }
  }

  transaction<T>(operation: (tx: StoreTransaction) => T | Promise<T>): Promise<T> {
    if (this.context.getStore()?.active) return Promise.reject(new Error("Nested transaction is not supported"));
    if (this.closing) return Promise.reject(new Error("Store is closed"));
    const run = this.tail.then(() => this.perform(operation));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  close(): Promise<void> {
    if (this.context.getStore()?.active) return Promise.reject(new Error("Cannot close from a transaction"));
    this.closing = true;
    this.closePromise ??= this.tail.then(() => {
      try { this.db.close(); } finally { this.key.fill(0); }
    });
    return this.closePromise;
  }

  private async perform<T>(operation: (tx: StoreTransaction) => T | Promise<T>): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    const scope = { active: true };
    try {
      const records = this.read();
      const check = () => { if (!scope.active) throw new Error("Transaction is no longer active"); };
      const tx: StoreTransaction = {
        get: (key) => { check(); const value = records.get(key); return value && Uint8Array.from(value); },
        set: (key, value) => { check(); records.set(key, Uint8Array.from(value)); },
        delete: (key) => { check(); records.delete(key); },
        keys: (prefix = "") => { check(); return [...records.keys()].filter((key) => key.startsWith(prefix)); },
      };
      const result = await this.context.run(scope, () => operation(tx));
      scope.active = false;
      this.write(records);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      scope.active = false;
    }
  }

  private read(): Map<string, Uint8Array> {
    const value = this.db.prepare("SELECT version, nonce, tag, ciphertext FROM encrypted_state WHERE id = 1").get();
    if (typeof value !== "object" || value === null) throw new Error("Missing encrypted session state");
    const row = value as Record<string, unknown>;
    if (!row || row.version !== 1 || !(row.nonce instanceof Uint8Array) || row.nonce.length !== 12 ||
      !(row.tag instanceof Uint8Array) || row.tag.length !== 16 || !(row.ciphertext instanceof Uint8Array)) {
      throw new Error("Invalid encrypted session state");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(row.tag);
    const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
    try {
      const entries: unknown = JSON.parse(plaintext.toString("utf8"));
      if (!Array.isArray(entries)) throw new Error("Invalid session snapshot");
      const result = new Map<string, Uint8Array>();
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string" || result.has(entry[0])) {
          throw new Error("Invalid session snapshot record");
        }
        const bytes = Buffer.from(entry[1], "base64");
        if (bytes.toString("base64") !== entry[1]) throw new Error("Invalid session record encoding");
        result.set(entry[0], bytes);
      }
      return result;
    } finally { plaintext.fill(0); }
  }

  private write(records: Map<string, Uint8Array>): void {
    const plaintext = Buffer.from(JSON.stringify([...records].map(([key, value]) => [key, Buffer.from(value).toString("base64")])));
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      this.db.prepare("INSERT INTO encrypted_state (id, version, nonce, tag, ciphertext) VALUES (1, 1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET nonce = excluded.nonce, tag = excluded.tag, ciphertext = excluded.ciphertext")
        .run(nonce, cipher.getAuthTag(), ciphertext);
    } finally { plaintext.fill(0); }
  }
}
