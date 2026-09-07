import React from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import type { IdentityProfile } from "@echolet/client-core";
import { createSignedPreKeyBundle as buildSignedPreKeyBundle } from "@echolet/client-core";
import {
  createInboundSession,
  createOutboundSession,
  decodeBase64Url,
  decryptMessage,
  deriveMailboxId,
  encryptMessage,
  hashMailboxEnvelopeCiphertext,
  serializeSession,
  deserializeSession,
  signMailboxAckMessage,
  signMailboxEnvelopeMessage,
  signMailboxChallengeMessage,
  signMailboxCreateChallengeMessage,
} from "@echolet/crypto-core";
import type {
  ChatMessage,
  MailboxEnvelope,
  PreKeyBundle,
} from "@echolet/protocol";
import { relayApi } from "../services/relayApi";
import { useTerminalStore } from "../state/useTerminalStore";

interface MessagingScreenProps {
  profile: IdentityProfile | null;
}

interface RenderedMessage {
  id: string;
  direction: "incoming" | "outgoing";
  body: string;
  status: string;
  createdAtMs: number;
}

export function MessagingScreen({ profile }: MessagingScreenProps) {
  const demoEnabled =
    typeof __DEV__ !== "undefined" &&
    __DEV__ === true &&
    process.env.EXPO_PUBLIC_ECHOLET_ENABLE_UNSAFE_DEMO === "true";

  if (!demoEnabled) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyTitle}>
          Messaging is not ready for private conversations
        </Text>
        <Text style={styles.emptyText}>
          Echolet is a prototype. Messaging is disabled until the secure session
          and contact verification work is complete.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.demoNotice}>
        Development demo only. Do not send private or sensitive messages.
        Sessions and history can be lost when this screen closes.
      </Text>
      <DemoMessagingScreen profile={profile} />
    </View>
  );
}

function DemoMessagingScreen({ profile }: MessagingScreenProps) {
  const [recipientIdentityId, setRecipientIdentityId] = React.useState("");
  const [messageBody, setMessageBody] = React.useState("");
  const [publishedBundle, setPublishedBundle] = React.useState<PreKeyBundle | null>(
    null,
  );
  const [recipientBundle, setRecipientBundle] = React.useState<PreKeyBundle | null>(
    null,
  );
  const [messages, setMessages] = React.useState<RenderedMessage[]>([]);
  const [isBusy, setIsBusy] = React.useState(false);
  const [outboundSessions, setOutboundSessions] = React.useState<
    Record<string, string>
  >({});
  const [inboundSessions, setInboundSessions] = React.useState<
    Record<string, string>
  >({});
  const { addEvent } = useTerminalStore();

  React.useEffect(() => {
    if (!profile) {
      setRecipientIdentityId("");
      setRecipientBundle(null);
      setPublishedBundle(null);
      setMessages([]);
      setOutboundSessions({});
      setInboundSessions({});
      return;
    }

    setRecipientIdentityId(profile.identityId);
  }, [profile]);

  if (!profile) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyTitle}>Messaging unavailable</Text>
        <Text style={styles.emptyText}>
          Finish onboarding first to publish prekeys and send encrypted
          messages.
        </Text>
      </View>
    );
  }

  const ensureOwnPreKeyBundle = async (): Promise<PreKeyBundle | null> => {
    if (publishedBundle) {
      return publishedBundle;
    }

    const bundle = buildSignedPreKeyBundle(profile);
    const result = await relayApi.publishPreKeyBundle(bundle);
    if (!result.ok) {
      throw new Error(result.error?.message || "Failed to publish prekey bundle");
    }

    setPublishedBundle(bundle);
    addEvent("PREKEY", "Published local prekey bundle");
    return bundle;
  };

  const fetchBundle = async (identityId: string): Promise<PreKeyBundle | null> => {
    const result = await relayApi.getPreKeyBundles(identityId);
    if (!result.ok || !result.data?.bundles.length) {
      return null;
    }

    return result.data.bundles[0] as PreKeyBundle;
  };

  const ensureRecipientBundle = async (): Promise<PreKeyBundle | null> => {
    if (recipientIdentityId === profile.identityId) {
      const ownBundle = await ensureOwnPreKeyBundle();
      setRecipientBundle(ownBundle);
      return ownBundle;
    }

    if (
      recipientBundle &&
      recipientBundle.identity_id === recipientIdentityId
    ) {
      return recipientBundle;
    }

    const bundle = await fetchBundle(recipientIdentityId);
    if (bundle) {
      setRecipientBundle(bundle);
      addEvent("PREKEY", `Loaded bundle for ${recipientIdentityId.slice(0, 12)}`);
    }
    return bundle;
  };

  const handlePublishBundle = async () => {
    setIsBusy(true);
    try {
      await ensureOwnPreKeyBundle();
      Alert.alert("Success", "Prekey bundle published");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      addEvent("ERROR", `Failed to publish prekey bundle: ${message}`);
      Alert.alert("Error", message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleLoadBundle = async () => {
    setIsBusy(true);
    try {
      const bundle = await ensureRecipientBundle();
      if (!bundle) {
        throw new Error("No prekey bundle found for recipient");
      }
      Alert.alert("Success", `Loaded bundle for ${bundle.device_id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      addEvent("ERROR", `Failed to load prekey bundle: ${message}`);
      Alert.alert("Error", message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleSendMessage = async () => {
    const trimmedBody = messageBody.trim();
    if (!trimmedBody) {
      Alert.alert("Error", "Enter a message body first");
      return;
    }

    setIsBusy(true);
    try {
      const bundle = await ensureRecipientBundle();
      if (!bundle) {
        throw new Error("Recipient prekey bundle is unavailable");
      }

      const sessionKey = bundle.device_id;
      const outboundSession = outboundSessions[sessionKey]
        ? deserializeSession(outboundSessions[sessionKey])
        : createOutboundSession(
            profile.identityId,
            profile.deviceId,
            bundle.identity_id,
            bundle.device_id,
            decodeBase64Url(bundle.signed_prekey.public_key),
            decodeBase64Url(profile.sessionSecretKey),
          ).sessionState;

      const chatMessage: ChatMessage = {
        type: "chat_message",
        version: 1,
        message_id: createUuid(),
        conversation_id: [profile.identityId, bundle.identity_id].sort().join(":"),
        sender_identity_id: profile.identityId,
        sender_device_id: profile.deviceId,
        created_at_ms: Date.now(),
        body: trimmedBody,
        reply_to_message_id: null,
      };

      const { ciphertext, updatedSession } = encryptMessage(
        outboundSession,
        JSON.stringify(chatMessage),
      );

      const envelopeId = createUuid();
      const recipientMailboxId = deriveMailboxId(bundle.identity_id);
      const expiresAtMs = chatMessage.created_at_ms + 24 * 60 * 60 * 1000;

      const envelope: MailboxEnvelope = {
        type: "mailbox_envelope",
        version: 1,
        envelope_id: envelopeId,
        message_id: chatMessage.message_id,
        sender_identity_id: profile.identityId,
        sender_device_id: profile.deviceId,
        recipient_identity_id: bundle.identity_id,
        recipient_device_id: bundle.device_id,
        recipient_mailbox_id: recipientMailboxId,
        payload_type: "ciphertext_message",
        ciphertext,
        created_at_ms: chatMessage.created_at_ms,
        expires_at_ms: expiresAtMs,
        size_bytes: ciphertext.length,
        // The relay authenticates the sender of every envelope (T50, finding T49-F-001) against
        // the device record onboarding published, so this demo must sign too or every send is
        // refused.
        sender_signature: signMailboxEnvelopeMessage(
          recipientMailboxId,
          envelopeId,
          profile.identityId,
          profile.deviceId,
          hashMailboxEnvelopeCiphertext(ciphertext),
          chatMessage.created_at_ms,
          expiresAtMs,
          profile.deviceSecretKey,
        ),
      };

      const result = await relayApi.sendEnvelope(envelope);
      if (!result.ok) {
        throw new Error(result.error?.message || "Failed to send envelope");
      }

      setOutboundSessions((current) => ({
        ...current,
        [sessionKey]: serializeSession(updatedSession),
      }));
      setMessages((current) => [
        ...current,
        {
          id: chatMessage.message_id,
          direction: "outgoing",
          body: chatMessage.body,
          status: result.data?.status ?? "relayed",
          createdAtMs: chatMessage.created_at_ms,
        },
      ]);
      setMessageBody("");
      addEvent("MESSAGE", `Sent encrypted message to ${bundle.device_id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      addEvent("ERROR", `Failed to send message: ${message}`);
      Alert.alert("Error", message);
    } finally {
      setIsBusy(false);
    }
  };

  const handlePollMailbox = async () => {
    setIsBusy(true);
    try {
      const ownBundle = await ensureOwnPreKeyBundle();
      if (!ownBundle) {
        throw new Error("Own prekey bundle is unavailable");
      }

      const mailboxId = deriveMailboxId(profile.identityId);
      const challengeSignature = signMailboxCreateChallengeMessage(
        mailboxId,
        profile.deviceId,
        profile.deviceSecretKey,
      );
      const challengeResult = await relayApi.createChallenge(
        mailboxId,
        profile.deviceId,
        challengeSignature,
      );

      if (!challengeResult.ok || !challengeResult.data) {
        throw new Error(
          challengeResult.error?.message || "Failed to create mailbox challenge",
        );
      }

      const pollSignature = signMailboxChallengeMessage(
        challengeResult.data.challenge_id,
        mailboxId,
        profile.deviceId,
        challengeResult.data.nonce,
        profile.deviceSecretKey,
      );
      const pollResult = await relayApi.pollMailbox(
        challengeResult.data.challenge_id,
        mailboxId,
        profile.deviceId,
        pollSignature,
      );

      if (!pollResult.ok || !pollResult.data) {
        throw new Error(pollResult.error?.message || "Failed to poll mailbox");
      }

      const envelopes = pollResult.data.envelopes as MailboxEnvelope[];
      if (envelopes.length === 0) {
        addEvent("MAILBOX", "No envelopes available");
        Alert.alert("Mailbox", "No new messages");
        return;
      }

      const nextInboundSessions = { ...inboundSessions };
      const decryptedMessages: RenderedMessage[] = [];

      for (const envelope of envelopes) {
        const senderBundle =
          envelope.sender_identity_id === profile.identityId
            ? ownBundle
            : await fetchBundle(envelope.sender_identity_id);

        if (!senderBundle) {
          addEvent(
            "ERROR",
            `Missing sender bundle for ${envelope.sender_identity_id}`,
          );
          continue;
        }

        const sessionKey = envelope.sender_device_id;
        const inboundSession = nextInboundSessions[sessionKey]
          ? deserializeSession(nextInboundSessions[sessionKey])
          : createInboundSession(
              profile.identityId,
              profile.deviceId,
              envelope.sender_identity_id,
              envelope.sender_device_id,
              decodeBase64Url(profile.sessionSecretKey),
              decodeBase64Url(senderBundle.signed_prekey.public_key),
            );

        const { plaintext, updatedSession } = decryptMessage(
          inboundSession,
          envelope.ciphertext,
        );
        const chatMessage = JSON.parse(plaintext) as ChatMessage;

        nextInboundSessions[sessionKey] = serializeSession(updatedSession);
        decryptedMessages.push({
          id: chatMessage.message_id,
          direction:
            chatMessage.sender_identity_id === profile.identityId
              ? "outgoing"
              : "incoming",
          body: chatMessage.body,
          status: "delivered",
          createdAtMs: chatMessage.created_at_ms,
        });
      }

      setInboundSessions(nextInboundSessions);
      setMessages((current) => {
        const byId = new Map(current.map((item) => [item.id, item]));
        for (const message of decryptedMessages) {
          byId.set(message.id, message);
        }
        return Array.from(byId.values()).sort(
          (left, right) => left.createdAtMs - right.createdAtMs,
        );
      });

      const ackSignature = signMailboxAckMessage(
        mailboxId,
        profile.deviceId,
        envelopes.map((envelope) => envelope.envelope_id),
        profile.deviceSecretKey,
      );
      await relayApi.ackMailbox(
        mailboxId,
        profile.deviceId,
        envelopes.map((envelope) => envelope.envelope_id),
        ackSignature,
      );

      addEvent("MAILBOX", `Polled and decrypted ${decryptedMessages.length} message(s)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      addEvent("ERROR", `Failed to poll mailbox: ${message}`);
      Alert.alert("Error", message);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Messaging Demo</Text>
      <Text style={styles.helper}>
        Publish a prekey bundle, then send to your own identity for a full
        encrypted relay round-trip.
      </Text>

      <Text style={styles.label}>Recipient identity</Text>
      <TextInput
        style={styles.input}
        value={recipientIdentityId}
        onChangeText={setRecipientIdentityId}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <View style={styles.actionsRow}>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={handlePublishBundle}
          disabled={isBusy}
        >
          <Text style={styles.secondaryButtonText}>Publish Bundle</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={handleLoadBundle}
          disabled={isBusy}
        >
          <Text style={styles.secondaryButtonText}>Load Bundle</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.label}>Message</Text>
      <TextInput
        style={[styles.input, styles.messageInput]}
        value={messageBody}
        onChangeText={setMessageBody}
        multiline
        placeholder="Type an encrypted message"
        placeholderTextColor="#666"
      />

      <View style={styles.actionsRow}>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={handleSendMessage}
          disabled={isBusy}
        >
          <Text style={styles.primaryButtonText}>Send</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={handlePollMailbox}
          disabled={isBusy}
        >
          <Text style={styles.primaryButtonText}>Poll & Decrypt</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionTitle}>Messages</Text>
      {messages.length === 0 ? (
        <Text style={styles.helper}>No decrypted messages yet.</Text>
      ) : (
        messages.map((message) => (
          <View key={message.id} style={styles.messageCard}>
            <Text style={styles.messageMeta}>
              {message.direction.toUpperCase()} · {message.status}
            </Text>
            <Text style={styles.messageBody}>{message.body}</Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}

function createUuid(): string {
  const random = () =>
    Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .slice(1);

  return `${random()}${random()}-${random()}-4${random().slice(0, 3)}-a${random().slice(0, 3)}-${random()}${random()}${random()}`;
}

const styles = StyleSheet.create({
  demoNotice: {
    color: "#FFB000",
    padding: 16,
    lineHeight: 20,
  },
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: "#101010",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#101010",
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#00FF41",
    marginBottom: 12,
  },
  emptyText: {
    color: "#ccc",
    textAlign: "center",
    lineHeight: 22,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#00FF41",
    marginBottom: 8,
  },
  helper: {
    color: "#bcbcbc",
    marginBottom: 16,
    lineHeight: 20,
  },
  label: {
    color: "#fff",
    marginBottom: 8,
    fontSize: 15,
  },
  input: {
    backgroundColor: "#242424",
    color: "#fff",
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  messageInput: {
    minHeight: 100,
    textAlignVertical: "top",
  },
  actionsRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 16,
  },
  primaryButton: {
    flex: 1,
    backgroundColor: "#00FF41",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#111",
    fontWeight: "bold",
  },
  secondaryButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#00FF41",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
  },
  secondaryButtonText: {
    color: "#00FF41",
    fontWeight: "bold",
  },
  sectionTitle: {
    color: "#00FF41",
    fontSize: 18,
    fontWeight: "bold",
    marginBottom: 12,
  },
  messageCard: {
    backgroundColor: "#1d1d1d",
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  messageMeta: {
    color: "#FFB000",
    fontSize: 12,
    marginBottom: 6,
  },
  messageBody: {
    color: "#fff",
    fontSize: 15,
    lineHeight: 20,
  },
});
