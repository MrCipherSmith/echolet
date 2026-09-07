import { createHash } from "crypto";
import { encodeBase64Url } from "../encoding/base64url";

export function deriveMailboxId(identityPubKey: string): string {
  const input = `${identityPubKey}:mailbox:v1`;
  const hash = createHash("sha256").update(input).digest();
  return encodeBase64Url(hash);
}
