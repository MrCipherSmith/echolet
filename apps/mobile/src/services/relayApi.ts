import { RELAY_BASE_URL } from "./config";

export interface RelayApiError {
  code: string;
  message: string;
}

export interface RelayApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: RelayApiError;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<RelayApiResponse<T>> {
  try {
    const response = await fetch(`${RELAY_BASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    const data = await response.json();
    return data;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      },
    };
  }
}

export const relayApi = {
  async healthCheck() {
    return request<{ status: string; uptime_ms: number }>("/health");
  },

  async publishDeviceRecord(deviceRecord: unknown) {
    return request<{ stored: boolean; device_id: string }>(
      "/v1/device-records/publish",
      {
        method: "POST",
        body: JSON.stringify({ device_record: deviceRecord }),
      },
    );
  },

  async publishPreKeyBundle(bundle: unknown) {
    return request<{
      stored: boolean;
      bundle_id: string;
      one_time_prekeys_count: number;
    }>("/v1/prekeys/publish", {
      method: "POST",
      body: JSON.stringify({ bundle }),
    });
  },

  async getPreKeyBundles(identityId: string) {
    return request<{ bundles: unknown[] }>(`/v1/prekeys/${identityId}`);
  },

  async sendEnvelope(envelope: unknown) {
    return request<{ accepted: boolean; envelope_id: string; status: string }>(
      "/v1/messages/send",
      {
        method: "POST",
        body: JSON.stringify({ envelope }),
      },
    );
  },

  async createChallenge(
    recipientMailboxId: string,
    deviceId: string,
    signature: string,
  ) {
    return request<{
      challenge_id: string;
      nonce: string;
      expires_at_ms: number;
    }>("/v1/mailbox/challenge", {
      method: "POST",
      body: JSON.stringify({
        recipient_mailbox_id: recipientMailboxId,
        device_id: deviceId,
        signature,
      }),
    });
  },

  async pollMailbox(
    challengeId: string,
    recipientMailboxId: string,
    deviceId: string,
    signature: string,
  ) {
    return request<{ envelopes: unknown[]; next_cursor: string | null }>(
      "/v1/mailbox/poll",
      {
        method: "POST",
        body: JSON.stringify({
          challenge_id: challengeId,
          recipient_mailbox_id: recipientMailboxId,
          device_id: deviceId,
          signature,
        }),
      },
    );
  },

  async ackMailbox(
    recipientMailboxId: string,
    deviceId: string,
    envelopeIds: string[],
    signature: string,
  ) {
    return request<{ acked: number }>("/v1/mailbox/ack", {
      method: "POST",
      body: JSON.stringify({
        recipient_mailbox_id: recipientMailboxId,
        device_id: deviceId,
        envelope_ids: envelopeIds,
        signature,
      }),
    });
  },
};
