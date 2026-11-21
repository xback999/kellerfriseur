// Startet Testdatenbank + simuliertes Supabase + API + Webserver + Browser für die Oberflächen-Tests.

import { createRequire } from 'node:module';
import { createTestDatabase } from './pg.mjs';
import { startFakeSupabase } from './fake-supabase.mjs';
import { startDevServer } from './dev-server.mjs';
import { createApp } from '../../netlify/lib/app.mjs';
import { createDb } from '../../netlify/lib/db.mjs';
import { loadConfig } from '../../netlify/lib/config.mjs';

const require = createRequire(import.meta.url);

export const KEY = 'test-service-key';
export const APP_SECRET = 'geheimes-app-secret-fuer-tests-0123456789';

export async function startEnv() {
  const tdb = await createTestDatabase();
  const fake = await startFakeSupabase({ db: tdb.name, expectKey: KEY });
  const mails = []; const mode = { ok: true };
  const mailer = {
    from: 'Kellerfriseur <onboarding@resend.dev>', configured: true,
    async send(m) { if (!mode.ok) return { ok: false, error: 'Resend 403: simulierter Fehler' }; mails.push(m); return { ok: true, id: `m${mails.length}` }; },
  };
  let site = '';
  const holder = {
    handle: (req, ctx) => app.handle(req, ctx),
  };
  const web = await startDevServer(holder);
  site = web.url;
  const config = loadConfig({ SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: KEY, APP_SECRET, SITE_URL: site });
  const app = createApp({ db: createDb({ url: fake.url, key: KEY }), config, mailer, log: { error() {}, warn() {}, log() {} } });

  // Hauptadmin einrichten
  const path = await tdb.sql(`select public.kf_bootstrap_owner('chef@beispiel.de', 'Chef Inhaber')`);
  const setupToken = path.split('=')[1];

  let browser;
  async function launch() {
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    return browser;
  }
  return {
    tdb, site, mails, mailMode: mode, setupToken, launch,
    password: 'sehr-sicheres-passwort',
    async close() { if (browser) await browser.close(); await web.close(); await fake.close(); tdb.drop(); },
  };
}
