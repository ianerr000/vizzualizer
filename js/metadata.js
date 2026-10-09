/* metadata.js - pulls tags + real bitrate out of audio files with zero deps.
   runs in the browser (File/Blob) and in node (custom {size, read} reader).
   supported: mp3 (id3v1/v2, xing/info/vbri), flac, ogg vorbis/opus/flac,
   mp4/m4a (aac, alac, ...), wav/rf64, aiff, adts aac. anything else falls
   back to "size / duration" once the <audio> element knows the duration. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VizMetadata = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ---------- byte helpers ----------
  const be16 = (b, o) => (b[o] << 8) | b[o + 1];
  const be24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  const be32 = (b, o) => b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  const be64 = (b, o) => be32(b, o) * 4294967296 + be32(b, o + 4);
  const le16 = (b, o) => b[o] | (b[o + 1] << 8);
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216;
  const le64 = (b, o) => le32(b, o) + le32(b, o + 4) * 4294967296;
  const synchsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

  function ascii(b, s, e) {
    let out = '';
    for (let i = s; i < e && i < b.length; i++) out += String.fromCharCode(b[i]);
    return out;
  }
  const latin1 = (b) => ascii(b, 0, b.length);
  function utf8(b) {
    try { return new TextDecoder('utf-8').decode(b); } catch (e) { return latin1(b); }
  }
  function utf16(b, bigEndian) {
    let be = bigEndian, s = 0;
    if (b.length >= 2) {
      if (b[0] === 0xff && b[1] === 0xfe) { be = false; s = 2; }
      else if (b[0] === 0xfe && b[1] === 0xff) { be = true; s = 2; }
    }
    let out = '';
    for (let i = s; i + 1 < b.length; i += 2) {
      out += String.fromCharCode(be ? (b[i] << 8) | b[i + 1] : b[i] | (b[i + 1] << 8));
    }
    return out;
  }
  function clean(s) {
    if (!s) return null;
    s = s.replace(/\0+/g, ' ').replace(/\s+/g, ' ').trim();
    return s || null;
  }
  function cat(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  function b64(s) {
    if (typeof atob === 'function') {
      const bin = atob(s.replace(/\s+/g, ''));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }
  function sniffImage(d) {
    if (d[0] === 0xff && d[1] === 0xd8) return 'image/jpeg';
    if (d[0] === 0x89 && d[1] === 0x50) return 'image/png';
    if (ascii(d, 0, 4) === 'GIF8') return 'image/gif';
    if (ascii(d, 0, 4) === 'RIFF' && ascii(d, 8, 12) === 'WEBP') return 'image/webp';
    return null;
  }
  function bitReader(b, s, e) {
    let pos = s * 8;
    const end = e * 8;
    return {
      read(n) {
        let v = 0;
        for (let i = 0; i < n; i++) {
          const bit = pos < end ? (b[pos >> 3] >> (7 - (pos & 7))) & 1 : 0;
          v = v * 2 + bit;
          pos++;
        }
        return v;
      },
    };
  }

  // ---------- reader abstraction ----------
  function makeReader(src) {
    if (src && typeof src.read === 'function' && typeof src.size === 'number') return src;
    return {
      size: src.size,
      async read(offset, length) {
        offset = Math.max(0, Math.min(offset, src.size));
        const end = Math.min(src.size, offset + Math.max(0, length));
        const buf = await src.slice(offset, end).arrayBuffer();
        return new Uint8Array(buf);
      },
    };
  }

  function emptyInfo() {
    return {
      title: null, artist: null, album: null, year: null, track: null, genre: null,
      container: null, codec: null, lossless: false,
      bitrate: null,          // bits per second (average)
      bitrateMode: null,      // 'CBR' | 'VBR' | null
      nominalBitrate: null,   // vorbis target bitrate if any
      declaredBitrate: null,  // bitrate the container claims (mp4 esds), if any
      sampleRate: null, channels: null, bitsPerSample: null,
      duration: null,         // seconds
      picture: null,          // { mime, data: Uint8Array }
      audioBytes: null,       // payload bytes without tags/headers, when known
      fileName: null, fileSize: null, error: null,
    };
  }

  // ---------- id3 ----------
  const GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alt. Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta Rap', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock', 'Folk', 'Folk/Rock', 'National Folk', 'Swing', 'Fast-Fusion', 'Bebop', 'Latin', 'Revival', 'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening', 'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove', 'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle', 'Duet', 'Punk Rock', 'Drum Solo', 'A Cappella', 'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House', 'Hardcore', 'Terror', 'Indie', 'BritPop', 'Afro-Punk', 'Polsk Punk', 'Beat', 'Christian Gangsta Rap', 'Heavy Metal', 'Black Metal', 'Crossover', 'Contemporary Christian', 'Christian Rock', 'Merengue', 'Salsa', 'Thrash Metal', 'Anime', 'JPop', 'Synthpop'];
  function id3Genre(s) {
    const out = s.replace(/\((\d+)\)/g, (_, n) => GENRES[+n] || '').trim();
    if (/^\d+$/.test(out)) return GENRES[+out] || out;
    return out || s;
  }

  const ID3_MAP = {
    TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album',
    TYER: 'year', TYE: 'year', TDRC: 'year', TDRL: 'year', TORY: 'year',
    TRCK: 'track', TRK: 'track', TCON: 'genre', TCO: 'genre',
  };
  function id3Text(b, enc) {
    if (enc === 0) return latin1(b);
    if (enc === 1) return utf16(b, false);
    if (enc === 2) return utf16(b, true);
    return utf8(b);
  }
  const termWidth = (enc) => (enc === 1 || enc === 2 ? 2 : 1);
  function findTerm(b, start, enc) {
    const w = termWidth(enc);
    for (let i = start; i + w <= b.length; i += w) {
      if (b[i] === 0 && (w === 1 || b[i + 1] === 0)) return i;
    }
    return -1;
  }
  function deunsync(b) {
    const out = new Uint8Array(b.length);
    let o = 0;
    for (let i = 0; i < b.length; i++) {
      out[o++] = b[i];
      if (b[i] === 0xff && b[i + 1] === 0x00) i++;
    }
    return out.subarray(0, o);
  }
  function id3v2Size(b) {
    if (ascii(b, 0, 3) !== 'ID3' || b.length < 10) return 0;
    return 10 + synchsafe(b, 6) + (b[5] & 0x10 ? 10 : 0);
  }
  function parseID3v2(buf, info) {
    const total = id3v2Size(buf);
    if (!total) return 0;
    const major = buf[3], flags = buf[5], size = synchsafe(buf, 6);
    if (major < 2 || major > 4) return total;
    let body = buf.subarray(10, Math.min(buf.length, 10 + size));
    if (flags & 0x80 && major < 4) body = deunsync(body);
    let pos = 0;
    if (flags & 0x40 && major > 2) pos += major === 4 ? synchsafe(body, 0) : 4 + be32(body, 0);
    const hdrLen = major === 2 ? 6 : 10;
    while (pos + hdrLen <= body.length) {
      if (body[pos] === 0) break; // padding
      const id = ascii(body, pos, pos + (major === 2 ? 3 : 4));
      const fsize = major === 2 ? be24(body, pos + 3) : major === 3 ? be32(body, pos + 4) : synchsafe(body, pos + 4);
      const fflags = major === 2 ? 0 : be16(body, pos + 8);
      pos += hdrLen;
      if (fsize <= 0 || pos + fsize > body.length) break;
      let data = body.subarray(pos, pos + fsize);
      pos += fsize;
      if (major === 3) {
        if (fflags & 0xc0) continue; // compressed / encrypted
        if (fflags & 0x20) data = data.subarray(1); // grouping byte
      } else if (major === 4) {
        if (fflags & 0x0c) continue;
        if (fflags & 0x40) data = data.subarray(1);
        if (fflags & 0x01) data = data.subarray(4); // data length indicator
        if (fflags & 0x02) data = deunsync(data);
      }
      const key = ID3_MAP[id];
      if (key) {
        if (data.length < 2) continue;
        const txt = id3Text(data.subarray(1), data[0]).split('\0').map((s) => s.trim()).filter(Boolean).join(' / ');
        if (txt && info[key] == null) info[key] = key === 'genre' ? id3Genre(txt) : txt;
      } else if ((id === 'APIC' || id === 'PIC') && !info.picture) {
        info.picture = parseAPIC(data, major);
      }
    }
    return total;
  }
  function parseAPIC(d, major) {
    if (d.length < 8) return null;
    const enc = d[0];
    let p = 1, mime;
    if (major === 2) {
      mime = ascii(d, 1, 4).toLowerCase();
      mime = mime === 'jpg' ? 'image/jpeg' : 'image/' + mime;
      p = 4;
    } else {
      const z = d.indexOf(0, p);
      if (z < 0) return null;
      mime = latin1(d.subarray(p, z)).toLowerCase();
      p = z + 1;
    }
    p += 1; // picture type
    const t = findTerm(d, p, enc);
    if (t < 0) return null;
    p = t + termWidth(enc);
    if (p >= d.length) return null;
    const data = d.slice(p);
    if (!/^image\//.test(mime) || mime === 'image/jpg') mime = sniffImage(data) || 'image/jpeg';
    return { mime, data };
  }
  function parseID3v1(b, info) {
    if (b.length < 128 || ascii(b, 0, 3) !== 'TAG') return false;
    const f = (s, e) => clean(latin1(b.subarray(s, e)));
    if (info.title == null) info.title = f(3, 33);
    if (info.artist == null) info.artist = f(33, 63);
    if (info.album == null) info.album = f(63, 93);
    if (info.year == null) info.year = f(93, 97);
    if (info.track == null && b[125] === 0 && b[126] > 0) info.track = String(b[126]);
    if (info.genre == null && GENRES[b[127]]) info.genre = GENRES[b[127]];
    return true;
  }

  // ---------- mp3 ----------
  const BITRATES = {
    1: {
      1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
      2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
      3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    },
    2: {
      1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
      2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
      3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    },
  };
  const SRATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };
  function mpegHeader(b, o) {
    if (o + 4 > b.length) return null;
    if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
    const vBits = (b[o + 1] >> 3) & 3, lBits = (b[o + 1] >> 1) & 3;
    if (vBits === 1 || lBits === 0) return null;
    const version = vBits === 3 ? 1 : vBits === 2 ? 2 : 2.5;
    const layer = 4 - lBits;
    const brIdx = b[o + 2] >> 4, srIdx = (b[o + 2] >> 2) & 3;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
    const padding = (b[o + 2] >> 1) & 1;
    const mode = b[o + 3] >> 6;
    const bitrate = BITRATES[version === 1 ? 1 : 2][layer][brIdx] * 1000;
    const sampleRate = SRATES[version][srIdx];
    const spf = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
    const length = layer === 1
      ? (Math.floor(12 * bitrate / sampleRate) + padding) * 4
      : Math.floor(spf / 8 * bitrate / sampleRate) + padding;
    if (length < 4) return null;
    return { version, layer, bitrate, sampleRate, padding, channels: mode === 3 ? 1 : 2, spf, length };
  }
  async function parseMP3(reader, info, head) {
    info.container = 'MP3';
    let tagEnd = 0;
    // one or more id3v2 tags up front
    let guard = 0;
    while (guard++ < 4) {
      const probe = tagEnd + 10 <= head.length ? head.subarray(tagEnd) : await reader.read(tagEnd, 10);
      const tsz = id3v2Size(probe);
      if (!tsz) break;
      const tagBuf = tsz <= probe.length ? probe : await reader.read(tagEnd, Math.min(tsz, 64 * 1024 * 1024));
      parseID3v2(tagBuf, info);
      tagEnd += tsz;
    }
    const SCAN = 512 * 1024;
    const buf = tagEnd + SCAN <= head.length ? head.subarray(tagEnd) : await reader.read(tagEnd, SCAN);
    // first frame, confirmed by a plausible second frame right behind it
    let first = -1, h = null;
    for (let i = 0; i + 4 <= buf.length; i++) {
      const hh = mpegHeader(buf, i);
      if (!hh) continue;
      const next = i + hh.length;
      if (next + 4 <= buf.length) {
        const h2 = mpegHeader(buf, next);
        if (!h2 || h2.version !== hh.version || h2.layer !== hh.layer || h2.sampleRate !== hh.sampleRate) continue;
      }
      first = i; h = hh;
      break;
    }
    let tailTag = 0;
    if (reader.size >= 128) {
      const tail = await reader.read(reader.size - 128, 128);
      if (parseID3v1(tail, info)) tailTag = 128;
    }
    if (first < 0 || !h) return;
    info.codec = 'MPEG-' + h.version + ' Layer ' + ['', 'I', 'II', 'III'][h.layer];
    if (h.layer === 3) info.container = 'MP3';
    else if (h.layer === 2) info.container = 'MP2';
    info.sampleRate = h.sampleRate;
    info.channels = h.channels;
    let audioBytes = reader.size - (tagEnd + first) - tailTag;
    // xing / info / vbri
    const side = h.version === 1 ? (h.channels === 1 ? 17 : 32) : (h.channels === 1 ? 9 : 17);
    const xo = first + 4 + side;
    const tag = ascii(buf, xo, xo + 4);
    let frames = null, bytes = null, mode = null;
    if (tag === 'Xing' || tag === 'Info') {
      const fl = be32(buf, xo + 4);
      let p = xo + 8;
      if (fl & 1) { frames = be32(buf, p); p += 4; }
      if (fl & 2) { bytes = be32(buf, p); p += 4; }
      mode = tag === 'Info' ? 'CBR' : 'VBR';
      audioBytes -= h.length;
      info.audioStart = tagEnd + first + h.length;
    } else {
      const vo = first + 4 + 32;
      if (ascii(buf, vo, vo + 4) === 'VBRI') {
        bytes = be32(buf, vo + 10); frames = be32(buf, vo + 14); mode = 'VBR';
        audioBytes -= h.length;
      }
    }
    if (!mode) {
      let p = first, n = 0, varies = false;
      while (n < 64 && p + 4 <= buf.length) {
        const fh = mpegHeader(buf, p);
        if (!fh) break;
        if (fh.bitrate !== h.bitrate) { varies = true; break; }
        p += fh.length; n++;
      }
      mode = varies ? 'VBR' : 'CBR';
    }
    info.bitrateMode = mode;
    info.audioBytes = audioBytes;
    if (frames && h.sampleRate) info.duration = frames * h.spf / h.sampleRate;
    if (mode === 'CBR') {
      info.bitrate = h.bitrate;
      if (!info.duration) info.duration = audioBytes * 8 / h.bitrate;
    } else if (info.duration) {
      const nb = bytes && bytes > 0 && bytes <= reader.size ? bytes - h.length : audioBytes;
      info.bitrate = nb * 8 / info.duration;
    }
  }

  // ---------- adts aac ----------
  const AAC_SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const AAC_PROFILES = { 1: 'AAC Main', 2: 'AAC-LC', 3: 'AAC SSR', 4: 'AAC LTP', 5: 'HE-AAC', 23: 'AAC-LD', 29: 'HE-AACv2', 39: 'AAC-ELD', 42: 'xHE-AAC' };
  function parseADTS(head, info) {
    info.container = 'AAC (ADTS)';
    const profile = (head[2] >> 6) & 3, sfi = (head[2] >> 2) & 15;
    const chc = ((head[2] & 1) << 2) | (head[3] >> 6);
    info.codec = AAC_PROFILES[profile + 1] || 'AAC';
    info.sampleRate = AAC_SR[sfi] || null;
    info.channels = chc === 7 ? 8 : chc || null;
    info.audioBytes = info.fileSize;
  }

  // ---------- vorbis comments / flac ----------
  const VC_MAP = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', DATE: 'year', YEAR: 'year', TRACKNUMBER: 'track', GENRE: 'genre' };
  function parseVorbisComment(b, p, info) {
    if (p + 4 > b.length) return;
    const vl = le32(b, p);
    p += 4 + vl;
    if (p + 4 > b.length) return;
    const n = le32(b, p);
    p += 4;
    for (let i = 0; i < n && p + 4 <= b.length; i++) {
      const l = le32(b, p);
      p += 4;
      if (p + l > b.length) break;
      const s = utf8(b.subarray(p, p + l));
      p += l;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const k = s.slice(0, eq).toUpperCase(), v = s.slice(eq + 1).trim();
      const key = VC_MAP[k];
      if (key && v && info[key] == null) info[key] = v;
      else if (k === 'METADATA_BLOCK_PICTURE' && !info.picture) {
        try { info.picture = parseFlacPicture(b64(v)); } catch (e) { /* ignore */ }
      }
    }
  }
  function parseFlacPicture(b) {
    if (b.length < 32) return null;
    let p = 4;
    const ml = be32(b, p); p += 4;
    const mime = latin1(b.subarray(p, p + ml)); p += ml;
    const dl = be32(b, p); p += 4 + dl;
    p += 16;
    const n = be32(b, p); p += 4;
    if (p + n > b.length || n <= 0) return null;
    return { mime: /^image\//.test(mime) ? mime : sniffImage(b.subarray(p)) || 'image/jpeg', data: b.slice(p, p + n) };
  }
  function flacStreamInfo(b, info) {
    info.sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
    info.channels = ((b[12] >> 1) & 7) + 1;
    info.bitsPerSample = (((b[12] & 1) << 4) | (b[13] >> 4)) + 1;
    const total = (b[13] & 0x0f) * 4294967296 + be32(b, 14);
    if (total && info.sampleRate) info.duration = total / info.sampleRate;
  }
  async function parseFLAC(reader, info) {
    info.container = 'FLAC';
    info.codec = 'FLAC';
    info.lossless = true;
    let off = 4, last = false, guard = 0;
    while (!last && off + 4 <= reader.size && guard++ < 256) {
      const hd = await reader.read(off, 4);
      last = !!(hd[0] & 0x80);
      const type = hd[0] & 0x7f, len = be24(hd, 1);
      off += 4;
      if (type === 0 && len >= 34) flacStreamInfo(await reader.read(off, 34), info);
      else if (type === 4 && len < 16 * 1024 * 1024) parseVorbisComment(await reader.read(off, len), 0, info);
      else if (type === 6 && !info.picture && len < 64 * 1024 * 1024) info.picture = parseFlacPicture(await reader.read(off, len));
      else if (type === 127) break; // invalid
      off += len;
    }
    info.audioBytes = Math.max(0, reader.size - off);
    if (info.duration) info.bitrate = info.audioBytes * 8 / info.duration;
  }

  // ---------- ogg ----------
  async function parseOGG(reader, info) {
    info.container = 'Ogg';
    const buf = await reader.read(0, Math.min(reader.size, 1024 * 1024));
    const packets = [];
    const packetEnds = []; // file offset of the page end where packet i completed
    let cur = [], off = 0, serial = null;
    while (off + 27 <= buf.length && ascii(buf, off, off + 4) === 'OggS') {
      const ser = le32(buf, off + 14), nseg = buf[off + 26];
      if (off + 27 + nseg > buf.length) break;
      let body = off + 27 + nseg;
      if (serial === null) serial = ser;
      let truncated = false;
      for (let s = 0; s < nseg; s++) {
        const l = buf[off + 27 + s];
        if (body + l > buf.length) { truncated = true; break; }
        if (ser === serial) {
          cur.push(buf.subarray(body, body + l));
          if (l < 255) { packets.push(cat(cur)); cur = []; }
        }
        body += l;
      }
      if (truncated) break;
      while (packetEnds.length < packets.length) packetEnds.push(body);
      off = body;
      if (packets.length >= 3) break;
    }
    const id = packets[0];
    if (!id) return;
    let preskip = 0, nHeaders = 2;
    if (ascii(id, 0, 8) === 'OpusHead') {
      info.codec = 'Opus';
      info.channels = id[9];
      preskip = le16(id, 10);
      info.sampleRate = 48000;
      info.inputSampleRate = le32(id, 12) || null;
    } else if (ascii(id, 1, 7) === 'vorbis') {
      info.codec = 'Vorbis';
      info.channels = id[11];
      info.sampleRate = le32(id, 12);
      const max = le32(id, 16) | 0, nom = le32(id, 20) | 0, min = le32(id, 24) | 0;
      if (nom > 0) info.nominalBitrate = nom;
      info.bitrateMode = max > 0 && max === min && min === nom ? 'CBR' : 'VBR';
      nHeaders = 3;
    } else if (ascii(id, 1, 5) === 'FLAC') {
      info.codec = 'FLAC'; info.lossless = true;
      if (id.length >= 51) flacStreamInfo(id.subarray(17), info);
      nHeaders = 1 + be16(id, 7);
    } else if (ascii(id, 0, 8) === 'Speex   ') {
      info.codec = 'Speex';
      info.sampleRate = le32(id, 36); info.channels = le32(id, 48);
    } else {
      info.codec = clean(ascii(id, 0, 8).replace(/[^\x20-\x7e]/g, '')) || 'unknown';
    }
    const cm = packets[1];
    if (cm) {
      if (ascii(cm, 0, 8) === 'OpusTags') parseVorbisComment(cm, 8, info);
      else if (ascii(cm, 1, 7) === 'vorbis') parseVorbisComment(cm, 7, info);
      else if (info.codec === 'FLAC' && (cm[0] & 0x7f) === 4) parseVorbisComment(cm, 4, info);
    }
    // duration: granule position of the last page of our stream
    const TAIL = Math.min(reader.size, 256 * 1024);
    const tail = await reader.read(reader.size - TAIL, TAIL);
    let gp = null;
    for (let i = tail.length - 27; i >= 0; i--) {
      if (tail[i] === 0x4f && tail[i + 1] === 0x67 && tail[i + 2] === 0x67 && tail[i + 3] === 0x53 && tail[i + 4] === 0 && le32(tail, i + 14) === serial) {
        gp = le64(tail, i + 6);
        break;
      }
    }
    if (gp != null && gp >= 0 && info.sampleRate) {
      const samples = info.codec === 'Opus' ? gp - preskip : gp;
      if (samples > 0) info.duration = samples / info.sampleRate;
    }
    const headerEnd = packetEnds[Math.min(nHeaders, packets.length) - 1] || packetEnds[packetEnds.length - 1] || 0;
    info.audioBytes = Math.max(0, reader.size - headerEnd);
    if (info.duration) info.bitrate = info.audioBytes * 8 / info.duration;
  }

  // ---------- mp4 / m4a ----------
  function boxes(b, s, e, cb) {
    let p = s;
    while (p + 8 <= e) {
      let sz = be32(b, p), hl = 8;
      const t = ascii(b, p + 4, p + 8);
      if (sz === 1) { sz = be64(b, p + 8); hl = 16; }
      else if (sz === 0) sz = e - p;
      if (sz < hl || p + sz > e) break;
      cb(t, p + hl, p + sz);
      p += sz;
    }
  }
  const MP4_CODECS = {
    mp4a: 'AAC', alac: 'ALAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', Opus: 'Opus', fLaC: 'FLAC', samr: 'AMR-NB', sawb: 'AMR-WB',
    '.mp3': 'MP3', mp3: 'MP3', lpcm: 'PCM', twos: 'PCM', sowt: 'PCM', ulaw: 'µ-law', alaw: 'A-law', dtsc: 'DTS', dtsh: 'DTS-HD', dtsl: 'DTS-HD', dtse: 'DTS Express', mlpa: 'TrueHD',
  };
  const MP4_LOSSLESS = new Set(['alac', 'fLaC', 'lpcm', 'twos', 'sowt', 'mlpa', 'dtsl']);
  async function parseMP4(reader, info) {
    info.container = 'MP4';
    let off = 0, n = 0;
    while (off + 8 <= reader.size && n++ < 128) {
      const h = await reader.read(off, 16);
      let asz = be32(h, 0), hl = 8;
      const type = ascii(h, 4, 8);
      if (asz === 1) { asz = be64(h, 8); hl = 16; }
      else if (asz === 0) asz = reader.size - off;
      if (asz < hl) break;
      if (type === 'ftyp') {
        const brand = ascii(h, 8, 12).trim();
        if (/^M4A/.test(brand)) info.container = 'M4A';
        else if (/^M4B/.test(brand)) info.container = 'M4B';
        else if (brand === 'qt') info.container = 'QuickTime';
      } else if (type === 'moov' && asz - hl < 128 * 1024 * 1024) {
        parseMoov(await reader.read(off + hl, asz - hl), info);
      } else if (type === 'mdat') {
        info.audioBytes = (info.audioBytes || 0) + Math.min(asz, reader.size - off) - hl;
      }
      off += asz;
    }
    if (info.duration && info.audioBytes) info.bitrate = info.audioBytes * 8 / info.duration;
    else if (info.declaredBitrate) info.bitrate = info.declaredBitrate;
  }
  function parseMoov(b, info) {
    let mvhd = null;
    boxes(b, 0, b.length, (t, s, e) => {
      if (t === 'mvhd') {
        mvhd = b[s] === 1 ? { ts: be32(b, s + 20), dur: be64(b, s + 24) } : { ts: be32(b, s + 12), dur: be32(b, s + 16) };
      } else if (t === 'trak') parseTrak(b, s, e, info);
      else if (t === 'udta') {
        boxes(b, s, e, (t2, s2, e2) => {
          if (t2 !== 'meta') return;
          const start = ascii(b, s2 + 4, s2 + 8) === 'hdlr' ? s2 : s2 + 4; // FullBox unless a child starts right away
          boxes(b, start, e2, (t3, s3, e3) => { if (t3 === 'ilst') parseIlst(b, s3, e3, info); });
        });
      }
    });
    if (info.duration == null && mvhd && mvhd.ts && mvhd.dur) info.duration = mvhd.dur / mvhd.ts;
  }
  function parseTrak(b, s, e, info) {
    let handler = null, mdhd = null, stsd = null;
    boxes(b, s, e, (t, s1, e1) => {
      if (t !== 'mdia') return;
      boxes(b, s1, e1, (t2, s2, e2) => {
        if (t2 === 'hdlr') handler = ascii(b, s2 + 8, s2 + 12);
        else if (t2 === 'mdhd') mdhd = b[s2] === 1 ? { ts: be32(b, s2 + 20), dur: be64(b, s2 + 24) } : { ts: be32(b, s2 + 12), dur: be32(b, s2 + 16) };
        else if (t2 === 'minf') boxes(b, s2, e2, (t3, s3, e3) => {
          if (t3 === 'stbl') boxes(b, s3, e3, (t4, s4, e4) => { if (t4 === 'stsd') stsd = [s4, e4]; });
        });
      });
    });
    if (handler !== 'soun' || !stsd || info.codec) return;
    if (mdhd && mdhd.ts && mdhd.dur) info.duration = mdhd.dur / mdhd.ts;
    parseStsd(b, stsd[0], stsd[1], info);
  }
  function parseStsd(b, s, e, info) {
    if (e - s < 16 || be32(b, s + 4) < 1) return;
    const es = s + 8, esz = be32(b, es), fmt = ascii(b, es + 4, es + 8);
    if (esz < 36 || es + esz > e) return;
    let p = es + 16;
    const ver = be16(b, p);
    info.channels = be16(b, p + 8) || null;
    info.bitsPerSample = be16(b, p + 10) || null;
    info.sampleRate = be16(b, p + 16) || null;
    p += 20;
    if (ver === 1) p += 16;
    else if (ver === 2) {
      try {
        const dv = new DataView(b.buffer, b.byteOffset + p, 36);
        const sr = dv.getFloat64(4);
        if (sr > 0) info.sampleRate = sr;
        info.channels = dv.getUint32(12) || info.channels;
        info.bitsPerSample = dv.getUint32(20) || info.bitsPerSample;
      } catch (err) { /* ignore */ }
      p += 36;
    }
    info.codec = MP4_CODECS[fmt] || clean(fmt) || 'unknown';
    info.lossless = MP4_LOSSLESS.has(fmt);
    boxes(b, p, es + esz, (t, s1, e1) => {
      if (t === 'esds') parseEsds(b, s1 + 4, e1, info);
      else if (t === 'wave') boxes(b, s1, e1, (t2, s2, e2) => { if (t2 === 'esds') parseEsds(b, s2 + 4, e2, info); });
      else if (t === 'alac' && e1 - s1 >= 28) {
        const q = s1 + 4;
        info.bitsPerSample = b[q + 5] || info.bitsPerSample;
        info.channels = b[q + 9] || info.channels;
        info.sampleRate = be32(b, q + 20) || info.sampleRate;
      } else if (t === 'dOps' && e1 - s1 >= 11) {
        info.channels = b[s1 + 1] || info.channels;
        info.inputSampleRate = be32(b, s1 + 4) || null;
        info.sampleRate = 48000;
      } else if (t === 'dfLa' && e1 - s1 >= 42) {
        const keep = info.duration;
        flacStreamInfo(b.subarray(s1 + 8, s1 + 42), info);
        if (keep) info.duration = keep;
      } else if (t === 'dac3') info.codec = 'AC-3';
      else if (t === 'dec3') info.codec = 'E-AC-3';
    });
  }
  function descLen(b, p) {
    let n = 0, i = 0, c;
    do { c = b[p + i++]; n = (n << 7) | (c & 0x7f); } while (c & 0x80 && i < 4);
    return [n, p + i];
  }
  function parseEsds(b, s, e, info) {
    let p = s, guard = 0;
    while (p + 2 <= e && guard++ < 32) {
      const tag = b[p];
      const [len, q] = descLen(b, p + 1);
      if (tag === 3) {
        const fl = b[q + 2];
        p = q + 3;
        if (fl & 0x80) p += 2;
        if (fl & 0x40) p += 1 + b[p];
        if (fl & 0x20) p += 2;
        continue;
      }
      if (tag === 4) {
        const oti = b[q], avg = be32(b, q + 9);
        if (avg) info.declaredBitrate = avg;
        if (oti === 0x40 || (oti >= 0x66 && oti <= 0x68)) info.codec = 'AAC';
        else if (oti === 0x69 || oti === 0x6b) { info.codec = 'MP3'; info.lossless = false; }
        else if (oti === 0xa5) info.codec = 'AC-3';
        else if (oti === 0xa6) info.codec = 'E-AC-3';
        else if (oti === 0xa9 || oti === 0xaa || oti === 0xab || oti === 0xac) info.codec = 'DTS';
        else if (oti === 0xad) info.codec = 'Opus';
        else if (oti === 0xdd) info.codec = 'Vorbis';
        p = q + 13;
        continue;
      }
      if (tag === 5) {
        if (info.codec === 'AAC' && len >= 2) {
          const br = bitReader(b, q, Math.min(e, q + len));
          let aot = br.read(5);
          if (aot === 31) aot = 32 + br.read(6);
          const sfi = br.read(4);
          let sr = sfi === 15 ? br.read(24) : AAC_SR[sfi];
          const chc = br.read(4);
          if (aot === 5 || aot === 29) {
            const esfi = br.read(4);
            sr = esfi === 15 ? br.read(24) : AAC_SR[esfi];
          }
          info.codec = AAC_PROFILES[aot] || 'AAC';
          if (sr) info.sampleRate = sr;
          if (chc && chc < 8) info.channels = chc === 7 ? 8 : chc;
        }
        p = q + len;
        continue;
      }
      p = q + len;
    }
  }
  const ILST = { '\xa9nam': 'title', '\xa9ART': 'artist', '\xa9alb': 'album', '\xa9day': 'year', '\xa9gen': 'genre' };
  function parseIlst(b, s, e, info) {
    boxes(b, s, e, (t, s1, e1) => {
      boxes(b, s1, e1, (t2, s2, e2) => {
        if (t2 !== 'data' || e2 - s2 < 8) return;
        const kind = be24(b, s2 + 1);
        const d = b.subarray(s2 + 8, e2);
        const key = ILST[t];
        if (key) {
          if (kind === 1 && info[key] == null) info[key] = clean(utf8(d));
        } else if (t === 'trkn' && d.length >= 6 && info.track == null) {
          const n = be16(d, 2), tot = be16(d, 4);
          if (n) info.track = tot ? n + '/' + tot : String(n);
        } else if (t === 'gnre' && d.length >= 2 && info.genre == null) {
          info.genre = GENRES[be16(d, 0) - 1] || null;
        } else if (t === 'covr' && !info.picture && d.length > 16) {
          info.picture = { mime: kind === 14 ? 'image/png' : kind === 13 ? 'image/jpeg' : sniffImage(d) || 'image/jpeg', data: d.slice() };
        }
      });
    });
  }

  // ---------- wav / rf64 ----------
  const WAV_FMT = { 1: 'PCM', 2: 'MS ADPCM', 3: 'PCM', 6: 'A-law', 7: 'µ-law', 0x11: 'IMA ADPCM', 0x50: 'MPEG', 0x55: 'MP3', 0x161: 'WMA', 0x162: 'WMA Pro', 0x2000: 'AC-3', 0xf1ac: 'FLAC' };
  async function parseWAV(reader, info) {
    info.container = 'WAV';
    const head = await reader.read(0, 12);
    const rf64 = ascii(head, 0, 4) === 'RF64';
    let off = 12, n = 0, dataSize = null, ds64 = null, fmt = null, floatPcm = false;
    while (off + 8 <= reader.size && n++ < 512) {
      const h = await reader.read(off, 8);
      const id = ascii(h, 0, 4);
      let sz = le32(h, 4);
      const body = off + 8;
      if (id === 'ds64' && sz >= 16) {
        const d = await reader.read(body, 16);
        ds64 = { riff: le64(d, 0), data: le64(d, 8) };
      } else if (id === 'fmt ' && sz >= 16) {
        const d = await reader.read(body, Math.min(sz, 40));
        fmt = le16(d, 0);
        info.channels = le16(d, 2) || null;
        info.sampleRate = le32(d, 4) || null;
        const byteRate = le32(d, 8);
        info.bitsPerSample = le16(d, 14) || null;
        if (fmt === 0xfffe && sz >= 40) fmt = le16(d, 24);
        floatPcm = fmt === 3;
        info.codec = WAV_FMT[fmt] || 'WAVE 0x' + fmt.toString(16);
        info.lossless = fmt === 1 || fmt === 3;
        if (byteRate) { info.bitrate = byteRate * 8; info.bitrateMode = 'CBR'; }
      } else if (id === 'data') {
        dataSize = sz;
        if (rf64 && sz === 0xffffffff && ds64) dataSize = ds64.data;
        if (!dataSize || dataSize > reader.size - body) dataSize = reader.size - body;
        sz = dataSize;
      } else if (id === 'LIST') {
        const d = await reader.read(body, Math.min(sz, 256 * 1024));
        if (ascii(d, 0, 4) === 'INFO') parseRiffInfo(d, 4, info);
      } else if (id.toLowerCase() === 'id3 ') {
        parseID3v2(await reader.read(body, Math.min(sz, 64 * 1024 * 1024)), info);
      }
      off = body + sz + (sz & 1);
    }
    if (dataSize != null) {
      info.audioBytes = dataSize;
      if (info.bitrate) info.duration = dataSize * 8 / info.bitrate;
    }
    if (info.lossless && info.bitsPerSample) info.codec = 'PCM ' + info.bitsPerSample + '-bit' + (floatPcm ? ' float' : '');
  }
  function parseRiffInfo(d, p, info) {
    const M = { INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'year', IGNR: 'genre', ITRK: 'track', IPRT: 'track' };
    while (p + 8 <= d.length) {
      const id = ascii(d, p, p + 4), sz = le32(d, p + 4);
      p += 8;
      if (p + sz > d.length) break;
      const key = M[id];
      if (key && info[key] == null) info[key] = clean(utf8(d.subarray(p, p + sz)));
      p += sz + (sz & 1);
    }
  }

  // ---------- aiff ----------
  function ext80(b, o) {
    const expon = ((b[o] & 0x7f) << 8) | b[o + 1];
    const hi = be32(b, o + 2), lo = be32(b, o + 6);
    if (expon === 0 && hi === 0 && lo === 0) return 0;
    return (b[o] & 0x80 ? -1 : 1) * (hi * 4294967296 + lo) * Math.pow(2, expon - 16383 - 63);
  }
  async function parseAIFF(reader, info) {
    info.container = 'AIFF';
    let off = 12, n = 0, frames = 0;
    while (off + 8 <= reader.size && n++ < 512) {
      const h = await reader.read(off, 8);
      const id = ascii(h, 0, 4), sz = be32(h, 4), body = off + 8;
      if (id === 'COMM' && sz >= 18) {
        const d = await reader.read(body, Math.min(sz, 64));
        info.channels = be16(d, 0) || null;
        frames = be32(d, 2);
        info.bitsPerSample = be16(d, 6) || null;
        info.sampleRate = Math.round(ext80(d, 8)) || null;
        const comp = sz > 18 ? ascii(d, 18, 22) : 'NONE';
        info.lossless = comp === 'NONE' || comp === 'sowt' || comp === 'twos' || comp === 'in24' || comp === 'in32' || comp === 'fl32' || comp === 'fl64';
        info.codec = info.lossless ? 'PCM ' + info.bitsPerSample + '-bit' : clean(comp) || 'unknown';
        if (info.lossless && info.sampleRate) { info.bitrate = info.channels * info.bitsPerSample * info.sampleRate; info.bitrateMode = 'CBR'; }
      } else if (id === 'SSND') info.audioBytes = Math.max(0, sz - 8);
      else if (id === 'NAME' && info.title == null) info.title = clean(latin1(await reader.read(body, Math.min(sz, 1024))));
      else if (id === 'AUTH' && info.artist == null) info.artist = clean(latin1(await reader.read(body, Math.min(sz, 1024))));
      else if (id === 'ID3 ' || id === 'id3 ') parseID3v2(await reader.read(body, Math.min(sz, 64 * 1024 * 1024)), info);
      off = body + sz + (sz & 1);
    }
    if (frames && info.sampleRate) info.duration = frames / info.sampleRate;
  }

  // ---------- entry ----------
  const EXT_CONTAINER = { mp3: 'MP3', mp2: 'MP2', flac: 'FLAC', ogg: 'Ogg', oga: 'Ogg', opus: 'Ogg', spx: 'Ogg', m4a: 'M4A', m4b: 'M4B', mp4: 'MP4', aac: 'AAC', wav: 'WAV', wave: 'WAV', aif: 'AIFF', aiff: 'AIFF', aifc: 'AIFF', webm: 'WebM', weba: 'WebM', mka: 'Matroska', wma: 'WMA', ape: 'APE', wv: 'WavPack' };

  async function readMetadata(file, name) {
    const reader = makeReader(file);
    const info = emptyInfo();
    const fname = name || file.name || '';
    const ext = (fname.split('.').pop() || '').toLowerCase();
    info.fileName = fname;
    info.fileSize = reader.size;
    try {
      const head = await reader.read(0, Math.min(reader.size, 64 * 1024));
      const m4 = ascii(head, 0, 4), m4_8 = ascii(head, 4, 8), m8 = ascii(head, 8, 12);
      if (m4 === 'fLaC') await parseFLAC(reader, info);
      else if (m4 === 'OggS') await parseOGG(reader, info);
      else if ((m4 === 'RIFF' || m4 === 'RF64') && m8 === 'WAVE') await parseWAV(reader, info);
      else if (m4 === 'FORM' && (m8 === 'AIFF' || m8 === 'AIFC')) await parseAIFF(reader, info);
      else if (m4_8 === 'ftyp') await parseMP4(reader, info);
      else if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0 && ext !== 'mp3') parseADTS(head, info);
      else if (ascii(head, 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) || ext === 'mp3' || ext === 'mp2') await parseMP3(reader, info, head);
      else if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) info.container = ext === 'mka' ? 'Matroska' : 'WebM';
      else info.container = EXT_CONTAINER[ext] || (ext ? ext.toUpperCase() : null);
    } catch (err) {
      info.error = String((err && err.message) || err);
    }
    if (!info.container) info.container = EXT_CONTAINER[ext] || (ext ? ext.toUpperCase() : null);
    if (info.bitrate && !isFinite(info.bitrate)) info.bitrate = null;
    if (info.duration && !isFinite(info.duration)) info.duration = null;
    return info;
  }

  return { readMetadata, parseID3v2, makeReader, GENRES };
});
