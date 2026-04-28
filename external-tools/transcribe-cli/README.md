# transcribe-cli

Exocortex external tool for OpenAI-backed audio transcription.

## Usage

```bash
transcribe audio.wav
transcribe audio.wav --mime-type audio/wav
```

The tool expects Exocortex daemon-provided OpenAI auth via `--exocortex-auth-openai` and is normally invoked from inside Exocortex.
