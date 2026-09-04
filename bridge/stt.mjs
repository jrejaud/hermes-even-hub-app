/**
 * Speech to text for the glasses mic.
 *
 * The Even Hub SDK hands the app raw PCM and nothing else — there is no
 * transcription API on the phone or the glasses — so the bridge owns this.
 * Audio arrives as binary WebSocket frames between `audio.start` and
 * `audio.stop`: PCM, 16 kHz, signed 16-bit little-endian, mono, 100 ms per
 * frame (3,200 bytes).
 *
 * Two engines, chosen by STT_ENGINE:
 *
 *   whispercpp  spawn whisper.cpp's `whisper-cli` on a temp WAV. No network, no
 *               API key. This is the Overlord path (whisper-cpp 1.8.4 +
 *               ggml-large-v3-turbo already installed).
 *   openai      POST multipart to any OpenAI-compatible
 *               /v1/audio/transcriptions. Covers Groq, OpenAI, and whisper.cpp's
 *               own `whisper-server`, which speaks the same shape — that is the
 *               path for a host with no local binary.
 *   none        refuse politely instead of failing silently, so a missing STT
 *               config shows up on the lens as a sentence rather than a hang.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SAMPLE_RATE = 16_000;

/** Shortest clip worth sending. Below this it is a mis-tap, not speech. */
const MIN_SAMPLES = SAMPLE_RATE * 0.3;

export function createTranscriber(env = process.env, { log = () => {} } = {}) {
  const engine = env.STT_ENGINE ?? (env.WHISPER_MODEL ? "whispercpp" : "none");
  if (engine === "whispercpp") {
    return whisperCppTranscriber(
      {
        bin: env.WHISPER_BIN ?? "whisper-cli",
        model: env.WHISPER_MODEL,
        threads: env.WHISPER_THREADS ?? "4",
        language: env.WHISPER_LANGUAGE ?? "en",
      },
      log,
    );
  }
  if (engine === "openai") {
    return openAiTranscriber(
      {
        url: env.STT_URL ?? "https://api.groq.com/openai/v1/audio/transcriptions",
        key: env.STT_API_KEY ?? "",
        model: env.STT_MODEL ?? "whisper-large-v3-turbo",
      },
      log,
    );
  }
  return {
    engine: "none",
    async transcribe() {
      return "";
    },
    unavailableReason: "no speech-to-text configured on the bridge",
  };
}

function whisperCppTranscriber(cfg, log) {
  if (!cfg.model) throw new Error("STT_ENGINE=whispercpp needs WHISPER_MODEL (a ggml-*.bin path)");
  return {
    engine: "whispercpp",
    async transcribe(pcm) {
      if (pcm.length < MIN_SAMPLES * 2) return "";
      const dir = await mkdtemp(join(tmpdir(), "g2-stt-"));
      const wav = join(dir, "clip.wav");
      try {
        await writeFile(wav, wavFromPcm16(pcm));
        const out = await run(cfg.bin, [
          "-m", cfg.model,
          "-f", wav,
          "-l", cfg.language,
          "-t", String(cfg.threads),
          "-nt",  // no timestamps
          "-np",  // results only, nothing else on stdout
        ]);
        return cleanTranscript(out);
      } catch (err) {
        log(`[stt] whisper-cli failed: ${err.message}`);
        return "";
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

function openAiTranscriber(cfg, log) {
  return {
    engine: "openai",
    async transcribe(pcm) {
      if (pcm.length < MIN_SAMPLES * 2) return "";
      try {
        const form = new FormData();
        form.append("file", new Blob([wavFromPcm16(pcm)], { type: "audio/wav" }), "clip.wav");
        form.append("model", cfg.model);
        form.append("response_format", "text");
        const res = await fetch(cfg.url, {
          method: "POST",
          headers: cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {},
          body: form,
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 160)}`);
        return cleanTranscript(text.trim().startsWith("{") ? (JSON.parse(text).text ?? "") : text);
      } catch (err) {
        log(`[stt] transcription request failed: ${err.message}`);
        return "";
      }
    },
  };
}

/**
 * Whisper emits bracketed non-speech markers on silence — "[BLANK_AUDIO]",
 * "(wind blowing)". Sending one of those to Claude as a prompt is worse than
 * sending nothing, so strip them and let an empty result mean "say again".
 */
export function cleanTranscript(raw) {
  return String(raw)
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\((?:[^)]*(?:music|silence|blank|noise|inaudible|laughter|blowing)[^)]*)\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Minimal 44-byte RIFF header around raw PCM16 mono. */
export function wavFromPcm16(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16-bit)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(-400) || `exit ${code}`))));
  });
}
