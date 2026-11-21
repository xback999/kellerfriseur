// Oberflächen-Tests im ECHTEN Browser (Chromium via Playwright) gegen die komplette Anwendung:
// Webseite + API + echte PostgreSQL-Testdatenbank (E-Mail-Dienst und Supabase-Schnittstelle simuliert).
// Prüft auch die strenge Content-Security-Policy (jeder Verstoß zählt als Fehler).

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { pgAvailable } from './helpers/pg.mjs';
import { startEnv } from './helpers/browser-env.mjs';
import { addDays, localDateStr, parseLocalDateTime } from '../netlify/lib/time.mjs';
import { sha256Hex } from '../netlify/lib/crypto.mjs';

let HAVE_BROWSER = false;
try { const { createRequire } = await import('node:module'); createRequire(import.meta.url)('playwright'); HAVE_BROWSER = true; } catch { /* kein Browser */ }
const opts = { skip: pgAvailable() && HAVE_BROWSER ? false : 'Keine Testdatenbank oder kein Browser verfügbar' };

const SHOTS = process.env.KF_SHOTS ?? '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let env; let browser; const problems = [];
const day = (n) => addDays(localDateStr(Date.now()), n);
const iso = (date, hhmm) => new Date(parseLocalDateTime(`${date}T${hhmm}`)).toISOString();
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const VIEWPORTS = { mobile: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1440, height: 900 } };

before(async () => {
  if (opts.skip) return;
  env = await startEnv();
  browser = await env.launch();
});
after(async () => { if (env) await env.close(); });

async function newPage(vp = 'mobile', { ip, tz = 'America/New_York' } = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[vp], locale: 'de-DE', timezoneId: tz, extraHTTPHeaders: { 'x-test-ip': ip ?? `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${page.url()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${page.url()}] PAGEERROR ${e.message}`));
  await page.addInitScript(() => { window.addEventListener('securitypolicyviolation', (e) => console.error('CSP-Verstoß: ' + e.violatedDirective + ' ' + e.blockedURI)); });
  return page;
}
const noOverflow = async (page, label) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 1, `${label}: horizontaler Überlauf von ${over}px`);
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };

async function pickDay(page, date) {
  if (!(await page.locator(`.daybtn[data-date="${date}"]:not(.other)`).count())) {
    await page.click('[data-nav="today"]'); await page.waitForTimeout(200);
    for (let i = 0; i < 4 && !(await page.locator(`.daybtn[data-date="${date}"]:not(.other)`).count()); i++) {
      await page.click('[data-nav="next"]'); await page.waitForTimeout(200);
    }
  }
  await page.waitForFunction((d) => { const b = document.querySelector(`.daybtn[data-date="${d}"]`); return b && !b.disabled; }, date);
  await page.click(`.daybtn[data-date="${date}"]`);
}

const seed = async ({ start, end, name, email = null, phone = null, status = 'confirmed', source = 'manual', note = null, internal = null }) => {
  const id = randomUUID();
  await env.tdb.sql(`insert into kf_bookings(id,start_at,end_at,status,source,customer_name,customer_email,customer_phone,customer_note,internal_note,token_salt,token_hash) values (${q(id)}, ${q(start)}, ${q(end)}, ${q(status)}, ${q(source)}, ${q(name)}, ${email ? q(email) : 'null'}, ${phone ? q(phone) : 'null'}, ${note ? q(note) : 'null'}, ${internal ? q(internal) : 'null'}, 's', ${q(sha256Hex(id))})`);
  return id;
};

let manageUrl; const D = { book: day(3) };

// =====================================================================================
test('Kundenseite: Kalender, Woche/Monat, Zeiten in Berliner Zeit trotz anderer Geräte-Zeitzone', opts, async () => {
  const page = await newPage('mobile');
  await page.goto(env.site + '/');
  await page.waitForSelector('.daybtn.free');
  assert.equal(await page.title(), 'Kellerfriseur – Termin buchen');
  assert.equal(await page.locator('h1').innerText(), 'Termin buchen');
  assert.equal(await page.locator('nav, .nav, footer').count(), 0, 'keine Unterseiten/Navigation');
  assert.ok(await page.locator(`.daybtn[data-date="${day(0)}"]`).isEnabled(), 'heute buchbar');
  assert.ok(await page.locator(`.daybtn[data-date="${day(-1)}"]`).isDisabled(), 'gestern nicht');
  await pickDay(page, day(30));
  assert.equal(await page.locator('.chip:not([disabled])').count() > 0, true, 'Tag 30 noch buchbar');
  const beyond = page.locator(`.daybtn[data-date="${day(31)}"]`);
  if (await beyond.count()) assert.ok(await beyond.isDisabled(), 'Tag 31 gesperrt');
  await pickDay(page, D.book);
  assert.equal(await page.locator('.chip').count(), 96, '24/7: 96 Startzeiten');
  assert.equal(await page.locator('.chip:not([disabled])').count(), 96);
  assert.equal(await page.locator(`.chip[data-start="${iso(D.book, '10:15')}"]`).innerText(), '10:15', 'Anzeige in Berliner Zeit');
  await page.click('[data-view="week"]');
  await page.waitForSelector('.week .daybtn');
  assert.equal(await page.locator('.week .daybtn').count(), 7);
  assert.equal(await page.locator('.cal-title').innerText().then((t) => t.includes('–')), true);
  await page.click('[data-nav="next"]'); await page.click('[data-nav="next"]'); await page.waitForTimeout(200);
  assert.equal(await page.locator('.week .daybtn').count(), 7, 'mehrere Wochen blättern');
  await page.click('[data-nav="today"]');
  await page.waitForFunction(() => document.querySelector('[data-nav="prev"]').disabled);
  assert.ok(await page.locator('[data-nav="prev"]').isDisabled(), 'nicht in die Vergangenheit blättern');
  await page.click('[data-view="month"]');
  await page.waitForSelector('.month');
  await noOverflow(page, 'Kundenseite Handy');
  await page.context().close();
});

test('Buchung im Browser: Formular, Erfolgsmeldung, Reservierung, persönlicher Link', opts, async () => {
  const page = await newPage('mobile');
  await page.goto(env.site + '/');
  await pickDay(page, D.book);
  await page.click(`.chip[data-start="${iso(D.book, '10:00')}"]`);
  assert.match(await page.locator('#summary').innerText(), /10:00 bis 11:00 Uhr/);
  await page.click('#submit');
  assert.match(await page.locator('#booking-form .alert').innerText(), /Vor- und Nachnamen/);
  await page.fill('#first', 'Anna'); await page.fill('#last', 'Beispiel'); await page.fill('#email', 'kaputt');
  await page.click('#submit');
  assert.match(await page.locator('#booking-form .alert').innerText(), /gültige E-Mail/);
  await page.fill('#email', 'anna@test.de'); await page.fill('#phone', '0170 1234567'); await page.fill('#note', 'Nur Spitzen schneiden');
  await shot(page, 'kunde-formular-mobil');
  await page.click('#submit');
  await page.waitForSelector('#success');
  assert.match(await page.locator('#success').innerText(), /Deine Terminanfrage wurde erfolgreich übermittelt/);
  assert.match(await page.locator('#success').innerText(), /10:00 bis 11:00 Uhr/);
  manageUrl = await page.locator('#manage-link').getAttribute('href');
  assert.match(manageUrl, /^\/termin#[A-Za-z0-9_-]{43}$/);
  const row = JSON.parse(await env.tdb.sql(`select to_jsonb(b) from kf_bookings b where customer_email='anna@test.de'`));
  assert.equal(row.status, 'requested');
  assert.equal(row.source, 'online');
  assert.equal(row.customer_name, 'Anna Beispiel');
  assert.equal(new Date(row.start_at).toISOString(), iso(D.book, '10:00'));
  assert.ok(!row.token_hash.includes(manageUrl.split('#')[1]), 'nur Hash gespeichert');
  assert.ok(env.mails.some((m) => m.to === 'anna@test.de' && /eingegangen/.test(m.subject)), 'Eingangsbestätigung');
  assert.ok(env.mails.some((m) => m.to === 'lcordella818@gmail.com' && /Neue Terminanfrage/.test(m.subject)), 'Admin-Benachrichtigung');
  await shot(page, 'kunde-erfolg-mobil');
  await noOverflow(page, 'Erfolgsseite');
  await page.context().close();
});

test('Zwei Kunden gleichzeitig: der zweite bekommt eine Meldung, Eingaben bleiben, Zeit wird gesperrt angezeigt', opts, async () => {
  const a = await newPage('mobile'); const b = await newPage('desktop');
  for (const p of [a, b]) { await p.goto(env.site + '/'); await pickDay(p, D.book); }
  const slot = iso(D.book, '14:00');
  await a.click(`.chip[data-start="${slot}"]`); await b.click(`.chip[data-start="${slot}"]`);
  for (const [p, n] of [[a, 'Erste'], [b, 'Zweite']]) { await p.fill('#first', n); await p.fill('#last', 'Person'); await p.fill('#email', `${n.toLowerCase()}@test.de`); }
  await a.click('#submit'); await a.waitForSelector('#success');
  await b.click('#submit');
  await b.waitForSelector('.times .alert.error');
  assert.match(await b.locator('.times .alert').innerText(), /nicht mehr verfügbar/);
  await b.waitForSelector(`.chip[data-start="${slot}"][disabled]`);
  assert.equal(await b.locator('.chip.selected').count(), 0);
  await b.click(`.chip[data-start="${iso(D.book, '15:00')}"]`);
  assert.equal(await b.inputValue('#first'), 'Zweite', 'Eingaben bleiben erhalten');
  assert.equal(await b.inputValue('#email'), 'zweite@test.de');
  assert.equal(await env.tdb.sql(`select count(*) from kf_bookings where start_at=${q(slot)} and status in ('requested','confirmed')`), '1');
  await a.context().close(); await b.context().close();
});

test('Kundenseite zeigt belegte Zeiten (Termin + Sperre) gleich, ohne Personendaten', opts, async () => {
  await seed({ start: iso(D.book, '16:00'), end: iso(D.book, '17:30'), name: 'Geheim Person', phone: '0151 999', note: 'privat', internal: 'INTERN-X', source: 'manual' });
  await env.tdb.sql(`insert into kf_blocks(start_at,end_at,reason) values (${q(iso(D.book, '20:00'))}, ${q(iso(D.book, '21:00'))}, 'Arzt-Geheim')`);
  const page = await newPage('desktop');
  await page.goto(env.site + '/'); await pickDay(page, D.book);
  const dis = (hhmm) => page.locator(`.chip[data-start="${iso(D.book, hhmm)}"]`).isDisabled();
  assert.equal(await dis('15:15'), true, 'würde in den Termin ab 16:00 ragen (60 Min)');
  assert.equal(await dis('15:00'), false, '15:00-16:00 direkt davor frei');
  assert.equal(await dis('16:00'), true); assert.equal(await dis('17:15'), true);
  assert.equal(await dis('17:30'), false, 'direkt danach frei');
  assert.equal(await dis('19:30'), true, 'ragt in die Sperre'); assert.equal(await dis('20:30'), true); assert.equal(await dis('21:00'), false);
  const html = await page.content();
  for (const s of ['Geheim', 'INTERN-X', 'Arzt', '0151', 'privat']) assert.ok(!html.includes(s), `Seite darf "${s}" nicht enthalten`);
  await shot(page, 'kunde-desktop');
  await noOverflow(page, 'Kundenseite Desktop');
  await page.context().close();
});

test('Persönlicher Link: Status sehen, Rückfrage, Absage, Zeitraum wieder frei', opts, async () => {
  const page = await newPage('mobile');
  await page.goto(env.site + manageUrl);
  await page.waitForSelector('#booking-card');
  assert.match(await page.locator('#booking-card').innerText(), /Offen/);
  assert.match(await page.locator('#when').innerText(), /10:00 bis 11:00 Uhr/);
  const text = await page.content();
  for (const s of ['anna@test.de', '0170', 'Nur Spitzen']) assert.ok(!text.includes(s), `Link-Seite darf "${s}" nicht zeigen`);
  await shot(page, 'termin-mobil');
  await page.click('#cancel-btn');
  assert.match(await page.locator('dialog').innerText(), /wirklich zurückziehen/);
  await page.click('dialog button:text-is("Zurück")');
  await page.waitForFunction(() => !document.querySelector('dialog'));
  assert.equal(await env.tdb.sql(`select status from kf_bookings where customer_email='anna@test.de'`), 'requested', 'Abbrechen ändert nichts');
  await page.click('#cancel-btn'); await page.click('dialog >> text=Ja, zurückziehen');
  await page.waitForSelector('.alert.ok');
  assert.match(await page.locator('#booking-card').innerText(), /Zurückgezogen/);
  assert.equal(await page.locator('#cancel-btn').count(), 0, 'nicht erneut bearbeitbar');
  assert.equal(await env.tdb.sql(`select status from kf_bookings where customer_email='anna@test.de'`), 'withdrawn');
  assert.ok(env.mails.some((m) => m.to === 'anna@test.de' && /zurückgezogen/.test(m.subject)));
  const free = await newPage('mobile'); await free.goto(env.site + '/'); await pickDay(free, D.book);
  assert.equal(await free.locator(`.chip[data-start="${iso(D.book, '10:00')}"]`).isDisabled(), false, 'Zeitraum wieder frei');
  await free.context().close();
  const bad = await newPage('mobile'); await bad.goto(env.site + '/termin#' + 'A'.repeat(43));
  await bad.waitForSelector('.alert.error');
  assert.match(await bad.locator('.alert').innerText(), /ungültig/);
  await bad.context().close(); await page.context().close();
});

// =====================================================================================
let admin; // { page }
test('Admin: Einrichtung über Einladungslink und Anmeldung', opts, async () => {
  const page = await newPage('tablet', { ip: '10.9.9.9' });
  await page.goto(env.site + '/admin/#setup=' + env.setupToken);
  await page.waitForSelector('#setup-form');
  await page.fill('#setup-form input >> nth=0', 'kurz'); await page.fill('#setup-form input >> nth=1', 'kurz');
  await page.click('#setup-form button');
  await page.waitForSelector('#setup-form .alert, .alert.error');
  await page.fill('#setup-form input >> nth=0', env.password); await page.fill('#setup-form input >> nth=1', env.password);
  await page.click('#setup-form button');
  await page.waitForSelector('.tab');
  assert.equal(await page.locator('.tab[aria-selected="true"]').innerText().then((t) => t.startsWith('Anfragen')), true, 'Startseite = Anfragen');
  assert.ok(!page.url().includes('setup='), 'Token aus der Adresszeile entfernt');
  await page.click('#logout'); await page.waitForSelector('#login-form');
  await page.fill('#login-form input[type=email]', 'chef@beispiel.de'); await page.fill('#login-form input[type=password]', 'falsch!!!!!!');
  await page.click('#login-form button'); await page.waitForSelector('.alert.error');
  await page.fill('#login-form input[type=password]', env.password); await page.click('#login-form button');
  await page.waitForSelector('.tab');
  await page.reload(); await page.waitForSelector('.tab');
  admin = page;
});

test('Admin: Anfragen annehmen und ablehnen (Startseite zeigt nur offene Anfragen)', opts, async () => {
  const xss = '<img src=x onerror="window.__xss=1">Mallory';
  const a = await seed({ start: iso(day(4), '09:00'), end: iso(day(4), '10:00'), name: 'Berta Annahme', email: 'berta@test.de', phone: '0171 22', status: 'requested', source: 'online', note: 'Notiz Berta' });
  await seed({ start: iso(day(4), '11:00'), end: iso(day(4), '12:00'), name: xss, email: 'mal@test.de', status: 'requested', source: 'online' });
  await seed({ start: iso(day(4), '13:00'), end: iso(day(4), '14:00'), name: 'Schon Bestätigt', status: 'confirmed', source: 'online' });
  await env.tdb.sql(`update kf_bookings set status='declined' where status='requested' and id <> ${q(a)} and customer_email is distinct from 'mal@test.de'`);
  await admin.click('[data-tab="requests"]');
  await admin.waitForSelector('#request-list .item');
  assert.equal(await admin.locator('#request-list .item').count(), 2, 'nur offene Anfragen');
  assert.equal(await admin.locator('#req-count').innerText(), '2');
  assert.match(await admin.locator('#request-list .item').first().innerText(), /Berta Annahme[\s\S]*09:00 Uhr[\s\S]*Offen/);
  assert.equal(await admin.evaluate(() => window.__xss), undefined, 'kein Skript aus Kundennamen ausgeführt');
  assert.equal(await admin.locator('#request-list img').count(), 0);
  await shot(admin, 'admin-anfragen-tablet');
  await admin.click('#request-list .item >> nth=0');
  const detail = await admin.locator('#booking-detail').innerText();
  for (const s of ['Berta Annahme', 'berta@test.de', '0171 22', 'Notiz Berta', '09:00 bis 10:00 Uhr']) assert.ok(detail.includes(s), `Details zeigen ${s}`);
  assert.equal(await admin.locator('#accept').count(), 1); assert.equal(await admin.locator('#decline').count(), 1);
  env.mails.length = 0;
  await admin.click('#accept');
  await admin.waitForFunction(() => document.querySelectorAll('#request-list .item').length === 1);
  assert.equal(await env.tdb.sql(`select status from kf_bookings where id=${q(a)}`), 'confirmed');
  assert.ok(env.mails.some((m) => m.to === 'berta@test.de' && /bestätigt/.test(m.subject)));
  await admin.click('#request-list .item >> nth=0'); await admin.click('#decline');
  await admin.waitForSelector('.alert.info');
  assert.equal(await admin.locator('#req-count').count(), 0, 'Zähler weg');
  assert.equal(await env.tdb.sql(`select status from kf_bookings where customer_email='mal@test.de'`), 'declined');
  assert.ok(env.mails.some((m) => m.to === 'mal@test.de'));
});

test('Admin-Kalender: Monat, Woche, Tag mit Farben Gelb/Grün/Rot, Historie, Details', opts, async () => {
  const d = day(5);
  await seed({ start: iso(d, '09:00'), end: iso(d, '10:00'), name: 'Gelb Offen', status: 'requested', source: 'online' });
  await seed({ start: iso(d, '11:00'), end: iso(d, '12:00'), name: 'Gruen Fest', status: 'confirmed', source: 'online', email: 'g@test.de', internal: 'Interne Notiz G' });
  await seed({ start: iso(d, '13:00'), end: iso(d, '14:00'), name: 'Rot Abgesagt', status: 'cancelled', source: 'online' });
  await seed({ start: iso(d, '15:00'), end: iso(d, '16:00'), name: 'Grau Abgelehnt', status: 'declined', source: 'online' });
  await env.tdb.sql(`insert into kf_blocks(start_at,end_at,reason) values (${q(iso(d, '17:00'))}, ${q(iso(d, '19:00'))}, 'Mittagspause')`);
  await admin.click('[data-tab="calendar"]'); await admin.waitForSelector('#month-grid');
  const bg = (sel) => admin.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const goTo = async () => { for (let i = 0; i < 3 && !(await admin.locator(`.mcell[data-date="${d}"]:not(.other)`).count()); i++) { await admin.click('#cal-next'); await admin.waitForSelector('#month-grid'); } };
  await goTo();
  const cell = admin.locator(`.mcell[data-date="${d}"]`);
  assert.equal(await cell.locator('.ev.requested').count(), 1); assert.equal(await cell.locator('.ev.confirmed').count(), 1); assert.equal(await cell.locator('.ev.cancelled').count(), 1);
  assert.equal(await cell.locator('.ev.declined').count(), 0, 'abgelehnt ohne Historie nicht sichtbar');
  assert.equal(await cell.locator('.ev.block').count(), 1);
  assert.equal(await bg(`.mcell[data-date="${d}"] .ev.requested`), 'rgb(253, 243, 196)', 'Gelb');
  assert.equal(await bg(`.mcell[data-date="${d}"] .ev.confirmed`), 'rgb(217, 241, 227)', 'Grün');
  assert.equal(await bg(`.mcell[data-date="${d}"] .ev.cancelled`), 'rgb(249, 217, 215)', 'Rot');
  await shot(admin, 'admin-monat-tablet');
  await admin.check('#hist'); await admin.waitForSelector('#hist:checked');
  await goTo();
  await admin.waitForSelector(`.mcell[data-date="${d}"] .more`);
  assert.match(await admin.locator(`.mcell[data-date="${d}"] .more`).innerText(), /\+ 1 weitere/, 'Monatszelle zeigt höchstens 3 Einträge plus Rest');
  await admin.click(`.mcell[data-date="${d}"] .dn`); await admin.waitForSelector('#time-grid .evt.declined');
  assert.equal(await admin.locator('#time-grid .evt.declined').count(), 1, 'Historie zeigt abgelehnte (Tagesansicht)');
  await admin.click('[data-mode="month"]'); await admin.waitForSelector('#month-grid');
  await admin.uncheck('#hist'); await admin.waitForSelector('#hist:not(:checked)');
  // Details
  await goTo();
  await admin.click(`.mcell[data-date="${d}"] .ev.confirmed`);
  const detail = await admin.locator('#booking-detail').innerText();
  for (const s of ['Gruen Fest', 'g@test.de', 'Interne Notiz G', 'Bestätigt', '11:00 bis 12:00 Uhr']) assert.ok(detail.includes(s), `Details: ${s}`);
  await admin.click('#booking-detail >> text=Schließen');
  // Tagesansicht über Klick auf den Tag
  await admin.click(`.mcell[data-date="${d}"] .dn`);
  await admin.waitForSelector('#time-grid');
  assert.equal(await admin.locator('#time-grid .col').count(), 1);
  assert.equal(await admin.locator('#time-grid .evt.requested').count(), 1);
  assert.equal(await admin.locator('#time-grid .evt.confirmed').count(), 1);
  assert.equal(await admin.locator('#time-grid .evt.block').count(), 1);
  const top = await admin.locator('#time-grid .evt.confirmed').evaluate((el) => parseFloat(el.style.top));
  assert.equal(top, 11 * 60 * 0.8, '11:00 Uhr an der richtigen Stelle');
  const hgt = await admin.locator('#time-grid .evt.confirmed').evaluate((el) => parseFloat(el.style.height));
  assert.ok(Math.abs(hgt - (48 - 2)) < 0.5, '60 Minuten = 1 Stunde hoch');
  await shot(admin, 'admin-tag-tablet');
  await admin.click('[data-mode="week"]'); await admin.waitForSelector('#time-grid .col');
  assert.equal(await admin.locator('#time-grid .col').count(), 7);
  assert.equal(await admin.locator('#time-grid .evt.confirmed').count() >= 1, true);
  await shot(admin, 'admin-woche-tablet');
  await admin.click('[data-mode="month"]'); await admin.waitForSelector('#month-grid');
  assert.equal(await admin.locator('#cal-title').innerText().then((t) => /\d{4}/.test(t)), true);
});

test('Admin: manueller Termin, Bearbeiten, Verschieben, Konflikt, Absagen, Löschen', opts, async () => {
  const d = day(6);
  await admin.click('[data-tab="new"]'); await admin.waitForSelector('#booking-edit-form');
  const f = (label) => admin.locator(`#booking-edit-form label:text-is("${label}") + *`);
  await admin.locator('#booking-edit-form input[type=text]').first().fill('Frau Telefon');
  await admin.locator('#booking-edit-form input[type=tel]').fill('0151 55');
  await admin.locator('#booking-edit-form input[type=date]').fill(d);
  await admin.locator('#booking-edit-form input[type=time]').fill('09:10');
  await admin.locator('#booking-edit-form select').selectOption('45');
  await admin.locator('#booking-edit-form textarea').first().fill('Bringt Foto mit');
  await admin.click('#save-booking');
  await admin.waitForSelector('.alert.ok');
  const row = JSON.parse(await env.tdb.sql(`select to_jsonb(b) from kf_bookings b where customer_name='Frau Telefon'`));
  assert.equal(row.source, 'manual'); assert.equal(row.status, 'confirmed'); assert.equal(row.internal_note, 'Bringt Foto mit');
  assert.equal(new Date(row.end_at) - new Date(row.start_at), 45 * 60000);
  assert.equal(new Date(row.start_at).toISOString(), iso(d, '09:10'));
  // Konflikt
  await admin.locator('#booking-edit-form input[type=text]').first().fill('Doppelt Belegt');
  await admin.locator('#booking-edit-form input[type=date]').fill(d); await admin.locator('#booking-edit-form input[type=time]').fill('09:30');
  await admin.locator('#booking-edit-form select').selectOption('30');
  await admin.click('#save-booking'); await admin.waitForSelector('#booking-edit-form .alert.error');
  assert.match(await admin.locator('#booking-edit-form .alert').innerText(), /belegt/);
  // freie Dauer 75 Minuten
  await admin.locator('#booking-edit-form input[type=time]').fill('12:00');
  await admin.locator('#booking-edit-form select').selectOption('custom');
  await admin.locator('#booking-edit-form input[type=number]').fill('75');
  await admin.evaluate(() => document.querySelectorAll('.alert.ok').forEach((e) => e.remove()));
  await admin.click('#save-booking'); await admin.waitForSelector('.alert.ok');
  assert.equal(await env.tdb.sql(`select (extract(epoch from end_at-start_at)/60)::int from kf_bookings where customer_name='Doppelt Belegt'`), '75');
  // Bearbeiten/Verschieben über den Kalender
  await admin.click('[data-tab="calendar"]'); await admin.waitForSelector('#cal-title');
  await admin.click('[data-mode="day"]'); await admin.waitForSelector('#time-grid');
  for (let i = 0; i < 12 && !(await admin.locator('#time-grid .col').first().getAttribute('data-date')).includes(d); i++) { await admin.click('#cal-next'); await admin.waitForSelector('#time-grid'); }
  await admin.click('#time-grid .evt:has-text("Doppelt Belegt")');
  await admin.click('#edit');
  await admin.waitForSelector('dialog #booking-edit-form');
  await admin.locator('dialog input[type=time]').fill('15:00');
  await admin.locator('dialog select').selectOption('60');
  await admin.locator('dialog input[type=text]').first().fill('Verschoben Name');
  env.mails.length = 0;
  await admin.click('dialog #save-booking');
  await admin.waitForFunction(() => !document.querySelector('dialog'));
  const moved = JSON.parse(await env.tdb.sql(`select to_jsonb(b) from kf_bookings b where customer_name='Verschoben Name'`));
  assert.equal(new Date(moved.start_at).toISOString(), iso(d, '15:00'));
  assert.equal(await env.tdb.sql(`select count(*) from kf_bookings where customer_name='Doppelt Belegt'`), '0');
  // in belegte Zeit verschieben -> Fehlermeldung, nichts geändert
  await admin.click('#time-grid .evt:has-text("Verschoben Name")'); await admin.click('#edit');
  await admin.locator('dialog input[type=time]').fill('09:00'); await admin.click('dialog #save-booking');
  await admin.waitForSelector('dialog .alert.error');
  await admin.click('dialog >> text=Abbrechen');
  // Absagen mit Rückfrage
  await admin.click('#time-grid .evt:has-text("Verschoben Name")'); await admin.click('#cancel-booking');
  assert.match(await admin.locator('dialog >> nth=1').innerText(), /Termin absagen/);
  await admin.click('dialog >> text=Ja, absagen');
  await admin.waitForFunction(() => !document.querySelector('dialog'));
  assert.equal(await env.tdb.sql(`select status||'/'||cancelled_by from kf_bookings where customer_name='Verschoben Name'`), 'cancelled/admin');
  // Löschen mit Rückfrage
  await admin.click('#time-grid .evt:has-text("Frau Telefon")'); await admin.click('#delete-booking');
  await admin.click('dialog >> text=Ja, löschen');
  await admin.waitForFunction(() => !document.querySelector('dialog'));
  assert.equal(await env.tdb.sql(`select count(*) from kf_bookings where customer_name='Frau Telefon'`), '0');
  // Klick in die leere Spalte öffnet "Neuer Termin" mit Uhrzeit
  const col = admin.locator('#time-grid .col').first(); const box = await col.boundingBox();
  await col.click({ position: { x: 20, y: 10 * 48 + 5 } });
  await admin.waitForSelector('dialog #booking-edit-form');
  assert.equal(await admin.locator('dialog input[type=time]').inputValue(), '10:00');
  await admin.click('dialog >> text=Abbrechen');
});

test('Admin: Sperrzeiten (ganze Tage, Zeitraum, Konflikt-Warnung ohne Löschen, Löschen)', opts, async () => {
  const d = day(8);
  await seed({ start: iso(d, '11:00'), end: iso(d, '12:00'), name: 'Bleibt Bestehen', status: 'confirmed', source: 'online' });
  await env.tdb.sql('delete from kf_blocks');
  await admin.click('[data-tab="blocks"]'); await admin.waitForSelector('#block-form');
  await admin.selectOption('#block-mode', 'range');
  await admin.fill('#block-d1', d); await admin.fill('#block-d2', d); await admin.fill('#block-t1', '10:00'); await admin.fill('#block-t2', '13:00'); await admin.fill('#block-reason', 'Arzt');
  await admin.click('#block-save'); await admin.waitForSelector('#block-form .alert.warn');
  assert.match(await admin.locator('.alert.warn').innerText(), /NICHT gelöscht[\s\S]*Bleibt Bestehen/);
  assert.equal(await env.tdb.sql(`select count(*) from kf_blocks where reason='Arzt'`), '0');
  await admin.click('#block-force'); await admin.waitForSelector('#block-list .item');
  assert.equal(await env.tdb.sql(`select count(*) from kf_blocks where reason='Arzt'`), '1');
  assert.equal(await env.tdb.sql(`select status from kf_bookings where customer_name='Bleibt Bestehen'`), 'confirmed', 'Termin unberührt');
  // ganze Tage über mehrere Tage
  await admin.selectOption('#block-mode', 'days'); await admin.fill('#block-d1', day(10)); await admin.fill('#block-d2', day(14)); await admin.fill('#block-reason', 'Urlaub');
  await admin.click('#block-save'); await admin.waitForFunction(() => document.querySelectorAll('#block-list .item').length === 2);
  assert.match(await admin.locator('#block-list').innerText(), /Urlaub/);
  await shot(admin, 'admin-sperrzeiten-tablet');
  const cust = await newPage('mobile'); await cust.goto(env.site + '/');
  await pickDay(cust, day(12));
  assert.equal(await cust.locator('.chip:not([disabled])').count(), 0, 'Urlaubstag komplett gesperrt');
  await cust.click(`.daybtn[data-date="${day(15)}"]`);
  assert.equal(await cust.locator('.chip:not([disabled])').count(), 96, 'Tag nach dem Urlaub frei');
  await cust.context().close();
  // Löschen
  await admin.click('#block-list .btn >> nth=1'); await admin.click('dialog >> text=Ja, löschen');
  await admin.waitForFunction(() => document.querySelectorAll('#block-list .item').length === 1);
});

test('Admin: Kundensuche nach Name, E-Mail und Telefon (auch +49-Schreibweise)', opts, async () => {
  await seed({ start: iso(day(-20), '10:00'), end: iso(day(-20), '11:00'), name: 'Sabine Sucherin', email: 'sabine.s@test.de', phone: '0172 3334445', status: 'confirmed', source: 'online' });
  await seed({ start: iso(day(12), '10:00'), end: iso(day(12), '11:00'), name: 'Sabine Sucherin', email: 'sabine.s@test.de', phone: '0172 3334445', status: 'confirmed', source: 'online' });
  await admin.click('[data-tab="search"]'); await admin.waitForSelector('#search-q');
  for (const term of ['sucherin', 'SABINE.S@', '0172 333', '+49 172 3334445']) {
    await admin.fill('#search-q', term); await admin.press('#search-q', 'Enter');
    await admin.waitForSelector('#search-results .customer');
    const t = await admin.locator('#search-results').innerText();
    assert.match(t, /Sabine Sucherin/, term); assert.match(t, /Zukünftige Termine/); assert.match(t, /Bisherige Termine/);
  }
  await admin.fill('#search-q', 'a'); await admin.click('#search-go'); await admin.waitForSelector('#search-results .alert');
  await admin.fill('#search-q', 'gibtesnicht'); await admin.click('#search-go'); await admin.waitForFunction(() => /Kein Kunde/.test(document.querySelector('#search-results').innerText));
  await admin.fill('#search-q', 'sucherin'); await admin.click('#search-go'); await admin.waitForSelector('.customer .item');
  await admin.click('.customer .item >> nth=0'); await admin.waitForSelector('#booking-detail'); await admin.click('#booking-detail >> text=Schließen');
});

test('Admin: Einstellungen wirken auf die Kundenseite (Dauer, Buchungsfrist)', opts, async () => {
  await admin.click('[data-tab="settings"]'); await admin.waitForSelector('#settings-form');
  assert.equal(await admin.inputValue('#set-duration'), '60'); assert.equal(await admin.inputValue('#set-horizon'), '30');
  assert.equal(await admin.inputValue('#set-contact'), 'lcordella818@gmail.com');
  await admin.selectOption('#set-duration', 'custom'); await admin.fill('#set-duration-custom', '75'); await admin.fill('#set-horizon', '14');
  await admin.click('#settings-save'); await admin.waitForSelector('.alert.ok');
  const cust = await newPage('mobile'); await cust.goto(env.site + '/');
  await cust.waitForSelector('.daybtn.free');
  for (let i = 0; i < 3 && !(await cust.locator(`.daybtn[data-date="${day(16)}"]:not(.other)`).count()); i++) { await cust.click('[data-nav="next"]'); await cust.waitForTimeout(200); }
  assert.equal(await cust.locator(`.daybtn[data-date="${day(16)}"]`).isDisabled(), true, 'Tag 16 liegt außerhalb der 14 Tage');
  await pickDay(cust, day(2));
  assert.match(await cust.locator('.times').innerText(), /75 Minuten/);
  await cust.click(`.chip[data-start="${iso(day(2), '09:00')}"]`);
  assert.match(await cust.locator('#summary').innerText(), /09:00 bis 10:15 Uhr/);
  await cust.context().close();
  await admin.selectOption('#set-duration', '60'); await admin.fill('#set-horizon', '30'); await admin.click('#settings-save'); await admin.waitForSelector('.alert.ok');
});

test('Admin: E-Mail-Protokoll mit Fehler und erneutem Senden, Admin einladen, Passwort ändern', opts, async () => {
  env.mailMode.ok = false;
  await env.tdb.sql(`insert into kf_bookings(id,start_at,end_at,status,source,customer_name,customer_email,token_salt,token_hash) values ('11111111-1111-4111-8111-111111111111', ${q(iso(day(18), '10:00'))}, ${q(iso(day(18), '11:00'))}, 'requested','online','Mail Fehler','fehler@test.de','s','h-mailfehler')`);
  await admin.click('[data-tab="calendar"]'); await admin.waitForSelector('#cal-title');
  await admin.click('[data-tab="requests"]'); await admin.waitForSelector('#request-list .item');
  await admin.click('#request-list .item:has-text("Mail Fehler")'); await admin.click('#accept'); await admin.waitForFunction(() => !document.querySelector('dialog'));
  await admin.click('[data-tab="emails"]'); await admin.waitForSelector('#mail-filter');
  await admin.selectOption('#mail-filter', 'failed');
  await admin.waitForSelector('#mail-table, #content .alert.info', { timeout: 8000 }).catch(() => {});
  if (!(await admin.locator('#mail-table').count())) assert.fail('Kein Protokoll sichtbar: ' + (await admin.locator('#content').innerText()) + ' | Mails in DB: ' + (await env.tdb.sql('select kind||\':\'||to_email||\':\'||status from kf_email_log order by created_at desc limit 8')));
  assert.match(await admin.locator('#mail-table').innerText(), /fehler@test.de[\s\S]*Fehlgeschlagen/);
  env.mailMode.ok = true; env.mails.length = 0;
  await admin.click('#mail-table button >> nth=0'); await admin.waitForSelector('.alert.ok');
  assert.ok(env.mails.some((m) => m.to === 'fehler@test.de'), 'erneut gesendet');
  await shot(admin, 'admin-emails-tablet');
  // Admin einladen
  await admin.click('[data-tab="admins"]'); await admin.waitForSelector('#invite-form');
  await admin.fill('#inv-name', 'Lisa Friseurin'); await admin.fill('#inv-email', 'lisa@salon.de'); await admin.click('#invite-send');
  await admin.waitForSelector('#invite-url', { timeout: 8000 }).catch(async () => assert.fail('Einladung ohne Link: ' + (await admin.locator('#content').innerText()).slice(0, 600)));
  const inviteUrl = await admin.locator('#invite-url').innerText();
  assert.match(inviteUrl, /\/admin\/#setup=[A-Za-z0-9_-]{43}$/);
  assert.ok(env.mails.some((m) => m.to === 'lisa@salon.de' && /Einladung/.test(m.subject)));
  const lisa = await newPage('mobile'); await lisa.goto(inviteUrl.replace(/^https?:\/\/[^/]+/, env.site)); await lisa.waitForSelector('#setup-form');
  await lisa.fill('#setup-form input >> nth=0', 'lisas-passwort-123'); await lisa.fill('#setup-form input >> nth=1', 'lisas-passwort-123'); await lisa.click('#setup-form button');
  await lisa.waitForSelector('.tab');
  assert.equal(await lisa.locator('.tab[data-tab="admins"]').count(), 0, 'normaler Admin sieht keine Admin-Verwaltung');
  assert.equal(await lisa.locator('.tab[data-tab="requests"]').count(), 1);
  await lisa.context().close();
  // Konto
  await admin.click('[data-tab="account"]'); await admin.waitForSelector('#pw-form');
  assert.match(await admin.locator('#diagnostics').innerText(), /Datenbank: verbunden/);
  assert.match(await admin.locator('#diagnostics').innerText(), /Testadresse/);
  await admin.fill('#pw-cur', 'falsch-falsch'); await admin.fill('#pw-new', 'neues-passwort-99'); await admin.fill('#pw-new2', 'neues-passwort-99'); await admin.click('#pw-save');
  await admin.waitForSelector('#pw-form .alert.error');
  await admin.fill('#pw-cur', env.password); await admin.click('#pw-save'); await admin.waitForSelector('#pw-form .alert.ok');
});

test('Geschützt: ohne Anmeldung zeigt der Adminbereich nur die Anmeldung, keine Kundendaten', opts, async () => {
  const page = await newPage('mobile');
  await page.goto(env.site + '/admin/'); await page.waitForSelector('#login-form');
  const html = await page.content();
  for (const s of ['berta@test.de', 'Berta', 'Sabine', 'lisa@salon.de']) assert.ok(!html.includes(s), s);
  const r = await page.evaluate(async () => (await fetch('/api/admin/requests')).status);
  assert.equal(r, 401);
  await page.context().close();
});

test('Responsiv: Kundenseite, Terminverwaltung und Adminbereich ohne Überlauf auf Handy, Tablet, Desktop', opts, async () => {
  for (const vp of ['mobile', 'tablet', 'desktop']) {
    const c = await newPage(vp); await c.goto(env.site + '/'); await c.waitForSelector('.daybtn.free'); await noOverflow(c, `Kunde ${vp}`);
    await pickDay(c, day(2)); await c.click(`.chip[data-start="${iso(day(2), '12:00')}"]`); await noOverflow(c, `Kunde Formular ${vp}`);
    await shot(c, `kunde-${vp}`); await c.context().close();
    const m = await newPage(vp); await m.goto(env.site + '/termin#' + 'B'.repeat(43)); await m.waitForSelector('.alert'); await noOverflow(m, `Termin ${vp}`); await m.context().close();
    const a = await newPage(vp, { ip: `10.8.${vp.length}.1` }); await a.goto(env.site + '/admin/'); await a.waitForSelector('#login-form');
    await a.fill('#login-form input[type=email]', 'chef@beispiel.de'); await a.fill('#login-form input[type=password]', 'neues-passwort-99'); await a.click('#login-form button'); await a.waitForSelector('.tab');
    for (const tab of ['requests', 'calendar', 'new', 'search', 'blocks', 'settings', 'emails', 'admins', 'account']) {
      await a.click(`[data-tab="${tab}"]`); await a.waitForTimeout(250); await noOverflow(a, `Admin ${tab} ${vp}`);
    }
    await a.click('[data-tab="calendar"]'); await a.click('[data-mode="week"]'); await a.waitForSelector('#time-grid'); await noOverflow(a, `Admin Woche ${vp}`);
    const wide = await a.evaluate(() => { const s = document.querySelector('.tgrid-scroll'); return s.scrollWidth > s.clientWidth; });
    if (vp === 'desktop') assert.equal(wide, false, 'Woche passt auf Desktop ohne Scrollen');
    const tabsOk = await a.evaluate(() => [...document.querySelectorAll('.tab')].every((t) => t.getBoundingClientRect().height >= 40));
    assert.ok(tabsOk, 'Tabs groß genug zum Antippen');
    await shot(a, `admin-woche-${vp}`);
    await a.context().close();
  }
});

test('Keine Browser-Fehler, keine CSP-Verstöße, keine Fehlermeldungen in der Konsole', opts, () => {
  const real = problems.filter((p) => !/Failed to load resource.*(40[0-9]|409|422|429|404)/.test(p));
  assert.deepEqual(real, []);
});
