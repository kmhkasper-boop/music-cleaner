#!/usr/bin/env node
'use strict';
const DSP = require('./dsp.js');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS', msg); }
  else { failed++; console.error('  FAIL', msg); }
}
function almostEqual(a, b, eps, msg) {
  const d = Math.abs(a - b);
  assert(d <= eps, msg + ' (diff=' + d + ')');
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

function rms(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length);
}

function snrDb(signal, noisy) {
  // signal vs (noisy - signal) as noise
  let ps = 0, pn = 0;
  for (let i = 0; i < signal.length; i++) {
    ps += signal[i] * signal[i];
    const n = noisy[i] - signal[i];
    pn += n * n;
  }
  return 10 * Math.log10(ps / Math.max(pn, 1e-30));
}

console.log('\n=== Music Cleaner DSP tests ===\n');

// 1) Perfect reconstruction via STFT round-trip
console.log('1. Perfect reconstruction (STFT/ISTFT, gain=1)');
{
  const sr = 44100;
  const n = 44100; // 1 second
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    raw[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr)
           + 0.3 * Math.sin(2 * Math.PI * 880 * i / sr)
           + 0.1 * Math.sin(2 * Math.PI * 1320 * i / sr);
  }
  const out = DSP.stftRoundTrip(raw, 4096, 0.25);
  assert(out.length === raw.length, 'output length exact (' + out.length + ')');
  const err = maxAbsDiff(raw, out);
  assert(err < 1e-6, 'round-trip max abs err < 1e-6 (got ' + err + ')');
}

// 2) Reduction off => output equals input
console.log('\n2. Reduction off (maxReductionDb=0) equals input');
{
  const sr = 48000;
  const n = 24000;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = Math.sin(2 * Math.PI * 1000 * i / sr) * 0.4;
  const { clean, noise } = DSP.denoiseChannel(raw, sr, { maxReductionDb: 0 });
  assert(clean.length === raw.length, 'clean length exact');
  assert(noise.length === raw.length, 'noise length exact');
  const err = maxAbsDiff(raw, clean);
  assert(err < 1e-6, 'clean == input within 1e-6 (got ' + err + ')');
  const nerr = maxAbsDiff(noise, new Float32Array(n));
  assert(nerr < 1e-6, 'noise track is zeros when reduction off');
}

// 3) Synthetic music + white noise: SNR improves
console.log('\n3. SNR improves on tones + white noise');
{
  const sr = 44100;
  const n = sr * 2;
  const cleanTruth = new Float32Array(n);
  const noisy = new Float32Array(n);
  // Deterministic LCG noise
  let seed = 123456789;
  const rand = () => { seed = (1103515245 * seed + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // tonal content (music-like partials) + quiet gaps every 0.5s for noise profile
    const gate = (t % 0.5) < 0.35 ? 1 : 0.02;
    cleanTruth[i] = gate * (
      0.4 * Math.sin(2 * Math.PI * 220 * t) +
      0.25 * Math.sin(2 * Math.PI * 330 * t) +
      0.15 * Math.sin(2 * Math.PI * 440 * t) +
      0.1 * Math.sin(2 * Math.PI * 550 * t)
    );
    const hiss = 0.08 * rand(); // broadband hiss
    noisy[i] = cleanTruth[i] + hiss;
  }
  const snrIn = snrDb(cleanTruth, noisy);
  const { clean } = DSP.denoiseChannel(noisy, sr, {
    noisePercentile: 0.15,
    maxReductionDb: 12,
    oversubtraction: 1.2,
    smoothTime: 1,
    smoothFreq: 1,
    fftSize: 4096,
  });
  assert(clean.length === noisy.length, 'denoised length exact');
  const snrOut = snrDb(cleanTruth, clean);
  console.log('   SNR in:', snrIn.toFixed(2), 'dB  →  SNR out:', snrOut.toFixed(2), 'dB  (Δ', (snrOut - snrIn).toFixed(2), 'dB)');
  assert(snrOut > snrIn + 1.5, 'SNR improves by > 1.5 dB');
}

// 4) Limiter ceiling holds
console.log('\n4. Limiter ceiling holds');
{
  const sr = 48000;
  const n = sr;
  const hot = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    hot[i] = 1.5 * Math.sin(2 * Math.PI * 100 * i / sr); // clips above 0 dBFS
  }
  const ceilingDb = -1;
  const ceiling = Math.pow(10, ceilingDb / 20);
  const limited = DSP.applyLimiter(hot, sr, {
    limiterCeilingDb: ceilingDb,
    limiterLookaheadMs: 5,
    limiterReleaseMs: 50,
  });
  const peak = DSP.peakOfChannels([limited]);
  console.log('   peak after limiter:', (20 * Math.log10(peak)).toFixed(3), 'dBFS  (ceiling', ceilingDb, ')');
  assert(peak <= ceiling + 1e-5, 'peak <= ceiling (peak=' + peak + ', ceil=' + ceiling + ')');
  assert(limited.length === hot.length, 'limiter preserves length');
}

// 5) Master chain ceiling + LUFS changes
console.log('\n5. Master chain');
{
  const sr = 44100;
  const n = sr;
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = 0.9 * Math.sin(2 * Math.PI * 220 * i / sr);
  const m = DSP.masterChannels([ch], sr, {
    enableMaster: true,
    limiterCeilingDb: -1,
    eqHighShelfDb: 1.5,
    eqPresenceDb: 1,
    eqLowShelfDb: 0.5,
    compThresholdDb: -18,
    compRatio: 2.5,
  });
  const ceil = Math.pow(10, -1 / 20);
  assert(m.peak <= ceil + 1e-4, 'mastered peak <= -1 dBFS');
  assert(m.channels[0].length === n, 'master length exact');
  assert(typeof m.lufsBefore === 'number' && typeof m.lufsAfter === 'number', 'LUFS reported');
  console.log('   LUFS before', m.lufsBefore.toFixed(1), 'after', m.lufsAfter.toFixed(1), 'peak', (20*Math.log10(m.peak)).toFixed(2), 'dBFS');
}

// 6) WAV encode 16/24
console.log('\n6. WAV encode');
{
  const sr = 44100;
  const ch = [new Float32Array(256)];
  for (let i = 0; i < 256; i++) ch[0][i] = Math.sin(i / 10) * 0.5;
  const w16 = DSP.encodeWav(ch, sr, 16);
  const w24 = DSP.encodeWav(ch, sr, 24);
  assert(w16.byteLength === 44 + 256 * 2, '16-bit size');
  assert(w24.byteLength === 44 + 256 * 3, '24-bit size');
  const dv = new DataView(w16);
  assert(dv.getUint16(34, true) === 16, 'bits=16 in header');
}

console.log('\n=== Results:', passed, 'passed,', failed, 'failed ===\n');
process.exit(failed ? 1 : 0);
