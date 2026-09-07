import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  View: "div", Text: "span", ScrollView: "div", TextInput: "input",
  TouchableOpacity: "button", Alert: { alert: vi.fn() },
  StyleSheet: { create: (styles) => styles },
}));

async function renderMessaging(dev, optIn) {
  vi.resetModules();
  if (dev === undefined) vi.stubGlobal("__DEV__", undefined);
  else vi.stubGlobal("__DEV__", dev);
  vi.stubEnv("EXPO_PUBLIC_ECHOLET_ENABLE_UNSAFE_DEMO", optIn);
  const { MessagingScreen } = await import("./MessagingScreen");
  return renderToStaticMarkup(React.createElement(MessagingScreen, { profile: null }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("unvalidated messaging entry", () => {
  it.each([false, undefined])("blocks release/unknown build %s despite opt-in", async (dev) => {
    const html = await renderMessaging(dev, "true");
    expect(html).toContain("Messaging is not ready for private conversations");
    expect(html).not.toContain("Finish onboarding");
  });
  it.each([undefined, "false", "1"])("requires explicit development opt-in %s", async (optIn) => {
    const html = await renderMessaging(true, optIn);
    expect(html).toContain("Messaging is not ready for private conversations");
    expect(html).not.toContain("Finish onboarding");
  });
  it("allows development demo only with disclosure", async () => {
    const html = await renderMessaging(true, "true");
    expect(html).toContain("Development demo only");
    expect(html).toContain("Do not send private or sensitive messages");
    expect(html).toContain("Finish onboarding");
  });
});
