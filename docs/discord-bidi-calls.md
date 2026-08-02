# Discord Bidi calls

Exocortex owns realtime intelligence, conversation context, transcripts, delegation, and call-session lifecycle. Platform clients own media capture and playback.

Each call is identified by `callId` and an adapter identity. The daemon permits independent adapters to run concurrently; the native TUI uses `tui:local`, while Discord uses `<account-alias>:<channel-id>`. Commands, SDP answers, transcript events, cancellation, and shutdown remain call-ID scoped.

A Discord Bidi worker:

1. joins Discord voice and establishes its RTP/DAVE media session;
2. creates or selects an owning Exocortex conversation;
3. starts a call using a Discord adapter identity;
4. mixes decoded participant PCM into one WebRTC input track;
5. sends OpenAI WebRTC output back through Discord Opus/RTP; and
6. stops only its own Exocortex call when the Discord worker leaves.

Bidi mode does not run Discord's legacy segmentation, ASR notification, or file-based speech path. Legacy `discord call join` behavior remains available without `--bidi`.

```text
discord call join -a paramount CHANNEL --bidi
discord call join -a paramount CHANNEL --bidi --exo-conversation CONV_ID
discord call join -a paramount CHANNEL --bidi --voice sol
```

When no conversation is supplied, the worker creates `Discord call · <channel>`. Persisted call messages include call ID, adapter type/ID, Discord account alias, channel ID, and source label metadata.
