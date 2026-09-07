/** Opaque records. Implementations must commit all writes or none, and serialize callbacks. */
export interface StoreTransaction {
  get(key: string): Uint8Array | undefined;
  set(key: string, value: Uint8Array): void;
  delete(key: string): void;
  keys(prefix?: string): string[];
}

export interface TransactionalStore {
  /** Never perform network I/O here. Resolve only after a durable successful commit. */
  transaction<T>(operation: (tx: StoreTransaction) => T | Promise<T>): Promise<T>;
}
