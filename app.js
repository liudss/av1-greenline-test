'use strict';

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

const EDGE_ROWS = 24;        // rows sampled at each edge
const GREEN_MIN = 70;        // pixel counts as green when g - max(r,b) > this
const HIT_RATIO = 0.15;      // row is reported when this share of its pixels is green
const SAMPLE_INTERVAL = 120; // ms between analysed frames
const SCAN_MS = 1600;        // playback time per clip during the auto-scan

const CLIP_HEIGHTS = [886, 888, 890, 884, 1080, 1088, 720];
const HEIGHT_NOTES = {
  886: 'observed case (2 x 443)',
  888: '8-aligned',
  890: '2-aligned only',
  884: '4-aligned',
  1080: 'common 1080p',
  1088: '16 / 64 aligned',
  720: 'control 720p',
};

const CLIPS = CLIP_HEIGHTS.map(h => ({
  id: 'h' + h,
  label: `1920x${h}`,
  note: HEIGHT_NOTES[h] || '',
  url: `clips/av1_1920x${h}.mp4`,
  height: h,
}));

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

const $ = sel => document.querySelector(sel);

const video = $('#video');
const stage = $('#stage');
const stageEmpty = $('#stageEmpty');
const statusEl = $('#status');
const clipList = $('#clipList');
const resultsBody = $('#resultsBody');
const stripTop = $('#stripTop');
const stripBot = $('#stripBot');

document.querySelectorAll('[data-rows]').forEach(el => { el.textContent = EDGE_ROWS; });

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const results = new Map();  // id -> { id, w, h, frames, top:Map, bot:Map, maxScore, error }
let eyeball = loadEyeball();
let current = null;         // active clip descriptor
let scaleMode = 'fit';
let scanning = false;

/* Offscreen canvases hold the raw sampled rows (1:1, no smoothing). */
const hiddenTop = document.createElement('canvas');
const hiddenBot = document.createElement('canvas');
const ctxTop = hiddenTop.getContext('2d', { willReadFrequently: true });
const ctxBot = hiddenBot.getContext('2d', { willReadFrequently: true });
const stripCtxTop = stripTop.getContext('2d');
const stripCtxBot = stripBot.getContext('2d');

let taintWarned = false;
let frameSeen = false;   // true once the element has presented a frame of the *current* clip

/* requestVideoFrameCallback is one-shot, so re-arm it every frame: sampling right
   after a src change would otherwise read a canvas still holding the previous
   clip's pixels (stale green rows, wrong verdicts). */
function armFrameWatch() {
  if (typeof video.requestVideoFrameCallback !== 'function') {
    frameSeen = true;
    return;
  }
  video.requestVideoFrameCallback(() => {
    frameSeen = true;
    armFrameWatch();
  });
}

/* ------------------------------------------------------------------ *
 * Clip list
 * ------------------------------------------------------------------ */

function buildClipList() {
  for (const clip of CLIPS) {
    const btn = document.createElement('button');
    btn.className = 'clip';
    btn.dataset.id = clip.id;
    btn.innerHTML = `<span class="name">${clip.label}</span><span class="note">${clip.note}</span>`;
    btn.addEventListener('click', () => {
      loadClip(clip).then(() => video.play().catch(() => {}));
    });
    clipList.appendChild(btn);
  }
}

function markActive(id) {
  clipList.querySelectorAll('.clip').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });
}

/* ------------------------------------------------------------------ *
 * Playback
 * ------------------------------------------------------------------ */

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function applyScale() {
  if (!current) return;
  const w = video.videoWidth || current.width || 0;
  if (!w) return;

  if (scaleMode === 'fit') {
    video.style.width = '100%';
  } else {
    video.style.width = Math.round(w * Number(scaleMode)) + 'px';
  }
  video.style.height = 'auto';
}

function loadClip(clip) {
  current = clip;
  frameSeen = false;
  markActive(clip.id);
  stageEmpty.classList.add('hidden');
  video.classList.remove('hidden');

  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onError);
      resolve();
    };

    const onMeta = () => {
      applyScale();
      setStatus(`${clip.label} - decoded ${video.videoWidth}x${video.videoHeight}` +
        ` (H % 16 = ${video.videoHeight % 16}) - sampling...`);
      finish();
    };

    const onError = () => {
      const rec = ensureResult(clip.id);
      rec.error = 'decode failed or file missing';
      renderResults();
      setStatus(`${clip.label} - playback failed` +
        ` (${video.error ? 'code ' + video.error.code : 'unknown'});` +
        ' run tools/make-clips.ps1 first', 'bad');
      finish();
    };

    video.pause();
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onError);
    video.src = clip.url;
    video.load();
  });
}

/* ------------------------------------------------------------------ *
 * Sampling
 * ------------------------------------------------------------------ */

function readBand(canvas, ctx, fromBottom) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h || video.readyState < 2) return null;

  const band = Math.min(EDGE_ROWS, h);
  if (canvas.width !== w || canvas.height !== band) {
    canvas.width = w;
    canvas.height = band;
  }

  const sy = fromBottom ? h - band : 0;
  ctx.clearRect(0, 0, w, band);
  ctx.drawImage(video, 0, sy, w, band, 0, 0, w, band);

  let img;
  try {
    img = ctx.getImageData(0, 0, w, band);
  } catch {
    if (!taintWarned) {
      taintWarned = true;
      setStatus('Cannot read pixels (tainted canvas). Serve the page with ' +
        '"node serve.js" instead of opening index.html from disk.', 'bad');
    }
    return null;
  }

  const d = img.data;
  const rows = [];
  for (let r = 0; r < band; r++) {
    let hits = 0;
    let samples = 0;
    let maxScore = 0;
    let sum = 0;
    const base = r * w * 4;

    for (let x = 0; x < w; x += 2) {
      const i = base + x * 4;
      const R = d[i];
      const G = d[i + 1];
      const B = d[i + 2];
      const s = G - (R > B ? R : B);
      if (s > maxScore) maxScore = s;
      if (s > GREEN_MIN) hits++;
      sum += s;
      samples++;
    }

    rows.push({ row: r, ratio: hits / samples, maxScore, avg: sum / samples });
  }

  return { w, h, band, fromBottom, rows };
}

function record(band) {
  if (!band || !current) return;
  const rec = ensureResult(current.id);
  rec.w = band.w;
  rec.h = band.h;
  rec.frames++;

  const map = band.fromBottom ? rec.bot : rec.top;
  const baseRow = band.fromBottom ? band.h - band.band : 0;

  for (const row of band.rows) {
    const abs = baseRow + row.row;
    const prev = map.get(abs) || 0;
    if (row.ratio > prev) map.set(abs, row.ratio);
    if (row.maxScore > rec.maxScore) rec.maxScore = row.maxScore;
  }
}

function hitRows(map) {
  const out = [];
  for (const [row, ratio] of map) {
    if (ratio >= HIT_RATIO) out.push(row);
  }
  return out.sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ *
 * Live loop
 * ------------------------------------------------------------------ */

let lastSample = 0;

function tick(ts) {
  requestAnimationFrame(tick);
  if (ts - lastSample < SAMPLE_INTERVAL) return;
  lastSample = ts;
  sampleOnce();
}

/* One measurement of both edges at the current frame. Called by the sampling
   loop and, directly, by the test hooks so a capture never depends on the
   loop's cadence. */
function sampleOnce() {
  if (!current || video.readyState < 2 || !frameSeen) return false;

  const top = readBand(hiddenTop, ctxTop, false);
  const bot = readBand(hiddenBot, ctxBot, true);
  if (!top) return false;

  record(top);
  record(bot);

  drawStrip(stripCtxTop, stripTop, hiddenTop, top);
  drawStrip(stripCtxBot, stripBot, hiddenBot, bot);
  updateLiveStatus(top, bot);
  return true;
}

/* Magnify the sampled band into the visible filmstrip. `dest` is the strip
   canvas (the destination), `src` is the offscreen band canvas. */
function drawStrip(ctx, dest, src, band) {
  if (!band) return;
  const W = dest.width;
  const H = dest.height;
  if (!W || !H) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, band.w, band.band, 0, 0, W, H);
}

function updateLiveStatus(top, bot) {
  if (scanning) return;

  const topHits = hitRows(ratioMap(top));
  const botHits = hitRows(ratioMap(bot));
  const peak = Math.max(
    top.rows.reduce((m, r) => Math.max(m, r.maxScore), 0),
    bot.rows.reduce((m, r) => Math.max(m, r.maxScore), 0),
  );

  const label = `${current.label} - ${top.w}x${top.h} - H % 16 = ${top.h % 16}`;
  if (topHits.length || botHits.length) {
    const rows = topHits.length ? `top ${topHits.length}` : `bottom ${botHits.length}`;
    setStatus(`${label} - green edge rows detected (${rows}, peak ${Math.round(peak)})`, 'bad');
  } else {
    setStatus(`${label} - edges clean (peak ${Math.round(peak)})`, 'good');
  }
}

function ratioMap(band) {
  const m = new Map();
  band.rows.forEach(r => m.set(r.row, r.ratio));
  return m;
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

function ensureResult(id) {
  let rec = results.get(id);
  if (!rec) {
    rec = { id, w: 0, h: 0, frames: 0, top: new Map(), bot: new Map(), maxScore: 0, error: '' };
    results.set(id, rec);
  }
  return rec;
}

function renderResults() {
  const ids = CLIPS.map(c => c.id);
  if (results.has('custom')) ids.push('custom');

  resultsBody.innerHTML = '';

  for (const id of ids) {
    const rec = results.get(id);
    const clip = CLIPS.find(c => c.id === id);
    const label = clip ? clip.label : 'local file';

    const tr = document.createElement('tr');
    if (!rec) {
      tr.innerHTML = `<td class="mono">${label}</td><td colspan="6" class="no">not tested</td>`;
      resultsBody.appendChild(tr);
      continue;
    }

    if (rec.error) {
      tr.innerHTML = `<td class="mono">${label}</td><td colspan="6" class="yes">${rec.error}</td>`;
      resultsBody.appendChild(tr);
      continue;
    }

    const top = hitRows(rec.top);
    const bot = hitRows(rec.bot);
    const mod = rec.h ? rec.h % 16 : '?';
    const fmtRows = rows => rows.length
      ? `<span class="yes">${rows.slice(0, 6).join(', ')}${rows.length > 6 ? ' ...' : ''}</span>`
      : '<span class="no">-</span>';

    if (top.length || bot.length) tr.classList.add('hit');

    tr.innerHTML = `
      <td class="mono">${label}</td>
      <td class="mono">${rec.w}x${rec.h}</td>
      <td class="mono">${mod}</td>
      <td class="mono">${fmtRows(top)}</td>
      <td class="mono">${fmtRows(bot)}</td>
      <td class="mono">${Math.round(rec.maxScore)}</td>
      <td></td>`;

    const cell = tr.lastElementChild;
    const sel = document.createElement('select');
    sel.innerHTML = `
      <option value="">not checked</option>
      <option value="no">clean</option>
      <option value="yes">green line</option>
      <option value="other">other artifact</option>`;
    sel.value = eyeball[id] || '';
    sel.addEventListener('change', () => {
      eyeball[id] = sel.value;
      saveEyeball();
    });
    cell.appendChild(sel);

    resultsBody.appendChild(tr);
  }
}

function loadEyeball() {
  try {
    return JSON.parse(localStorage.getItem('av1gl.eyeball') || '{}');
  } catch {
    return {};
  }
}

function saveEyeball() {
  try {
    localStorage.setItem('av1gl.eyeball', JSON.stringify(eyeball));
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * Auto scan
 * ------------------------------------------------------------------ */

let scanPromise = null;

function scanAll() {
  if (scanPromise) return scanPromise;

  scanPromise = (async () => {
    scanning = true;
    $('#btnScan').disabled = true;

    try {
      for (let i = 0; i < CLIPS.length; i++) {
        const clip = CLIPS[i];
        setStatus(`Scanning ${i + 1}/${CLIPS.length} - ${clip.label} ...`);
        // reset per clip so a rescan reflects the current driver / flags
        results.delete(clip.id);
        await loadClip(clip);
        await video.play().catch(() => {});
        await new Promise(r => setTimeout(r, SCAN_MS));
        video.pause();
        renderResults();
      }
      setStatus('Scan complete. Compare 1088/720 against 886, then look at the modulus and chroma alignment.', 'good');
    } finally {
      scanning = false;
      $('#btnScan').disabled = false;
      renderResults();
    }
  })().finally(() => { scanPromise = null; });

  return scanPromise;
}

/* ------------------------------------------------------------------ *
 * Driver API (tools/shot.js)
 *
 * The page reports, the driver screenshots:
 *   out: { type: 'playing', id, w, h }  - first frame is actually on screen
 *   out: { type: 'idle' }               - paused, ready for the next clip
 *   out: { type: 'error', id }          - clip failed to load/decode
 *   in : __probe.list() / open(id) / stop()
 *
 * The driver injects the binding with Runtime.addBinding('__report').
 * ------------------------------------------------------------------ */

const report = payload => {
  if (typeof window.__report === 'function') window.__report(JSON.stringify(payload));
  else console.log('probe', payload);
};

window.__probe = {
  ready: () => true,
  list: () => CLIPS.map(c => ({ id: c.id, h: c.height })),

  scale: value => {
    scaleMode = String(value);
    applyScale();
    return true;
  },

  open(id) {
    const clip = CLIPS.find(c => c.id === id);
    if (!clip) {
      report({ type: 'error', id, reason: 'unknown clip' });
      return true;
    }

    scanning = false;
    results.delete(id);
    current = clip;
    frameSeen = false;
    markActive(id);
    stageEmpty.classList.add('hidden');

    video.pause();
    video.addEventListener('loadedmetadata', applyScale, { once: true });
    video.addEventListener('error', () => report({ type: 'error', id, reason: 'decode' }), { once: true });
    video.src = clip.url;
    video.play().catch(() => report({ type: 'error', id, reason: 'play' }));

    // Report only once the frame reached the compositor, then hold it so the
    // screenshot is deterministic.
    video.requestVideoFrameCallback(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      sampleOnce();
      video.pause();
      report({ type: 'playing', id, w: video.videoWidth, h: video.videoHeight });
    })));
    return true;
  },

  stop() {
    video.pause();
    report({ type: 'idle' });
    return true;
  },
};

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

$('#btnScan').addEventListener('click', scanAll);

$('#btnPlay').addEventListener('click', () => {
  if (!current) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
});

$('#btnFs').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen().catch(() => {});
});

$('#selScale').addEventListener('change', e => {
  scaleMode = e.target.value;
  applyScale();
});

$('#chkPixelated').addEventListener('change', e => {
  video.style.imageRendering = e.target.checked ? 'pixelated' : '';
});

$('#fileInput').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const clip = {
    id: 'custom',
    label: file.name,
    note: 'local file',
    url: URL.createObjectURL(file),
    height: 0,
  };
  results.delete('custom');
  loadClip(clip).then(() => video.play().catch(() => {}));
});

$('#btnCopyGpu').addEventListener('click', async () => {
  const text = [
    'chrome://gpu  ->  Video Decode / Video Encode: hardware accelerated?',
    'chrome://media-internals  ->  kVideoDecoderName / coded size / visible rect',
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Copied. Open chrome://gpu and chrome://media-internals and save both.', 'good');
  } catch {
    setStatus(text.replace(/\n/g, ' | '));
  }
});

video.addEventListener('resize', applyScale);

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

for (const canvas of [stripTop, stripBot]) {
  canvas.width = 1200;
  canvas.height = EDGE_ROWS * 6;
}

buildClipList();
renderResults();
armFrameWatch();
requestAnimationFrame(tick);

// ?auto=1 starts the scan immediately, for manual checks.
if (new URLSearchParams(location.search).get('auto') === '1') {
  scanAll();
}


