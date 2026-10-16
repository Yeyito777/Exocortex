import { expect, test } from "bun:test";
import { conversationActivityIndicator } from "./sidebar/activityindicator";
import { theme } from "./theme";

test("waiting streaming conversations use yellow in the shared sidebar/Tasks indicator", () => {
  const context = { globalIdle: false, optimisticStreaming: false, notificationsMuted: false };
  const conv = { streaming: true, unread: false, providerWaiting: true };
  expect(conversationActivityIndicator(conv, context).color).toBe(theme.warning);
  expect(conversationActivityIndicator({ ...conv, providerWaiting: false }, context).color).toBe(theme.accent);
});
