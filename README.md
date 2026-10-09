# vizzualizer

a music visualizer that runs entirely in the browser. pick some files or a whole
folder, it plays through everything, and the little ⓘ in the top-right corner
shows what's playing: title / artist / album / cover art plus the technical
stuff, bitrate first.

no build step, no dependencies, nothing leaves your machine.

## run it

open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8080
# then http://localhost:8080
```

## using it

- **pick files**, **pick a folder**, or drag & drop files/folders onto the page
- everything plays in order; it moves to the next track by itself
- hover the **ⓘ** for a peek, click it to pin the panel open
- **☰** opens the playlist (click a row to jump, `×` to remove)

keys: `space` play/pause · `←/→` seek 5s (shift: 30s) · `↑/↓` volume · `n/p`
next/prev · `v` cycle visual · `i` info · `l` playlist · `s` shuffle · `r` repeat
· `m` mute · `f` fullscreen · `o` add files

## what the info panel shows

| row | where it comes from |
| --- | --- |
| bitrate | mp3: cbr from the frame header, vbr from the xing/vbri frame count. flac/ogg/opus/mp4: audio bytes ÷ duration (tags and headers excluded). wav/aiff: byte rate. anything else: file size ÷ duration once the browser knows it |
| cbr / vbr / lossless | mp3 header scan + xing/info tag, vorbis header, container type |
| format | codec + container, e.g. `MPEG-1 Layer III · MP3`, `AAC-LC · M4A`, `FLAC`, `Opus · Ogg`, `PCM 16-bit · WAV` |
| sample rate / channels / bit depth | parsed from the stream header |
| title, artist, album, year, track #, genre, cover | id3v1/v2, vorbis comments, flac picture, mp4 ilst, riff info |

parsers live in `js/metadata.js` and only read the bytes they need, so huge
files open instantly.

## formats

parsing works for mp3, flac, ogg vorbis, opus, m4a/mp4 (aac, alac, ...), aac
(adts), wav/rf64 and aiff. *playback* depends on the browser: chrome and
firefox do mp3/flac/ogg/opus/wav/aac, safari adds aiff and alac. a file the
browser can't decode gets flagged in the playlist and skipped.

## layout

```
index.html        markup
css/style.css     styling
js/metadata.js    tag + bitrate parsers (also loads in node)
js/player.js      playlist, <audio>, web audio analyser
js/visualizer.js  canvas renderers: bars, wave, ring, dust
js/app.js         ui wiring
test/             node + headless chromium tests
```

## tests

```sh
npm test            # generates fixtures with ffmpeg and checks parsers against ffprobe
npm run smoke       # headless chromium: load files, play, check the info panel, screenshot modes
```

`npm test` needs ffmpeg/ffprobe on your path. `npm run smoke` needs
`npm install` (playwright) and a chromium it can find.
