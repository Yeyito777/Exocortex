# Realtime Delegation Parity Todo

Port the relevant handoff behavior from the OpenAI Codex realtime implementation while preserving Exocortex's durable conversation model and speaker attribution.

- [x] Maintain a per-call transcript ledger and snapshot the transcript delta at each handoff.
- [x] Send a structured, escaped realtime delegation payload containing the distilled input, original speech, speaker attribution, and transcript delta.
- [x] Stream backend text into `delegation.context.append` with bounded, throttled updates instead of waiting only for the final result.
- [x] Queue subsequent handoffs instead of silently dropping them, and expose compact delegation lifecycle feedback to the TUI.
- [x] Flush and durably preserve the transcript tail when a call closes without duplicating already handed-off entries.
- [x] Strengthen the GPT-Live operating prompt and add regression tests for context, streaming, queuing, lifecycle feedback, and tail handling.
- [x] Run formatting/type checks and the focused realtime test suites, then document the completed behavior.
- [x] Reproduce and suppress Frameless assistant transcript replay after a user barges into an active response.
- [x] Verify from the latest call timestamps and transcript that macOS capture remains active during assistant playback.
- [x] Add a `/mute` toggle that sends silence without tearing down the local WebRTC microphone track.
- [x] Add a distinct active-call indicator to conversations and recursively containing folders in the sidebar.

## Completed behavior

- Each call now keeps a finalized role-bearing transcript ledger and advances an explicit boundary whenever GPT-Live creates a handoff.
- Delegated model input is a visible XML-like payload with escaped task text, original speech when different, authenticated speaker information, and the transcript since the previous boundary.
- Backend answer text is forwarded to GPT-Live in ordered 200 ms batches, capped at 16,000 characters, while the canonical agent stream remains visible in the TUI.
- Additional handoffs are serialized per conversation rather than discarded; while waiting they appear through the canonical `queued: next turn` message system as full structured realtime delegations, then reconcile into ordinary delegation history when execution starts.
- Call shutdown finalizes only uncommitted transcript buffers and closes the remaining ledger boundary, leaving every spoken turn durably represented once.
- GPT-Live is explicitly instructed to behave as one assistant, trust Exocortex results, acknowledge audio accurately, delegate execution work, and treat later instructions as steering.
- Interrupted assistant streams now discard provider-replayed speech even when the replay is wrapped by short continuation fragments.
- The latest reported call captured “Nuts” during assistant playback and continued capturing a 90-second background utterance; the local WebRTC helper runs independent full-duplex capture/playback processes, so the observed delay is Bidi turn/VAD behavior rather than the microphone process stopping.

Validation completed with `git diff --check`, the workspace TypeScript typecheck, 166 focused call manager, command, media, event, and sidebar tests, plus 192 queue, handler, persistence, event, and TUI tests in the latest broader integration run.
