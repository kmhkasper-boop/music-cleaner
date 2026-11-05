/* Music Cleaner — UI + audio I/O */
(function () {
  'use strict';
  const DSP = window.MusicCleanerDSP;
  const LS_KEY = 'musicCleaner.settings.v1';

  const $ = (id) => document.getElementById(id);
  const fileList = $('fileList');
  const logEl = $('log');
  const reportEl = $('report');

  let audioCtx = null;
  let worker = null;
  let workerId = 0;
  const pending = new Map();
  let entries = [];
  let selected = null;
  let stopFlag = false;
  let busy = false;

  // Playback
  const transport = {
    entry: null,
    stage: 'original', // original|clean|mastered|noise
    playing: false,
    source: null,
    startedAt: 0,
    offset: 0,
    duration: 0,
    raf: 0,
  };

  function ensureCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('worker.js');
    worker.onmessage = (ev) => {
      const msg = ev.data;
      const p = pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') {
        if (p.onProgress) p.onProgress(msg.progress);
      } else if (msg.type === 'done' || msg.type === 'masterDone') {
        pending.delete(msg.id);
        p.resolve(msg);
      } else if (msg.type === 'error') {
        pending.delete(msg.id);
        p.reject(new Error(msg.error));
      }
    };
    worker.onerror = (e) => {
      console.error(e);
      log('Worker error: ' + (e.message || e), 'err');
    };
    return worker;
  }

  function processInWorker(channels, sampleRate, settings, onProgress) {
    ensureWorker();
    const id = ++workerId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress });
      const copies = channels.map((c) => {
        const copy = new Float32Array(c.length);
        copy.set(c);
        return copy;
      });
      const chBufs = copies.map((c) => c.buffer);
      worker.postMessage({
        id, type: 'process',
        channels: chBufs,
        sampleRate,
        settings,
      }, chBufs);
    });
  }

  function log(msg, cls) {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function fmtTime(s) {
    s = Math.max(0, s || 0);
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }

  function fmtDb(x) {
    if (!isFinite(x)) return '—';
    return (x >= 0 ? '+' : '') + x.toFixed(1) + ' dB';
  }

  // ---------- Settings ----------
  const SETTING_IDS = [
    'noisePercentile', 'maxReductionDb', 'oversubtraction', 'smoothTime', 'smoothFreq',
    'hfOnlyHz', 'fftSize', 'eqLowShelfDb', 'eqPresenceDb', 'eqHighShelfDb',
    'compThresholdDb', 'compRatio', 'limiterCeilingDb',
  ];

  function readSettings() {
    const s = Object.assign({}, DSP.DEFAULTS);
    s.noisePercentile = (+$('noisePercentile').value) / 100;
    s.maxReductionDb = +$('maxReductionDb').value;
    s.oversubtraction = +$('oversubtraction').value;
    s.smoothTime = +$('smoothTime').value;
    s.smoothFreq = +$('smoothFreq').value;
    s.hfOnlyHz = +$('hfOnlyHz').value;
    s.fftSize = +$('fftSize').value;
    s.eqLowShelfDb = +$('eqLowShelfDb').value;
    s.eqPresenceDb = +$('eqPresenceDb').value;
    s.eqHighShelfDb = +$('eqHighShelfDb').value;
    s.compThresholdDb = +$('compThresholdDb').value;
    s.compRatio = +$('compRatio').value;
    s.limiterCeilingDb = +$('limiterCeilingDb').value;
    s.enableMaster = $('chkMaster').checked;
    s.bitDepth = +$('bitDepth').value;
    return s;
  }

  function applySettingsToUI(s) {
    $('noisePercentile').value = Math.round((s.noisePercentile != null ? s.noisePercentile : 0.12) * 100);
    $('maxReductionDb').value = s.maxReductionDb;
    $('oversubtraction').value = s.oversubtraction;
    $('smoothTime').value = s.smoothTime;
    $('smoothFreq').value = s.smoothFreq;
    $('hfOnlyHz').value = s.hfOnlyHz || 0;
    $('fftSize').value = s.fftSize || 4096;
    $('eqLowShelfDb').value = s.eqLowShelfDb;
    $('eqPresenceDb').value = s.eqPresenceDb;
    $('eqHighShelfDb').value = s.eqHighShelfDb;
    $('compThresholdDb').value = s.compThresholdDb;
    $('compRatio').value = s.compRatio;
    $('limiterCeilingDb').value = s.limiterCeilingDb;
    if (s.enableMaster != null) $('chkMaster').checked = !!s.enableMaster;
    if (s.bitDepth) $('bitDepth').value = String(s.bitDepth);
    refreshLabels();
  }

  function refreshLabels() {
    const pct = $('noisePercentile').value;
    $('v_noisePercentile').textContent = pct + '%';
    $('v_maxReductionDb').textContent = (+$('maxReductionDb').value).toFixed(1).replace(/\.0$/, '') + ' dB';
    $('v_oversubtraction').textContent = (+$('oversubtraction').value).toFixed(2) + '×';
    $('v_smoothTime').textContent = $('smoothTime').value;
    $('v_smoothFreq').textContent = $('smoothFreq').value;
    const hf = +$('hfOnlyHz').value;
    $('v_hfOnlyHz').textContent = hf <= 0 ? 'off' : hf + ' Hz';
    $('v_fftSize').textContent = $('fftSize').value;
    const fdb = (v) => { const n = +v; return (n >= 0 ? '+' : '') + n.toFixed(1) + ' dB'; };
    $('v_eqLowShelfDb').textContent = fdb($('eqLowShelfDb').value);
    $('v_eqPresenceDb').textContent = fdb($('eqPresenceDb').value);
    $('v_eqHighShelfDb').textContent = fdb($('eqHighShelfDb').value);
    $('v_compThresholdDb').textContent = (+$('compThresholdDb').value).toFixed(0).replace('-', '−') + ' dB';

    $('v_compRatio').textContent = (+$('compRatio').value).toFixed(1) + ' : 1';
    $('v_limiterCeilingDb').textContent = (+$('limiterCeilingDb').value).toFixed(1).replace('-', '−') + ' dBFS';
  }

  function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(readSettings())); } catch (_) {}
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      applySettingsToUI(JSON.parse(raw));
    } catch (_) {}
  }

  SETTING_IDS.forEach((id) => {
    $(id).addEventListener('input', () => { refreshLabels(); saveSettings(); markPreset(null); });
  });
  ['chkMaster', 'chkSaveClean', 'chkSaveMaster', 'bitDepth'].forEach((id) => {
    $(id).addEventListener('change', saveSettings);
  });

  function markPreset(name) {
    document.querySelectorAll('.presets button').forEach((b) => {
      b.classList.toggle('on', name && b.dataset.preset === name);
    });
  }

  document.querySelectorAll('.presets button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.preset;
      const p = DSP.PRESETS[name];
      if (!p) return;
      applySettingsToUI(Object.assign({}, DSP.DEFAULTS, p));
      markPreset(name);
      saveSettings();
      log('Preset: ' + name, 'info');
    });
  });

  // ---------- Entries ----------
  function baseName(name) {
    return name.replace(/\.[^.]+$/, '');
  }

  function updateToolbar() {
    const n = entries.length;
    $('counter').textContent = n + ' track' + (n === 1 ? '' : 's');
    $('btnProcessAll').disabled = n === 0 || busy;
    $('btnClear').disabled = n === 0 || busy;
    $('btnStop').disabled = !busy;
    const ready = entries.some((e) => e.clean);
    $('btnDownloadAll').disabled = !ready || busy;
    $('globalStatus').textContent = busy ? 'Processing…' : (n ? n + ' ready' : 'Ready');
  }

  function syncRow(e) {
    if (!e.row) return;
    e.row.querySelector('.status').textContent = e.status;
    e.row.querySelector('.status').className = 'status ' + (e.status === 'done' ? 'done' : e.status === 'error' ? 'error' : (e.status === 'processing' || e.status === 'decoding') ? 'processing' : '');
    e.row.querySelector('.t-prog i').style.width = Math.round((e.progress || 0) * 100) + '%';
    const meta = e.row.querySelector('.t-name span');
    if (e.buffer) {
      meta.textContent = e.buffer.sampleRate + ' Hz · ' + e.buffer.numberOfChannels + ' ch · ' + fmtTime(e.buffer.duration);
    }
    const pv = e.row.querySelector('.previews');
    ['original', 'clean', 'mastered', 'noise'].forEach((st) => {
      const b = pv.querySelector('[data-stage="' + st + '"]');
      const ready = st === 'original' ? !!e.buffer : !!e[st];
      b.disabled = !ready;
      b.classList.toggle('ready', ready);
      b.classList.toggle('active', selected === e && transport.stage === st);
    });
  }

  function createRow(e) {
    const row = document.createElement('div');
    row.className = 'track';
    row.innerHTML =
      '<div class="t-top">' +
        '<div class="t-name"><b></b><span>Decoding…</span></div>' +
        '<span class="status">queued</span>' +
        '<button class="iconBtn" title="Remove">✕</button>' +
      '</div>' +
      '<div class="t-bottom">' +
        '<button class="proc">Process</button>' +
        '<div class="previews">' +
          '<span class="lbl">PREVIEW</span>' +
          '<button data-stage="original" disabled title="Original">A</button>' +
          '<button data-stage="clean" disabled title="Clean">B</button>' +
          '<button data-stage="mastered" disabled title="Mastered">C</button>' +
          '<button data-stage="noise" disabled title="Noise">D</button>' +
        '</div>' +
        '<button class="dl" disabled>Download</button>' +
      '</div>' +
      '<div class="t-prog"><i></i></div>';
    row.querySelector('.t-name b').textContent = e.title;
    row.querySelector('.iconBtn').onclick = (ev) => { ev.stopPropagation(); removeEntry(e); };
    row.querySelector('.proc').onclick = (ev) => { ev.stopPropagation(); processEntry(e); };
    row.querySelector('.dl').onclick = (ev) => { ev.stopPropagation(); downloadEntry(e); };
    row.querySelectorAll('.previews button').forEach((b) => {
      b.onclick = (ev) => {
        ev.stopPropagation();
        selectEntry(e);
        previewStage(e, b.dataset.stage);
      };
    });
    row.onclick = () => selectEntry(e);
    e.row = row;
    return row;
  }

  function selectEntry(e) {
    selected = e;
    entries.forEach((x) => x.row && x.row.classList.toggle('selected', x === e));
    $('nowTitle').textContent = e ? e.title : 'No selection';
    if (e && e.report) reportEl.textContent = e.report;
    else if (e) reportEl.textContent = 'Not processed yet.';
    drawWave(e);
    drawSpectrum(e);
    entries.forEach(syncRow);
  }

  function removeEntry(e) {
    if (busy && e.status === 'processing') return;
    if (transport.entry === e) stopPlayback();
    entries = entries.filter((x) => x !== e);
    e.row.remove();
    if (!entries.length) {
      fileList.innerHTML = '<div class="empty">No tracks yet. Add WAV or MP3 — batch upload supported.<br>Nothing is uploaded; processing is 100% local.</div>';
    }
    if (selected === e) { selected = null; $('nowTitle').textContent = 'No selection'; reportEl.textContent = 'Processing reports appear here.'; }
    updateToolbar();
  }

  async function addFiles(fileListObj) {
    const files = Array.from(fileListObj || []);
    if (!files.length) return;
    ensureCtx();
    if (fileList.querySelector('.empty')) fileList.innerHTML = '';
    for (const file of files) {
      const e = {
        id: Math.random().toString(36).slice(2),
        name: file.name,
        title: baseName(file.name),
        file,
        status: 'decoding',
        progress: 0,
        buffer: null,
        clean: null,
        mastered: null,
        noise: null,
        report: '',
      };
      entries.push(e);
      fileList.appendChild(createRow(e));
      syncRow(e);
      updateToolbar();
      try {
        const ab = await file.arrayBuffer();
        const buf = await ensureCtx().decodeAudioData(ab.slice(0));
        e.buffer = buf;
        e.status = 'ready';
        e.progress = 0;
        log('Decoded ' + e.name + ' (' + buf.sampleRate + ' Hz, ' + buf.numberOfChannels + ' ch, ' + fmtTime(buf.duration) + ')', 'ok');
      } catch (err) {
        e.status = 'error';
        e.report = String(err.message || err);
        log('Decode failed: ' + e.name + ' — ' + e.report, 'err');
      }
      syncRow(e);
    }
    updateToolbar();
    if (!selected && entries[0]) selectEntry(entries[0]);
  }

  // Drop zone
  const drop = $('drop');
  drop.addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (ev) => { addFiles(ev.target.files); ev.target.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.add('hover'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.remove('hover'); }));
  drop.addEventListener('drop', (ev) => addFiles(ev.dataTransfer.files));

  // ---------- Process ----------
  function channelsFromBuffer(buf) {
    const chs = [];
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const src = buf.getChannelData(c);
      const copy = new Float32Array(src.length);
      copy.set(src);
      chs.push(copy);
    }
    return chs;
  }

  function bufferFromChannels(chs, sr) {
    const ctx = ensureCtx();
    const buf = ctx.createBuffer(chs.length, chs[0].length, sr);
    for (let c = 0; c < chs.length; c++) buf.copyToChannel(chs[c], c);
    return buf;
  }

  async function processEntry(e) {
    if (!e.buffer || busy) return;
    busy = true; stopFlag = false;
    e.status = 'processing'; e.progress = 0; e.clean = null; e.mastered = null; e.noise = null;
    syncRow(e); updateToolbar(); selectEntry(e);
    const t0 = performance.now();
    try {
      const settings = readSettings();
      const chs = channelsFromBuffer(e.buffer);
      log('[' + e.title + '] STFT denoise…', 'info');
      const msg = await processInWorker(chs, e.buffer.sampleRate, settings, (p) => {
        e.progress = p;
        syncRow(e);
      });
      if (stopFlag) throw new Error('Stopped');

      const toF32 = (bufs) => bufs.map((b) => new Float32Array(b));
      const cleanCh = toF32(msg.clean);
      const noiseCh = toF32(msg.noise);
      e.clean = bufferFromChannels(cleanCh, msg.sampleRate);
      e.noise = bufferFromChannels(noiseCh, msg.sampleRate);
      if (msg.mastered) e.mastered = bufferFromChannels(toF32(msg.mastered), msg.sampleRate);

      const r = msg.report;
      const lines = [
        '=== ' + e.title + ' ===',
        'Source: ' + e.name,
        'Original: ' + r.sampleRate + ' Hz / ' + r.channels + ' ch / ' + r.samples + ' samples / ' + r.duration.toFixed(3) + ' s',
        'Peak original: ' + fmtDb(r.peakOriginal),
        'Peak clean:    ' + fmtDb(r.peakClean),
        'Peak noise:    ' + fmtDb(r.peakNoise),
        'LUFS-ish original: ' + r.lufsOriginal.toFixed(1),
        'LUFS-ish clean:    ' + r.lufsClean.toFixed(1),
      ];
      if (r.lufsMastered != null) {
        lines.push('LUFS-ish mastered: ' + r.lufsMastered.toFixed(1));
        lines.push('Peak mastered: ' + fmtDb(r.peakMastered) + '  (ceiling ' + settings.limiterCeilingDb + ' dBFS)');
      }
      lines.push('Settings: pct=' + Math.round(settings.noisePercentile * 100) + '%  maxRed=' + settings.maxReductionDb + 'dB  over=' + settings.oversubtraction + '  FFT=' + settings.fftSize + (settings.hfOnlyHz ? '  HF>' + settings.hfOnlyHz + 'Hz' : ''));
      lines.push('Elapsed: ' + ((performance.now() - t0) / 1000).toFixed(2) + ' s');
      e.report = lines.join('\n');
      e.status = 'done';
      e.progress = 1;
      e.row.querySelector('.dl').disabled = false;
      log('[' + e.title + '] done in ' + ((performance.now() - t0) / 1000).toFixed(2) + 's', 'ok');
      reportEl.textContent = e.report;
      drawWave(e);
      drawSpectrum(e);
    } catch (err) {
      e.status = 'error';
      e.report = String(err.message || err);
      log('[' + e.title + '] ' + e.report, 'err');
      reportEl.textContent = e.report;
    }
    busy = false;
    syncRow(e);
    updateToolbar();
  }

  async function processAll() {
    for (const e of entries) {
      if (stopFlag) break;
      if (e.buffer && e.status !== 'done') await processEntry(e);
    }
  }

  $('btnProcessAll').onclick = () => { stopFlag = false; processAll(); };
  $('btnStop').onclick = () => { stopFlag = true; log('Stop requested…', 'info'); };
  $('btnClear').onclick = () => {
    if (busy) return;
    stopPlayback();
    entries = [];
    selected = null;
    fileList.innerHTML = '<div class="empty">No tracks yet. Add WAV or MP3 — batch upload supported.<br>Nothing is uploaded; processing is 100% local.</div>';
    reportEl.textContent = 'Processing reports appear here.';
    updateToolbar();
  };

  // ---------- Playback A/B/C/D ----------
  function getStageBuffer(e, stage) {
    if (stage === 'original') return e.buffer;
    if (stage === 'clean') return e.clean;
    if (stage === 'mastered') return e.mastered;
    if (stage === 'noise') return e.noise;
    return null;
  }

  function stageLabel(s) {
    return ({ original: 'A · Original', clean: 'B · Clean', mastered: 'C · Mastered', noise: 'D · Noise' })[s] || s;
  }

  function getPosition() {
    if (!transport.playing || !audioCtx) return transport.offset;
    return Math.min(transport.duration, transport.offset + (audioCtx.currentTime - transport.startedAt));
  }

  function stopVoices() {
    if (transport.source) {
      try { transport.source.stop(); } catch (_) {}
      try { transport.source.disconnect(); } catch (_) {}
      transport.source = null;
    }
  }

  function stopPlayback() {
    stopVoices();
    transport.playing = false;
    transport.offset = 0;
    cancelAnimationFrame(transport.raf);
    $('btnPlay').disabled = !transport.entry;
    $('btnPause').disabled = true;
    updateTransportUI();
  }

  function pausePlayback() {
    if (!transport.playing) return;
    transport.offset = getPosition();
    stopVoices();
    transport.playing = false;
    cancelAnimationFrame(transport.raf);
    $('btnPause').disabled = true;
    $('btnPlay').disabled = false;
    updateTransportUI();
  }

  function startPlayback() {
    const e = transport.entry;
    const buf = getStageBuffer(e, transport.stage);
    if (!buf) return;
    ensureCtx();
    stopVoices();
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    const off = Math.min(transport.offset, Math.max(0, buf.duration - 0.01));
    src.start(0, off);
    src.onended = () => {
      if (transport.source === src) {
        transport.playing = false;
        transport.offset = 0;
        $('btnPlay').disabled = false;
        $('btnPause').disabled = true;
        updateTransportUI();
      }
    };
    transport.source = src;
    transport.startedAt = audioCtx.currentTime;
    transport.offset = off;
    transport.duration = buf.duration;
    transport.playing = true;
    $('btnPlay').disabled = true;
    $('btnPause').disabled = false;
    $('seek').disabled = false;
    tick();
  }

  function previewStage(e, stage) {
    const buf = getStageBuffer(e, stage);
    if (!buf) return;
    const pos = getPosition();
    const wasPlaying = transport.playing;
    stopVoices();
    transport.entry = e;
    transport.stage = stage;
    transport.duration = buf.duration;
    transport.offset = Math.min(pos, buf.duration);
    $('nowStage').textContent = stageLabel(stage);
    $('nowMeta').textContent = buf.sampleRate + ' Hz · ' + buf.numberOfChannels + ' ch · ' + fmtTime(buf.duration);
    $('seek').disabled = false;
    $('btnPlay').disabled = false;
    entries.forEach(syncRow);
    drawWave(e);
    drawSpectrum(e);
    if (wasPlaying) startPlayback();
    else updateTransportUI();
  }

  function tick() {
    updateTransportUI();
    if (transport.playing) transport.raf = requestAnimationFrame(tick);
  }

  function updateTransportUI() {
    const dur = transport.duration || 0;
    const pos = getPosition();
    $('timeLbl').textContent = fmtTime(pos) + ' / ' + fmtTime(dur);
    if (dur > 0) $('seek').value = Math.round((pos / dur) * 1000);
    drawPlayhead(pos, dur);
  }

  $('btnPlay').onclick = () => {
    if (!transport.entry) {
      if (selected) previewStage(selected, selected.clean ? 'clean' : 'original');
    }
    startPlayback();
  };
  $('btnPause').onclick = pausePlayback;
  $('seek').oninput = () => {
    const dur = transport.duration || 0;
    transport.offset = ( (+$('seek').value) / 1000) * dur;
    if (transport.playing) startPlayback();
    else updateTransportUI();
  };

  // ---------- Visuals ----------
  function drawWave(e) {
    const canvas = $('waveCanvas');
    const w = canvas.width = canvas.clientWidth * devicePixelRatio;
    const h = canvas.height = 90 * devicePixelRatio;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0c0e12';
    ctx.fillRect(0, 0, w, h);
    if (!e || !e.buffer) return;
    const buf = getStageBuffer(e, transport.entry === e ? transport.stage : (e.clean ? 'clean' : 'original')) || e.buffer;
    const data = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / w));
    ctx.strokeStyle = '#ff8a3d';
    ctx.lineWidth = 1 * devicePixelRatio;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      let min = 1, max = -1;
      const start = x * step;
      for (let i = 0; i < step && start + i < data.length; i++) {
        const v = data[start + i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = (1 - max) * 0.5 * h;
      const y2 = (1 - min) * 0.5 * h;
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
    }
    ctx.stroke();
  }

  function drawPlayhead(pos, dur) {
    // redraw wave with playhead — lightweight: just overlay on next drawWave call via seek
  }

  function drawSpectrum(e) {
    const canvas = $('specCanvas');
    const w = canvas.width = canvas.clientWidth * devicePixelRatio;
    const h = canvas.height = 120 * devicePixelRatio;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0c0e12';
    ctx.fillRect(0, 0, w, h);
    if (!e || !e.buffer) return;

    function spectrum(buf) {
      const N = 2048;
      const data = buf.getChannelData(0);
      const mid = Math.max(0, Math.floor(data.length / 2) - N / 2);
      const re = new Float32Array(N), im = new Float32Array(N);
      const win = DSP.hann(N);
      for (let i = 0; i < N; i++) { re[i] = (data[mid + i] || 0) * win[i]; im[i] = 0; }
      DSP.fft(re, im, false);
      const bins = N / 2;
      const mags = new Float32Array(bins);
      for (let k = 0; k < bins; k++) mags[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      return mags;
    }

    function paint(mags, color, alpha) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      const bins = mags.length;
      for (let x = 0; x < w; x++) {
        const k = Math.floor((x / w) * bins);
        const db = 20 * Math.log10(mags[k] + 1e-12);
        const n = Math.max(0, Math.min(1, (db + 90) / 90));
        const bar = n * h;
        ctx.fillRect(x, h - bar, 1, bar);
      }
      ctx.globalAlpha = 1;
    }

    paint(spectrum(e.buffer), '#556', 0.7);
    if (e.clean) paint(spectrum(e.clean), '#ff8a3d', 0.85);
  }

  // ---------- Export ----------
  function encodeEntryWav(buf, bits) {
    const chs = channelsFromBuffer(buf);
    const ab = DSP.encodeWav(chs, buf.sampleRate, bits);
    return new Blob([ab], { type: 'audio/wav' });
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  function downloadEntry(e) {
    const bits = +$('bitDepth').value;
    const saveClean = $('chkSaveClean').checked;
    const saveMaster = $('chkSaveMaster').checked;
    if (saveClean && e.clean) downloadBlob(encodeEntryWav(e.clean, bits), e.title + '_clean.wav');
    if (saveMaster && e.mastered) downloadBlob(encodeEntryWav(e.mastered, bits), e.title + '_mastered.wav');
    if (!saveClean && !saveMaster) {
      if (e.mastered) downloadBlob(encodeEntryWav(e.mastered, bits), e.title + '_mastered.wav');
      else if (e.clean) downloadBlob(encodeEntryWav(e.clean, bits), e.title + '_clean.wav');
    }
  }

  $('btnDownloadAll').onclick = () => {
    entries.forEach((e) => { if (e.clean || e.mastered) downloadEntry(e); });
  };

  // ---------- Init ----------
  loadSettings();
  refreshLabels();
  updateToolbar();
  window.addEventListener('resize', () => { if (selected) { drawWave(selected); drawSpectrum(selected); } });
  log('Music Cleaner ready — files stay on your device.', 'info');
})();
