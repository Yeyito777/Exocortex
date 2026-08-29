import type { RealtimeCallSpeakerAttribution } from "./protocol";

function escapeXmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizedRequest(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

function renderSpeaker(speaker?: RealtimeCallSpeakerAttribution): string | null {
  if (!speaker) return null;
  if (speaker.kind === "single" && speaker.participants[0]) {
    const participant = speaker.participants[0];
    return `${participant.displayName} <${participant.id}> [${participant.trust}]`;
  }
  if (speaker.kind === "multiple") {
    return `overlap: ${speaker.participants
      .map(participant => `${participant.displayName} <${participant.id}> [${participant.trust}]`)
      .join(", ")}`;
  }
  return "unknown [untrusted]";
}

/** One visible, durable request carrying the exact context behind a realtime handoff. */
export function buildRealtimeDelegationMessage(
  originalUserUtterance: string,
  backendTask = originalUserUtterance,
  speaker?: RealtimeCallSpeakerAttribution,
  transcriptDelta: Array<{ role: "user" | "assistant"; text: string }> = [],
): string {
  const original = originalUserUtterance.trim();
  const task = backendTask.trim();
  const sameRequest = normalizedRequest(original) === normalizedRequest(task);
  const speakerText = renderSpeaker(speaker);
  const transcript = transcriptDelta
    .map(entry => ({ role: entry.role, text: entry.text.trim() }))
    .filter(entry => entry.text)
    .map(entry => `${entry.role}: ${entry.text}`)
    .join("\n");

  return [
    "[realtime delegation]",
    "<realtime_delegation>",
    `  <input>${escapeXmlText(task)}</input>`,
    ...(!sameRequest ? [`  <original_speech>${escapeXmlText(original)}</original_speech>`] : []),
    ...(speakerText ? [`  <speaker>${escapeXmlText(speakerText)}</speaker>`] : []),
    ...(transcript ? [`  <transcript_delta>${escapeXmlText(transcript)}</transcript_delta>`] : []),
    "  <action>Complete only the delegated backend task. Return useful result text without conversational filler; GPT-Live owns the spoken conversation.</action>",
    "</realtime_delegation>",
  ].join("\n");
}
