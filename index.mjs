// Einstiegspunkt für Vercel. Alle Adressen unter /api/... landen (per Regel in vercel.json) hier.
// Die gesamte Logik steckt in netlify/lib/app.mjs (dort getestet) – der Ordnername ist nur historisch.

import { createApp } from '../netlify/lib/app.mjs';
import { loadConfig } from '../netlify/lib/config.mjs';
import { createDb } from '../netlify/lib/db.mjs';
import { createMailer } from '../netlify/lib/mailer.mjs';

let app;

function getApp() {
  if (!app) {
    const config = loadConfig(process.env);
    app = createApp({
      config,
      db: createDb({ url: config.supabaseUrl || 'http://invalid.local', key: config.supabaseKey || 'missing' }),
      mailer: createMailer({ apiKey: config.resendApiKey, from: config.emailFrom }),
    });
  }
  return app;
}

/** Stellt die ursprüngliche Adresse (/api/...) und eine vertrauenswürdige Client-IP her. */
export function normalizeRequest(req) {
  const url = new URL(req.url);
  const p = url.searchParams.get('__p');
  if (p !== null) {
    url.searchParams.delete('__p');
    url.pathname = '/api/' + p.replace(/^\/+/, '');
  }
  const headers = new Headers(req.headers);
  // Dieser Header gehört zu Netlify und darf von außen nicht vorgegeben werden.
  headers.delete('x-nf-client-connection-ip');
  const ip = headers.get('x-vercel-forwarded-for') || headers.get('x-real-ip')
    || (headers.get('x-forwarded-for') || '').split(',')[0].trim();
  if (ip) headers.set('x-nf-client-connection-ip', ip);
  const hasBody = !['GET', 'HEAD'].includes(req.method.toUpperCase());
  return new Request(url, { method: req.method, headers, body: hasBody ? req.body : undefined, ...(hasBody ? { duplex: 'half' } : {}) });
}

export default {
  async fetch(req) {
    return getApp().handle(normalizeRequest(req), {});
  },
};
