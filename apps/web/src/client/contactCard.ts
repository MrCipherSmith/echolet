export const MAX_CONTACT_CARD_BYTES = 128 * 1024;

export type ContactCardFormat = "echolet_contact_card_v1";

export interface ContactCardPreview {
  identityId: string;
  deviceId: string;
  format: ContactCardFormat;
}

export type ContactCardParseResult =
  | { ok: true; card: Record<string, unknown>; preview: ContactCardPreview }
  | { ok: false; error: string };

export type ExportCardResponse =
  | { ok: true; cardJson: string }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string" && record[key].length > 0;
}

function hasRecord(record: Record<string, unknown>, key: string): boolean {
  return isRecord(record[key]);
}

/**
 * Performs only bounded, display-safe format checks. The bridge remains the
 * authority for signatures, expiry, and cryptographic trust.
 */
export function parseContactCard(input: string): ContactCardParseResult {
  if (!input.trim()) return { ok: false, error: "Вставьте JSON-карточку или выберите файл." };

  if (new TextEncoder().encode(input).byteLength > MAX_CONTACT_CARD_BYTES) {
    return { ok: false, error: "Карточка превышает допустимый размер 128 КБ." };
  }

  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return { ok: false, error: "Некорректный JSON карточки." };
  }

  if (!isRecord(value)) return { ok: false, error: "Карточка должна быть JSON-объектом." };

  const bundle = value.signal_bundle;
  if (value.type === "echolet_contact_card" && value.version === 1 && isRecord(bundle)) {
    if (
      bundle.type === "signal_prekey_bundle" &&
      bundle.version === 2 &&
      bundle.suite === "libsignal-pq-v1" &&
      hasRecord(bundle, "device_record") &&
      hasString(bundle, "bundle_id") &&
      hasString(bundle, "signal_identity_key") &&
      hasRecord(bundle, "signed_prekey") &&
      hasRecord(bundle, "kyber_prekey") &&
      isRecord(bundle.one_time_prekey) &&
      hasString(bundle, "signature")
    ) {
      const device = bundle.device_record;
      if (isRecord(device) && typeof device.identity_id === "string" && device.identity_id && typeof device.device_id === "string" && device.device_id) {
        return {
          ok: true,
          card: value,
          preview: { identityId: device.identity_id, deviceId: device.device_id, format: "echolet_contact_card_v1" },
        };
      }
    }
  }
  return { ok: false, error: "Неподдерживаемый формат карточки. Нужна действительная contact-card Echolet." };
}

export function isDuplicateContact(preview: ContactCardPreview, identityIds: Iterable<string>): boolean {
  return Array.from(identityIds).some((identityId) => identityId === preview.identityId);
}

/** Keeps bridge error envelopes out of the card parser and exposes their operator code. */
export function parseExportCardResponse(status: number, body: string): ExportCardResponse {
  if (status < 200 || status >= 300) {
    try {
      const error = JSON.parse(body);
      if (isRecord(error)) {
        const code = typeof error.code === "string" ? error.code : typeof error.error === "string" ? error.error : null;
        if (code) return { ok: false, error: `Ошибка экспорта: ${code}` };
      }
    } catch {
      // A non-JSON error remains an HTTP failure, not a card-format failure.
    }
    return { ok: false, error: `Экспорт недоступен (HTTP ${status}).` };
  }

  const parsed = parseContactCard(body);
  return parsed.ok ? { ok: true, cardJson: body } : parsed;
}
