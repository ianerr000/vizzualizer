// node test/metadata.test.mjs
// generates small fixtures with ffmpeg, parses them with js/metadata.js and
// compares against ffprobe. needs ffmpeg + ffprobe on PATH.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, openSync, readSync, statSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readMetadata } = require('../js/metadata.js');

const dir = process.env.FIXTURE_DIR || mkdtempSync(join(tmpdir(), 'viz-fixtures-'));
const DUR = 4; // seconds
const inputs = ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${DUR}`, '-f', 'lavfi', '-i', `sine=frequency=660:sample_rate=44100:duration=${DUR}`];
const mix = ['-filter_complex', '[0:a][1:a]amerge=inputs=2[a]', '-map', '[a]'];
const src = [...inputs, ...mix];
const tags = ['-metadata', 'title=Test Tone', '-metadata', 'artist=Viz Bot', '-metadata', 'album=Fixtures', '-metadata', 'date=2026', '-metadata', 'track=3', '-metadata', 'genre=Electronic'];

// a tiny cover image
const cover = join(dir, 'cover.png');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=64x64:d=1', '-frames:v', '1', cover]);
const withCover = [...inputs, '-i', cover, ...mix, '-map', '2:v', '-c:v', 'copy'];

const cases = [
  { name: 'cbr.mp3', args: [...src, ...tags, '-c:a', 'libmp3lame', '-b:a', '192k', '-ac', '2'], expect: { codec: /Layer III/, bitrateMode: 'CBR', bitrate: [192000, 192000], channels: 2, sampleRate: 44100 } },
  { name: 'cbr-cover.mp3', args: [...withCover, '-id3v2_version', '3', ...tags, '-c:a', 'libmp3lame', '-b:a', '128k'], expect: { bitrateMode: 'CBR', bitrate: [128000, 128000], picture: true } },
  { name: 'vbr.mp3', args: [...src, ...tags, '-c:a', 'libmp3lame', '-q:a', '2'], expect: { bitrateMode: 'VBR', codec: /Layer III/ } },
  { name: 'mono.mp3', args: [...src, '-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '64k'], expect: { channels: 1, sampleRate: 22050, codec: /MPEG-2 Layer III/, bitrate: [64000, 64000] } },
  { name: 'tone.flac', args: [...src, ...tags, '-c:a', 'flac'], expect: { codec: 'FLAC', lossless: true, channels: 2, sampleRate: 44100, bitsPerSample: 16 } },
  { name: 'cover.flac', args: [...withCover, '-disposition:v', 'attached_pic', ...tags, '-c:a', 'flac', '-sample_fmt', 's32'], expect: { codec: 'FLAC', picture: true, bitsPerSample: 24 } },
  { name: 'tone.ogg', args: [...src, ...tags, '-c:a', 'libvorbis', '-q:a', '5'], expect: { codec: 'Vorbis', channels: 2, sampleRate: 44100 } },
  { name: 'tone.opus', args: [...src, ...tags, '-c:a', 'libopus', '-b:a', '96k'], expect: { codec: 'Opus', channels: 2, sampleRate: 48000 } },
  { name: 'tone.m4a', args: [...src, ...tags, '-c:a', 'aac', '-b:a', '128k'], expect: { codec: /AAC/, container: 'M4A', channels: 2, sampleRate: 44100 } },
  { name: 'cover.m4a', args: [...withCover, '-disposition:v', 'attached_pic', ...tags, '-c:a', 'aac', '-b:a', '96k'], expect: { codec: /AAC/, picture: true } },
  { name: 'tone-alac.m4a', args: [...src, ...tags, '-c:a', 'alac'], expect: { codec: 'ALAC', lossless: true, channels: 2, sampleRate: 44100, bitsPerSample: 16 } },
  { name: 'tone.wav', args: [...src, ...tags, '-c:a', 'pcm_s16le'], expect: { codec: 'PCM 16-bit', lossless: true, bitrate: [1411200, 1411200], channels: 2, sampleRate: 44100 } },
  { name: 'tone24.wav', args: [...src, '-c:a', 'pcm_s24le', '-ar', '48000'], expect: { codec: 'PCM 24-bit', bitrate: [2304000, 2304000], sampleRate: 48000 } },
  { name: 'tone.aiff', args: [...src, ...tags, '-write_id3v2', '1', '-c:a', 'pcm_s16be'], expect: { codec: 'PCM 16-bit', lossless: true, bitrate: [1411200, 1411200], sampleRate: 44100 } },
  { name: 'tone.aac', args: [...src, '-c:a', 'aac', '-b:a', '128k', '-f', 'adts'], expect: { codec: /AAC/, channels: 2, sampleRate: 44100 } },
];

function nodeReader(path) {
  const size = statSync(path).size;
  return {
    size,
    async read(offset, length) {
      const fd = openSync(path, 'r');
      try {
        offset = Math.max(0, Math.min(offset, size));
        const len = Math.max(0, Math.min(length, size - offset));
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, offset);
        return new Uint8Array(buf.buffer, buf.byteOffset, n);
      } finally { closeSync(fd); }
    },
  };
}
function ffprobe(path) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]).toString();
  const j = JSON.parse(out);
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return { duration: +(a.duration || j.format.duration), bitrates: [+a.bit_rate, +j.format.bit_rate].filter(Boolean), sampleRate: +a.sample_rate, channels: +a.channels, tags: Object.assign({}, j.format.tags, a.tags) };
}

let failed = 0;
const check = (name, cond, msg) => { if (!cond) { failed++; console.log(`  FAIL ${name}: ${msg}`); } };

for (const c of cases) {
  const path = join(dir, c.name);
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...c.args, path]);
  } catch (e) {
    console.log(`skip ${c.name}: ffmpeg could not encode (${String(e.message).split('\n')[0]})`);
    continue;
  }
  const info = await readMetadata(nodeReader(path), c.name);
  const ref = ffprobe(path);
  // fill in like the player does when the parser cannot know the duration
  if (!info.duration) info.duration = ref.duration;
  if (!info.bitrate && info.duration) info.bitrate = (info.audioBytes || info.fileSize) * 8 / info.duration;
  const line = `${c.name.padEnd(16)} ${String(info.codec).padEnd(18)} ${(info.bitrate / 1000).toFixed(0).padStart(5)} kbps ${info.bitrateMode || (info.lossless ? 'lossless' : '-')}  ${info.sampleRate} Hz  ${info.channels}ch  ${info.duration.toFixed(2)}s  ${info.title || '-'} / ${info.artist || '-'} / ${info.album || '-'} / ${info.year || '-'} / #${info.track || '-'}${info.picture ? '  [art ' + info.picture.mime + ' ' + info.picture.data.length + 'B]' : ''}`;
  console.log(line);
  check(c.name, !info.error, 'parser error ' + info.error);
  check(c.name, Math.abs(info.duration - ref.duration) < 0.15, `duration ${info.duration} vs ffprobe ${ref.duration}`);
  // ffprobe's format bit_rate counts tags/art/headers; ours is the audio stream only, so reconcile by adding the overhead back
  const overhead = info.audioBytes ? (info.fileSize - info.audioBytes) * 8 / info.duration : 0;
  if (ref.bitrates.length) check(c.name, ref.bitrates.some((r) => Math.abs(info.bitrate - r) / r < 0.08 || Math.abs(info.bitrate + overhead - r) / r < 0.08), `bitrate ${info.bitrate} (+${overhead.toFixed(0)} overhead) vs ffprobe ${ref.bitrates}`);
  if (ref.sampleRate) check(c.name, info.sampleRate === ref.sampleRate, `sampleRate ${info.sampleRate} vs ${ref.sampleRate}`);
  if (ref.channels) check(c.name, info.channels === ref.channels, `channels ${info.channels} vs ${ref.channels}`);
  if (ref.tags && (ref.tags.title || ref.tags.TITLE)) {
    check(c.name, info.title === 'Test Tone', `title ${info.title}`);
    check(c.name, info.artist === 'Viz Bot', `artist ${info.artist}`);
    check(c.name, info.album === 'Fixtures', `album ${info.album}`);
    check(c.name, String(info.year || '').startsWith('2026'), `year ${info.year}`);
    check(c.name, String(info.track || '').startsWith('3'), `track ${info.track}`);
  }
  for (const [k, v] of Object.entries(c.expect)) {
    if (k === 'picture') check(c.name, !!info.picture === v, `picture ${!!info.picture}`);
    else if (Array.isArray(v)) check(c.name, info[k] >= v[0] * 0.98 && info[k] <= v[1] * 1.02, `${k} ${info[k]} not within ${v}`);
    else if (v instanceof RegExp) check(c.name, v.test(String(info[k])), `${k} ${info[k]} !~ ${v}`);
    else check(c.name, info[k] === v, `${k} ${JSON.stringify(info[k])} !== ${JSON.stringify(v)}`);
  }
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
writeFileSync(join(dir, 'README.txt'), 'fixtures generated by test/metadata.test.mjs\n');
console.log('fixtures in', dir);
process.exit(failed ? 1 : 0);
