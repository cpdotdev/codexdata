#!/usr/bin/env python3
"""Regenerate original speech samples with eSpeak NG 1.52.0 and FFmpeg.

This is an authoring tool, not a build dependency. Commit the WAV sources and
metadata, then run pnpm build:static. Published v1 files must remain immutable;
use a new version when changing text, voice or synthesis tools.
"""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import wave

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = [
    ("en", "en-us", "You do not have to finish everything today. Take one small step, keep learning, and give yourself credit for making progress."),
    ("zh", "cmn", "不用一次完成所有事情。今天先做好眼前的一小步，你就在前进。"),
]
entries = []
for language, voice, text in SAMPLES:
    speech = subprocess.run(
        ["espeak-ng", "-v", voice, "-s", "145", "--stdout", text],
        check=True, capture_output=True,
    ).stdout
    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"],
        input=speech, check=True, capture_output=True,
    ).stdout
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(pcm)
    audio = buffer.getvalue()
    filename = f"{language}-v1.wav"
    destination = ROOT / "data" / "audio-samples" / filename
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(audio)
    entries.append({
        "language": language, "file": filename, "transcript": text,
        "sha256": hashlib.sha256(audio).hexdigest(), "bytes": len(audio),
        "duration_seconds": len(pcm) / 32000,
        "sample_rate": 16000, "channels": 1, "bits_per_sample": 16,
    })
(ROOT / "data/audio-samples/manifest.json").write_text(
    json.dumps({"schema_version": 1, "license": "CC-BY-4.0", "generator": "eSpeak NG 1.52.0", "samples": entries}, ensure_ascii=False, indent=2) + "\n"
)
