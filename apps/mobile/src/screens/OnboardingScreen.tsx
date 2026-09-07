import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ScrollView,
} from "react-native";
import {
  createIdentityProfile,
  createSignedDeviceRecord,
  type IdentityProfile,
} from "@echolet/client-core";
import { relayApi } from "../services/relayApi";
import { useTerminalStore } from "../state/useTerminalStore";

interface OnboardingScreenProps {
  onComplete?: (profile: IdentityProfile) => void;
}

export function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
  const [step, setStep] = useState(1);
  const [profile, setProfile] = useState<IdentityProfile | null>(null);
  const [seedInput, setSeedInput] = useState<string>("");
  const [callsign, setCallsign] = useState<string>("");
  const [suffix, setSuffix] = useState<string>("");
  const { addEvent } = useTerminalStore();

  const handleGenerateIdentity = async () => {
    try {
      const nextProfile = await createIdentityProfile({
        seed: seedInput.trim() || undefined,
        suffix,
        deviceLabel: "mobile-device",
      });
      setProfile(nextProfile);
      setSeedInput(nextProfile.seed);
      setCallsign(nextProfile.callsign);
      setStep(2);
      addEvent(
        "IDENTITY",
        seedInput.trim()
          ? `Recovered identity: ${nextProfile.callsign}`
          : `Generated identity: ${nextProfile.callsign}`,
      );
    } catch (error) {
      addEvent("ERROR", `Failed to generate identity: ${error}`);
      Alert.alert("Error", "Failed to generate identity");
    }
  };

  const handleConfirmSeed = async () => {
    setStep(3);
    addEvent("ONBOARDING", "Seed confirmed");
  };

  const handlePublishToRelay = async () => {
    if (!profile) {
      Alert.alert("Error", "Generate or recover an identity first");
      return;
    }

    try {
      const deviceRecord = createSignedDeviceRecord(
        profile.identityId,
        profile.deviceId,
        profile.devicePubKey,
        profile.identitySecretKey,
        "mobile-device",
      );

      const result = await relayApi.publishDeviceRecord(deviceRecord);
      if (result.ok) {
        addEvent("RELAY", "Device record published");
        setStep(4);
        onComplete?.(profile);
      } else {
        addEvent(
          "ERROR",
          `Failed to publish device record: ${result.error?.message}`,
        );
        Alert.alert("Error", result.error?.message || "Failed to publish");
      }
    } catch (error) {
      addEvent("ERROR", `Failed to publish: ${error}`);
      Alert.alert("Error", "Failed to publish to relay");
    }
  };

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Echolet Onboarding</Text>

      {step === 1 && (
        <View>
          <Text style={styles.label}>Choose callsign suffix (optional):</Text>
          <TextInput
            style={styles.input}
            value={suffix}
            onChangeText={setSuffix}
            placeholder="e.g., SKY"
            placeholderTextColor="#666"
          />
          <Text style={styles.label}>Existing seed (optional recovery):</Text>
          <TextInput
            style={[styles.input, styles.seedInput]}
            value={seedInput}
            onChangeText={setSeedInput}
            placeholder="Leave empty to generate a new seed"
            placeholderTextColor="#666"
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={styles.button}
            onPress={handleGenerateIdentity}
          >
            <Text style={styles.buttonText}>Generate Identity</Text>
          </TouchableOpacity>
        </View>
      )}

      {step === 2 && (
        <View>
          <Text style={styles.warning}>
            IMPORTANT: Write down your seed phrase. This is the only way to
            recover your identity!
          </Text>
          <View style={styles.seedBox}>
            <Text style={styles.seedText}>{profile?.seed}</Text>
          </View>
          <TouchableOpacity style={styles.button} onPress={handleConfirmSeed}>
            <Text style={styles.buttonText}>I've saved my seed</Text>
          </TouchableOpacity>
        </View>
      )}

      {step === 3 && (
        <View>
          <Text style={styles.success}>Your callsign: {callsign}</Text>
          <TouchableOpacity
            style={styles.button}
            onPress={handlePublishToRelay}
          >
            <Text style={styles.buttonText}>Publish to Relay</Text>
          </TouchableOpacity>
        </View>
      )}

      {step === 4 && (
        <View>
          <Text style={styles.success}>
            Setup complete! You're ready to use Echolet.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: "#1a1a1a",
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#00FF41",
    marginBottom: 30,
    textAlign: "center",
  },
  label: {
    fontSize: 16,
    color: "#fff",
    marginBottom: 8,
  },
  input: {
    backgroundColor: "#333",
    color: "#fff",
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  seedInput: {
    minHeight: 96,
    textAlignVertical: "top",
  },
  button: {
    backgroundColor: "#00FF41",
    padding: 16,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonText: {
    color: "#1a1a1a",
    fontSize: 16,
    fontWeight: "bold",
  },
  warning: {
    color: "#FFB000",
    fontSize: 14,
    marginBottom: 16,
    textAlign: "center",
  },
  seedBox: {
    backgroundColor: "#333",
    padding: 16,
    borderRadius: 8,
    marginBottom: 16,
  },
  seedText: {
    color: "#00FF41",
    fontSize: 14,
    fontFamily: "monospace",
    lineHeight: 20,
  },
  success: {
    color: "#00FF41",
    fontSize: 18,
    textAlign: "center",
    marginTop: 40,
  },
});
