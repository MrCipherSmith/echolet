import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import type { IdentityProfile } from "@echolet/client-core";
import { OnboardingScreen } from "../screens/OnboardingScreen";
import { MessagingScreen } from "../screens/MessagingScreen";
import { TerminalScreen } from "../screens/TerminalScreen";

export function App() {
  const [activeScreen, setActiveScreen] = React.useState<
    "onboarding" | "messages" | "terminal"
  >("onboarding");
  const [profile, setProfile] = React.useState<IdentityProfile | null>(null);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Echolet Prototype</Text>
        <View style={styles.nav}>
          <TouchableOpacity
            style={[
              styles.navButton,
              activeScreen === "onboarding" && styles.navButtonActive,
            ]}
            onPress={() => setActiveScreen("onboarding")}
          >
            <Text style={styles.navButtonText}>Onboarding</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.navButton,
              activeScreen === "messages" && styles.navButtonActive,
            ]}
            onPress={() => setActiveScreen("messages")}
          >
            <Text style={styles.navButtonText}>Messages</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.navButton,
              activeScreen === "terminal" && styles.navButtonActive,
            ]}
            onPress={() => setActiveScreen("terminal")}
          >
            <Text style={styles.navButtonText}>Terminal</Text>
          </TouchableOpacity>
        </View>
      </View>

      {profile ? (
        <Text style={styles.subtitle}>Active callsign: {profile.callsign}</Text>
      ) : (
        <Text style={styles.subtitle}>Experimental relay messaging</Text>
      )}

      <View style={styles.screenContainer}>
        {activeScreen === "onboarding" ? (
          <OnboardingScreen
            onComplete={(nextProfile) => {
              setProfile(nextProfile);
              setActiveScreen("messages");
            }}
          />
        ) : activeScreen === "messages" ? (
          <MessagingScreen profile={profile} />
        ) : (
          <TerminalScreen />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a1a",
    paddingTop: 48,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: "bold",
    color: "#00FF41",
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    color: "#888",
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  nav: {
    flexDirection: "row",
    gap: 12,
  },
  navButton: {
    borderWidth: 1,
    borderColor: "#00FF41",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  navButtonActive: {
    backgroundColor: "#00FF41",
  },
  navButtonText: {
    color: "#1a1a1a",
    fontWeight: "bold",
  },
  screenContainer: {
    flex: 1,
  },
});
