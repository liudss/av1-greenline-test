// Play every clip in Chrome, screenshot each one. ~85 lines, one blocking loop.
//
//   node tools/shot.js          -> out/clip-h<height>.png + out/chrome-gpu.png
//
// Chrome has no "play this and save a PNG" shell flag, so this drives it over the
// DevTools protocol; Page.captureScreenshot is the API DevTools itself uses.
//
// Handshake with the page (see __probe in app.js):
//   in : __probe.list() / open(id) / stop()
//   out: __report({type:'playing'}) -> screenshot -> __probe.stop() -> __report({type:'idle'})

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = 'http://localhost:8777/';
const PORT = 9300 + Math.floor(Math.random() * 600);
const OUT = path.resolve('out');

fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'av1gl-'))}`,
  '--autoplay-policy=no-user-gesture-required',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1980,1300',
  PAGE,
], { stdio: 'ignore' });

(async () => {
  // The debugger endpoint is a TCP socket, so wait for it to answer.
  let target;
  while (!target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.url.includes('8777'));
    } catch { /* not listening yet */ }
    if (!target) await new Promise(r => setTimeout(r, 100));
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));

  let seq = 0;
  const pending = new Map();
  const inbox = [];       // __report payloads not yet consumed
  let wake = null;        // set while someone waits for a payload

  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.bindingCalled' && m.params.name === '__report') {
      inbox.push(JSON.parse(m.params.payload));
      if (wake) { wake(); wake = null; }
    }
  });

  // Every call has a deadline, so a stuck Chrome surfaces as an error, not a hang.
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error('timeout: ' + method)), 15000);
    pending.set(id, m => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async expression => {
    const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text);
    return res.result?.result?.value;
  };

  // Block until the page reports the given event. No polling, and the deadline
  // timer is cleared so it cannot keep the process alive after the last clip.
  const signal = type => new Promise((resolve, reject) => {
    const take = () => {
      const i = inbox.findIndex(s => s.type === type);
      if (i < 0) return false;
      clearTimeout(timer);
      wake = null;
      resolve(inbox.splice(i, 1)[0]);
      return true;
    };
    const timer = setTimeout(() => {
      wake = null;
      reject(new Error('timeout waiting for ' + type));
    }, 10000);
    wake = take;
    take();   // already queued?
  });

  const event = method => new Promise(resolve => {
    const h = e => {
      if (JSON.parse(e.data).method === method) { ws.removeEventListener('message', h); resolve(); }
    };
    ws.addEventListener('message', h);
  });

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Runtime.addBinding', { name: '__report' });   // must exist before the page runs
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1980, height: 1300, deviceScaleFactor: 1, mobile: false,
  });

  // Evaluating before the new document commits leaves the call pending forever.
  const loaded = event('Page.loadEventFired');
  await call('Page.navigate', { url: PAGE });
  await loaded;
  await evaluate('__probe.ready()');

  const shot = async name => {
    const res = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(res.result.data, 'base64'));
    console.log('  out/' + name);
  };

  await evaluate('__probe.scale(1)');   // 1:1 native pixels

  for (const { id, h } of JSON.parse(await evaluate('JSON.stringify(__probe.list())'))) {
    process.stdout.write(`clip h${h}\n`);
    await evaluate(`__probe.open('${id}')`);
    const playing = await signal('playing');   // page: first frame is on screen
    await shot(`clip-h${playing.h}.png`);
    await evaluate('__probe.stop()');
    await signal('idle');                     // page: paused, next
  }

  ws.close();
  chrome.kill();
})().catch(e => { chrome.kill(); console.error('error: ' + e.message); process.exit(1); });

