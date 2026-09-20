import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliOutcome } from "./cliBridge";

export interface ContactCardBridge {
  exportContact(outPath: string): Promise<CliOutcome>;
  importContact(cardPath: string): Promise<CliOutcome>;
  validateContact(cardPath: string): Promise<CliOutcome>;
}

export interface ContactCardPreview {
  identityId: string;
  deviceId: string;
}

type ContactCardSuccess = {
  ok: true;
  data: {
    card: Record<string, unknown>;
    preview: ContactCardPreview;
  };
};

type ContactCardFailure = {
  ok: false;
  code: string;
  message: string;
  outcome?: CliOutcome;
};

export type ContactCardResult = ContactCardSuccess | ContactCardFailure;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseContactCardJson(input: unknown): ContactCardResult {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, code: "INVALID_CONTACT_CARD", message: "Contact card is not valid JSON" };
    }
  }
  const card = objectValue(value);
  const signalBundle = objectValue(card?.signal_bundle);
  const deviceRecord = objectValue(signalBundle?.device_record);
  const identityId = deviceRecord?.identity_id;
  const deviceId = deviceRecord?.device_id;
  if (
    card?.type !== "echolet_contact_card"
    || card.version !== 1
    || typeof identityId !== "string"
    || !identityId
    || typeof deviceId !== "string"
    || !deviceId
  ) {
    return {
      ok: false,
      code: "INVALID_CONTACT_CARD",
      message: "Contact card is missing public identity fields",
    };
  }
  return {
    ok: true,
    data: { card: card!, preview: { identityId, deviceId } },
  };
}

function errorDetail(outcome: CliOutcome): string | null {
  const data = objectValue(outcome.data);
  const error = objectValue(data?.error);
  return typeof error?.detail === "string" ? error.detail : null;
}

function operationFailure(outcome: CliOutcome): ContactCardFailure {
  return {
    ok: false,
    code: outcome.code,
    message: "Contact card operation failed",
    outcome,
  };
}

function ioFailure(): ContactCardFailure {
  return { ok: false, code: "PERSISTENCE_FAILURE", message: "Temporary contact card storage failed" };
}

export async function exportContactCard(
  bridge: ContactCardBridge,
  temporaryRoot = tmpdir(),
): Promise<ContactCardResult> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(temporaryRoot, "echolet-web-export-"));
    const outputPath = join(directory, "contact-card.json");
    const outcome = await bridge.exportContact(outputPath);
    if (!outcome.ok) return operationFailure(outcome);
    const contents = await readFile(outputPath, "utf8");
    return parseContactCardJson(contents);
  } catch {
    return ioFailure();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function importContactCardJson(
  bridge: ContactCardBridge,
  cardJson: unknown,
  temporaryRoot = tmpdir(),
): Promise<ContactCardResult> {
  const parsed = parseContactCardJson(cardJson);
  if (!parsed.ok) return parsed;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(temporaryRoot, "echolet-web-import-"));
    const inputPath = join(directory, "contact-card.json");
    await writeFile(inputPath, JSON.stringify(parsed.data.card), { encoding: "utf8", flag: "wx", mode: 0o600 });
    const outcome = await bridge.importContact(inputPath);
    if (!outcome.ok) return operationFailure(outcome);
    return parsed;
  } catch {
    return ioFailure();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function validateContactCardJson(
  bridge: ContactCardBridge,
  cardJson: unknown,
  temporaryRoot = tmpdir(),
): Promise<ContactCardResult> {
  const parsed = parseContactCardJson(cardJson);
  if (!parsed.ok) return parsed;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(temporaryRoot, "echolet-web-validate-"));
    const inputPath = join(directory, "contact-card.json");
    await writeFile(inputPath, JSON.stringify(parsed.data.card), { encoding: "utf8", flag: "wx", mode: 0o600 });
    const outcome = await bridge.validateContact(inputPath);
    const declinedAfterVerification = outcome.code === "CONTACT_NOT_CONFIRMED"
      || (outcome.code === "TRUST_FAILURE" && errorDetail(outcome) === "CONTACT_NOT_CONFIRMED");
    return declinedAfterVerification ? parsed : operationFailure(outcome);
  } catch {
    return ioFailure();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
