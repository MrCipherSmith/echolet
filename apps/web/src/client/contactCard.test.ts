import { describe, expect, it } from "vitest";
import { MAX_CONTACT_CARD_BYTES, isDuplicateContact, parseContactCard, parseExportCardResponse } from "./contactCard";

const v2Card = {
  type: "echolet_contact_card",
  version: 1,
  signal_bundle: {
    type: "signal_prekey_bundle",
    version: 2,
    suite: "libsignal-pq-v1",
    bundle_id: "bundle-1",
    device_record: { identity_id: "identity-a", device_id: "device-a" },
    signal_identity_key: "signal-key",
    signed_prekey: {},
    kyber_prekey: {},
    one_time_prekey: { key_id: 1, public_key: "key" },
    signature: "signature",
  },
};

describe("parseContactCard", () => {
  it("previews the exported contact-card envelope without importing it", () => {
    expect(parseContactCard(JSON.stringify(v2Card))).toEqual({
      ok: true,
      card: v2Card,
      preview: { identityId: "identity-a", deviceId: "device-a", format: "echolet_contact_card_v1" },
    });
  });

  it("requires the one-time prekey from the real exported envelope", () => {
    const withoutOneTimePrekey = { ...v2Card, signal_bundle: { ...v2Card.signal_bundle, one_time_prekey: null } };
    expect(parseContactCard(JSON.stringify(withoutOneTimePrekey))).toMatchObject({ ok: false });
  });

  it("keeps malformed and oversized input out of the confirmation step", () => {
    expect(parseContactCard("{")).toEqual({ ok: false, error: "Некорректный JSON карточки." });
    expect(parseContactCard("x".repeat(MAX_CONTACT_CARD_BYTES + 1))).toEqual({
      ok: false,
      error: "Карточка превышает допустимый размер 128 КБ.",
    });
  });

  it("detects an existing identity before import", () => {
    const parsed = parseContactCard(JSON.stringify(v2Card));
    if (!parsed.ok) throw new Error("Expected valid card");
    expect(isDuplicateContact(parsed.preview, ["identity-a"])).toBe(true);
    expect(isDuplicateContact(parsed.preview, ["identity-b"])).toBe(false);
  });

  it("preserves a failed export code instead of treating its envelope as a card", () => {
    expect(parseExportCardResponse(500, JSON.stringify({ ok: false, code: "PERSISTENCE_FAILURE" })))
      .toEqual({ ok: false, error: "Ошибка экспорта: PERSISTENCE_FAILURE" });
    expect(parseExportCardResponse(200, JSON.stringify(v2Card))).toEqual({ ok: true, cardJson: JSON.stringify(v2Card) });
  });
});
