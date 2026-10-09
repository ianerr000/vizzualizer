/* app.js - wires the ui to the player + visualizer */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    canvas: $('viz'), dropzone: $('dropzone'), dragOverlay: $('dragOverlay'),
    fileInput: $('fileInput'), folderInput: $('folderInput'), pickFiles: $('pickFiles'), pickFolder: $('pickFolder'),
    nowPlaying: $('nowPlaying'), npTitle: $('npTitle'), npSub: $('npSub'),
    infoBtn: $('infoBtn'), infoPanel: $('infoPanel'), listBtn: $('listBtn'),
    playlist: $('playlist'), plItems: $('plItems'), plCount: $('plCount'), addMore: $('addMore'), clearList: $('clearList'), closeList: $('closeList'),
    controls: $('controls'), seek: $('seek'), tCur: $('tCur'), tDur: $('tDur'),
    shuffleBtn: $('shuffleBtn'), repeatBtn: $('repeatBtn'), repeatBadge: $('repeatBadge'),
    prevBtn: $('prevBtn'), playBtn: $('playBtn'), nextBtn: $('nextBtn'),
    modes: $('modes'), muteBtn: $('muteBtn'), volume: $('volume'), fsBtn: $('fsBtn'), toast: $('toast'),
  };

  const player = new Player();
  const viz = new Visualizer(el.canvas, player);
  viz.start();

  // ---------- persisted prefs ----------
  const prefs = (() => { try { return JSON.parse(localStorage.getItem('viz.prefs') || '{}'); } catch (e) { return {}; } })();
  const savePrefs = () => {
    try {
      localStorage.setItem('viz.prefs', JSON.stringify({ mode: viz.mode, volume: player.audio.volume, muted: player.audio.muted, shuffle: player.shuffle, repeat: player.repeat }));
    } catch (e) { /* private mode etc */ }
  };
  if (prefs.mode) viz.setMode(prefs.mode);
  if (typeof prefs.volume === 'number') player.audio.volume = prefs.volume;
  if (prefs.muted) player.audio.muted = true;
  if (prefs.shuffle) player.shuffle = true;
  if (prefs.repeat) player.repeat = prefs.repeat;
  el.volume.value = player.audio.volume;

  // ---------- formatting ----------
  const fmtTime = (s) => {
    if (!isFinite(s) || s < 0) return '0:00';
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  };
  const fmtSize = (b) => {
    if (!b && b !== 0) return '–';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  };
  const fmtHz = (hz) => (hz ? (hz % 1000 === 0 ? hz / 1000 : (hz / 1000).toFixed(1)) + ' kHz' : '–');
  const fmtChannels = (n) => (n === 1 ? 'mono' : n === 2 ? 'stereo' : n ? n + ' channels' : '–');
  const fmtKbps = (bps) => (bps ? Math.round(bps / 1000).toLocaleString() : '–');
  const baseName = (name) => String(name).replace(/\.[^.]+$/, '');
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function trackTitle(track) { return (track.info && track.info.title) || baseName(track.name); }
  function trackSub(track) {
    const i = track.info || {};
    return [i.artist, i.album].filter(Boolean).join(' · ');
  }
  function formatLabel(info) {
    if (!info) return '–';
    const codec = info.codec, cont = info.container;
    if (codec && cont && !codec.toUpperCase().startsWith(cont.toUpperCase()) && !cont.toUpperCase().startsWith(codec.toUpperCase())) return codec + ' · ' + cont;
    return codec || cont || '–';
  }

  // ---------- toast ----------
  let toastTimer = 0;
  function toast(msg, ms = 2600) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  // ---------- info panel ----------
  let infoPinned = false;
  let artUrl = null;
  function setArt(track) {
    if (artUrl) { URL.revokeObjectURL(artUrl); artUrl = null; }
    const pic = track && track.info && track.info.picture;
    if (pic && pic.data && pic.data.length) {
      try { artUrl = URL.createObjectURL(new Blob([pic.data], { type: pic.mime || 'image/jpeg' })); } catch (e) { artUrl = null; }
    }
    viz.setCover(artUrl);
    return artUrl;
  }

  function renderInfo() {
    const track = player.current;
    if (!track) {
      el.infoPanel.innerHTML = '<div class="info-empty">nothing playing yet</div>';
      return;
    }
    const info = track.info;
    const noteSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l11-2v13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="17.5" cy="16" r="2.5" fill="currentColor"/></svg>';
    const art = artUrl ? `<img src="${artUrl}" alt="">` : noteSvg;
    let html = `<div class="info-head"><div class="info-art">${art}</div><div class="info-titles">
      <div class="info-title">${esc(trackTitle(track))}</div>
      ${info && info.artist ? `<div class="info-artist">${esc(info.artist)}</div>` : ''}
      ${info && (info.album || info.year) ? `<div class="info-album">${esc([info.album, info.year].filter(Boolean).join(' · '))}</div>` : ''}
    </div></div>`;

    if (!info) {
      html += '<div class="info-loading">reading tags…</div>';
    } else {
      const tag = info.lossless ? '<span class="tag lossless">lossless</span>'
        : info.bitrateMode ? `<span class="tag ${info.bitrateMode.toLowerCase()}">${info.bitrateMode}</span>`
          : info.bitrate ? '<span class="tag">avg</span>' : '';
      const approx = info.bitrate && (info.bitrateMode !== 'CBR' || info.bitrateEstimated) ? '~' : '';
      html += `<div class="bitrate-card" title="${info.bitrateMode === 'CBR' ? 'constant bitrate from the stream header' : 'average bitrate: audio bytes ÷ duration'}">
        <span class="big">${approx}${fmtKbps(info.bitrate)}</span><span class="unit">kbps</span>${tag}</div>`;

      const rows = [
        ['format', formatLabel(info)],
        ['sample rate', fmtHz(info.sampleRate) + (info.inputSampleRate && info.inputSampleRate !== info.sampleRate ? ` <span style="color:var(--faint)">(source ${fmtHz(info.inputSampleRate)})</span>` : '')],
        ['channels', fmtChannels(info.channels)],
      ];
      if (info.bitsPerSample && info.lossless) rows.push(['bit depth', info.bitsPerSample + '-bit']);
      if (info.nominalBitrate && Math.abs(info.nominalBitrate - (info.bitrate || 0)) / info.nominalBitrate > 0.05) rows.push(['target', fmtKbps(info.nominalBitrate) + ' kbps nominal']);
      if (info.declaredBitrate && info.bitrate && Math.abs(info.declaredBitrate - info.bitrate) / info.declaredBitrate > 0.05) rows.push(['declared', fmtKbps(info.declaredBitrate) + ' kbps']);
      rows.push(['duration', fmtTime(info.duration || player.audio.duration)]);
      rows.push(['size', fmtSize(track.size)]);
      if (info.track) rows.push(['track #', esc(info.track)]);
      if (info.genre) rows.push(['genre', esc(info.genre)]);
      rows.push(['file', `<span class="mono">${esc(track.path || track.name)}</span>`]);
      html += '<dl class="info-grid">' + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl>';
      if (info.error) html += `<div class="info-loading">tag parser hiccup: ${esc(info.error)}</div>`;
    }
    html += `<div class="info-foot"><span>track ${player.index + 1} of ${player.tracks.length}</span><span>${player.ctx ? 'graph @ ' + fmtHz(player.ctx.sampleRate) : ''}</span></div>`;
    el.infoPanel.innerHTML = html;
  }

  function showInfo(show) {
    el.infoPanel.hidden = !show;
    el.infoBtn.setAttribute('aria-expanded', String(show));
    if (show) { renderInfo(); showList(false); }
  }
  // click pins the panel open (even if a hover already peeked it); a second click closes it
  function toggleInfoPinned() {
    infoPinned = !infoPinned;
    showInfo(infoPinned);
  }
  el.infoBtn.addEventListener('click', toggleInfoPinned);
  // hover peek on pointer devices, click to pin
  if (matchMedia('(hover: hover)').matches) {
    el.infoBtn.addEventListener('mouseenter', () => { if (el.infoPanel.hidden) showInfo(true); });
    const maybeHide = (e) => {
      if (infoPinned) return;
      const to = e.relatedTarget;
      if (to && (el.infoPanel.contains(to) || el.infoBtn.contains(to))) return;
      showInfo(false);
    };
    el.infoBtn.addEventListener('mouseleave', maybeHide);
    el.infoPanel.addEventListener('mouseleave', maybeHide);
  }

  // ---------- playlist ----------
  function showList(show) {
    el.playlist.hidden = !show;
    el.listBtn.setAttribute('aria-expanded', String(show));
    if (show) { renderList(); if (!infoPinned) showInfo(false); scrollActiveIntoView(); }
  }
  function renderList() {
    el.plCount.textContent = player.tracks.length + (player.tracks.length === 1 ? ' track' : ' tracks');
    const frag = document.createDocumentFragment();
    player.tracks.forEach((t, i) => {
      const li = document.createElement('li');
      li.dataset.index = i;
      if (i === player.index) li.classList.add('active');
      if (t.failed) li.classList.add('failed');
      const meta = t.info ? [formatLabel(t.info), t.info.bitrate ? fmtKbps(t.info.bitrate) + ' kbps' : null, t.info.duration ? fmtTime(t.info.duration) : null].filter(Boolean).join(' · ') : fmtSize(t.size);
      li.innerHTML = `<span class="pl-num">${i + 1}</span><div class="pl-main"><div class="pl-name">${esc(trackTitle(t))}${i === player.index ? '<span class="eq"><i></i><i></i><i></i></span>' : ''}</div><div class="pl-meta">${esc(trackSub(t) || t.path)} ${trackSub(t) ? '· ' + esc(meta) : ''}</div></div><button class="pl-remove" type="button" aria-label="remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>`;
      frag.appendChild(li);
    });
    el.plItems.replaceChildren(frag);
  }
  function scrollActiveIntoView() {
    const a = el.plItems.querySelector('li.active');
    if (a) a.scrollIntoView({ block: 'nearest' });
  }
  el.plItems.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const i = +li.dataset.index;
    if (e.target.closest('.pl-remove')) { player.remove(i); return; }
    player.play(i);
  });
  el.listBtn.addEventListener('click', () => showList(el.playlist.hidden));
  el.closeList.addEventListener('click', () => showList(false));
  el.addMore.addEventListener('click', () => el.fileInput.click());
  el.clearList.addEventListener('click', () => { player.clear(); showList(false); });

  // ---------- adding files ----------
  function addItems(items, autoplay) {
    const hadTracks = player.tracks.length > 0;
    const n = player.addFiles(items);
    if (!n) { toast('no playable audio in that selection'); return; }
    toast(`added ${n} track${n === 1 ? '' : 's'}`);
    el.dropzone.classList.add('hiding');
    el.controls.hidden = false;
    if (autoplay && (!hadTracks || player.audio.paused)) player.play(hadTracks ? player.tracks.length - n : 0);
  }
  el.pickFiles.addEventListener('click', () => el.fileInput.click());
  el.pickFolder.addEventListener('click', () => el.folderInput.click());
  el.fileInput.addEventListener('change', () => { addItems(Array.from(el.fileInput.files), true); el.fileInput.value = ''; });
  el.folderInput.addEventListener('change', () => { addItems(Array.from(el.folderInput.files), true); el.folderInput.value = ''; });
  if (!('webkitdirectory' in el.folderInput)) el.pickFolder.hidden = true;

  // drag & drop with directory support
  async function walkEntry(entry, out, path) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: path + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walkEntry(e, out, path + entry.name + '/');
      }
    }
  }
  async function itemsFromDrop(dt) {
    const entries = dt.items ? Array.from(dt.items).map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)) : [];
    if (entries.some(Boolean)) {
      const out = [];
      for (const e of entries) if (e) await walkEntry(e, out, '');
      return out;
    }
    return Array.from(dt.files);
  }
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); dragDepth++; el.dragOverlay.hidden = false; } });
  document.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; el.dragOverlay.hidden = true; } });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.dragOverlay.hidden = true;
    player.ensureAudioGraph();
    const items = await itemsFromDrop(e.dataTransfer);
    addItems(items, true);
  });

  // ---------- transport ----------
  el.playBtn.addEventListener('click', () => player.toggle());
  el.prevBtn.addEventListener('click', () => player.prev());
  el.nextBtn.addEventListener('click', () => player.next(false));
  el.shuffleBtn.addEventListener('click', () => { player.toggleShuffle(); savePrefs(); });
  el.repeatBtn.addEventListener('click', () => { player.cycleRepeat(); savePrefs(); });
  function renderModes() {
    el.shuffleBtn.setAttribute('aria-pressed', String(player.shuffle));
    el.repeatBtn.setAttribute('aria-pressed', String(player.repeat !== 'off'));
    el.repeatBtn.title = `repeat: ${player.repeat} (r)`;
    el.repeatBadge.hidden = player.repeat !== 'one';
  }
  player.addEventListener('modes', renderModes);
  renderModes();

  let seeking = false;
  el.seek.addEventListener('input', () => { seeking = true; const d = player.audio.duration; el.tCur.textContent = fmtTime(el.seek.value / 1000 * d); el.seek.style.setProperty('--p', el.seek.value / 10 + '%'); });
  el.seek.addEventListener('change', () => { seeking = false; const d = player.audio.duration; if (isFinite(d)) player.seek(el.seek.value / 1000 * d); });
  function renderTime() {
    const a = player.audio, d = a.duration;
    if (!seeking) {
      const p = isFinite(d) && d > 0 ? a.currentTime / d * 1000 : 0;
      el.seek.value = p;
      el.seek.style.setProperty('--p', p / 10 + '%');
      el.tCur.textContent = fmtTime(a.currentTime);
    }
    el.tDur.textContent = fmtTime(d);
  }
  player.addEventListener('timeupdate', renderTime);
  player.addEventListener('durationchange', renderTime);
  player.addEventListener('loadedmetadata', renderTime);

  function renderPlayState() {
    const playing = !player.audio.paused && player.current;
    document.body.classList.toggle('playing', !!playing);
    document.body.classList.toggle('paused', !playing);
    el.playBtn.setAttribute('aria-label', playing ? 'pause' : 'play');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    scheduleIdle();
  }
  player.addEventListener('play', renderPlayState);
  player.addEventListener('pause', renderPlayState);

  el.muteBtn.addEventListener('click', () => { player.audio.muted = !player.audio.muted; savePrefs(); });
  el.volume.addEventListener('input', () => { player.audio.volume = +el.volume.value; player.audio.muted = false; savePrefs(); });
  function renderVolume() {
    document.body.classList.toggle('muted', player.audio.muted || player.audio.volume === 0);
    el.volume.value = player.audio.muted ? 0 : player.audio.volume;
    el.volume.style.setProperty('--p', (el.volume.value * 100) + '%');
  }
  player.addEventListener('volumechange', renderVolume);
  renderVolume();

  el.fsBtn.addEventListener('click', toggleFullscreen);
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  }

  // modes
  function renderModeButtons() {
    for (const b of el.modes.querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === viz.mode);
  }
  el.modes.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    viz.setMode(b.dataset.mode);
    renderModeButtons();
    savePrefs();
  });
  renderModeButtons();

  // ---------- track changes ----------
  player.addEventListener('track', (e) => {
    const { track } = e.detail;
    if (!track) {
      el.nowPlaying.hidden = true;
      document.title = 'vizzualizer';
      setArt(null);
      renderInfo();
      renderList();
      if (!player.tracks.length) { el.dropzone.classList.remove('hiding'); el.controls.hidden = true; }
      return;
    }
    el.nowPlaying.hidden = false;
    el.npTitle.textContent = trackTitle(track);
    el.npSub.textContent = trackSub(track);
    document.title = trackTitle(track) + ' – vizzualizer';
    setArt(track);
    renderInfo();
    renderList();
    scrollActiveIntoView();
    updateMediaSession(track);
  });
  player.addEventListener('info', (e) => {
    const { track } = e.detail;
    if (track !== player.current) { renderList(); return; }
    el.npTitle.textContent = trackTitle(track);
    el.npSub.textContent = trackSub(track);
    document.title = trackTitle(track) + ' – vizzualizer';
    setArt(track);
    renderInfo();
    renderList();
    updateMediaSession(track);
  });
  player.addEventListener('playlist', () => { renderList(); if (!el.infoPanel.hidden) renderInfo(); });
  player.addEventListener('trackerror', (e) => {
    const t = e.detail.track;
    toast(`can't play ${t ? t.name : 'that file'} (${e.detail.error && e.detail.error.code === 4 ? 'format not supported by this browser' : 'decode error'}), skipping`);
    renderList();
  });
  player.addEventListener('playerror', (e) => {
    if (e.detail.err && e.detail.err.name === 'NotAllowedError') toast('press play to start (browser blocked autoplay)');
  });
  player.addEventListener('finished', () => toast('end of playlist'));

  function updateMediaSession(track) {
    if (!('mediaSession' in navigator)) return;
    const i = track.info || {};
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: trackTitle(track), artist: i.artist || '', album: i.album || '',
        artwork: artUrl ? [{ src: artUrl, type: (i.picture && i.picture.mime) || 'image/jpeg' }] : [],
      });
    } catch (e) { /* ignore */ }
  }
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const set = (a, h) => { try { ms.setActionHandler(a, h); } catch (e) { /* unsupported action */ } };
    set('play', () => player.play());
    set('pause', () => player.pause());
    set('previoustrack', () => player.prev());
    set('nexttrack', () => player.next(false));
    set('seekto', (d) => player.seek(d.seekTime));
    set('seekbackward', (d) => player.seek(player.audio.currentTime - (d.seekOffset || 10)));
    set('seekforward', (d) => player.seek(player.audio.currentTime + (d.seekOffset || 10)));
  }

  // ---------- idle hiding ----------
  let idleTimer = 0;
  function scheduleIdle() {
    clearTimeout(idleTimer);
    document.body.classList.remove('idle');
    if (player.audio.paused || !player.current) return;
    idleTimer = setTimeout(() => {
      if (!el.playlist.hidden || infoPinned) return;
      document.body.classList.add('idle');
    }, 3200);
  }
  for (const ev of ['mousemove', 'mousedown', 'touchstart', 'keydown']) document.addEventListener(ev, scheduleIdle, { passive: true });

  // ---------- keyboard ----------
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' && e.target.type !== 'range') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === ' ' || k === 'k') { e.preventDefault(); player.toggle(); }
    else if (k === 'ArrowRight') { e.preventDefault(); player.seek(player.audio.currentTime + (e.shiftKey ? 30 : 5)); }
    else if (k === 'ArrowLeft') { e.preventDefault(); player.seek(player.audio.currentTime - (e.shiftKey ? 30 : 5)); }
    else if (k === 'ArrowUp') { e.preventDefault(); player.audio.volume = Math.min(1, player.audio.volume + 0.05); player.audio.muted = false; savePrefs(); }
    else if (k === 'ArrowDown') { e.preventDefault(); player.audio.volume = Math.max(0, player.audio.volume - 0.05); savePrefs(); }
    else if (k === 'n' || k === 'N' || k === 'MediaTrackNext') player.next(false);
    else if (k === 'p' || k === 'P' || k === 'MediaTrackPrevious') player.prev();
    else if (k === 'v' || k === 'V') { viz.nextMode(); renderModeButtons(); savePrefs(); toast('mode: ' + viz.mode, 1200); }
    else if (k === 'i' || k === 'I') toggleInfoPinned();
    else if (k === 'l' || k === 'L') showList(el.playlist.hidden);
    else if (k === 'm' || k === 'M') { player.audio.muted = !player.audio.muted; savePrefs(); }
    else if (k === 's' || k === 'S') { player.toggleShuffle(); savePrefs(); toast('shuffle ' + (player.shuffle ? 'on' : 'off'), 1200); }
    else if (k === 'r' || k === 'R') { savePrefs(); toast('repeat: ' + player.cycleRepeat(), 1200); savePrefs(); }
    else if (k === 'f' || k === 'F') toggleFullscreen();
    else if (k === 'o' || k === 'O') el.fileInput.click();
    else if (k === 'Escape') { infoPinned = false; showInfo(false); showList(false); }
  });

  // tapping the canvas toggles play on touch devices, double-click goes fullscreen
  el.canvas.addEventListener('dblclick', toggleFullscreen);
  el.canvas.addEventListener('click', () => { if (!infoPinned) showInfo(false); showList(false); });

  // expose for debugging / tests
  window.viz = { player, visualizer: viz, renderInfo };
})();
