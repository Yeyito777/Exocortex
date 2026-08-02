# Discord Bidi calls TODO

- [x] Replace the daemon-wide call singleton with independent call sessions keyed by call ID and adapter identity.
- [x] Make call start, media attachment, hangup, delegation cancellation, events, and shutdown target the correct session.
- [x] Preserve the native TUI call flow on the generic session contract and cover concurrent-session behavior with tests.
- [x] Add an Exocortex adapter-client control contract suitable for detached Discord media workers.
- [x] Add a Discord Bidi media adapter that bridges Discord participant audio to OpenAI WebRTC and OpenAI audio back to Discord.
- [x] Bind each Discord call to an owning Exocortex conversation with explicit account/channel/source metadata and independent lifecycle.
- [x] Remove local ASR/TTS from Discord Bidi mode while retaining the existing legacy Discord call mode.
- [x] Verify a native TUI call and a Discord call can run concurrently, delegate independently, and hang up independently.
- [ ] Run full relevant test suites, update documentation/help, commit and push each repository, merge the Exocortex worktree, and clean it up.
