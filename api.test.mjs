// Ende-zu-Ende-Tests der kompletten API (netlify/lib/app.mjs):
//   echte PostgreSQL-Datenbank + simulierte Supabase-REST-Schnittstelle + simulierter E-Mail-Dienst.
// NICHT getestet (braucht echte Zugänge): echtes Supabase, echtes Resend, echtes Netlify.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, pgAvailable } from './helpers/pg.mjs';
import { startFakeSupabase } from './helpers/fake-supabase.mjs';
import { createApp } from '../netlify/lib/app.mjs';
import { createDb } from '../netlify/lib/db.mjs';
import { loadConfig } from '../netlify/lib/config.mjs';
import { localDateStr, parseLocalDateTime, addDays } from '../netlify/lib/time.mjs';

const HAVE_PG = pgAvailable();
const opts = { skip: HAVE_PG ? false : 'Keine PostgreSQL-Testdatenbank erreichbar' };

const KEY = 'test-service-key';
const APP_SECRET = 'geheimes-app-secret-fuer-tests-0123456789';
const SITE = 'https://salon.test';

let tdb; let fake; let app; let mails; let mailMode;
let ipCounter = 0;

const mailer = {
  from: 'Kellerfriseur <onboarding@resend.dev>',
  configured: true,
  async send(m) {
    if (!mailMode.ok) return { ok: false, error: 'Resend 403: simulierter Fehler' };
    mails.push(m);
    return { ok: true, id: `mail-${mails.length}` };
  },
};

before(async () => {
  if (!HAVE_PG) return;
  tdb = await createTestDatabase();
  fake = await startFakeSupabase({ db: tdb.name, expectKey: KEY });
  const config = loadConfig({ SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: KEY, APP_SECRET, SITE_URL: SITE });
  app = createApp({ db: createDb({ url: fake.url, key: KEY }), config, mailer, log: { error() {}, warn() {}, log() {} } });
  mails = []; mailMode = { ok: true };
});
after(async () => { if (fake) await fake.close(); if (tdb) tdb.drop(); });

// --- Hilfen -----------------------------------------------------------------
async function call(method, path, { body, cookie, token, headers = {}, ip, raw, contentType } = {}) {
  const h = { 'x-nf-client-connection-ip': ip ?? `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`, ...headers };
  if (cookie) h.cookie = cookie;
  if (token) h['x-booking-token'] = token;
  let payload;
  if (raw !== undefined) { payload = raw; h['content-type'] = contentType ?? 'application/json'; }
  else if (body !== undefined && method !== 'GET' && method !== 'HEAD') { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const res = await app.handle(new Request(`${SITE}/api${path}`, { method, headers: h, body: payload }), {});
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* leer */ }
  return { status: res.status, data, text, headers: res.headers };
}

const day = (n) => addDays(localDateStr(Date.now()), n);
const startOf = (date, hhmm) => new Date(parseLocalDateTime(`${date}T${hhmm}`)).toISOString();
const sentTo = (addr, subjectPart) => mails.filter((m) => m.to === addr && (!subjectPart || m.subject.includes(subjectPart)));
const resetMails = () => { mails.length = 0; };
const uniq = (() => { let i = 0; return () => `kunde${++i}-${Date.now() % 100000}@test.de`; })();

async function requestBooking(date, hhmm, extra = {}) {
  const email = extra.email ?? uniq();
  const r = await call('POST', '/bookings', { body: { name: 'Max Muster', email, start: startOf(date, hhmm), ...extra } });
  return { ...r, email, token: r.data?.managePath?.split('#')[1] };
}

let ownerCookie; let ownerId;
async function adminLogin() {
  const path = await tdb.sql(`select public.kf_bootstrap_owner('Chef@Beispiel.de', 'Chef Inhaber')`);
  const setupToken = path.split('=')[1];
  const r = await call('POST', '/admin/setup', { body: { token: setupToken, password: 'sehr-sicheres-passwort' } });
  assert.equal(r.status, 200, r.text);
  ownerId = r.data.admin.id;
  ownerCookie = r.headers.get('set-cookie').split(';')[0];
  return setupToken;
}

// =============================================================================
test('Konfiguration: fehlende Variablen -> klare Fehlermeldung ohne Geheimnisse', opts, async () => {
  const bare = createApp({ db: createDb({ url: fake.url, key: KEY }), config: loadConfig({}), mailer, log: { error() {} } });
  const res = await bare.handle(new Request(`${SITE}/api/health`), {});
  const data = await res.json();
  assert.equal(res.status, 500);
  assert.equal(data.error, 'config_error');
  assert.deepEqual(data.missing, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'APP_SECRET (mindestens 32 Zeichen)']);
});

test('Verbindung: Health-Check, Datenbank erreichbar, Schlüssel kommt beim Server an', opts, async () => {
  const r = await call('GET', '/health');
  assert.deepEqual(r.data, { ok: true, db: true });
  assert.ok(fake.requests.length > 0 && fake.requests.every((x) => x.apikey === KEY));
  const wrong = createApp({ db: createDb({ url: fake.url, key: 'falscher-key' }), config: loadConfig({ SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'falscher-key', APP_SECRET }), mailer, log: { error() {} } });
  const h = await (await wrong.handle(new Request(`${SITE}/api/health`), {})).json();
  assert.equal(h.ok, false, 'falscher Schlüssel wird erkannt');
});

test('Öffentlicher Kalender: 24/7, 15-Minuten-Raster, 30 Tage Frist', opts, async () => {
  const r = await call('GET', `/availability?from=${day(1)}&to=${day(1)}`);
  assert.equal(r.status, 200);
  const d = r.data.days[0];
  assert.equal(d.slots.length, 96, '00:00 bis 23:45 = 96 Startzeiten');
  assert.equal(d.free, 96);
  assert.equal(d.slots[0][0], startOf(day(1), '00:00'));
  assert.equal(d.slots[95][0], startOf(day(1), '23:45'));
  assert.equal(r.data.durationMinutes, 60);
  const far = await call('GET', `/availability?from=${day(30)}&to=${day(31)}`);
  assert.equal(far.data.days[0].bookable, true);
  assert.equal(far.data.days[1].bookable, false, 'Tag 31 ist zu weit');
  assert.equal((await call('GET', '/availability?from=x&to=y')).status, 400);
  assert.equal((await call('GET', `/availability?from=${day(0)}&to=${day(60)}`)).status, 400);
});

test('Buchung: Anfrage wird gespeichert, Zeitraum sofort reserviert, Mails gehen raus', opts, async () => {
  resetMails();
  const date = day(2);
  const a = await requestBooking(date, '10:00', { name: 'Anna Beispiel', phone: '0170 1112223', note: 'Bitte kurz schneiden' });
  assert.equal(a.status, 201, a.text);
  assert.equal(a.data.status, 'requested');
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  const avail = (await call('GET', `/availability?from=${date}&to=${date}`)).data.days[0];
  const free = Object.fromEntries(avail.slots.map(([t, f]) => [t, f]));
  assert.equal(free[startOf(date, '09:00')], 1, '09:00-10:00 direkt davor frei');
  assert.equal(free[startOf(date, '09:15')], 0, '09:15-10:15 überlappt');
  assert.equal(free[startOf(date, '10:00')], 0);
  assert.equal(free[startOf(date, '10:45')], 0);
  assert.equal(free[startOf(date, '11:00')], 1, 'direkt danach frei');
  // Eingangsbestätigung an den Kunden, Info an beide Admins
  const toCustomer = sentTo(a.email);
  assert.equal(toCustomer.length, 1);
  assert.match(toCustomer[0].subject, /eingegangen/);
  assert.ok(toCustomer[0].html.includes(`${SITE}/termin#${a.token}`), 'persönlicher Link in der Mail');
  assert.equal(toCustomer[0].replyTo, 'lcordella818@gmail.com');
  assert.equal(sentTo('lcordella818@gmail.com', 'Neue Terminanfrage').length, 1, 'Kontaktadresse bekommt die Info');
  const adminMail = sentTo('lcordella818@gmail.com')[0];
  assert.ok(adminMail.html.includes('Anna Beispiel') && adminMail.html.includes(`${SITE}/admin/`));
  assert.ok(!adminMail.html.includes('0170') && !adminMail.html.includes('kurz schneiden'), 'Admin-Mail enthält nur Name/Datum/Uhrzeit/Link');
  const log = await tdb.sql(`select count(*) from kf_email_log where status='sent'`);
  assert.ok(Number(log) >= 2);
});

test('Buchung: zweiter Kunde kann denselben/überlappenden Zeitraum nicht buchen', opts, async () => {
  const date = day(2);
  assert.equal((await requestBooking(date, '10:00')).status, 409);
  const r = await requestBooking(date, '10:30');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'slot_unavailable');
  assert.equal((await requestBooking(date, '09:15')).status, 409);
  assert.equal((await requestBooking(date, '11:00')).status, 201, 'direkt aufeinanderfolgend erlaubt');
  assert.equal((await requestBooking(date, '09:00')).status, 201);
});

test('Buchung: 10 gleichzeitige Kunden -> genau einer bekommt den Termin', opts, async () => {
  const date = day(3);
  const results = await Promise.all(Array.from({ length: 10 }, () => requestBooking(date, '15:00')));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 9);
});

test('Buchung: Eingabeprüfung, Honeypot, Inhaltstyp, fremde Herkunft', opts, async () => {
  const date = day(4);
  const post = (body, extra) => call('POST', '/bookings', { body, ...extra });
  const ok = { name: 'Max Muster', email: 'max@test.de', start: startOf(date, '09:00') };
  assert.equal((await post({ ...ok, name: 'Max' })).status, 422, 'Vor- und Nachname Pflicht');
  assert.equal((await post({ ...ok, email: 'kaputt' })).status, 422);
  assert.equal((await post({ ...ok, email: undefined })).status, 422);
  assert.equal((await post({ ...ok, phone: 'abc' })).status, 422);
  assert.equal((await post({ ...ok, note: 'x'.repeat(1001) })).status, 422);
  assert.equal((await post({ ...ok, start: 'morgen' })).status, 422);
  assert.equal((await post({ ...ok, start: startOf(day(-1), '09:00') })).status, 422, 'Vergangenheit');
  assert.equal((await post({ ...ok, start: startOf(day(45), '09:00') })).status, 422, 'zu weit');
  assert.equal((await post({ ...ok, start: startOf(date, '09:00').replace(':00.000Z', ':07.000Z') })).status, 422, 'keine 15-Minuten-Zeit');
  assert.equal((await call('POST', '/bookings', { raw: 'kein json{' })).status, 400);
  assert.equal((await call('POST', '/bookings', { raw: JSON.stringify(ok), contentType: 'text/plain' })).status, 415);
  assert.equal((await call('POST', '/bookings', { raw: '[1,2]' })).status, 400);
  assert.equal((await post(ok, { headers: { origin: 'https://boese-seite.example' } })).status, 403, 'fremde Seite darf nicht senden');
  assert.equal((await post({ ...ok, website: 'http://spam.example' })).status, 201, 'Honeypot: Bot sieht Erfolg');
  assert.equal(await tdb.sql(`select count(*) from kf_bookings where customer_email='max@test.de'`), '0', 'Honeypot legt nichts an');
  assert.equal((await post({ ...ok, name: "Robert'); DROP TABLE kf_bookings;-- Tabelle", email: 'sql@test.de' })).status, 201);
  assert.equal(await tdb.sql(`select customer_name from kf_bookings where customer_email='sql@test.de'`), "Robert'); DROP TABLE kf_bookings;-- Tabelle", 'SQL-Injection bleibt reiner Text');
  assert.ok(Number(await tdb.sql('select count(*) from kf_bookings')) > 0);
});

test('Rate-Limit: mehr als 4 Buchungsversuche pro Minute und IP werden gestoppt', opts, async () => {
  const ip = '203.0.113.77';
  const codes = [];
  for (let i = 0; i < 6; i++) {
    codes.push((await call('POST', '/bookings', { ip, body: { name: 'A B', email: `rl${i}@test.de`, start: startOf(day(8), `0${i}:00`) } })).status);
  }
  assert.deepEqual(codes.slice(0, 4), [201, 201, 201, 201]);
  assert.deepEqual(codes.slice(4), [429, 429]);
});

test('Kunden-Link: Status ansehen, nur eigene Daten, ungültige Tokens', opts, async () => {
  const a = await requestBooking(day(5), '12:00', { name: 'Berta Privat', phone: '0171 9998887', note: 'geheime Notiz' });
  const view = await call('GET', '/manage', { token: a.token });
  assert.equal(view.status, 200);
  assert.deepEqual(Object.keys(view.data).sort(), ['action', 'canCancel', 'end', 'name', 'start', 'status']);
  assert.equal(view.data.status, 'requested');
  assert.equal(view.data.action, 'withdraw');
  for (const secret of [a.email, '0171', 'geheime', 'internal']) assert.ok(!view.text.includes(secret), `Kunden-Link darf "${secret}" nicht liefern`);
  assert.equal((await call('GET', '/manage', { token: 'A'.repeat(43) })).status, 404, 'erfundener Token');
  assert.equal((await call('GET', '/manage', { token: 'kurz' })).status, 404);
  assert.equal((await call('GET', '/manage', {})).status, 404);
  assert.equal((await call('GET', '/manage', { token: "' or 1=1 --aaaaaaaaaaaaaaaaaaaaa" })).status, 404);
  // Token einer anderen Buchung zeigt nur deren Daten
  const b = await requestBooking(day(5), '14:00', { name: 'Carla Andere' });
  assert.equal((await call('GET', '/manage', { token: b.token })).data.name, 'Carla Andere');
  // In der Datenbank steht nur der Hash
  assert.equal(await tdb.sql(`select count(*) from kf_bookings where token_hash='${a.token}'`), '0');
});

test('Kunden-Absage: Sicherheitsabfrage, Zeitraum wird frei, Mails an Kunde und Admins', opts, async () => {
  const date = day(6);
  const a = await requestBooking(date, '09:00');
  resetMails();
  assert.equal((await call('POST', '/manage/cancel', { token: a.token, body: {} })).status, 400, 'ohne Bestätigung keine Absage');
  assert.equal((await call('POST', '/manage/cancel', { token: a.token, body: { confirm: 'ja' } })).status, 400);
  assert.equal((await call('GET', '/manage', { token: a.token })).data.status, 'requested');
  const done = await call('POST', '/manage/cancel', { token: a.token, body: { confirm: true } });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.data.status, 'withdrawn', 'offene Anfrage -> zurückgezogen');
  assert.equal(done.data.canCancel, false);
  assert.equal(sentTo(a.email, 'zurückgezogen').length, 1);
  assert.equal(sentTo('lcordella818@gmail.com', 'zurückgezogen').length, 1);
  assert.equal((await requestBooking(date, '09:00')).status, 201, 'Zeitraum sofort wieder frei');
  assert.equal((await call('POST', '/manage/cancel', { token: a.token, body: { confirm: true } })).status, 409, 'nicht erneut bearbeitbar');
});

test('Admin: Einrichtung, Anmeldung, Sitzung, Fehlversuche, Sperre', opts, async () => {
  const setupToken = await adminLogin();
  const me = await call('GET', '/admin/me', { cookie: ownerCookie });
  assert.equal(me.data.admin.role, 'owner');
  assert.equal(me.data.admin.email, 'chef@beispiel.de');
  const cookieHeader = (await call('POST', '/admin/login', { body: { email: 'chef@beispiel.de', password: 'sehr-sicheres-passwort' } })).headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Strict/);
  assert.match(cookieHeader, /Secure/);
  assert.match(cookieHeader, /Path=\/api/);
  assert.equal((await call('POST', '/admin/setup', { body: { token: setupToken, password: 'anderes-passwort-123' } })).status, 400, 'Einrichtungslink nur einmal nutzbar');
  assert.equal((await call('POST', '/admin/setup', { body: { token: 'x'.repeat(43), password: 'anderes-passwort-123' } })).status, 400);
  const bad = await call('POST', '/admin/login', { body: { email: 'chef@beispiel.de', password: 'falsch' } });
  assert.equal(bad.status, 401);
  assert.equal((await call('POST', '/admin/login', { body: { email: 'unbekannt@x.de', password: 'falsch' } })).data.message, bad.data.message, 'gleiche Meldung: verrät nicht, ob das Konto existiert');
  assert.ok(!bad.headers.get('set-cookie'));
  // Ohne Anmeldung sind alle Admin-Funktionen gesperrt
  for (const [m, p] of [['GET', '/admin/requests'], ['GET', '/admin/calendar?from=2026-01-01&to=2026-01-02'], ['POST', '/admin/bookings'], ['GET', '/admin/search?q=abc'], ['GET', '/admin/blocks'], ['POST', '/admin/blocks'], ['GET', '/admin/settings'], ['PUT', '/admin/settings'], ['GET', '/admin/emails'], ['GET', '/admin/admins'], ['POST', '/admin/admins'], ['GET', '/admin/me'], ['PATCH', '/admin/bookings/00000000-0000-4000-8000-000000000000'], ['DELETE', '/admin/bookings/00000000-0000-4000-8000-000000000000']]) {
    assert.equal((await call(m, p, { body: {} })).status, 401, `${m} ${p} muss gesperrt sein`);
  }
  assert.equal((await call('GET', '/admin/me', { cookie: 'kf_session=' + 'z'.repeat(43) })).status, 401, 'erfundene Sitzung');
  // Abmelden beendet die Sitzung wirklich
  const tmp = await call('POST', '/admin/login', { body: { email: 'chef@beispiel.de', password: 'sehr-sicheres-passwort' } });
  const tmpCookie = tmp.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/admin/me', { cookie: tmpCookie })).status, 200);
  await call('POST', '/admin/logout', { cookie: tmpCookie });
  assert.equal((await call('GET', '/admin/me', { cookie: tmpCookie })).status, 401);
  // Kontosperre nach 8 Fehlversuchen
  for (let i = 0; i < 8; i++) await call('POST', '/admin/login', { body: { email: 'chef@beispiel.de', password: `falsch${i}` } });
  const locked = await call('POST', '/admin/login', { body: { email: 'chef@beispiel.de', password: 'sehr-sicheres-passwort' } });
  assert.equal(locked.status, 429);
  await tdb.sql(`update kf_admins set locked_until=null, failed_logins=0`);
  assert.equal((await call('POST', '/admin/login', { body: { email: 'chef@beispiel.de', password: 'sehr-sicheres-passwort' } })).status, 200);
});

test('Admin: offene Anfragen annehmen und ablehnen, Mails, Liste wird kleiner', opts, async () => {
  await tdb.sql(`update kf_bookings set status='declined' where status='requested'`); // saubere Liste
  const date = day(7);
  const a = await requestBooking(date, '09:00', { name: 'Anna Annahme', phone: '0170 1', note: 'Notiz A' });
  const b = await requestBooking(date, '11:00', { name: 'Bernd Ablehnung' });
  const list = await call('GET', '/admin/requests', { cookie: ownerCookie });
  assert.equal(list.data.requests.length, 2);
  const first = list.data.requests.find((r) => r.name === 'Anna Annahme');
  assert.equal(first.status, 'requested');
  assert.equal(first.email, a.email);
  assert.equal(first.phone, '0170 1');
  assert.equal(first.note, 'Notiz A');
  resetMails();
  const acc = await call('POST', `/admin/bookings/${first.id}/accept`, { cookie: ownerCookie, body: {} });
  assert.equal(acc.status, 200, acc.text);
  assert.equal(acc.data.booking.status, 'confirmed');
  const confirmed = sentTo(a.email, 'bestätigt');
  assert.equal(confirmed.length, 1);
  assert.ok(confirmed[0].html.includes('14:00') === false && /09:00 bis 10:00 Uhr/.test(confirmed[0].html), 'Datum + Uhrzeit in der Annahme-Mail');
  assert.ok(confirmed[0].html.includes(`${SITE}/termin#${a.token}`), 'derselbe persönliche Link bleibt gültig');
  const second = list.data.requests.find((r) => r.name === 'Bernd Ablehnung');
  const dec = await call('POST', `/admin/bookings/${second.id}/decline`, { cookie: ownerCookie, body: {} });
  assert.equal(dec.data.booking.status, 'declined');
  assert.equal(sentTo(b.email, 'Terminanfrage').length, 1, 'höfliche Absage');
  assert.equal((await call('GET', '/admin/requests', { cookie: ownerCookie })).data.requests.length, 0, 'beide verschwinden aus der Liste');
  assert.equal((await requestBooking(date, '11:00')).status, 201, 'abgelehnter Zeitraum ist frei');
  assert.equal((await requestBooking(date, '09:00')).status, 409, 'bestätigter Zeitraum bleibt blockiert');
  assert.equal((await call('POST', `/admin/bookings/${first.id}/accept`, { cookie: ownerCookie, body: {} })).status, 409, 'nicht doppelt annehmbar');
  assert.equal((await call('POST', `/admin/bookings/nicht-gueltig/accept`, { cookie: ownerCookie, body: {} })).status, 404);
  // Kunde sieht den bestätigten Termin und kann ihn absagen
  const v = await call('GET', '/manage', { token: a.token });
  assert.equal(v.data.status, 'confirmed');
  assert.equal(v.data.action, 'cancel');
  resetMails();
  const c = await call('POST', '/manage/cancel', { token: a.token, body: { confirm: true } });
  assert.equal(c.data.status, 'cancelled');
  assert.equal(sentTo(a.email, 'abgesagt').length, 1);
  assert.equal(sentTo('lcordella818@gmail.com', 'abgesagt').length, 1);
  assert.equal((await requestBooking(date, '09:00')).status, 201, 'abgesagter Zeitraum wieder frei');
});

test('Admin: manueller Termin, Bearbeiten, Verschieben, Löschen, Notizen bleiben intern', opts, async () => {
  const date = day(9);
  resetMails();
  const created = await call('POST', '/admin/bookings', { cookie: ownerCookie, body: { name: 'Frau Telefon', phone: '0151 222', start: `${date}T09:10`, durationMinutes: 45, internalNote: 'Bringt Foto mit' } });
  assert.equal(created.status, 201, created.text);
  const m = created.data.booking;
  assert.equal(m.status, 'confirmed');
  assert.equal(m.source, 'manual');
  assert.equal(m.internalNote, 'Bringt Foto mit');
  assert.equal(new Date(m.end) - new Date(m.start), 45 * 60000);
  assert.equal(mails.length, 0, 'ohne E-Mail-Adresse keine Kunden-Mail');
  assert.equal((await requestBooking(date, '09:00')).status, 409, 'manueller Termin blockiert');
  assert.equal((await call('POST', '/admin/bookings', { cookie: ownerCookie, body: { name: 'Doppelt', start: `${date}T09:30`, durationMinutes: 30 } })).status, 409);
  assert.equal((await call('POST', '/admin/bookings', { cookie: ownerCookie, body: { name: 'X', start: `${date}T09:30`, durationMinutes: 30 } })).status, 422, 'Name zu kurz');
  assert.equal((await call('POST', '/admin/bookings', { cookie: ownerCookie, body: { name: 'Ok Name', start: `${date}T09:30`, durationMinutes: 0 } })).status, 422);
  assert.equal((await call('POST', '/admin/bookings', { cookie: ownerCookie, body: { name: 'Ok Name', start: '2026-03-29T02:30', durationMinutes: 30 } })).status, 422, 'Zeit, die es wegen Zeitumstellung nicht gibt');
  // Mit E-Mail: Kunde bekommt Bestätigung + Link
  const withMail = await call('POST', '/admin/bookings', { cookie: ownerCookie, body: { name: 'Herr Mail', email: 'herr@mail.de', start: `${date}T14:00`, durationMinutes: 60 } });
  assert.equal(sentTo('herr@mail.de', 'bestätigt').length, 1);
  // Verschieben
  resetMails();
  const moved = await call('PATCH', `/admin/bookings/${withMail.data.booking.id}`, { cookie: ownerCookie, body: { start: `${date}T16:00` } });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.data.booking.start, startOf(date, '16:00'));
  assert.equal(new Date(moved.data.booking.end) - new Date(moved.data.booking.start), 3600000, 'Dauer bleibt');
  assert.equal(sentTo('herr@mail.de', 'geändert').length, 1);
  assert.equal((await requestBooking(date, '14:00')).status, 201, 'alter Platz frei');
  assert.equal((await call('PATCH', `/admin/bookings/${withMail.data.booking.id}`, { cookie: ownerCookie, body: { start: `${date}T09:15` } })).status, 409, 'Verschieben in belegte Zeit');
  const edit = await call('PATCH', `/admin/bookings/${m.id}`, { cookie: ownerCookie, body: { name: 'Frau Telefon-Neu', durationMinutes: 60, internalNote: null } });
  assert.equal(edit.data.booking.name, 'Frau Telefon-Neu');
  assert.equal(edit.data.booking.internalNote, null);
  assert.equal(edit.data.booking.phone, '0151 222', 'nicht gesendete Felder bleiben');
  // Interne Notizen sind nirgends für Kunden sichtbar
  await call('PATCH', `/admin/bookings/${m.id}`, { cookie: ownerCookie, body: { internalNote: 'TOP-SECRET-INTERN' } });
  const pub = await call('GET', `/availability?from=${date}&to=${date}`);
  assert.ok(!pub.text.includes('TOP-SECRET') && !pub.text.includes('Telefon'));
  // Löschen
  assert.equal((await call('DELETE', `/admin/bookings/${m.id}`, { cookie: ownerCookie })).status, 200);
  assert.equal((await call('GET', `/admin/bookings/${m.id}`, { cookie: ownerCookie })).status, 404);
  assert.equal((await requestBooking(date, '09:00')).status, 201, 'gelöschter Termin ist frei');
  // Absagen durch den Salon
  resetMails();
  const toCancel = await call('POST', `/admin/bookings/${withMail.data.booking.id}/cancel`, { cookie: ownerCookie, body: {} });
  assert.equal(toCancel.data.booking.status, 'cancelled');
  assert.equal(sentTo('herr@mail.de', 'abgesagt').length, 1);
});

test('Admin-Kalender: Monats-/Wochen-/Tagesbereich liefert Termine mit Status, Historie optional', opts, async () => {
  const date = day(10);
  const a = await requestBooking(date, '10:00');
  const b = await requestBooking(date, '12:00');
  const c = await requestBooking(date, '14:00');
  const d = await requestBooking(date, '16:00');
  const all = (await call('GET', '/admin/requests', { cookie: ownerCookie })).data.requests;
  const id = (email) => all.find((r) => r.email === email).id;
  await call('POST', `/admin/bookings/${id(b.email)}/accept`, { cookie: ownerCookie, body: {} });
  await call('POST', `/admin/bookings/${id(b.email)}/cancel`, { cookie: ownerCookie, body: {} });
  await call('POST', `/admin/bookings/${id(c.email)}/decline`, { cookie: ownerCookie, body: {} });
  await call('POST', `/admin/bookings/${id(d.email)}/accept`, { cookie: ownerCookie, body: {} });
  const cal = await call('GET', `/admin/calendar?from=${date}&to=${date}`, { cookie: ownerCookie });
  const byEmail = Object.fromEntries(cal.data.bookings.map((x) => [x.email, x.status]));
  assert.equal(byEmail[a.email], 'requested', 'gelb');
  assert.equal(byEmail[d.email], 'confirmed', 'grün');
  assert.equal(byEmail[b.email], 'cancelled', 'rot');
  assert.equal(byEmail[c.email], undefined, 'abgelehnt nicht im Kalender');
  const hist = await call('GET', `/admin/calendar?from=${date}&to=${date}&history=1`, { cookie: ownerCookie });
  assert.equal(hist.data.bookings.find((x) => x.email === c.email).status, 'declined', 'Historie zeigt abgelehnte');
  const month = await call('GET', `/admin/calendar?from=${day(0)}&to=${day(42)}`, { cookie: ownerCookie });
  assert.ok(month.data.bookings.length >= 4);
  assert.equal((await call('GET', '/admin/calendar?from=x&to=y', { cookie: ownerCookie })).status, 400);
});

test('Sperrzeiten: ganze Tage, Zeiträume, mehrere Wochen; bestehende Termine bleiben', opts, async () => {
  const date = day(12);
  const existing = await requestBooking(date, '11:00');
  const part = { start: `${date}T11:00`, end: `${date}T14:00`, reason: 'Arzt' };
  const warn = await call('POST', '/admin/blocks', { cookie: ownerCookie, body: part });
  assert.equal(warn.status, 409);
  assert.equal(warn.data.error, 'conflicts');
  assert.equal(warn.data.conflicts.length, 1);
  assert.match(warn.data.message, /NICHT gelöscht/);
  assert.equal((await call('GET', '/admin/blocks', { cookie: ownerCookie })).data.blocks.filter((b) => b.reason === 'Arzt').length, 0);
  const ok = await call('POST', '/admin/blocks', { cookie: ownerCookie, body: { ...part, acknowledgeConflicts: true } });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.data.conflictCount, 1);
  const stillThere = (await call('GET', '/admin/requests', { cookie: ownerCookie })).data.requests.find((r) => r.email === existing.email);
  assert.equal(stillThere.status, 'requested', 'Termin wurde nicht angetastet');
  assert.equal((await requestBooking(date, '12:00')).status, 409, 'gesperrt');
  assert.equal((await requestBooking(date, '14:00')).status, 201, 'danach frei');
  const av = (await call('GET', `/availability?from=${date}&to=${date}`)).data.days[0];
  assert.equal(av.slots.find((s) => s[0] === startOf(date, '13:00'))[1], 0);
  // Ganze Tage / Urlaub über mehrere Wochen
  const vac = await call('POST', '/admin/blocks', { cookie: ownerCookie, body: { startDate: day(15), endDate: day(28), reason: 'Urlaub' } });
  assert.equal(vac.status, 201, vac.text);
  const days = (await call('GET', `/availability?from=${day(14)}&to=${day(29)}`)).data.days;
  assert.equal(days[0].free > 0, true, 'Tag davor frei');
  for (let i = 1; i <= 14; i++) assert.equal(days[i].free, 0, `${days[i].date} ist gesperrt`);
  assert.equal(days[15].free > 0, true, 'Tag danach frei');
  assert.equal((await requestBooking(day(20), '10:00')).status, 409);
  // Mehrere Sperren am selben Tag + Löschen gibt frei
  const d2 = day(29);
  const s1 = await call('POST', '/admin/blocks', { cookie: ownerCookie, body: { start: `${d2}T09:00`, end: `${d2}T10:00` } });
  const s2 = await call('POST', '/admin/blocks', { cookie: ownerCookie, body: { start: `${d2}T13:00`, end: `${d2}T15:00` } });
  assert.equal(s1.status + s2.status, 402);
  assert.equal((await requestBooking(d2, '09:00')).status, 409);
  assert.equal((await requestBooking(d2, '11:00')).status, 201, 'zwischen den Sperren frei');
  await call('DELETE', `/admin/blocks/${s2.data.block.id}`, { cookie: ownerCookie });
  assert.equal((await requestBooking(d2, '13:00')).status, 201);
  assert.equal((await call('DELETE', `/admin/blocks/${s2.data.block.id}`, { cookie: ownerCookie })).status, 404);
  // Ungültige Eingaben
  assert.equal((await call('POST', '/admin/blocks', { cookie: ownerCookie, body: { start: `${d2}T10:00`, end: `${d2}T09:00` } })).status, 422);
  assert.equal((await call('POST', '/admin/blocks', { cookie: ownerCookie, body: { startDate: day(5), endDate: day(3) } })).status, 422);
  assert.equal((await call('POST', '/admin/blocks', { cookie: ownerCookie, body: { startDate: 'x' } })).status, 422);
  // Kunden erkennen nicht, ob Sperre oder Termin
  const pub = (await call('GET', `/availability?from=${date}&to=${date}`)).text;
  assert.ok(!pub.includes('Arzt') && !pub.includes('Urlaub') && !pub.includes('reason'));
});

test('Einstellungen: Termindauer (30/45/60/90/frei), Buchungsfrist, Kontaktadresse', opts, async () => {
  const get = await call('GET', '/admin/settings', { cookie: ownerCookie });
  assert.deepEqual(get.data.settings, { durationMinutes: 60, horizonDays: 30, minLeadMinutes: 0, contactEmail: 'lcordella818@gmail.com', businessName: 'Kellerfriseur' });
  const date = day(13);
  for (const dur of [30, 45, 90, 75]) {
    assert.equal((await call('PUT', '/admin/settings', { cookie: ownerCookie, body: { durationMinutes: dur } })).status, 200);
    const r = await requestBooking(date, '08:00');
    assert.equal(r.status, 201);
    assert.equal(new Date(r.data.end) - new Date(r.data.start), dur * 60000, `Dauer ${dur}`);
    const me = (await call('GET', `/admin/calendar?from=${date}&to=${date}`, { cookie: ownerCookie })).data.bookings.find((b) => b.email === r.email);
    await call('POST', `/admin/bookings/${me.id}/decline`, { cookie: ownerCookie, body: {} });
    assert.equal((await call('GET', `/availability?from=${date}&to=${date}`)).data.durationMinutes, dur);
  }
  await call('PUT', '/admin/settings', { cookie: ownerCookie, body: { durationMinutes: 60, horizonDays: 7 } });
  assert.equal((await requestBooking(day(8), '10:00')).status, 422, 'Frist 7 Tage greift');
  assert.equal((await call('GET', `/availability?from=${day(7)}&to=${day(8)}`)).data.days[1].bookable, false);
  await call('PUT', '/admin/settings', { cookie: ownerCookie, body: { horizonDays: 30, minLeadMinutes: 60 * 24 * 2 } });
  assert.equal((await requestBooking(day(1), '10:00')).status, 422, 'Mindestvorlauf 2 Tage');
  await call('PUT', '/admin/settings', { cookie: ownerCookie, body: { minLeadMinutes: 0 } });
  assert.equal((await call('PUT', '/admin/settings', { cookie: ownerCookie, body: { durationMinutes: 2 } })).status, 422);
  assert.equal((await call('PUT', '/admin/settings', { cookie: ownerCookie, body: { durationMinutes: 'abc' } })).status, 422);
  assert.equal((await call('PUT', '/admin/settings', { cookie: ownerCookie, body: { horizonDays: 0 } })).status, 422);
  assert.equal((await call('PUT', '/admin/settings', { cookie: ownerCookie, body: { contactEmail: 'kaputt' } })).status, 422);
  assert.equal((await call('PUT', '/admin/settings', { cookie: ownerCookie, body: {} })).status, 400);
  // Kontaktadresse ändern -> neue Anfragen gehen an die neue Adresse
  await call('PUT', '/admin/settings', { cookie: ownerCookie, body: { contactEmail: 'neu@salon.de' } });
  resetMails();
  await requestBooking(day(14), '08:00');
  assert.equal(sentTo('neu@salon.de', 'Neue Terminanfrage').length, 1);
  assert.equal(sentTo('lcordella818@gmail.com', 'Neue Terminanfrage').length, 0);
  await call('PUT', '/admin/settings', { cookie: ownerCookie, body: { contactEmail: 'lcordella818@gmail.com' } });
});

test('Kundensuche: Name, E-Mail, Telefon, vergangene und zukünftige Termine, nur für Admins', opts, async () => {
  await call('POST', '/admin/bookings', { cookie: ownerCookie, body: { name: 'Sabine Sucherin', email: 'sabine.s@test.de', phone: '0172 3334445', start: `${day(-30)}T10:00`, durationMinutes: 60 } });
  await call('POST', '/admin/bookings', { cookie: ownerCookie, body: { name: 'Sabine Sucherin', email: 'sabine.s@test.de', phone: '0172 3334445', start: `${day(20)}T10:00`, durationMinutes: 60 } });
  for (const q of ['sucherin', 'SABINE.S@', '0172 333', '+49 172 3334445']) {
    const r = await call('GET', `/admin/search?q=${encodeURIComponent(q)}`, { cookie: ownerCookie });
    const c = r.data.customers.find((x) => x.email === 'sabine.s@test.de');
    assert.ok(c, `Suche "${q}" findet die Kundin`);
    assert.equal(c.bookings.length, 2);
    assert.ok(new Date(c.bookings[0].start) > new Date(c.bookings[1].start), 'neueste zuerst');
  }
  assert.equal((await call('GET', '/admin/search?q=a', { cookie: ownerCookie })).status, 400);
  assert.equal((await call('GET', '/admin/search?q=sucherin')).status, 401, 'ohne Anmeldung gesperrt');
  assert.equal((await call('GET', `/admin/search?q=${encodeURIComponent("'; DROP TABLE kf_bookings; --")}`, { cookie: ownerCookie })).data.customers.length, 0);
});

test('E-Mail-Fehler: Buchung geht nicht verloren, Fehler wird protokolliert, erneut senden klappt', opts, async () => {
  mailMode.ok = false;
  const r = await requestBooking(day(30), '08:00');
  assert.equal(r.status, 201, 'Buchung trotz E-Mail-Fehler gespeichert');
  const logs = (await call('GET', '/admin/emails?status=failed', { cookie: ownerCookie })).data.emails;
  const mine = logs.filter((l) => l.to === r.email);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'failed');
  assert.match(mine[0].error, /403/);
  assert.equal(mine[0].retryable, true);
  assert.ok(logs.some((l) => l.kind === 'admin_new_request' && l.booking?.name === 'Max Muster'));
  // Retry während der Dienst noch kaputt ist
  const again = await call('POST', `/admin/emails/${mine[0].id}/retry`, { cookie: ownerCookie });
  assert.equal(again.data.ok, false);
  mailMode.ok = true; resetMails();
  const retry = await call('POST', `/admin/emails/${mine[0].id}/retry`, { cookie: ownerCookie });
  assert.equal(retry.data.ok, true);
  assert.equal(sentTo(r.email, 'eingegangen').length, 1);
  assert.ok(sentTo(r.email)[0].html.includes(`/termin#${r.token}`), 'Wiederholung enthält denselben persönlichen Link');
  const sentRow = (await call('GET', '/admin/emails?status=sent', { cookie: ownerCookie })).data.emails.find((l) => l.id === mine[0].id);
  assert.equal(sentRow.status, 'sent');
  assert.ok(sentRow.attempts >= 3);
  assert.equal((await call('POST', `/admin/emails/${mine[0].id}/retry`, { cookie: ownerCookie })).status, 409, 'bereits gesendet');
  assert.equal((await call('POST', `/admin/emails/${mine[0].id}/retry`)).status, 401);
});

test('Mehrere Admins: Einladung, eigenes Passwort, Rechte, Deaktivieren', opts, async () => {
  resetMails();
  const inv = await call('POST', '/admin/admins', { cookie: ownerCookie, body: { name: 'Lisa Friseurin', email: 'Lisa@Salon.de' } });
  assert.equal(inv.status, 201, inv.text);
  assert.match(inv.data.inviteUrl, new RegExp(`^${SITE}/admin/#setup=[A-Za-z0-9_-]{43}$`));
  assert.equal(inv.data.admin.pendingSetup, true);
  assert.equal(sentTo('lisa@salon.de', 'Einladung').length, 1);
  assert.ok(sentTo('lisa@salon.de')[0].html.includes(inv.data.inviteUrl.split('#')[1]));
  assert.equal((await call('POST', '/admin/admins', { cookie: ownerCookie, body: { name: 'Lisa Doppelt', email: 'lisa@salon.de' } })).status, 409, 'E-Mail nur einmal');
  assert.equal((await call('POST', '/admin/login', { body: { email: 'lisa@salon.de', password: 'irgendwas12345' } })).status, 401, 'vor der Einrichtung kein Login');
  assert.equal((await call('POST', '/admin/setup', { body: { token: inv.data.inviteUrl.split('=')[1], password: 'kurz' } })).status, 422);
  const setup = await call('POST', '/admin/setup', { body: { token: inv.data.inviteUrl.split('=')[1], password: 'lisas-eigenes-passwort' } });
  assert.equal(setup.status, 200, setup.text);
  assert.equal(setup.data.admin.role, 'admin');
  const lisa = setup.headers.get('set-cookie').split(';')[0];
  // Lisa darf Termine verwalten, aber keine Admins
  assert.equal((await call('GET', '/admin/requests', { cookie: lisa })).status, 200);
  assert.equal((await call('GET', '/admin/admins', { cookie: lisa })).status, 403);
  assert.equal((await call('POST', '/admin/admins', { cookie: lisa, body: { name: 'Eve Fremd', email: 'eve@x.de' } })).status, 403, 'kein Admin-Konto ohne Berechtigung');
  assert.equal((await call('PATCH', `/admin/admins/${ownerId}`, { cookie: lisa, body: { active: false } })).status, 403);
  // Beide bekommen Benachrichtigungen
  resetMails();
  await requestBooking(day(30), '12:00');
  assert.equal(sentTo('lisa@salon.de', 'Neue Terminanfrage').length, 1);
  assert.equal(sentTo('chef@beispiel.de', 'Neue Terminanfrage').length, 1);
  assert.equal(sentTo('lcordella818@gmail.com', 'Neue Terminanfrage').length, 1);
  // Passwort ändern
  assert.equal((await call('POST', '/admin/password', { cookie: lisa, body: { currentPassword: 'falsch', newPassword: 'neues-passwort-123' } })).status, 403);
  assert.equal((await call('POST', '/admin/password', { cookie: lisa, body: { currentPassword: 'lisas-eigenes-passwort', newPassword: 'neues-passwort-123' } })).status, 200);
  assert.equal((await call('POST', '/admin/login', { body: { email: 'lisa@salon.de', password: 'neues-passwort-123' } })).status, 200);
  // Benachrichtigung abschalten, Deaktivieren beendet Sitzungen
  const lisaId = inv.data.admin.id;
  await call('PATCH', `/admin/admins/${lisaId}`, { cookie: ownerCookie, body: { notify: false } });
  resetMails();
  await requestBooking(day(30), '14:00');
  assert.equal(sentTo('lisa@salon.de').length, 0);
  assert.equal((await call('PATCH', `/admin/admins/${lisaId}`, { cookie: ownerCookie, body: { active: false } })).status, 200);
  assert.equal((await call('GET', '/admin/requests', { cookie: lisa })).status, 401, 'Sitzung beendet');
  assert.equal((await call('POST', '/admin/login', { body: { email: 'lisa@salon.de', password: 'neues-passwort-123' } })).status, 401);
  assert.equal((await call('PATCH', `/admin/admins/${ownerId}`, { cookie: ownerCookie, body: { active: false } })).status, 409, 'Hauptadmin nicht deaktivierbar');
  // Neuer Einrichtungslink (Passwort vergessen)
  assert.equal((await call('PATCH', `/admin/admins/${lisaId}`, { cookie: ownerCookie, body: { active: true } })).status, 200);
  const re = await call('POST', `/admin/admins/${lisaId}/invite`, { cookie: ownerCookie });
  assert.equal(re.status, 200);
  assert.equal((await call('POST', '/admin/setup', { body: { token: re.data.inviteUrl.split('=')[1], password: 'wieder-neues-passwort' } })).status, 200);
  const list = await call('GET', '/admin/admins', { cookie: ownerCookie });
  assert.equal(list.data.admins.length, 2);
  assert.ok(list.data.admins.every((a) => !('password_hash' in a) && !JSON.stringify(a).includes('scrypt')));
});

test('Abgelaufene Einladung wird abgelehnt', opts, async () => {
  const path = await tdb.sql(`insert into kf_admins(email,name,invite_token_hash,invite_expires_at) values ('alt@x.de','Alt', encode(sha256(convert_to('A'||repeat('b',42),'UTF8')),'hex'), now() - interval '1 hour') returning 'ok'`);
  assert.equal(path, 'ok');
  assert.equal((await call('POST', '/admin/setup', { body: { token: 'A' + 'b'.repeat(42), password: 'langes-passwort-123' } })).status, 400);
});

test('Diagnose: zeigt Test-Absender-Warnung, ohne Geheimnisse', opts, async () => {
  const d = await call('GET', '/admin/diagnostics', { cookie: ownerCookie });
  assert.equal(d.data.database, true);
  assert.equal(d.data.usingResendTestSender, true);
  assert.ok(!d.text.includes(KEY) && !d.text.includes(APP_SECRET));
});

test('Geheimnisse: kein API-Antworttext enthält Schlüssel oder Passwort-Hashes', opts, async () => {
  const probes = [
    call('GET', '/health'), call('GET', `/availability?from=${day(1)}&to=${day(3)}`),
    call('GET', '/admin/admins', { cookie: ownerCookie }), call('GET', '/admin/settings', { cookie: ownerCookie }),
    call('GET', '/admin/emails', { cookie: ownerCookie }), call('GET', '/nicht-vorhanden'), call('DELETE', '/availability'),
    call('POST', '/bookings', { raw: '{' }),
  ];
  for (const r of await Promise.all(probes)) {
    assert.ok(!r.text.includes(KEY) && !r.text.includes(APP_SECRET) && !r.text.includes('scrypt$') && !r.text.includes('token_hash'), r.text.slice(0, 120));
  }
  assert.equal((await call('GET', '/nicht-vorhanden')).status, 404);
  assert.equal((await call('DELETE', '/availability')).status, 405);
});

test('Datenbankausfall: freundliche Fehlermeldung, kein Absturz, keine Interna', opts, async () => {
  const broken = createApp({ db: createDb({ url: 'http://127.0.0.1:1', key: KEY, timeoutMs: 500 }), config: loadConfig({ SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: KEY, APP_SECRET }), mailer, log: { error() {} } });
  const res = await broken.handle(new Request(`${SITE}/api/availability?from=${day(1)}&to=${day(1)}`, { headers: { 'x-nf-client-connection-ip': '9.9.9.9' } }), {});
  const data = await res.json();
  assert.equal(res.status, 503);
  assert.equal(data.error, 'server_error');
  assert.match(data.message, /später/);
  assert.ok(!JSON.stringify(data).includes('127.0.0.1'));
});
