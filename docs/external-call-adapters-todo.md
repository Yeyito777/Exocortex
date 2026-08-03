# External call media adapters TODO

- [x] Replace the daemon-wide call singleton with independent call sessions keyed by call ID and adapter identity.
- [x] Make call start, media attachment, hangup, delegation cancellation, events, and shutdown target the correct session.
- [x] Preserve the native TUI call flow on the generic session contract and cover concurrent-session behavior with tests.
- [x] Add an Exocortex adapter-client control contract suitable for detached platform media workers.
- [x] Add a Discord media adapter that bridges participant audio to Exocortex WebRTC and Exocortex audio back to Discord.
- [x] Bind external calls to the invoking Exocortex conversation and current daemon endpoint by default.
- [x] Replace platform-specific core adapter fields with generic tool/account/endpoint metadata.
- [x] Make Exocortex-backed calling canonical in Discord CLI and remove its legacy ASR/TTS call pipeline.
- [x] Verify native TUI and external calls can run concurrently, delegate independently, and hang up independently.
- [x] Run final test suites, commit and push both repositories, merge the worktree, and clean it up.
