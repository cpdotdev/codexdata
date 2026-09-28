# Voice API samples

Original motivational speech for testing the Codex Pass local transcription API.
The WAV sources and transcripts are CC-BY-4.0, attributed to the Codex Pass team.
Speech was synthesized with eSpeak NG 1.52.0; these are synthetic voices.

- `/v1/audio/samples/index.json` contains language, transcript, URL, SHA-256,
  byte length, duration, sample rate, channels and bit depth.
- `/v1/audio/samples/en-v1.wav` and `/v1/audio/samples/zh-v1.wav` are immutable
  PCM WAV files (16 kHz, mono, 16 bit). Never overwrite a published version.
- `data/audio-samples/` holds sources. `pnpm build:static` verifies checksums and
  copies them into `public/v1/audio/samples/`; `pnpm check` rejects drift.
- `python3 scripts/generate-audio-samples.py` is the authoring recipe (requires
  eSpeak NG and FFmpeg). Do not run it to refresh published v1 assets; create
  a new version for any text or synthesis changes.

Deploy and verify these public URLs before releasing the App download button.
The App downloads without credentials, saves to the user's chosen location, and
only then shows a curl command using the local path. Local API tokens are never
sent to CodexData. Daily audio generation is a separate follow-up.
