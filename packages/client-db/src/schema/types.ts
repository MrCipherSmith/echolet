export interface Contact {
  id: string;
  identity_id: string;
  callsign: string;
  display_name: string | null;
  trust_state: "unverified" | "verified" | "blocked";
  added_via: "qr" | "invite" | "manual";
  safety_number: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface Message {
  id: string;
  message_id: string;
  conversation_id: string;
  direction: "incoming" | "outgoing";
  status: "queued" | "relayed" | "delivered" | "failed";
  ciphertext: string | null;
  plaintext_body: string | null;
  sender_identity_id: string;
  recipient_identity_id: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface Session {
  id: string;
  local_device_id: string;
  remote_device_id: string;
  remote_identity_id: string;
  session_state: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface Outbox {
  id: string;
  message_id: string;
  conversation_id: string;
  recipient_identity_id: string;
  status: "pending" | "relayed" | "failed";
  attempt_count: number;
  next_retry_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface Receipt {
  id: string;
  receipt_id: string;
  message_id: string;
  status: "queued" | "relayed" | "delivered" | "read";
  created_at_ms: number;
}

export interface RelayConfig {
  id: string;
  relay_base_url: string;
  relay_fingerprint: string | null;
  is_default: boolean;
  created_at_ms: number;
  updated_at_ms: number;
}
