// Zero-dependency local server: serves the static app and mounts api/*.js
// with a minimal Vercel-style req/res. Usage: npm start  (PORT=3000 by default)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT) || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function decorate(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
  return res;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5);
      if (!/^[a-z0-9-]+$/i.test(name)) { res.statusCode = 404; return res.end('Not found'); }
      const path = join(root, 'api', `${name}.js`);
      if (!(await stat(path).catch(() => null))) { res.statusCode = 404; return res.end('Not found'); }
      const mod = await import(pathToFileURL(path).href);
      return await mod.default(req, decorate(res));
    }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (!p || p.endsWith('/')) p += 'index.html';
    const file = resolve(root, p);
    if (!file.startsWith(root) || /(^|[/\\])\.|node_modules|test|scripts|n8n/.test(p)) { res.statusCode = 404; return res.end('Not found'); }
    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.statusCode = 500; res.end('Server error'); }
  }
});

server.listen(PORT, () => console.log(`Invoice Extractor on http://localhost:${PORT}`));
