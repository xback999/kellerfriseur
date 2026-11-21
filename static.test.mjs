// Statische Prüfungen (ohne Datenbank/Browser): Projektstruktur, Netlify-Konfiguration, keine Geheimnisse im Frontend,
// keine unsicheren Konstrukte, Einstiegspunkt der Netlify Function, Umgebungsvariablen-Dokumentation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
function walk(dir) {
  return readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
}
const publicFiles = walk(join(ROOT, 'public'));

test('Netlify-Konfiguration: Ordner existieren, kein Build nötig, Sicherheits-Header gesetzt', () => {
  const toml = read('netlify.toml');
  assert.match(toml, /publish\s*=\s*"public"/);
  assert.match(toml, /functions\s*=\s*"netlify\/functions"/);
  assert.ok(existsSync(join(ROOT, 'public/index.html')));
  assert.ok(existsSync(join(ROOT, 'public/admin/index.html')));
  assert.ok(existsSync(join(ROOT, 'public/termin/index.html')));
  assert.ok(existsSync(join(ROOT, 'netlify/functions/api.mjs')));
  assert.ok(!/^\s*command\s*=/m.test(toml), 'kein Build-Befehl');
  for (const h of ['Content-Security-Policy', 'X-Frame-Options', 'Strict-Transport-Security', 'Referrer-Policy', 'X-Content-Type-Options']) assert.ok(toml.includes(h), h);
  assert.match(toml, /script-src 'self'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(toml), 'CSP ohne unsafe-*');
  for (const from of ['/termin', '/admin']) assert.ok(toml.includes(`from = "${from}"`), `Weiterleitung ${from}`);
});

test('Frontend enthält keine Geheimnisse und keine Server-Bezeichner', () => {
  for (const f of publicFiles) {
    const text = readFileSync(f, 'utf8');
    for (const bad of ['service_role', 'SERVICE_ROLE', 'sb_secret', 'APP_SECRET', 'RESEND_API_KEY', 're_', 'eyJhbGci', 'supabase.co']) {
      if (bad === 're_' ) { assert.ok(!/\bre_[A-Za-z0-9]{10,}/.test(text), `${relative(ROOT, f)}: Resend-Schlüssel?`); continue; }
      assert.ok(!text.includes(bad), `${relative(ROOT, f)} enthält "${bad}"`);
    }
  }
});

test('Frontend ist CSP-tauglich: keine Inline-Skripte, -Styles oder -Handler, kein innerHTML/eval', () => {
  for (const f of publicFiles) {
    const rel = relative(ROOT, f); const text = readFileSync(f, 'utf8');
    if (f.endsWith('.html')) {
      assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(text), `${rel}: Inline-Skript`);
      assert.ok(!/<style[\s>]/i.test(text), `${rel}: Inline-Style`);
      assert.ok(!/\sstyle\s*=/i.test(text), `${rel}: style-Attribut`);
      assert.ok(!/\son[a-z]+\s*=/i.test(text), `${rel}: Inline-Handler`);
      assert.ok(!/(src|href)\s*=\s*"https?:\/\//i.test(text), `${rel}: externe Ressource`);
      assert.match(text, /<html lang="de">/); assert.match(text, /name="viewport"/);
    }
    if (f.endsWith('.js')) {
      assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(text), `${rel}: unsichere Einfügung`);
      assert.ok(!/setAttribute\(\s*['"]style['"]/.test(text), `${rel}: style per setAttribute (von CSP blockiert)`);
    }
  }
  for (const p of ['admin/index.html', 'termin/index.html']) assert.match(readFileSync(join(ROOT, 'public', p), 'utf8'), /noindex/, `${p} nicht für Suchmaschinen`);
});

test('Öffentliche Startseite enthält nur die Buchung (keine Unterseiten, keine Vorstellung)', () => {
  const html = read('public/index.html');
  assert.ok(!/<nav|<footer/i.test(html));
  assert.ok(!/<a\s/i.test(html), 'keine Links auf der Startseite');
  assert.ok(!/admin/i.test(html), 'Adminbereich nicht verlinkt');
});

test('Umgebungsvariablen: alle im Code genutzten Namen stehen in .env.example', () => {
  const used = new Set();
  for (const f of walk(join(ROOT, 'netlify'))) for (const m of readFileSync(f, 'utf8').matchAll(/env\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);
  assert.ok(used.size >= 6, [...used].join(','));
  const example = read('.env.example');
  for (const name of used) assert.ok(new RegExp(`^#?\\s*${name}=`, 'm').test(example), `${name} fehlt in .env.example`);
  assert.ok(!/eyJ|sb_secret_[A-Za-z0-9]{10,}|re_[A-Za-z0-9]{12,}/.test(example), 'keine echten Schlüssel in der Vorlage');
});

test('Keine externen Pakete nötig (kein npm install, kein Build)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.dependencies, {}); assert.deepEqual(pkg.devDependencies, {});
  assert.equal(pkg.type, 'module');
});

test('Einstiegspunkt der Netlify Function: Export, Pfad, Antwort bei fehlender Konfiguration', async () => {
  const keys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'APP_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM', 'SITE_URL'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]])); for (const k of keys) delete process.env[k];
  try {
    const mod = await import('../netlify/functions/api.mjs');
    assert.equal(typeof mod.default, 'function');
    assert.deepEqual(mod.config, { path: '/api/*' });
    const res = await mod.default(new Request('https://salon.test/api/health'), {});
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error, 'config_error');
    assert.ok(body.missing.includes('SUPABASE_URL') && body.missing.includes('APP_SECRET (mindestens 32 Zeichen)'));
  } finally { for (const k of keys) if (saved[k] !== undefined) process.env[k] = saved[k]; }
});
