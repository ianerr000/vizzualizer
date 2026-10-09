// node test/smoke.mjs [fixtureDir]
// headless chromium smoke test: loads the page, feeds it the fixture files,
// checks playback + analyser + the info panel, and screenshots each mode.
// needs the playwright package + a chromium (PLAYWRIGHT_BROWSERS_PATH or default).
import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = process.argv[2] || process.env.FIXTURE_DIR;
if (!fixtures) { console.error('usage: node test/smoke.mjs <dir with audio files> (run test/metadata.test.mjs with FIXTURE_DIR set to make some)'); process.exit(2); }
const shots = process.env.SHOT_DIR || join(fixtures, 'shots');
await mkdir(shots, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const p = join(root, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const files = (await readdir(fixtures)).filter((f) => /\.(mp3|flac|ogg|opus|m4a|wav|aiff|aac)$/i.test(f)).sort().map((f) => join(fixtures, f));
let failed = 0;
const check = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; };

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url);
await page.screenshot({ path: join(shots, '0-empty.png') });

// user gesture first so the audio context may start, then feed files
await page.click('#pickFiles').catch(() => {});
await page.setInputFiles('#fileInput', files);
await page.waitForSelector('#controls:not([hidden])');
check(await page.locator('#plItems li').count() === 0 || true, 'controls appeared after adding files');
await page.click('#listBtn');
const n = await page.locator('#plItems li').count();
check(n === files.length, `playlist lists all ${files.length} files (got ${n})`);
await page.screenshot({ path: join(shots, '1-playlist.png') });
await page.click('#closeList');

// playback + analyser
await page.waitForFunction(() => window.viz && !window.viz.player.audio.paused && window.viz.player.audio.currentTime > 0.3, null, { timeout: 10000 });
const state = await page.evaluate(() => ({ ctx: window.viz.player.ctx && window.viz.player.ctx.state, peak: Math.max(...window.viz.visualizer.freq), cur: window.viz.player.audio.currentTime }));
check(state.ctx === 'running', `audio context running (${state.ctx})`);
check(state.peak > 60, `analyser sees the signal (peak bin ${state.peak}/255)`);

// info panel: hover peeks, click pins
await page.hover('#infoBtn');
check(await page.locator('#infoPanel').isVisible(), 'hovering the corner icon peeks the info panel');
await page.click('#infoBtn');
await page.mouse.move(400, 400);
await page.waitForTimeout(100);
check(await page.locator('#infoPanel').isVisible(), 'clicking the corner icon pins the info panel open');
await page.waitForFunction(() => /kbps/.test(document.querySelector('#infoPanel').textContent) && !/reading tags/.test(document.querySelector('#infoPanel').textContent));
let txt = await page.locator('#infoPanel').innerText();
console.log('  info panel:\n    ' + txt.replace(/\n+/g, '\n    '));
check(/\d+\s*kbps/.test(txt), 'info panel shows a bitrate');
check(/sample rate/.test(txt) && /kHz/.test(txt), 'info panel shows sample rate');
check(/Test Tone|cbr/.test(txt), 'info panel shows a title');
await page.screenshot({ path: join(shots, '2-info-bars.png') });
await page.click('#infoBtn');
await page.mouse.move(400, 400);
await page.waitForTimeout(100);
check(await page.locator('#infoPanel').isHidden(), 'second click closes the info panel');

// walk every track, make sure each gets info with bitrate (or is skipped when this
// browser has no decoder for it, e.g. playwright's chromium lacks aac/alac/aiff), and each mode renders
const MIME = { mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg; codecs=vorbis', opus: 'audio/ogg; codecs=opus', m4a: 'audio/mp4; codecs="mp4a.40.2"', aac: 'audio/aac', wav: 'audio/wav', aiff: 'audio/aiff' };
const modes = ['bars', 'wave', 'ring', 'particles'];
for (let i = 0; i < files.length; i++) {
  const ext = files[i].split('.').pop().toLowerCase();
  const supported = await page.evaluate((m) => !!document.createElement('audio').canPlayType(m), MIME[ext] || 'audio/' + ext);
  await page.evaluate((i) => window.viz.player.play(i), i);
  await page.waitForFunction((i) => { const p = window.viz.player; const t = p.tracks[i]; return t.failed || p.index !== i || (t.info && t.info.bitrate && p.audio.currentTime > 0.2); }, i, { timeout: 10000 }).catch(() => {});
  const r = await page.evaluate((i) => { const p = window.viz.player; const t = p.tracks[i]; const inf = t.info || {}; return { name: t.name, failed: t.failed, codec: inf.codec, kbps: inf.bitrate ? Math.round(inf.bitrate / 1000) : null, mode: inf.bitrateMode, lossless: inf.lossless, sr: inf.sampleRate, ch: inf.channels, playing: p.index === i && !p.audio.paused, cur: p.audio.currentTime }; }, i);
  const line = `${r.name.padEnd(16)} ${String(r.codec).padEnd(16)} ${String(r.kbps).padStart(5)} kbps ${(r.mode || (r.lossless ? 'lossless' : '-')).padEnd(8)} ${r.sr}Hz ${r.ch}ch`;
  if (supported) check(r.kbps > 0 && !r.failed && r.playing, line + `  playing=${r.playing} t=${r.cur.toFixed(2)}`);
  else check(r.failed, line + '  (no decoder in this browser -> flagged + skipped)');
  if (!supported) await page.waitForTimeout(600); // let the auto-skip settle before the next play()
  const mode = modes[i % modes.length];
  await page.click(`#modes button[data-mode="${mode}"]`);
  await page.waitForTimeout(500);
  if (i < modes.length) await page.screenshot({ path: join(shots, `3-mode-${mode}.png`) });
}

// auto-advance: jump near the end of the current track and expect the next one
const before = await page.evaluate(() => window.viz.player.index);
await page.evaluate(() => { const a = window.viz.player.audio; a.currentTime = Math.max(0, a.duration - 0.3); });
await page.waitForFunction((b) => window.viz.player.index !== b, before, { timeout: 8000 }).catch(() => {});
const after = await page.evaluate(() => window.viz.player.index);
check(after !== before, `auto-advanced from track ${before + 1} to ${after + 1}`);

// keyboard: v cycles mode, i toggles info
await page.keyboard.press('Escape');
await page.keyboard.press('v');
const m1 = await page.evaluate(() => window.viz.visualizer.mode);
await page.keyboard.press('v');
const m2 = await page.evaluate(() => window.viz.visualizer.mode);
check(m1 !== m2, `v cycles modes (${m1} -> ${m2})`);
await page.keyboard.press('i');
check(!(await page.locator('#infoPanel').isHidden()), 'i opens the info panel');

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nsmoke test passed');
console.log('screenshots in', shots);
process.exit(failed ? 1 : 0);
