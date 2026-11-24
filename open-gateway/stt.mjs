// Speech to text for the open gateway: 16 kHz mono s16le PCM → an OpenAI-compatible /audio/transcriptions
// endpoint (OpenAI, Groq, a local whisper.cpp server, …).

/** Wrap raw PCM in a WAV header. */
export function wav(pcm, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export async function transcribe(pcm, { url, key, model, fetchImpl = fetch }) {
  if (!key) throw new Error('no STT_KEY (or OPENAI_API_KEY) set');
  const form = new FormData();
  form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'take.wav');
  form.append('model', model);
  const r = await fetchImpl(`${url.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return String(j.text ?? '').trim();
}
