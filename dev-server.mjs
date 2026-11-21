// Lokaler Testserver: liefert den Ordner "public" aus (mit den Header-Regeln aus netlify.toml,
// insbesondere der strengen Content-Security-Policy) und leitet /api/* an die echte API-Logik weiter.
// Nur für Tests. Auf Netlify übernehmen Netlify selbst diese Aufgaben.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../public', import.meta.url));
const TOML = readFileSync(fileURLToPath(new URL('../../netlify.toml', import.meta.url)), 'utf8');
export const CSP = /Content-Security-Policy\s*=\s*"([^"]+)"/.exec(TOML)?.[1];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export async function startDevServer(app) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const secHeaders = {
      'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
    };
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      headers.set('x-nf-client-connection-ip', req.headers['x-test-ip'] ?? req.socket.remoteAddress ?? '127.0.0.1');
      const origin = `http://${req.headers.host}`;
      const r = await app.handle(new Request(origin + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), {});
      const out = {}; r.headers.forEach((v, k) => { out[k] = v; });
      const cookies = r.headers.getSetCookie?.() ?? [];
      if (cookies.length) out['set-cookie'] = cookies;
      res.writeHead(r.status, out); res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let p = url.pathname;
    if (p === '/termin') p = '/termin/index.html';
    else if (p === '/admin') p = '/admin/index.html';
    else if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', ...secHeaders });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...secHeaders }); res.end('Nicht gefunden');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
