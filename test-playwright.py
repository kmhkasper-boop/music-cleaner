#!/usr/bin/env python3
"""Headless UI smoke test + screenshots for Music Cleaner."""
import http.server, socketserver, threading, os, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT
PORT = 8765

os.chdir(ROOT)
Handler = http.server.SimpleHTTPRequestHandler
httpd = socketserver.TCPServer(('127.0.0.1', PORT), Handler)
httpd.allow_reuse_address = True
t = threading.Thread(target=httpd.serve_forever, daemon=True)
t.start()
print('serving', ROOT, 'on', PORT)

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    br = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = br.new_page(viewport={'width': 1280, 'height': 900})
    pg.goto(f'http://127.0.0.1:{PORT}/', wait_until='networkidle')
    pg.wait_for_selector('h1')
    assert 'Music Cleaner' in pg.inner_text('h1')
    assert pg.locator('#drop').is_visible()
    assert pg.locator('#noisePercentile').is_visible()
    # Presets
    pg.locator('button[data-preset="Gentle"]').click()
    pg.wait_for_timeout(200)
    assert 'on' in (pg.locator('button[data-preset="Gentle"]').get_attribute('class') or '')
    pct = pg.input_value('#noisePercentile')
    assert pct == '8', pct
    pg.locator('button[data-preset="Standard"]').click()
    pg.wait_for_timeout(200)
    assert pg.input_value('#noisePercentile') == '12'
    pg.locator('button[data-preset="Strong"]').click()
    pg.wait_for_timeout(200)
    assert pg.input_value('#maxReductionDb') == '12'
    pg.screenshot(path=str(OUT / 'screenshot-ui.png'), full_page=True)
    print('screenshot-ui.png')

    # Generate a tiny WAV in page and "upload" via DataTransfer is hard;
    # instead verify worker loads and DSP is present.
    ok = pg.evaluate('''() => {
      return !!(window.MusicCleanerDSP && MusicCleanerDSP.denoiseChannel && MusicCleanerDSP.PRESETS);
    }''')
    assert ok, 'DSP not on window'

    # Run a quick denoise in-page to populate visuals conceptually
    result = pg.evaluate('''() => {
      const sr = 44100, n = sr;
      const raw = new Float32Array(n);
      let seed = 1;
      const rnd = () => { seed = (seed*1103515245+12345)&0x7fffffff; return (seed/0x7fffffff)*2-1; };
      for (let i=0;i<n;i++){
        const t=i/sr;
        const gate=(t%0.5)<0.35?1:0.02;
        raw[i]=gate*0.4*Math.sin(2*Math.PI*220*t)+0.05*rnd();
      }
      const {clean,noise}=MusicCleanerDSP.denoiseChannel(raw,sr,{maxReductionDb:7,noisePercentile:0.12});
      const m=MusicCleanerDSP.masterChannels([clean],sr,{limiterCeilingDb:-1});
      return {
        len: clean.length===n && noise.length===n,
        peak: m.peak,
        lufs: m.lufsAfter,
        ceil: Math.pow(10,-1/20)
      };
    }''')
    assert result['len']
    assert result['peak'] <= result['ceil'] + 1e-4
    print('in-page DSP ok', result)

    # Settings persistence
    pg.locator('#maxReductionDb').fill('9')
    pg.locator('#maxReductionDb').dispatch_event('input')
    pg.wait_for_timeout(100)
    pg.reload(wait_until='networkidle')
    pg.wait_for_selector('#maxReductionDb')
    # localStorage should restore
    val = pg.input_value('#maxReductionDb')
    print('restored maxReductionDb', val)
    assert val == '9' or val == '9.0'

    pg.locator('button[data-preset="Standard"]').click()
    pg.wait_for_timeout(150)
    pg.screenshot(path=str(OUT / 'screenshot-settings.png'), full_page=True)
    print('screenshot-settings.png')

    # Empty state tracks pane
    assert 'No tracks yet' in pg.inner_text('#fileList')
    br.close()

httpd.shutdown()
print('ALL PLAYWRIGHT CHECKS PASSED')
