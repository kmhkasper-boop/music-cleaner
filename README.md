# Music Cleaner

Browser-based STFT spectral cleanup for AI-generated (Suno) music. Built for Lucas Casca — works alongside Ableton, Audition and Studio One.

**Live:** https://kmhkasper-boop.github.io/music-cleaner/

Inspired by [Music Cleanup Pro v2](https://musiccleanerpro.musictechtools.xyz/), with adjustable settings, presets, a Web Worker DSP path, and a master chain.

## Features

- Batch WAV/MP3 upload — decoded with `AudioContext.decodeAudioData`, processed fully in-browser
- STFT spectral subtraction (Hann window, 75% overlap, default FFT 4096) with original phase preserved
- Noise profile from a percentile of the quietest frames (adjustable)
- Soft gain subtraction with oversubtraction, max-reduction cap, time/frequency smoothing, optional HF-only mode
- Noise track = original − clean; sample-exact length
- Master: highpass · low/high shelf · presence EQ · RMS glue compressor · lookahead limiter (−1 dBFS default)
- A/B/C/D preview (Original / Clean / Mastered / Noise) without losing play position
- Waveform + before/after spectrum
- Presets: Gentle · Standard · Strong (settings remembered in `localStorage`)
- Export WAV 24-bit or 16-bit (TPDF dither), `name_clean.wav` / `name_mastered.wav`, download all

## Defaults (Standard)

| Setting | Default |
|---|---|
| Noise percentile | 12% |
| Max reduction | 7 dB |
| Oversubtraction | 1.0× |
| Time / freq smooth | 1 / 1 |
| HF-only | off |
| FFT size | 4096 |
| Limiter ceiling | −1 dBFS |
| Comp threshold / ratio | −18 dB / 2.5:1 |

## Run locally

```bash
cd music-cleaner
python3 -m http.server 8765
# open http://127.0.0.1:8765/
```

## Tests

```bash
node test-dsp.js
python3 test-playwright.py   # needs Playwright + Chromium
```

## Honest limitations

- Broadband hiss / static only — not hum, clicks, room reverb, or musical artefact repair
- Noise profile is estimated from quiet frames of the same file (no separate noise print)
- Aggressive settings can soft-gate quiet reverb tails or breathe (musical noise); prefer Gentle / HF-only for vocals
- LUFS is a K-weighted approximation, not a certified BS.1770 meter
- Limiter is peak/lookahead sample-peak, not true inter-sample oversampling TP
- Large files (long stereo 48 kHz) can take tens of seconds; UI stays responsive via a Worker
- No server — refresh clears unsaved buffers (settings persist)

## License

Personal tool for Lucas Casca. DSP approach shares the classic spectral-subtraction lineage used by many offline cleaners.
