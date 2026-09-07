import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { useTerminalStore } from "../state/useTerminalStore";

export function TerminalScreen() {
  const { events, clearEvents } = useTerminalStore();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Terminal</Text>
        <Text style={styles.clearButton} onPress={clearEvents}>
          Clear
        </Text>
      </View>
      <ScrollView style={styles.logContainer}>
        {events.map((event) => (
          <Text key={event.id} style={styles.logEntry}>
            <Text style={styles.timestamp}>
              {new Date(event.timestamp).toLocaleTimeString()}
            </Text>{" "}
            <Text style={styles.type}>[{event.type}]</Text>{" "}
            <Text style={styles.message}>{event.message}</Text>
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a1a",
    padding: 16,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#00FF41",
  },
  clearButton: {
    fontSize: 16,
    color: "#FFB000",
  },
  logContainer: {
    flex: 1,
  },
  logEntry: {
    fontSize: 12,
    color: "#00FF41",
    fontFamily: "monospace",
    marginBottom: 4,
  },
  timestamp: {
    color: "#888",
  },
  type: {
    color: "#FFB000",
  },
  message: {
    color: "#00FF41",
  },
});
