import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, getQueuedMessages, remove, setMessageQueuePersistenceFailureForTest } from "./conversations";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID } from "./messages";
import { setIsolatedBashRunnerPathForTest } from "./tools/bash";
import {
  recordExternalNotificationReceipt,
  registerExternalNotificationSource,
  resetExternalNotificationsForTest,
  subscribeExternalNotification,
  unsubscribeExternalNotification,
  updateExternalNotificationSubscription,
} from "./external-notifications";
import {
  enqueueExternalNotificationSoftWake,
  externalNotificationSoftWakesPath,
  listPendingExternalNotificationSoftWakes,
  reloadExternalNotificationSoftWakesForTest,
  retryExternalNotificationSoftWakesNowForTest,
  resetExternalNotificationSoftWakesForTest,
  setExternalNotificationSoftWakePersistenceFailureForTest,
  startExternalNotificationSoftWakeService,
  stopExternalNotificationSoftWakeService,
} from "./external-notification-soft-wakes";

const conversationIds: string[] = [];
const isWindows = process.platform === "win32";

function platformCommand(posix: string, windows: string): string {
  return isWindows ? windows : posix;
}

function makeConversation(label: string): string {
  const id = `${Date.now()}-${label}-${Math.random().toString(36).slice(2, 8)}`;
  create(id, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], label);
  conversationIds.push(id);
  return id;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for external notification soft wake");
    await Bun.sleep(10);
  }
}

beforeEach(() => {
  setIsolatedBashRunnerPathForTest(null);
  setMessageQueuePersistenceFailureForTest(null);
  resetExternalNotificationSoftWakesForTest();
  resetExternalNotificationsForTest();
});

afterEach(() => {
  setIsolatedBashRunnerPathForTest(null);
  setMessageQueuePersistenceFailureForTest(null);
  stopExternalNotificationSoftWakeService();
  resetExternalNotificationSoftWakesForTest();
  resetExternalNotificationsForTest();
  for (const id of conversationIds.splice(0)) remove(id);
});

describe("external notification command soft wakes", () => {
  test("passes structured events on stdin and renders an exit-10 selection once", async () => {
    const convId = makeConversation("soft-wake-match");
    const source = registerExternalNotificationSource({
      toolName: "whatsapp",
      id: "incoming-messages",
      label: "Incoming WhatsApp messages",
    });
    const subscription = subscribeExternalNotification({
      toolName: source.toolName,
      sourceId: source.id,
      convId,
      delivery: "soft",
      softWake: {
        command: platformCommand(
          [
            "payload=$(cat)",
            "[[ \"$payload\" == *'/ai hello'* ]] || exit 0",
            "printf 'selected:%s:%s:%s' \"$EXOCORTEX_NOTIFICATION_TOOL\" \"$EXOCORTEX_NOTIFICATION_EVENT_ID\" \"$EXOCORTEX_NOTIFICATION_OCCURRENCE_ID\"",
            "exit 10",
          ].join("\n"),
          [
            "$payload = [Console]::In.ReadToEnd()",
            "if ($payload -notlike '*/ai hello*') { exit 0 }",
            "[Console]::Write('selected:{0}:{1}:{2}', $env:EXOCORTEX_NOTIFICATION_TOOL, $env:EXOCORTEX_NOTIFICATION_EVENT_ID, $env:EXOCORTEX_NOTIFICATION_OCCURRENCE_ID)",
            "exit 10",
          ].join("\n"),
        ),
        timeoutMs: 2_000,
        hardWake: {
          when: "failure",
          message: "Handle the matching WhatsApp /ai query.",
          includeOutput: true,
        },
      },
    });
    const event = {
      eventId: "chat-1:message-1",
      occurredAt: 1_784_335_000_000,
      text: "Alice [chat:123@s.whatsapp.net]\n\n→ Alice <123@s.whatsapp.net>:\n/ai hello\n[msg:message-1]",
      data: { schemaVersion: 1, kind: "incoming_message", senderName: "Alice", senderJid: "123@s.whatsapp.net", content: "   /ai hello" },
    } as const;

    const queued = enqueueExternalNotificationSoftWake(subscription, event);
    recordExternalNotificationReceipt(subscription.id, event.eventId);
    expect(queued.duplicate).toBe(false);
    expect(existsSync(externalNotificationSoftWakesPath())).toBe(true);
    reloadExternalNotificationSoftWakesForTest();
    expect(listPendingExternalNotificationSoftWakes()).toHaveLength(1);
    startExternalNotificationSoftWakeService();

    await waitUntil(() => getQueuedMessages(convId).length === 1);
    const wake = getQueuedMessages(convId)[0];
    expect(wake.id).toBe(`${queued.occurrenceId}:hard-wake`);
    expect(wake.text).toContain("[notification] WhatsApp · message");
    expect(wake.text).toContain("Action: Handle the matching WhatsApp /ai query.");
    expect(wake.text).toContain("selected:whatsapp:chat-1:message-1:external-soft:");
    expect(wake.text).toContain("→ Alice <123@s.whatsapp.net>:");
    expect(wake.text.match(/→ Alice <123@s\.whatsapp\.net>:/g)).toHaveLength(1);
    expect(wake.text).not.toContain("exit code 10");
    expect(wake.text).not.toContain("command output (untrusted, JSON string)");
    expect(listPendingExternalNotificationSoftWakes()).toEqual([]);
    expect(existsSync(externalNotificationSoftWakesPath())).toBe(false);
  });

  test("consumes a successful nonmatching event without invoking the model", async () => {
    const convId = makeConversation("soft-wake-ignore");
    registerExternalNotificationSource({ toolName: "whatsapp", id: "incoming", label: "Incoming" });
    const subscription = subscribeExternalNotification({
      toolName: "whatsapp",
      sourceId: "incoming",
      convId,
      delivery: "soft",
      softWake: {
        command: platformCommand("payload=$(cat); [[ \"$payload\" == *'/ai '* ]] || exit 0; exit 7", "$payload = [Console]::In.ReadToEnd(); if ($payload -notlike '*/ai *') { exit 0 }; exit 7"),
        timeoutMs: 2_000,
        hardWake: { when: "failure", message: "Handle /ai.", includeOutput: true },
      },
    });

    enqueueExternalNotificationSoftWake(subscription, {
      eventId: "ordinary-message",
      text: "Sender: Alice\nMessage: hello",
      data: { body: "hello" },
    });
    startExternalNotificationSoftWakeService();

    await waitUntil(() => listPendingExternalNotificationSoftWakes().length === 0);
    expect(getQueuedMessages(convId)).toEqual([]);
  });

  test("drops durable occurrences whose subscription was removed before execution", async () => {
    const convId = makeConversation("soft-wake-unsubscribed");
    registerExternalNotificationSource({ toolName: "whatsapp", id: "incoming", label: "Incoming" });
    const subscription = subscribeExternalNotification({
      toolName: "whatsapp",
      sourceId: "incoming",
      convId,
      delivery: "soft",
      softWake: {
        command: "printf should-not-run; exit 9",
        timeoutMs: 2_000,
        hardWake: { when: "failure", message: "Handle failure.", includeOutput: true },
      },
    });
    enqueueExternalNotificationSoftWake(subscription, { eventId: "removed-route", text: "message" });
    unsubscribeExternalNotification({ subscriptionId: subscription.id });

    startExternalNotificationSoftWakeService();
    await waitUntil(() => listPendingExternalNotificationSoftWakes().length === 0);
    expect(getQueuedMessages(convId)).toEqual([]);
  });

  test("aborts an active command and suppresses escalation when its route is disabled", async () => {
    const convId = makeConversation("soft-wake-disabled");
    const markerPath = join(tmpdir(), `exocortex-soft-wake-active-${process.pid}-${Date.now()}`);
    registerExternalNotificationSource({ toolName: "whatsapp", id: "incoming", label: "Incoming" });
    const subscription = subscribeExternalNotification({
      toolName: "whatsapp",
      sourceId: "incoming",
      convId,
      delivery: "soft",
      softWake: {
        command: platformCommand(`touch '${markerPath}'; sleep 2; exit 9`, `[IO.File]::WriteAllText('${markerPath}', ''); Start-Sleep -Seconds 2; exit 9`),
        timeoutMs: 5_000,
        hardWake: { when: "failure", message: "Should be revoked.", includeOutput: true },
      },
    });
    enqueueExternalNotificationSoftWake(subscription, { eventId: "disable-active", text: "message" });
    startExternalNotificationSoftWakeService();
    await waitUntil(() => existsSync(markerPath));

    setExternalNotificationSoftWakePersistenceFailureForTest(new Error("soft-wake disk unavailable"));
    updateExternalNotificationSubscription(subscription.id, { enabled: false });
    await Bun.sleep(300);
    expect(getQueuedMessages(convId)).toEqual([]);
    expect(listPendingExternalNotificationSoftWakes()).toHaveLength(1);

    setExternalNotificationSoftWakePersistenceFailureForTest(null);
    retryExternalNotificationSoftWakesNowForTest();
    await waitUntil(() => listPendingExternalNotificationSoftWakes().length === 0);
    rmSync(markerPath, { force: true });
  });

  test("applies per-subscription backpressure before acknowledging an unbounded event flood", () => {
    const convId = makeConversation("soft-wake-backpressure");
    registerExternalNotificationSource({ toolName: "whatsapp", id: "incoming", label: "Incoming" });
    const subscription = subscribeExternalNotification({
      toolName: "whatsapp",
      sourceId: "incoming",
      convId,
      delivery: "soft",
      softWake: { command: platformCommand("true", "exit 0"), timeoutMs: 2_000 },
    });

    for (let index = 0; index < 64; index++) {
      enqueueExternalNotificationSoftWake(subscription, { eventId: `flood-${index}`, text: `message ${index}` });
    }
    expect(() => enqueueExternalNotificationSoftWake(subscription, { eventId: "flood-overflow", text: "overflow" }))
      .toThrow("backlog is full for subscription");
    expect(listPendingExternalNotificationSoftWakes()).toHaveLength(64);
    expect(listPendingExternalNotificationSoftWakes().map(item => item.event.eventId)).toEqual(
      Array.from({ length: 64 }, (_, index) => `flood-${index}`),
    );
  });

  test("rolls back an enqueue that could not be made durable", () => {
    const convId = makeConversation("soft-wake-storage-failure");
    registerExternalNotificationSource({ toolName: "whatsapp", id: "incoming", label: "Incoming" });
    const subscription = subscribeExternalNotification({
      toolName: "whatsapp",
      sourceId: "incoming",
      convId,
      delivery: "soft",
      softWake: { command: platformCommand("true", "exit 0"), timeoutMs: 2_000 },
    });
    setExternalNotificationSoftWakePersistenceFailureForTest(new Error("disk unavailable"));

    expect(() => enqueueExternalNotificationSoftWake(subscription, { eventId: "not-durable", text: "message" }))
      .toThrow("disk unavailable");
    expect(listPendingExternalNotificationSoftWakes()).toEqual([]);

    setExternalNotificationSoftWakePersistenceFailureForTest(null);
    expect(enqueueExternalNotificationSoftWake(subscription, { eventId: "not-durable", text: "message" }).duplicate).toBe(false);
    expect(listPendingExternalNotificationSoftWakes()).toHaveLength(1);
  });

  test("serializes each subscription in durable acceptance order", async () => {
    const convId = makeConversation("soft-wake-fifo");
    const outputPath = join(tmpdir(), `exocortex-soft-wake-fifo-${process.pid}-${Date.now()}`);
    registerExternalNotificationSource({ toolName: "whatsapp", id: "incoming", label: "Incoming" });
    const subscription = subscribeExternalNotification({
      toolName: "whatsapp",
      sourceId: "incoming",
      convId,
      delivery: "soft",
      softWake: {
        command: platformCommand(`python3 -c 'import json,sys,time; e=json.load(sys.stdin); open(\"${outputPath}\",\"a\").write(e[\"event\"][\"data\"][\"body\"]+\"\\n\"); time.sleep(.03)'`, `$event = [Console]::In.ReadToEnd() | ConvertFrom-Json; Add-Content -LiteralPath '${outputPath}' -Value $event.event.data.body; Start-Sleep -Milliseconds 30`),
        timeoutMs: 2_000,
      },
    });
    for (let index = 0; index < 3; index++) {
      enqueueExternalNotificationSoftWake(subscription, {
        eventId: `ordered-${index}`,
        text: `message ${index}`,
        data: { body: String(index) },
      });
    }
    startExternalNotificationSoftWakeService();

    await waitUntil(() => listPendingExternalNotificationSoftWakes().length === 0);
    expect(readFileSync(outputPath, "utf8").replace(/\r\n/g, "\n")).toBe("0\n1\n2\n");
    rmSync(outputPath, { force: true });
  });

  test("retries a checkpointed hard wake after durable message-queue persistence recovers", async () => {
    const convId = makeConversation("soft-wake-queue-retry");
    registerExternalNotificationSource({ toolName: "whatsapp", id: "incoming", label: "Incoming" });
    const subscription = subscribeExternalNotification({
      toolName: "whatsapp",
      sourceId: "incoming",
      convId,
      delivery: "soft",
      softWake: {
        command: platformCommand("printf selected; exit 17", "[Console]::Write('selected'); exit 17"),
        timeoutMs: 2_000,
        hardWake: { when: "failure", message: "Retry hard wake.", includeOutput: true },
      },
    });
    enqueueExternalNotificationSoftWake(subscription, { eventId: "queue-retry", text: "message" });
    setMessageQueuePersistenceFailureForTest(new Error("queue disk unavailable"));
    startExternalNotificationSoftWakeService();

    await waitUntil(() => Boolean(listPendingExternalNotificationSoftWakes()[0]?.commandResult));
    expect(getQueuedMessages(convId)).toEqual([]);
    setMessageQueuePersistenceFailureForTest(null);
    retryExternalNotificationSoftWakesNowForTest();

    await waitUntil(() => getQueuedMessages(convId).length === 1);
    expect(getQueuedMessages(convId)[0].text).toContain("Retry hard wake.");
    expect(getQueuedMessages(convId)[0].text).toContain("selected");
    expect(listPendingExternalNotificationSoftWakes()).toEqual([]);
  });

  test("retries runner infrastructure failures without checkpointing them as command outcomes", async () => {
    const convId = makeConversation("soft-wake-runner-retry");
    registerExternalNotificationSource({ toolName: "whatsapp", id: "incoming", label: "Incoming" });
    const subscription = subscribeExternalNotification({
      toolName: "whatsapp",
      sourceId: "incoming",
      convId,
      delivery: "soft",
      softWake: { command: platformCommand("true", "exit 0"), timeoutMs: 2_000 },
    });
    enqueueExternalNotificationSoftWake(subscription, { eventId: "runner-retry", text: "message" });
    setIsolatedBashRunnerPathForTest("/definitely/missing/exocortex-bash-runner.ts");
    startExternalNotificationSoftWakeService();

    await waitUntil(() => Boolean(listPendingExternalNotificationSoftWakes()[0]?.retryAt));
    expect(listPendingExternalNotificationSoftWakes()[0].commandResult).toBeUndefined();

    setIsolatedBashRunnerPathForTest(null);
    retryExternalNotificationSoftWakesNowForTest();
    await waitUntil(() => listPendingExternalNotificationSoftWakes().length === 0);
    expect(getQueuedMessages(convId)).toEqual([]);
  });
});
