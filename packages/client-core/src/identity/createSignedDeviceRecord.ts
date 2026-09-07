import { DeviceRecord } from "@echolet/protocol";
import { signCanonicalJson } from "@echolet/crypto-core";
import { decodeBase64Url } from "@echolet/crypto-core";

export function createSignedDeviceRecord(
  identityId: string,
  deviceId: string,
  devicePubKey: string,
  identitySecretKey: string,
  deviceLabel?: string,
): DeviceRecord {
  const record: Omit<DeviceRecord, "signature"> = {
    type: "device_record",
    version: 1,
    identity_id: identityId,
    device_id: deviceId,
    device_pubkey: devicePubKey,
    device_label: deviceLabel,
    capabilities: {
      mailbox_poll: true,
      receipts: true,
      attachments: false,
    },
    created_at_ms: Date.now(),
  };

  const secretKeyBytes = decodeBase64Url(identitySecretKey);
  const signature = signCanonicalJson(record, secretKeyBytes);

  return {
    ...record,
    signature,
  };
}
