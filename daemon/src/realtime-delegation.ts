import type { RealtimeCallSpeakerAttribution } from "./protocol";

/** One visible, durable request matching Exocortex's automated-event style. */
export function buildRealtimeDelegationMessage(
  originalUserUtterance: string,
  backendTask = originalUserUtterance,
  speaker?: RealtimeCallSpeakerAttribution,
): string {
  const original = originalUserUtterance.trim();
  const task = backendTask.trim();
  const sameRequest = original.replace(/\s+/gu, " ") === task.replace(/\s+/gu, " ");
  const speakerLine = !speaker
    ? []
    : speaker.kind === "single" && speaker.participants[0]
      ? [`Speaker: ${speaker.participants[0].displayName} <${speaker.participants[0].id}> [${speaker.participants[0].trust}]`]
      : speaker.kind === "multiple"
        ? [`Speakers (overlap): ${speaker.participants.map(participant => `${participant.displayName} <${participant.id}> [${participant.trust}]`).join(", ")}`]
        : ["Speaker: unknown [untrusted]"];
  return [
    "[realtime delegation]",
    ...speakerLine,
    `Task: ${task}`,
    ...(!sameRequest ? [`Original speech: ${original}`] : []),
    "",
    "Action: Complete only the backend task and return its result without conversational filler or progress narration. GPT-Live handles the live conversation.",
  ].join("\n");
}
