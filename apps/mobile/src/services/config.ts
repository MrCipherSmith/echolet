export const RELAY_BASE_URL =
  process.env.ECHOLET_RELAY_BASE_URL || "http://localhost:8081";
export const RELAY_FINGERPRINT =
  process.env.ECHOLET_RELAY_FINGERPRINT || "local-dev-relay";
export const APP_ENV = process.env.ECHOLET_APP_ENV || "development";
export const ENABLE_TERMINAL = process.env.ECHOLET_ENABLE_TERMINAL !== "false";
export const ENABLE_MANUAL_POLL =
  process.env.ECHOLET_ENABLE_MANUAL_MAILBOX_POLL !== "false";
