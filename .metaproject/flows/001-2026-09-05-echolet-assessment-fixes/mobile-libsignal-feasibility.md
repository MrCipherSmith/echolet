# Mobile libsignal feasibility

Date: 2026-09-06. STATUS: DONE_WITH_CONCERNS. Source inspection only; no runtime installation, native build, device run, or security audit performed.

## Decision

Do not adopt `p-num/react-native-libsignal-client` unmodified for Echolet's trusted session layer. The source exposes application trust/storage gaps that an adapter name does not repair. Preferred next spike: a narrow app-owned native module around official Swift/Java libsignal bindings, with durable transactional stores and explicit verified-contact trust. This recommendation is an engineering inference from the code below, not proof that a new bridge is already safe. A reviewed fork fixing the same gaps is an alternative; do not assume it is cheaper than the narrow module.

## Reproducible versions

- Wrapper npm latest: `react-native-libsignal-client@0.1.44`, git head `e2edbcaec803cb75cf41693ad1538be96f9244f7`; repository latest commit dated 2025-12-17. [Package source](https://github.com/p-num/react-native-libsignal-client/blob/e2edbcaec803cb75cf41693ad1538be96f9244f7/package.json).
- Wrapper Android pins both `org.signal:libsignal-client:0.70.0` and `org.signal:libsignal-android:0.70.0`. It requires ExpoModulesCore Gradle integration, not merely React Native. [Gradle source](https://github.com/p-num/react-native-libsignal-client/blob/e2edbcaec803cb75cf41693ad1538be96f9244f7/android/build.gradle).
- Wrapper iOS podspec requires ExpoModulesCore and LibSignalClient without a version constraint in that podspec; its README plugin instructions target v0.70.0. Podspec specifies Swift 5.4 and iOS 13.4. [Podspec](https://github.com/p-num/react-native-libsignal-client/blob/e2edbcaec803cb75cf41693ad1538be96f9244f7/ios/ReactNativeLibsignalClient.podspec).
- Official latest release observed: [v0.102.0](https://github.com/signalapp/libsignal/releases/tag/v0.102.0), published 2026-09-03. Official source inspected at `b3f7ecc2f6c5b5246fa9d24b891579f17fa47893`. Pin a release plus resolved checksum for the spike; do not mix 0.70 wrapper assumptions with 0.102 binaries. No claim made that 0.70 contains a known exploitable vulnerability merely because it is older.

## Concrete wrapper gaps

### Trust policy is not carried through bootstrap

`src/index.ts:createAndProcessPreKeyBundle` lines 1350–1386 passes only local identity initializer to native, then saves returned identity/session. Although the JS abstract class declares `isTrustedIdentity`, this path does not invoke it or transfer stored remote trust. `signalDecryptPreKey` likewise passes local identity/prekeys without current remote identity/session. Native Android creates a fresh in-memory store (lines 735–768), so application-pinned remote keys are absent from that operation. Native Swift in-memory trust returns true for an unknown identity (lines 142–148). Consequence: Echolet cannot rely on supplying a rejecting JS trust callback to enforce verified contacts here. [JS operations](https://github.com/p-num/react-native-libsignal-client/blob/e2edbcaec803cb75cf41693ad1538be96f9244f7/src/index.ts#L1350), [Android operation](https://github.com/p-num/react-native-libsignal-client/blob/e2edbcaec803cb75cf41693ad1538be96f9244f7/android/src/main/java/expo/modules/libsignalclient/ReactNativeLibsignalClientModule.kt#L735), [Swift trust](https://github.com/p-num/react-native-libsignal-client/blob/e2edbcaec803cb75cf41693ad1538be96f9244f7/ios/ReactNativeLibsignalClientModule.swift#L142).

### Persistent updates lack an atomic operation boundary

`src/stores.ts` loops over returned maps and awaits separate save calls. Removed prekeys are not represented as delete operations. JS prekey decrypt saves sessions, identities and signed prekeys sequentially, then upserts remaining prekeys; Kyber state update is commented out. A crash or overlapping operation can leave application state inconsistent unless the caller supplies stronger coordination than this wrapper provides. Durable one-time-key consumption is not established. This is source-level risk; no exploit or device crash reproduced. [Store update helpers](https://github.com/p-num/react-native-libsignal-client/blob/e2edbcaec803cb75cf41693ad1538be96f9244f7/src/stores.ts), [Prekey writeback](https://github.com/p-num/react-native-libsignal-client/blob/e2edbcaec803cb75cf41693ad1538be96f9244f7/src/index.ts#L1492).

### Native compatibility remains a real project task

Wrapper `requireNativeModule` comes from expo-modules-core; peer declarations with wildcards are not evidence for RN 0.84/React 19 compatibility. Echolet mobile package currently declares React Native 0.84.1, React 19.2.4 and no Expo dependency. iOS/Android native project and build wiring would need validation. README examples alone are insufficient; package metadata still points to a different repository owner than the inspected fork. [Native loader](https://github.com/p-num/react-native-libsignal-client/blob/e2edbcaec803cb75cf41693ad1538be96f9244f7/src/ReactNativeLibsignalClientModule.ts), [Package metadata](https://github.com/p-num/react-native-libsignal-client/blob/e2edbcaec803cb75cf41693ad1538be96f9244f7/package.json).

## Official native interfaces and required app responsibilities

Swift `DataStoreProtocols.swift` provides `IdentityKeyStore.isTrustedIdentity`, explicit `removePreKey`, `markKyberPreKeyUsed`, and `StoreContext` on operations. An app-defined transaction context can be threaded through callbacks; the interface does not implement the transaction or secure storage itself. `saveIdentity` now returns an IdentityChange enum, demonstrating that blindly upgrading the old wrapper is not a safe compatibility assumption. [Swift protocols](https://github.com/signalapp/libsignal/blob/b3f7ecc2f6c5b5246fa9d24b891579f17fa47893/swift/Sources/LibSignalClient/DataStoreProtocols.swift).

Java `IdentityKeyStore` exposes identity verification with sending/receiving direction. Echolet should enforce its own verified-contact policy, not default unknown-key acceptance. Java `SessionStore` requires copies of durable state on load and explicit commit on store. Wrap complete cryptographic operations and associated message/prekey mutations in one application transaction and serialize competing operations. [Java identity contract](https://github.com/signalapp/libsignal/blob/b3f7ecc2f6c5b5246fa9d24b891579f17fa47893/java/shared/java/org/signal/libsignal/protocol/state/IdentityKeyStore.java), [Java session contract](https://github.com/signalapp/libsignal/blob/b3f7ecc2f6c5b5246fa9d24b891579f17fa47893/java/shared/java/org/signal/libsignal/protocol/state/SessionStore.java).

Official Swift package uses Swift tools 6.0 and SignalFfi; its package file alone does not bundle a ready RN module or eliminate Rust/native linking work. [Swift package](https://github.com/signalapp/libsignal/blob/b3f7ecc2f6c5b5246fa9d24b891579f17fa47893/swift/Package.swift). Both wrapper and official source declare AGPL licensing; record license compatibility as a project decision rather than inventing a permissive license assumption.

## Local native tool availability

Observed commands, not inferred from documentation:

- `xcode-select -p`: `/Applications/Xcode.app/Contents/Developer`.
- `xcodebuild -version`: Xcode 26.6, build 17F113.
- Standard `/Users/Goodea/Library/Android/sdk` directory exists.
- ANDROID_HOME and ANDROID_SDK_ROOT are not configured in this process. No other environment variables or secrets printed.

This removes the assumption that SDK tooling is entirely absent. It does not prove Android platform/build-tools/NDK versions, JDK/Gradle compatibility, provisioning, connected phones or working native builds.

## Next bounded spike acceptance

1. Pin official native version and build each platform; expose only bootstrap/encrypt/decrypt plus native durable storage, not the wrapper's broad backup/group APIs.
2. Map verified Echolet identities to Signal protocol identities without treating Ed25519 signing keys as interchangeable with libsignal identity keys; version contracts if required.
3. Test a rejecting trust store against a changed remote key, including inbound prekey messages; reject before durable changes.
4. Inject failure after each store mutation; require rollback of session/prekey/message state. Commit outbound ciphertext together with ratchet state before allowing send; commit inbound message/dedup/session/prekey state before acknowledgement.
5. Run simultaneous sends/decrypts, duplicates, out-of-order messages and process restart on two physical phones. Track real background behavior separately.

Until those checks pass, retain the existing disabled-by-default messaging guard. A Node adapter can validate the protocol concept but cannot establish native platform readiness.

Routing: Metaproject hard gate read; wiki index previously empty. graph not-relevant for upstream source investigation; local graph previously used to establish mobile scope. ctx used for local package read in preceding verification; upstream source fetched at exact commits, no raw rg. Native environment checks were short bounded commands. No runtime/dependency edits performed.
