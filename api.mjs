// Einstiegspunkt der Netlify Function. Alle Adressen unter /api/* landen hier.
// Die gesamte Logik steckt in ../lib/app.mjs (dort getestet).

import { createApp } from '../lib/app.mjs';
import { loadConfig } from '../lib/config.mjs';
import { createDb } from '../lib/db.mjs';
import { createMailer } from '../lib/mailer.mjs';

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

export default async (req, context) => getApp().handle(req, context);

export const config = {
  path: '/api/*',
};
