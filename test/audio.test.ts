import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("voice sample downloads", () => {
  it("serves both manifest entries as real WAV with matching size and checksum", async () => {
    const manifest = await SELF.fetch("https://codexdata.test/v1/audio/samples/index.json");
    expect(manifest.status).toBe(200);
    const body = (await manifest.json()) as {
      samples: {
        language: string;
        url: string;
        sha256: string;
        bytes: number;
        transcript: string;
      }[];
    };
    expect(body.samples.map((s) => s.language)).toEqual(["en", "zh"]);
    for (const sample of body.samples) {
      const response = await SELF.fetch(sample.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("audio/wav");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const audio = await response.arrayBuffer();
      expect(audio.byteLength).toBe(sample.bytes);
      expect(new TextDecoder().decode(audio.slice(0, 4))).toBe("RIFF");
      expect(new TextDecoder().decode(audio.slice(8, 12))).toBe("WAVE");
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", audio));
      expect(Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")).toBe(sample.sha256);
      expect(sample.transcript.length).toBeGreaterThan(10);
    }
  });
});
