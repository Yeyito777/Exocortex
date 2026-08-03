# Discord call speaker attribution TODO

- [x] Reproduce the transient join-trigger message duplication and fix live/canonical user-turn reconciliation by stable identity rather than text.
- [x] Omit redundant `Original speech` from realtime delegation messages while preserving it when GPT-Live materially changes the backend task.
- [x] Extend the generic realtime call protocol with platform participant identity, trust, and speaker-segment events.
- [x] Preserve per-user Discord audio identity through local segmentation and publish participant/speaker boundaries without sending per-frame IPC.
- [x] Correlate Bidi input turns with speaker segments conservatively, including explicit unknown/multi-speaker handling for overlaps.
- [x] Persist, render, and replay speaker attribution so the UI, GPT-Live context, and delegated backend all receive the appropriate identity and trust context.
- [x] Add regression, protocol, adapter, multi-speaker, overlap, and trust-sensitive delegation tests.
- [x] Run the full relevant Exocortex and discord-cli test suites, commit and push both repositories, and verify both worktrees are clean and synced.
