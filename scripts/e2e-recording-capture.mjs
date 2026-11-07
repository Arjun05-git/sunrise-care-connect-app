/**
 * Real-browser check of the recording capture (src/features/consult/recording): in Chrome with a fake microphone it mixes two
 * audio tracks, records opus/webm in slices, uploads the slices through ChunkUploader, and proves that joining the parts in order
 * gives ONE valid recording (webm header, decodes, about the right length, not silent) - the assumption playback relies on.
 *   CHROMIUM_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npm run e2e:recording-capture
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'src/features/consult/recording').replace(/\\/g, '/');
const bundle = await build({
  stdin: {
    contents: `import { AudioCapture } from '${dir}/capture.ts'; import { ChunkUploader } from '${dir}/uploader.ts'; window.__rec = { AudioCapture, ChunkUploader };`,
    resolveDir: root, loader: 'ts',
  },
  bundle: true, format: 'iife', write: false, target: 'es2020',
});

// getUserMedia needs a secure context: localhost is one
const server = http.createServer((_, res) => res.end('<!doctype html><title>capture</title>')).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
let failed = 0;
const check = (ok, name, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failed++; };

try {
  const page = await browser.newPage();
  await page.goto(url);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const r = await page.evaluate(async () => {
    const { AudioCapture, ChunkUploader } = window.__rec;
    const supported = AudioCapture.supported();
    // two microphones: the doctor's, and a stand-in for the patient's remote audio
    const a = await navigator.mediaDevices.getUserMedia({ audio: true });
    const b = await navigator.mediaDevices.getUserMedia({ audio: true });
    const tracks = [...a.getAudioTracks(), ...b.getAudioTracks()];
    const uploaded = [];
    const up = new ChunkUploader('recordings/appt/rec/', async (p, blob) => { uploaded.push({ p, blob }); }, { sleep: async () => undefined });
    const cap = new AudioCapture(() => tracks, (c) => up.push(c), { timesliceMs: 1000 });
    cap.start();
    await new Promise((res) => setTimeout(res, 4500));
    await cap.stop();
    const res = await up.drain();
    const whole = new Blob(uploaded.map((u) => u.blob), { type: 'audio/webm' });
    const buf = await whole.arrayBuffer();
    const head = (u) => Array.from(new Uint8Array(u)).slice(0, 4);
    const firstHeads = await Promise.all(uploaded.map(async (u) => head(await u.blob.arrayBuffer())));
    const ctx = new AudioContext();
    const audio = await ctx.decodeAudioData(buf.slice(0));
    const data = audio.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i += 16) peak = Math.max(peak, Math.abs(data[i]));
    const sizes = uploaded.map((u) => u.blob.size);
    return { sizes, ctxState: ctx.state, supported, names: uploaded.map((u) => u.p.slice(-16)), parts: res.parts, failed: res.failed, bytes: res.bytes, firstHeads, duration: audio.duration, peak, mime: cap.mimeType };
  });
  const EBML = [0x1a, 0x45, 0xdf, 0xa3];
  console.log('diagnostics:', JSON.stringify({ sizes: r.sizes, heads: r.firstHeads, duration: r.duration, ctx: r.ctxState }));
  check(r.supported, 'Chrome supports the capture (MediaRecorder + audio/webm;codecs=opus)');
  check(r.parts >= 3 && !r.failed, 'the recording was cut into slices and every slice uploaded', `${r.parts} parts, ${r.bytes} bytes`);
  check(r.names[0] === 'part-000001.webm' && r.names.every((n, i) => n === `part-${String(i + 1).padStart(6, '0')}.webm`), 'parts are named in order', r.names.join(', '));
  check(JSON.stringify(r.firstHeads[0]) === JSON.stringify(EBML), 'the first part carries the webm header');
  check(r.firstHeads.slice(1).every((h) => JSON.stringify(h) !== JSON.stringify(EBML)), 'later parts are continuations (so they must be joined in order, not played alone)');
  check(r.duration > 3.5 && r.duration < 5.6, 'the joined parts decode as ONE recording of the right length', `${r.duration.toFixed(2)} s for ~4.5 s`);
  check(r.peak > 0.01, 'and it is not silent (the mixed microphones were captured)', `peak ${r.peak.toFixed(3)}`);
  check(r.mime === 'audio/webm', 'the upload type is the plain container type');
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
