import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = parseInt(process.env.PORT || '8080', 10);
const UPSTREAM = 'https://api.openshift.com/api/upgrades_info/v1/graph';
const CACHE_TTL_MS = 60 * 60 * 1000;
const DIST = join(fileURLToPath(import.meta.url), '..', 'dist');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const cache = new Map();

async function proxyGraph(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const channel = url.searchParams.get('channel') || '';
  const arch = url.searchParams.get('arch') || 'amd64';
  const key = `${channel}|${arch}`;

  const now = Date.now();
  const cached = cache.get(key);

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Cache': 'HIT',
      'X-Fetched-At': new Date(cached.fetchedAt).toISOString(),
    });
    res.end(cached.body);
    if (now - cached.fetchedAt > CACHE_TTL_MS * 0.8) {
      refreshInBackground(channel, arch, key);
    }
    return;
  }

  try {
    const upstream = `${UPSTREAM}?channel=${encodeURIComponent(channel)}&arch=${encodeURIComponent(arch)}`;
    const resp = await fetch(upstream, { headers: { Accept: 'application/json' } });
    const body = await resp.text();
    cache.set(key, { body, fetchedAt: now });
    res.writeHead(resp.status, {
      'Content-Type': 'application/json',
      'X-Cache': 'MISS',
      'X-Fetched-At': new Date(now).toISOString(),
    });
    res.end(body);
  } catch (err) {
    if (cached) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Cache': 'STALE',
        'X-Fetched-At': new Date(cached.fetchedAt).toISOString(),
      });
      res.end(cached.body);
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}

function refreshInBackground(channel, arch, key) {
  const upstream = `${UPSTREAM}?channel=${encodeURIComponent(channel)}&arch=${encodeURIComponent(arch)}`;
  fetch(upstream, { headers: { Accept: 'application/json' } })
    .then(r => r.text())
    .then(body => { cache.set(key, { body, fetchedAt: Date.now() }); })
    .catch(() => {});
}

async function serveStatic(req, res) {
  let pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
  if (pathname === '/') pathname = '/index.html';

  const filePath = join(DIST, pathname);
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403); res.end(); return;
  }

  try {
    await stat(filePath);
  } catch {
    const indexPath = join(DIST, 'index.html');
    try {
      const html = await readFile(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(404); res.end('Not Found');
    }
    return;
  }

  const ext = extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';
  const data = await readFile(filePath);

  const headers = { 'Content-Type': contentType };
  if (pathname.startsWith('/assets/')) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  }

  res.writeHead(200, headers);
  res.end(data);
}

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/graph')) {
    proxyGraph(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`listening on :${PORT} | dist=${DIST}`);
});
