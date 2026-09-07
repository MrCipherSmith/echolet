# gdgraph Repomap

Ranked by personalized PageRank over the import/call graph.

## packages/protocol/src/types/signalPreKeyBundleV2.ts
- encodedBytes(length: number, prefix?: number)
- signalAddressForDevice(identityId: string, deviceId: string)
- signalBundleV2SigningText(bundle: SignalPreKeyBundleV2)

## packages/session-node/src/SignalClient.ts
- interface DeviceAddress
- interface StoredCiphertext
- interface DeviceMetadata
- interface OutboxRecord
- encode()
- decode()
- binary()
- addressKey()
- protocolAddress()
- requireRecord(
- assertAddress(address: DeviceAddress)
- assertMessageId(id: string)

## packages/session-node/src/store.ts
- interface StoreTransaction
- StoreTransaction.get(key: string)
- StoreTransaction.set(key: string, value: Uint8Array)
- StoreTransaction.delete(key: string)
- StoreTransaction.keys(prefix?: string)
- interface TransactionalStore
- TransactionalStore.transaction(operation: (tx: StoreTransaction) => T | Promise<T>)

## .opencode/plugin/keryx-ctx-guard.js
- KeryxCtxGuard()

## apps/mobile/index.js

## apps/mobile/src/app/App.tsx
- App()

## apps/mobile/src/screens/MessagingScreen.tsx
- interface MessagingScreenProps
- interface RenderedMessage
- MessagingScreen({ profile }: MessagingScreenProps)
- DemoMessagingScreen({ profile }: MessagingScreenProps)
- ensureOwnPreKeyBundle()
- fetchBundle()
- ensureRecipientBundle()
- handlePublishBundle()
- handleLoadBundle()
- handleSendMessage()
- handlePollMailbox()
- createUuid()

## apps/mobile/src/screens/OnboardingScreen.tsx
- interface OnboardingScreenProps
- OnboardingScreen({ onComplete }: OnboardingScreenProps)
- handleGenerateIdentity()
- handleConfirmSeed()
- handlePublishToRelay()

## apps/mobile/src/screens/TerminalScreen.tsx
- TerminalScreen()

## apps/mobile/src/services/config.ts

## apps/mobile/src/services/relayApi.ts
- interface RelayApiError
- interface RelayApiResponse
- request(
- healthCheck()
- publishDeviceRecord(deviceRecord: unknown)
- publishPreKeyBundle(bundle: unknown)
- getPreKeyBundles(identityId: string)
- sendEnvelope(envelope: unknown)
- createChallenge(
- pollMailbox(
- ackMailbox(

## apps/mobile/src/state/useTerminalStore.ts
- interface TerminalEvent
- interface TerminalStore

## packages/client-core/src/identity/createIdentityProfile.test.ts

## packages/client-core/src/identity/createIdentityProfile.ts
- interface IdentityProfile
- interface CreateIdentityProfileOptions
- generateCallsign(
- createIdentityProfile(

## packages/client-core/src/identity/createSignedDeviceRecord.ts
- createSignedDeviceRecord(

## packages/client-core/src/identity/createSignedPreKeyBundle.test.ts

## packages/client-core/src/identity/createSignedPreKeyBundle.ts
- interface CreateSignedPreKeyBundleOptions
- createSignedPreKeyBundle(

## packages/client-core/src/index.ts

## packages/client-core/src/messages/encryption.ts
- encryptOutgoingMessage(
- decryptIncomingEnvelope(

## packages/client-core/src/sessions/sessionAdapter.ts
- interface SessionAdapter

## packages/client-core/src/sessions/sessions.ts
- interface SessionsRepository
- SessionsRepository.getById(id: string)
- SessionsRepository.getByDevicePair(
- SessionsRepository.insert(session: SessionState)
- SessionsRepository.update(session: SessionState)
- createOutboundSession(
- createInboundSession(
- loadSession(
- saveSession(

## packages/client-db/src/index.test.ts

## packages/client-db/src/index.ts

## packages/client-db/src/repositories/interfaces.ts
- interface ContactsRepository
- ContactsRepository.getById(id: string)
- ContactsRepository.list()
- ContactsRepository.insert(contact: Omit<Contact, "id" | "updated_at_ms">)
- ContactsRepository.update(
- ContactsRepository.delete(id: string)
- interface MessagesRepository
- MessagesRepository.getById(id: string)
- MessagesRepository.getByMessageId(messageId: string)
- MessagesRepository.listByConversation(conversationId: string)
- MessagesRepository.insert(message: Omit<Message, "id" | "updated_at_ms">)
- MessagesRepository.updateStatus(

## packages/client-db/src/schema/types.ts
- interface Contact
- interface Message
- interface Session
- interface Outbox
- interface Receipt
- interface RelayConfig

## packages/crypto-core/src/encoding/base64url.ts
- encodeBase64Url(bytes: Uint8Array)
- decodeBase64Url(base64url: string)

## packages/crypto-core/src/identity/generateKeyPair.ts
- generateKeyPair()
- deriveKeyPairFromSeed(
- deriveSessionKeyPairFromSeed(
- deriveSeedBytes(seed: string, namespace: string)

## packages/crypto-core/src/identity/generateSeed.ts
- generateSeed()

## packages/crypto-core/src/index.ts

## packages/crypto-core/src/mailbox/auth.test.ts

## packages/crypto-core/src/mailbox/auth.ts
- createMailboxChallengeMessage(
- createMailboxCreateChallengeMessage(
- createMailboxAckMessage(
- signMailboxChallengeMessage(
- signMailboxCreateChallengeMessage(
- verifyMailboxChallengeMessage(
- verifyMailboxCreateChallengeMessage(
- signMailboxAckMessage(
- verifyMailboxAckMessage(

## packages/crypto-core/src/mailbox/deriveMailboxId.ts
- deriveMailboxId(identityPubKey: string)

## packages/crypto-core/src/session/session.test.ts

## packages/crypto-core/src/session/session.ts
- interface EncryptedPayload
- hkdf(
- assertKeyLength(key: Uint8Array, label: string)
- deriveRootKey(sharedSecret: Uint8Array)
- deriveDirectionalChainKey(
- deriveMessageKeyMaterial(
- rotateChainKey(chainKey: Uint8Array)
- createOutboundSession(
- createInboundSession(
- encryptMessage(
- decryptMessage(
- serializeSession(sessionState: SessionState)

## packages/crypto-core/src/session/sessionKeys.ts
- interface SessionKeys
- interface SessionState
- generateKeyPair()
- serializeSessionState(state: SessionState)
- deserializeSessionState(serialized: string)

## packages/crypto-core/src/signatures/canonicalJson.ts
- canonicalJson(obj: unknown)

## packages/crypto-core/src/signatures/sign.ts
- normalizeKeyBytes(key: Uint8Array | string)
- signCanonicalJson(obj: unknown, secretKey: Uint8Array)
- verifyCanonicalJson(
- signUtf8Message(
- verifyUtf8Message(

## packages/protocol/src/constants/errorCodes.ts

## packages/protocol/src/constants/limits.ts

## packages/protocol/src/constants/protocolVersion.ts

## packages/protocol/src/index.ts

## packages/protocol/src/types/chatMessage.ts

## packages/protocol/src/types/deviceRecord.ts

## packages/protocol/src/types/mailboxEnvelope.ts

## packages/protocol/src/types/preKeyBundle.ts

## packages/protocol/src/types/receipt.ts

## packages/protocol/src/types/signalPreKeyBundleV2.test.ts
- bytes()
- bundle()

## packages/protocol/src/validators/validateDeviceRecord.test.ts

## packages/protocol/src/validators/validateDeviceRecord.ts
- validateDeviceRecord(

## packages/protocol/src/validators/validatePreKeyBundle.ts
- validatePreKeyBundle(

## packages/session-node/src/EncryptedSqliteStore.test.ts
- setup()
- open()

## packages/session-node/src/EncryptedSqliteStore.ts
- class EncryptedSqliteStore
- EncryptedSqliteStore.constructor(path: string, key: Uint8Array)
- EncryptedSqliteStore.transaction(operation: (tx: StoreTransaction) => T | Promise<T>)
- EncryptedSqliteStore.close()
- EncryptedSqliteStore.perform(operation: (tx: StoreTransaction) => T | Promise<T>)
- check()
- EncryptedSqliteStore.read()
- EncryptedSqliteStore.write(records: Map<string, Uint8Array>)

## packages/session-node/src/SignalClient.test.ts
- participant()
- pair()
- crash()

## packages/session-node/src/index.ts

## packages/session-node/src/wire.test.ts
- keyPair()
- participant()
- clone()
- resign()

## packages/session-node/src/wire.ts
- interface ExportSignalBundleV2Options
- interface ExpectedSignalContact
- bytes()
- copyJson()
- requireDeviceSignature(record: DeviceRecord)
- exportSignedSignalBundleV2(
- importVerifiedSignalBundleV2(

