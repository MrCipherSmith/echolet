import type { Contact } from "../schema/types";
import type { Message } from "../schema/types";
import type { Session } from "../schema/types";
import type { Outbox } from "../schema/types";
import type { Receipt } from "../schema/types";
import type { RelayConfig } from "../schema/types";

export interface ContactsRepository {
  getById(id: string): Promise<Contact | null>;
  list(): Promise<Contact[]>;
  insert(contact: Omit<Contact, "id" | "updated_at_ms">): Promise<Contact>;
  update(
    id: string,
    contact: Partial<Omit<Contact, "id" | "updated_at_ms">>,
  ): Promise<Contact | null>;
  delete(id: string): Promise<boolean>;
}

export interface MessagesRepository {
  getById(id: string): Promise<Message | null>;
  getByMessageId(messageId: string): Promise<Message | null>;
  listByConversation(conversationId: string): Promise<Message[]>;
  insert(message: Omit<Message, "id" | "updated_at_ms">): Promise<Message>;
  updateStatus(
    messageId: string,
    status: Message["status"],
  ): Promise<Message | null>;
}

export interface SessionsRepository {
  getById(id: string): Promise<Session | null>;
  getByDevicePair(
    localDeviceId: string,
    remoteDeviceId: string,
  ): Promise<Session | null>;
  insert(session: Omit<Session, "id" | "updated_at_ms">): Promise<Session>;
  updateSessionState(id: string, sessionState: string): Promise<Session | null>;
}

export interface OutboxRepository {
  getById(id: string): Promise<Outbox | null>;
  listPending(): Promise<Outbox[]>;
  insert(outbox: Omit<Outbox, "id" | "updated_at_ms">): Promise<Outbox>;
  updateStatus(id: string, status: Outbox["status"]): Promise<Outbox | null>;
  incrementAttempt(id: string, nextRetryAtMs: number): Promise<Outbox | null>;
}

export interface ReceiptsRepository {
  getById(id: string): Promise<Receipt | null>;
  getByMessageId(messageId: string): Promise<Receipt | null>;
  insert(receipt: Omit<Receipt, "id">): Promise<Receipt>;
}

export interface RelayConfigRepository {
  getById(id: string): Promise<RelayConfig | null>;
  getDefault(): Promise<RelayConfig | null>;
  insert(
    config: Omit<RelayConfig, "id" | "updated_at_ms">,
  ): Promise<RelayConfig>;
  update(
    id: string,
    config: Partial<Omit<RelayConfig, "id" | "updated_at_ms">>,
  ): Promise<RelayConfig | null>;
}
