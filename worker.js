/* Music Cleaner DSP worker */
importScripts('dsp.js');
const DSP = self.MusicCleanerDSP;

self.onmessage = function (ev) {
  const msg = ev.data || {};
  const id = msg.id;
  try {
    if (msg.type === 'process') {
      const { channels, sampleRate, settings } = msg;
      // channels: Array of ArrayBuffer or Float32Array
      const chs = channels.map((c) => (c instanceof Float32Array ? c : new Float32Array(c)));
      const opts = DSP.mergeSettings(settings || {});
      self.postMessage({ id, type: 'progress', progress: 0.05 });

      const { clean, noise } = DSP.denoiseBuffer(chs, sampleRate, opts, (p) => {
        self.postMessage({ id, type: 'progress', progress: p });
      });

      let mastered = null;
      let report = {
        sampleRate,
        channels: chs.length,
        samples: chs[0].length,
        duration: chs[0].length / sampleRate,
        peakOriginal: DSP.db(DSP.peakOfChannels(chs)),
        peakClean: DSP.db(DSP.peakOfChannels(clean)),
        peakNoise: DSP.db(DSP.peakOfChannels(noise)),
        lufsOriginal: DSP.integratedLufs(chs, sampleRate),
        lufsClean: DSP.integratedLufs(clean, sampleRate),
      };

      if (opts.enableMaster) {
        self.postMessage({ id, type: 'progress', progress: 0.9 });
        const m = DSP.masterChannels(clean, sampleRate, opts);
        mastered = m.channels;
        report.lufsBeforeMaster = m.lufsBefore;
        report.lufsMastered = m.lufsAfter;
        report.peakMastered = DSP.db(m.peak);
        report.limiterCeilingDb = opts.limiterCeilingDb;
      }

      self.postMessage({ id, type: 'progress', progress: 1 });

      const transfer = [];
      const pack = (arrs) => arrs.map((a) => { transfer.push(a.buffer); return a.buffer; });
      const payload = {
        id,
        type: 'done',
        clean: pack(clean),
        noise: pack(noise),
        mastered: mastered ? pack(mastered) : null,
        report,
        length: chs[0].length,
        sampleRate,
        channelCount: chs.length,
      };
      self.postMessage(payload, transfer);
    } else if (msg.type === 'masterOnly') {
      const chs = msg.channels.map((c) => (c instanceof Float32Array ? c : new Float32Array(c)));
      const opts = DSP.mergeSettings(msg.settings || {});
      const m = DSP.masterChannels(chs, msg.sampleRate, opts);
      const transfer = [];
      const bufs = m.channels.map((a) => { transfer.push(a.buffer); return a.buffer; });
      self.postMessage({
        id, type: 'masterDone',
        channels: bufs,
        lufsBefore: m.lufsBefore,
        lufsAfter: m.lufsAfter,
        peak: DSP.db(m.peak),
      }, transfer);
    } else {
      self.postMessage({ id, type: 'error', error: 'Unknown message type' });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', error: (err && err.message) || String(err) });
  }
};
