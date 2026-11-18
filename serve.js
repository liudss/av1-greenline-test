// Zero-dependency static server for the AV1 green-line test page.
//
//   node serve.js [port]
//
// Why a server instead of file://: a page loaded from file:// gets an opaque
// origin, and drawing the video into a canvas taints it, which kills the
// pixel-level green detection. http://127.0.0.1 keeps everything same-origin.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8777);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  let pathname = decodeURIComponent(parsed.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const target = path.normalize(path.join(ROOT, pathname));
  if (!target.startsWith(ROOT)) {
    return send(res, 403, { 'Content-Type': 'text/plain' }, 'forbidden');
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found: ' + pathname);
  }
  if (stat.isDirectory()) {
    return send(res, 404, { 'Content-Type': 'text/plain' }, 'not found');
  }

  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  // Range support: the <video> element needs it for seeking and for reliable
  // playback of local media.
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) {
      return send(res, 416, { 'Content-Range': `bytes */${stat.size}` }, '');
    }
    let start = m[1] === '' ? null : Number(m[1]);
    let end = m[2] === '' ? null : Number(m[2]);
    if (start === null && end === null) {
      return send(res, 416, { 'Content-Range': `bytes */${stat.size}` }, '');
    }
    if (start === null) {
      // suffix range: last N bytes
      start = Math.max(0, stat.size - end);
      end = stat.size - 1;
    } else {
      end = end === null ? stat.size - 1 : Math.min(end, stat.size - 1);
    }
    if (start > end || start >= stat.size) {
      return send(res, 416, { 'Content-Range': `bytes */${stat.size}` }, '');
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    return fs.createReadStream(target, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(target).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`AV1 green-line test  ->  http://${HOST}:${PORT}/`);
  console.log('Ctrl+C to stop.');
});
