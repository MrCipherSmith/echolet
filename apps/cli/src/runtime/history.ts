import { z } from "zod";
import type { StoreTransaction } from "@echolet/session-node";

const entrySchema = z.object({ sequence: z.number().int().positive(), contactIdentityId: z.string().min(1), messageId: z.string().uuid(), direction: z.enum(["inbound", "outbound"]), plaintext: z.string(), createdAtMs: z.number().int().nonnegative() }).strict();
export type HistoryEntry = z.infer<typeof entrySchema>;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

/** Must run inside the same transaction as native state and inbox/outbox. */
export function appendHistory(tx: StoreTransaction, entry: Omit<HistoryEntry, "sequence">): void {
  const previous = tx.get("cli:history-sequence");
  const sequence = previous ? z.number().int().nonnegative().parse(decode(previous)) + 1 : 1;
  if (!Number.isSafeInteger(sequence)) throw new Error("History sequence exhausted");
  const record = entrySchema.parse({ ...entry, sequence });
  tx.set(`cli:history:${String(sequence).padStart(16, "0")}`, encode(record));
  tx.set("cli:history-sequence", encode(sequence));
}
export function readHistory(tx: StoreTransaction, contactIdentityId: string): HistoryEntry[] {
  return tx.keys("cli:history:").sort().map((key) => entrySchema.parse(decode(tx.get(key)!)))
    .filter((entry) => entry.contactIdentityId === contactIdentityId);
}
