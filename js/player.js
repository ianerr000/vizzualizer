/* player.js - playlist + <audio> element + web audio analyser graph */
(function (root) {
  'use strict';

  const AUDIO_EXT = new Set(['mp3', 'mp2', 'flac', 'ogg', 'oga', 'opus', 'spx', 'm4a', 'm4b', 'mp4', 'aac', 'wav', 'wave', 'aif', 'aiff', 'aifc', 'webm', 'weba', 'mka', 'caf']);
  const extOf = (name) => (String(name).split('.').pop() || '').toLowerCase();

  class Player extends EventTarget {
    constructor() {
      super();
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.tracks = [];
      this.index = -1;
      this.shuffle = false;
      this.repeat = 'all'; // 'off' | 'all' | 'one'
      this.ctx = null;
      this.analyser = null;
      this.history = [];
      this._url = null;
      this._errorStreak = 0;
      this._seq = 0;

      this.audio.addEventListener('ended', () => this._onEnded());
      this.audio.addEventListener('error', () => this._onError());
      this.audio.addEventListener('loadedmetadata', () => this._onLoadedMeta());
      this.audio.addEventListener('playing', () => { this._errorStreak = 0; });
      for (const ev of ['play', 'pause', 'timeupdate', 'volumechange', 'durationchange', 'waiting', 'playing']) {
        this.audio.addEventListener(ev, () => this.emit(ev));
      }
    }

    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

    static isAudioFile(file) {
      return AUDIO_EXT.has(extOf(file.name)) || (file.type && file.type.startsWith('audio/'));
    }

    /* must be called from a user gesture at least once so the context can start */
    ensureAudioGraph() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        return;
      }
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
        const src = this.ctx.createMediaElementSource(this.audio);
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.78;
        src.connect(this.analyser);
        this.analyser.connect(this.ctx.destination);
      } catch (err) {
        console.warn('web audio unavailable, playing without visuals', err);
        this.ctx = null;
        this.analyser = null;
      }
    }

    /* items: File objects or { file, path } */
    addFiles(items) {
      const added = [];
      for (const it of items) {
        const file = it instanceof Blob ? it : it.file;
        if (!file || !Player.isAudioFile(file)) continue;
        const path = (it.path || file.webkitRelativePath || file.name || '').replace(/^\/+/, '');
        added.push({
          id: 't' + (++this._seq),
          file,
          name: file.name,
          path,
          size: file.size,
          info: null,
          failed: false,
        });
      }
      added.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
      this.tracks.push(...added);
      this.emit('playlist');
      return added.length;
    }

    remove(index) {
      if (index < 0 || index >= this.tracks.length) return;
      const wasCurrent = index === this.index;
      this.tracks.splice(index, 1);
      this.history = this.history.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i));
      if (wasCurrent) {
        this.stop();
        this.index = -1;
        if (this.tracks.length) this.play(Math.min(index, this.tracks.length - 1));
      } else if (index < this.index) {
        this.index--;
      }
      this.emit('playlist');
    }

    clear() {
      this.stop();
      this.tracks = [];
      this.index = -1;
      this.history = [];
      this.emit('playlist');
      this.emit('track', { track: null, index: -1 });
    }

    get current() { return this.tracks[this.index] || null; }

    async play(index) {
      this.ensureAudioGraph();
      if (index == null) {
        if (this.index < 0) { if (!this.tracks.length) return; index = 0; }
        else return this.audio.play().catch(() => {});
      }
      if (index < 0 || index >= this.tracks.length) return;
      const track = this.tracks[index];
      this.index = index;
      this.history.push(index);
      if (this.history.length > 500) this.history.shift();
      if (this._url) URL.revokeObjectURL(this._url);
      this._url = URL.createObjectURL(track.file);
      this.audio.src = this._url;
      this.emit('track', { track, index });
      const playing = this.audio.play().catch((err) => {
        if (err && err.name === 'AbortError') return; // another track was selected meanwhile
        this.emit('playerror', { err, track });
      });
      if (!track.info) {
        try {
          track.info = await root.VizMetadata.readMetadata(track.file, track.path);
        } catch (err) {
          track.info = { error: String(err), fileName: track.name, fileSize: track.size };
        }
        this._finalizeInfo(track);
        this.emit('info', { track, index: this.tracks.indexOf(track) });
      } else if (this._finalizeInfo(track)) {
        this.emit('info', { track, index });
      }
      return playing;
    }

    /* fill in whatever the parser could not know from the <audio> element */
    _finalizeInfo(track) {
      const info = track.info;
      if (!info) return false;
      let changed = false;
      const isCurrent = this.current === track;
      const d = isCurrent && isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : null;
      if (!info.duration && d) { info.duration = d; changed = true; }
      if (!info.bitrate && info.duration) {
        info.bitrate = (info.audioBytes || track.size) * 8 / info.duration;
        info.bitrateEstimated = true;
        changed = true;
      }
      if (!info.sampleRate && isCurrent && this.ctx && info.lossless === false && !info.codec) {
        // unknown container: at least show what the graph runs at
        info.sampleRateIsContext = true;
      }
      return changed;
    }

    _onLoadedMeta() {
      const t = this.current;
      if (t && t.info && this._finalizeInfo(t)) this.emit('info', { track: t, index: this.index });
      this.emit('loadedmetadata');
    }

    pause() { this.audio.pause(); }
    toggle() { if (this.audio.paused) this.play(); else this.pause(); }

    stop() {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
    }

    seek(seconds) {
      if (!isFinite(this.audio.duration)) return;
      this.audio.currentTime = Math.max(0, Math.min(this.audio.duration, seconds));
    }

    next(auto) {
      if (!this.tracks.length) return;
      if (this.shuffle && this.tracks.length > 1) {
        let i;
        do { i = Math.floor(Math.random() * this.tracks.length); } while (i === this.index);
        return this.play(i);
      }
      let i = this.index + 1;
      if (i >= this.tracks.length) {
        if (this.repeat === 'off' && auto) { this.emit('finished'); return; }
        i = 0;
      }
      return this.play(i);
    }

    prev() {
      if (!this.tracks.length) return;
      if (this.audio.currentTime > 3 && this.current) { this.audio.currentTime = 0; return; }
      if (this.shuffle && this.history.length > 1) {
        this.history.pop(); // current
        const i = this.history.pop();
        if (i != null && i < this.tracks.length) return this.play(i);
      }
      let i = this.index - 1;
      if (i < 0) i = this.tracks.length - 1;
      return this.play(i);
    }

    cycleRepeat() {
      this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off';
      this.emit('modes');
      return this.repeat;
    }
    toggleShuffle() { this.shuffle = !this.shuffle; this.emit('modes'); return this.shuffle; }

    _onEnded() {
      if (this.repeat === 'one') { this.audio.currentTime = 0; this.audio.play().catch(() => {}); return; }
      this.next(true);
    }

    _onError() {
      if (!this.audio.error || !this.audio.getAttribute('src')) return;
      const t = this.current;
      if (t) t.failed = true;
      this._errorStreak++;
      this.emit('trackerror', { track: t, error: this.audio.error });
      if (this.tracks.length > 1 && this._errorStreak < this.tracks.length) setTimeout(() => this.next(true), 400);
    }
  }

  root.Player = Player;
})(window);
