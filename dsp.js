/**
 * Music Cleaner — STFT spectral subtraction + master chain (pure JS).
 * Works in browser (Worker / main) and Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MusicCleanerDSP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    fftSize: 4096,
    hopRatio: 0.25, // 75% overlap
    noisePercentile: 0.12,
    maxReductionDb: 7,
    oversubtraction: 1.0, // scales the frequency-dependent alpha curve
    smoothTime: 1, // frames each side (±1 = 3-point)
    smoothFreq: 1, // bins each side
    hfOnlyHz: 0, // 0 = full band; else only apply reduction above this Hz
    enableMaster: true,
    eqLowShelfHz: 100,
    eqLowShelfDb: 0.5,
    eqPresenceHz: 3000,
    eqPresenceDb: 1.0,
    eqPresenceQ: 0.9,
    eqHighShelfHz: 10000,
    eqHighShelfDb: 1.5,
    eqHighpassHz: 30,
    compThresholdDb: -18,
    compRatio: 2.5,
    compAttackMs: 30,
    compReleaseMs: 250,
    compKneeDb: 12,
    limiterCeilingDb: -1,
    limiterLookaheadMs: 5,
    limiterReleaseMs: 50,
    bitDepth: 24,
  };

  const PRESETS = {
    Gentle: {
      noisePercentile: 0.08,
      maxReductionDb: 4,
      oversubtraction: 0.7,
      smoothTime: 2,
      smoothFreq: 2,
      hfOnlyHz: 4000,
      eqLowShelfDb: 0.3,
      eqPresenceDb: 0.5,
      eqHighShelfDb: 1.0,
      compThresholdDb: -16,
      compRatio: 2.0,
      limiterCeilingDb: -1,
    },
    Standard: {
      noisePercentile: 0.12,
      maxReductionDb: 7,
      oversubtraction: 1.0,
      smoothTime: 1,
      smoothFreq: 1,
      hfOnlyHz: 0,
      eqLowShelfDb: 0.5,
      eqPresenceDb: 1.0,
      eqHighShelfDb: 1.5,
      compThresholdDb: -18,
      compRatio: 2.5,
      limiterCeilingDb: -1,
    },
    Strong: {
      noisePercentile: 0.18,
      maxReductionDb: 12,
      oversubtraction: 1.4,
      smoothTime: 1,
      smoothFreq: 1,
      hfOnlyHz: 0,
      eqLowShelfDb: 0.8,
      eqPresenceDb: 1.5,
      eqHighShelfDb: 2.0,
      compThresholdDb: -20,
      compRatio: 3.5,
      limiterCeilingDb: -1,
    },
  };

  function mergeSettings(partial) {
    return Object.assign({}, DEFAULTS, partial || {});
  }

  // ---------- FFT ----------
  function fft(re, im, invert) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (2 * Math.PI / len) * (invert ? -1 : 1);
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cRe = 1, cIm = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = re[i + k], b = im[i + k];
          const vRe = re[i + k + len / 2] * cRe - im[i + k + len / 2] * cIm;
          const vIm = re[i + k + len / 2] * cIm + im[i + k + len / 2] * cRe;
          re[i + k] = a + vRe; im[i + k] = b + vIm;
          re[i + k + len / 2] = a - vRe; im[i + k + len / 2] = b - vIm;
          const nRe = cRe * wRe - cIm * wIm;
          cIm = cRe * wIm + cIm * wRe;
          cRe = nRe;
        }
      }
    }
    if (invert) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
  }

  function stft(sig, N, H) {
    const win = hann(N);
    const frames = Math.max(1, Math.floor((sig.length - N) / H) + 1);
    const bins = (N >> 1) + 1;
    const re = new Array(frames), im = new Array(frames);
    const fr = new Float32Array(N), fi = new Float32Array(N);
    for (let f = 0; f < frames; f++) {
      const off = f * H;
      for (let i = 0; i < N; i++) {
        fr[i] = (off + i < sig.length ? sig[off + i] : 0) * win[i];
        fi[i] = 0;
      }
      fft(fr, fi, false);
      re[f] = new Float32Array(bins);
      im[f] = new Float32Array(bins);
      for (let k = 0; k < bins; k++) { re[f][k] = fr[k]; im[f][k] = fi[k]; }
    }
    return { re, im };
  }

  function istft(re0, im0, N, H, length) {
    const win = hann(N);
    const out = new Float32Array(length);
    const norm = new Float32Array(length);
    const fr = new Float32Array(N), fi = new Float32Array(N);
    for (let f = 0; f < re0.length; f++) {
      const off = f * H;
      for (let k = 0; k < N; k++) {
        if (k < re0[f].length) { fr[k] = re0[f][k]; fi[k] = im0[f][k]; }
        else { const m = N - k; fr[k] = re0[f][m]; fi[k] = -im0[f][m]; }
      }
      fft(fr, fi, true);
      for (let i = 0; i < N; i++) {
        const idx = off + i;
        if (idx < length) {
          out[idx] += fr[i] * win[i];
          norm[idx] += win[i] * win[i];
        }
      }
    }
    for (let i = 0; i < length; i++) if (norm[i] > 1e-8) out[i] /= norm[i];
    return out;
  }

  // ---------- Noise profile + gain mask ----------
  function noiseProfile(re, im, pct) {
    const F = re.length, B = re[0].length;
    const en = new Float32Array(F);
    let enmax = 0;
    for (let f = 0; f < F; f++) {
      let s = 0;
      for (let k = 0; k < B; k++) {
        const r = re[f][k], m = im[f][k];
        s += r * r + m * m;
      }
      en[f] = s;
      if (s > enmax) enmax = s;
    }
    const thr = enmax * 1e-9;
    const idx = [];
    for (let f = 0; f < F; f++) if (en[f] > thr) idx.push(f);
    idx.sort((a, b) => en[a] - en[b]);
    const nq = Math.max(1, Math.floor(idx.length * pct));
    const p = new Float32Array(B);
    for (let j = 0; j < nq; j++) {
      const f = idx[j];
      for (let k = 0; k < B; k++) {
        const r = re[f][k], m = im[f][k];
        p[k] += Math.sqrt(r * r + m * m);
      }
    }
    for (let k = 0; k < B; k++) p[k] /= nq;
    return p;
  }

  /** Frequency-dependent oversubtraction curve (reference-style), scaled by factor. */
  function alphaForHz(hz, factor) {
    let a;
    if (hz < 350) a = 0.10;
    else if (hz < 1200) a = 0.45;
    else if (hz < 4000) a = 0.65;
    else if (hz < 8000) a = 0.95;
    else if (hz < 14000) a = 1.20;
    else a = 1.40;
    return a * factor;
  }

  function gainMask(re, im, noise, sr, N, opts) {
    const F = re.length, B = re[0].length;
    const maxRed = opts.maxReductionDb;
    const minG = Math.pow(10, -maxRed / 20);
    const over = opts.oversubtraction;
    const hfOnly = opts.hfOnlyHz || 0;
    const g = new Array(F);
    for (let f = 0; f < F; f++) {
      g[f] = new Float32Array(B);
      for (let k = 0; k < B; k++) {
        const hz = (k * sr) / N;
        if (hfOnly > 0 && hz < hfOnly) { g[f][k] = 1; continue; }
        const r = re[f][k], m = im[f][k];
        const mag = Math.sqrt(r * r + m * m);
        if (mag < 1e-12) { g[f][k] = 1; continue; }
        const v = (mag - alphaForHz(hz, over) * noise[k]) / mag;
        g[f][k] = Math.max(minG, Math.min(1, v));
      }
    }
    // Time smoothing
    const st = Math.max(0, opts.smoothTime | 0);
    let cur = g;
    if (st > 0) {
      const t = new Array(F);
      for (let f = 0; f < F; f++) {
        t[f] = new Float32Array(B);
        const a = Math.max(0, f - st), b = Math.min(F - 1, f + st);
        const den = b - a + 1;
        for (let k = 0; k < B; k++) {
          let s = 0;
          for (let j = a; j <= b; j++) s += cur[j][k];
          t[f][k] = s / den;
        }
      }
      cur = t;
    }
    // Frequency smoothing
    const sf = Math.max(0, opts.smoothFreq | 0);
    if (sf > 0) {
      const out = new Array(F);
      for (let f = 0; f < F; f++) {
        out[f] = new Float32Array(B);
        for (let k = 0; k < B; k++) {
          const a = Math.max(0, k - sf), b = Math.min(B - 1, k + sf);
          let s = 0;
          for (let j = a; j <= b; j++) s += cur[f][j];
          out[f][k] = s / (b - a + 1);
        }
      }
      return out;
    }
    return cur;
  }

  /**
   * Denoise one channel. Returns { clean, noise } Float32Arrays of exact input length.
   * When maxReductionDb <= 0, returns perfect reconstruction of input (within float error).
   */
  function denoiseChannel(raw, sr, opts) {
    opts = mergeSettings(opts);
    const N = opts.fftSize | 0;
    const H = Math.max(1, Math.floor(N * opts.hopRatio));
    const len = raw.length;

    if (opts.maxReductionDb <= 0) {
      const clean = new Float32Array(len);
      clean.set(raw);
      const noise = new Float32Array(len);
      return { clean, noise };
    }

    // Pad both ends by one FFT frame so every real sample has full overlap.
    const framesNeeded = Math.ceil((raw.length + 2 * N - N) / H) + 1;
    const totalLen = (framesNeeded - 1) * H + N;
    const sig = new Float32Array(totalLen);
    sig.set(raw, N);

    const sp = stft(sig, N, H);
    const prof = noiseProfile(sp.re, sp.im, opts.noisePercentile);
    const mask = gainMask(sp.re, sp.im, prof, sr, N, opts);

    const nr = new Array(sp.re.length), ni = new Array(sp.re.length);
    for (let f = 0; f < nr.length; f++) {
      nr[f] = new Float32Array(sp.re[0].length);
      ni[f] = new Float32Array(sp.re[0].length);
      for (let k = 0; k < nr[f].length; k++) {
        nr[f][k] = sp.re[f][k] * mask[f][k];
        ni[f][k] = sp.im[f][k] * mask[f][k];
      }
    }
    const denFull = istft(nr, ni, N, H, totalLen);
    const clean = new Float32Array(len);
    const noise = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const d = denFull[N + i];
      clean[i] = d;
      noise[i] = raw[i] - d;
    }
    return { clean, noise };
  }

  /** Perfect-reconstruction STFT round-trip (no masking) — for tests. */
  function stftRoundTrip(raw, fftSize, hopRatio) {
    const N = fftSize | 0;
    const H = Math.max(1, Math.floor(N * (hopRatio == null ? 0.25 : hopRatio)));
    const framesNeeded = Math.ceil((raw.length + 2 * N - N) / H) + 1;
    const totalLen = (framesNeeded - 1) * H + N;
    const sig = new Float32Array(totalLen);
    sig.set(raw, N);
    const sp = stft(sig, N, H);
    const full = istft(sp.re, sp.im, N, H, totalLen);
    const out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = full[N + i];
    return out;
  }

  // ---------- Biquad (Direct Form I) ----------
  function biquadCoeffs(type, freq, Q, gainDb, sr) {
    const w0 = 2 * Math.PI * Math.max(1, freq) / sr;
    const cos = Math.cos(w0), sin = Math.sin(w0);
    const A = Math.pow(10, gainDb / 40);
    const alpha = sin / (2 * Math.max(0.001, Q));
    let b0, b1, b2, a0, a1, a2;
    if (type === 'highpass') {
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
    } else if (type === 'lowshelf') {
      const S = 1, beta = Math.sqrt(A) / Q; // use Q as shelf slope proxy
      // RBJ lowshelf with S=1:
      const alpha2 = (sin / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
      b0 = A * ((A + 1) - (A - 1) * cos + 2 * Math.sqrt(A) * alpha2);
      b1 = 2 * A * ((A - 1) - (A + 1) * cos);
      b2 = A * ((A + 1) - (A - 1) * cos - 2 * Math.sqrt(A) * alpha2);
      a0 = (A + 1) + (A - 1) * cos + 2 * Math.sqrt(A) * alpha2;
      a1 = -2 * ((A - 1) + (A + 1) * cos);
      a2 = (A + 1) + (A - 1) * cos - 2 * Math.sqrt(A) * alpha2;
    } else if (type === 'highshelf') {
      const S = 1;
      const alpha2 = (sin / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
      b0 = A * ((A + 1) + (A - 1) * cos + 2 * Math.sqrt(A) * alpha2);
      b1 = -2 * A * ((A - 1) + (A + 1) * cos);
      b2 = A * ((A + 1) + (A - 1) * cos - 2 * Math.sqrt(A) * alpha2);
      a0 = (A + 1) - (A - 1) * cos + 2 * Math.sqrt(A) * alpha2;
      a1 = 2 * ((A - 1) - (A + 1) * cos);
      a2 = (A + 1) - (A - 1) * cos - 2 * Math.sqrt(A) * alpha2;
    } else { // peaking
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  function applyBiquad(input, c) {
    const out = new Float32Array(input.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      out[i] = y;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
    }
    return out;
  }

  // ---------- RMS glue compressor ----------
  function applyCompressor(input, sr, opts) {
    const thr = Math.pow(10, opts.compThresholdDb / 20);
    const ratio = Math.max(1.001, opts.compRatio);
    const knee = opts.compKneeDb;
    const atk = Math.exp(-1 / (sr * (opts.compAttackMs / 1000)));
    const rel = Math.exp(-1 / (sr * (opts.compReleaseMs / 1000)));
    const out = new Float32Array(input.length);
    let env = 0;
    const kneeStart = thr * Math.pow(10, -knee / 40);
    for (let i = 0; i < input.length; i++) {
      const x = Math.abs(input[i]);
      // RMS-ish: leaky square
      const sq = x * x;
      env = sq + (env - sq) * (sq > env ? atk : rel);
      const rms = Math.sqrt(Math.max(env, 1e-20));
      let gr = 1;
      if (rms > kneeStart) {
        const rmsDb = 20 * Math.log10(rms);
        const thrDb = opts.compThresholdDb;
        let grDb = 0;
        if (knee > 0 && rmsDb < thrDb + knee / 2) {
          // soft knee
          const xk = rmsDb - thrDb + knee / 2;
          grDb = ((1 / ratio - 1) * xk * xk) / (2 * knee);
        } else {
          grDb = (thrDb - rmsDb) * (1 - 1 / ratio);
        }
        gr = Math.pow(10, grDb / 20);
      }
      out[i] = input[i] * gr;
    }
    return out;
  }

  // ---------- Lookahead true-peak-ish limiter ----------
  function applyLimiter(input, sr, opts) {
    const ceiling = Math.pow(10, opts.limiterCeilingDb / 20);
    const la = Math.max(1, Math.round(sr * (opts.limiterLookaheadMs / 1000)));
    const rel = Math.exp(-1 / (sr * (opts.limiterReleaseMs / 1000)));
    const n = input.length;
    // Peak envelope with lookahead: for each sample, look ahead la samples for peak
    const env = new Float32Array(n);
    let peak = 0;
    // First pass: delayed envelope
    const delayed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ahead = i + la < n ? Math.abs(input[i + la]) : 0;
      if (ahead > peak) peak = ahead;
      else peak *= rel;
      // also consider current for release continuity
      const cur = Math.abs(input[i]);
      if (cur > peak) peak = cur;
      env[i] = peak;
    }
    // Better lookahead: sliding max over [i, i+la]
    const maxbuf = new Float32Array(n);
    // naive but correct for short la
    for (let i = 0; i < n; i++) {
      let m = 0;
      const end = Math.min(n, i + la + 1);
      for (let j = i; j < end; j++) {
        const a = Math.abs(input[j]);
        if (a > m) m = a;
      }
      maxbuf[i] = m;
    }
    // Smooth gain
    const out = new Float32Array(n);
    let gain = 1;
    const atk = Math.exp(-1 / (sr * 0.001)); // ~1ms attack
    for (let i = 0; i < n; i++) {
      const needed = maxbuf[i] > 1e-12 ? Math.min(1, ceiling / maxbuf[i]) : 1;
      if (needed < gain) gain = needed + (gain - needed) * atk; // fast attack toward lower gain
      else gain = needed + (gain - needed) * rel;
      // delay output by lookahead so gain reacts in time
      const srcIdx = i - la;
      if (srcIdx >= 0) out[i] = input[srcIdx] * gain;
      else out[i] = 0;
    }
    // Compensate delay: shift back (trim silence at end, keep length)
    const shifted = new Float32Array(n);
    for (let i = 0; i < n - la; i++) shifted[i] = out[i + la];
    // last la samples: process without further delay using final gain
    for (let i = n - la; i < n; i++) {
      const needed = Math.abs(input[i]) > 1e-12 ? Math.min(1, ceiling / Math.abs(input[i])) : 1;
      shifted[i] = input[i] * Math.min(gain, needed);
    }
    // Hard ceiling clamp (true-peak-ish safety)
    for (let i = 0; i < n; i++) {
      if (shifted[i] > ceiling) shifted[i] = ceiling;
      else if (shifted[i] < -ceiling) shifted[i] = -ceiling;
    }
    return shifted;
  }

  // ---------- K-weighted LUFS-ish ----------
  function kWeightFilter(input, sr) {
    // Simplified ITU-R BS.1770-ish: high shelf ~4dB @ 1500 + highpass ~38Hz
    const hs = biquadCoeffs('highshelf', 1500, 0.707, 4, sr);
    const hp = biquadCoeffs('highpass', 38, 0.5, 0, sr);
    return applyBiquad(applyBiquad(input, hs), hp);
  }

  function integratedLufs(channels, sr) {
    // Mean of channel energies after K-weight, then -0.691 offset (BS.1770)
    let sum = 0, count = 0;
    for (let c = 0; c < channels.length; c++) {
      const kw = kWeightFilter(channels[c], sr);
      for (let i = 0; i < kw.length; i++) { sum += kw[i] * kw[i]; count++; }
    }
    const mean = sum / Math.max(1, count);
    if (mean < 1e-20) return -70;
    return -0.691 + 10 * Math.log10(mean);
  }

  function peakOfChannels(channels) {
    let p = 0;
    for (let c = 0; c < channels.length; c++) {
      const d = channels[c];
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > p) p = a;
      }
    }
    return p;
  }

  function masterChannels(channels, sr, opts) {
    opts = mergeSettings(opts);
    const lufsBefore = integratedLufs(channels, sr);
    const nCh = channels.length;
    const len = channels[0].length;
    let staged = channels.map((ch) => ch.slice());

    // Highpass
    const hp = biquadCoeffs('highpass', opts.eqHighpassHz, 0.707, 0, sr);
    staged = staged.map((ch) => applyBiquad(ch, hp));

    // Low shelf
    if (Math.abs(opts.eqLowShelfDb) > 0.01) {
      const c = biquadCoeffs('lowshelf', opts.eqLowShelfHz, 0.707, opts.eqLowShelfDb, sr);
      staged = staged.map((ch) => applyBiquad(ch, c));
    }
    // Presence peaking
    if (Math.abs(opts.eqPresenceDb) > 0.01) {
      const c = biquadCoeffs('peaking', opts.eqPresenceHz, opts.eqPresenceQ, opts.eqPresenceDb, sr);
      staged = staged.map((ch) => applyBiquad(ch, c));
    }
    // High shelf
    if (Math.abs(opts.eqHighShelfDb) > 0.01) {
      const c = biquadCoeffs('highshelf', opts.eqHighShelfHz, 0.707, opts.eqHighShelfDb, sr);
      staged = staged.map((ch) => applyBiquad(ch, c));
    }

    // Glue compressor per channel (linked via max abs would be nicer; use mid for stereo)
    if (nCh === 2) {
      const mid = new Float32Array(len);
      for (let i = 0; i < len; i++) mid[i] = 0.5 * (staged[0][i] + staged[1][i]);
      // Derive gain from mid, apply to both
      const compressedMid = applyCompressor(mid, sr, opts);
      // approximate per-sample gain
      for (let i = 0; i < len; i++) {
        const g = Math.abs(mid[i]) > 1e-12 ? compressedMid[i] / mid[i] : 1;
        staged[0][i] *= g;
        staged[1][i] *= g;
      }
    } else {
      staged = staged.map((ch) => applyCompressor(ch, sr, opts));
    }

    // Limiter — link stereo by limiting on max abs envelope
    if (nCh === 2) {
      const maxAbs = new Float32Array(len);
      for (let i = 0; i < len; i++) maxAbs[i] = Math.max(Math.abs(staged[0][i]), Math.abs(staged[1][i]));
      // Build gain from mono max, apply to both via applying limiter to max then ratio
      const limMax = applyLimiter(maxAbs, sr, opts); // wrong polarity — better custom
      // Custom linked limiter:
      const ceiling = Math.pow(10, opts.limiterCeilingDb / 20);
      const la = Math.max(1, Math.round(sr * (opts.limiterLookaheadMs / 1000)));
      const rel = Math.exp(-1 / (sr * (opts.limiterReleaseMs / 1000)));
      const atk = Math.exp(-1 / (sr * 0.001));
      const maxbuf = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        let m = 0;
        const end = Math.min(len, i + la + 1);
        for (let j = i; j < end; j++) m = Math.max(m, Math.abs(staged[0][j]), Math.abs(staged[1][j]));
        maxbuf[i] = m;
      }
      let gain = 1;
      const out0 = new Float32Array(len), out1 = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const needed = maxbuf[i] > 1e-12 ? Math.min(1, ceiling / maxbuf[i]) : 1;
        if (needed < gain) gain = needed + (gain - needed) * atk;
        else gain = needed + (gain - needed) * rel;
        const si = i - la;
        if (si >= 0) { out0[i] = staged[0][si] * gain; out1[i] = staged[1][si] * gain; }
      }
      const sh0 = new Float32Array(len), sh1 = new Float32Array(len);
      for (let i = 0; i < len - la; i++) { sh0[i] = out0[i + la]; sh1[i] = out1[i + la]; }
      for (let i = len - la; i < len; i++) {
        const m = Math.max(Math.abs(staged[0][i]), Math.abs(staged[1][i]));
        const g = m > 1e-12 ? Math.min(1, ceiling / m) : 1;
        sh0[i] = staged[0][i] * Math.min(gain, g);
        sh1[i] = staged[1][i] * Math.min(gain, g);
      }
      for (let i = 0; i < len; i++) {
        if (sh0[i] > ceiling) sh0[i] = ceiling; else if (sh0[i] < -ceiling) sh0[i] = -ceiling;
        if (sh1[i] > ceiling) sh1[i] = ceiling; else if (sh1[i] < -ceiling) sh1[i] = -ceiling;
      }
      staged = [sh0, sh1];
      void limMax;
    } else {
      staged = staged.map((ch) => applyLimiter(ch, sr, opts));
    }

    // Final hard ceiling
    const ceiling = Math.pow(10, opts.limiterCeilingDb / 20);
    for (let c = 0; c < staged.length; c++) {
      const d = staged[c];
      for (let i = 0; i < d.length; i++) {
        if (d[i] > ceiling) d[i] = ceiling;
        else if (d[i] < -ceiling) d[i] = -ceiling;
      }
    }

    const lufsAfter = integratedLufs(staged, sr);
    const peak = peakOfChannels(staged);
    return { channels: staged, lufsBefore, lufsAfter, peak };
  }

  function denoiseBuffer(channels, sr, opts, onProgress) {
    opts = mergeSettings(opts);
    const clean = [], noise = [];
    for (let c = 0; c < channels.length; c++) {
      if (onProgress) onProgress(0.1 + 0.7 * (c / channels.length));
      const r = denoiseChannel(channels[c], sr, opts);
      clean.push(r.clean);
      noise.push(r.noise);
    }
    if (onProgress) onProgress(0.85);
    return { clean, noise };
  }

  // ---------- WAV encode ----------
  function encodeWav(channels, sr, bits) {
    bits = bits === 16 ? 16 : 24;
    const nCh = channels.length, len = channels[0].length;
    const bps = bits / 8, align = nCh * bps, dataSize = len * align;
    const ab = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(ab);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nCh, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * align, true); dv.setUint16(32, align, true); dv.setUint16(34, bits, true);
    str(36, 'data'); dv.setUint32(40, dataSize, true);
    let off = 44;
    // TPDF dither for 16-bit
    const ditherAmp = 1 / 65536; // ±1 LSB triangular at 16-bit
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < nCh; c++) {
        let s = channels[c][i];
        if (bits === 16) {
          const dith = ((Math.random() + Math.random()) - 1) * ditherAmp;
          s = Math.max(-1, Math.min(1, s + dith));
          dv.setInt16(off, s < 0 ? (s * 32768) | 0 : (s * 32767) | 0, true);
          off += 2;
        } else {
          s = Math.max(-1, Math.min(1, s));
          const v = (s < 0 ? s * 8388608 : s * 8388607) | 0;
          dv.setUint8(off, v & 255);
          dv.setUint8(off + 1, (v >> 8) & 255);
          dv.setUint8(off + 2, (v >> 16) & 255);
          off += 3;
        }
      }
    }
    return ab;
  }

  function db(x) { return x > 1e-20 ? 20 * Math.log10(x) : -120; }

  return {
    DEFAULTS, PRESETS, mergeSettings,
    fft, hann, stft, istft, stftRoundTrip,
    noiseProfile, gainMask, denoiseChannel, denoiseBuffer,
    masterChannels, integratedLufs, peakOfChannels, encodeWav, db,
    applyCompressor, applyLimiter, applyBiquad, biquadCoeffs,
  };
});
