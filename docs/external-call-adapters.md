# External call media adapters

Exocortex owns realtime intelligence, conversation context, transcripts, delegation, and call-session lifecycle. Platform tools own only their platform session and media transport.

Each call is identified by `callId` and a media-adapter identity. The native TUI uses `tui:local`; external adapters use stable IDs such as `discord:paramount:<channel-id>` or `whatsapp:personal:<call-id>`. Commands, SDP answers, transcript events, cancellation, and shutdown remain call-ID scoped, so independent TUI and external calls can run concurrently.

External adapters identify themselves without adding platform-specific fields to the core protocol:

```json
{
  "type": "external",
  "id": "discord:paramount:1482111776505204953",
  "toolName": "discord",
  "accountAlias": "paramount",
  "endpointId": "1482111776505204953",
  "label": "#yeyito-chill"
}
```

A platform call worker:

1. joins or answers the platform call;
2. selects `EXOCORTEX_PARENT_CONV_ID`, an explicit override, or a newly-created conversation;
3. starts an Exocortex call with its external adapter identity;
4. submits a WebRTC offer through `attach_call_media`;
5. maps platform input audio into the WebRTC input track and WebRTC output back into the platform; and
6. stops only its own Exocortex call when the worker leaves.

Exocortex tool processes receive both the invoking conversation and current daemon endpoint:

```text
EXOCORTEX_PARENT_CONV_ID=<conversation-id>
EXOCORTEX_SOCKET=<daemon socket or named pipe>
```

An explicit conversation override wins. Without one, the invoking conversation is used. A manually-launched adapter with no invoking conversation may create a dedicated top-level call conversation.

Discord uses this contract directly:

```text
discord call join -a paramount CHANNEL
discord call start -a paramount DM
discord call join -a paramount CHANNEL --conversation CONV_ID
discord call join -a paramount CHANNEL --voice sol
```

There is no public Bidi mode switch: the realtime backend is an Exocortex implementation detail. Discord CLI contains no separate ASR, speech segmentation, transcript notification, saved-segment, or one-shot speech path. It retains Discord gateway/voice state, RTP, Opus, DAVE, participant mapping, mute/deafen, and media adaptation.

Future platform tools, including WhatsApp when its call media is available, implement the same control and WebRTC boundary without changing Exocortex call orchestration. Persisted call messages retain call ID, adapter identity, tool, account, endpoint, and source-label metadata.
