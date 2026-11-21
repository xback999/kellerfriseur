// Reine Logik-Tests ohne Datenbank: Zeit/Sommerzeit, Slots, Validierung, Krypto, E-Mails, Mailer, DB-Client.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, daySlotStarts, diffDays, formatRangeDe, localDateStr, localDayRange,
  localToUtcMs, parseLocalDateTime, tzOffsetMs,
} from '../netlify/lib/time.mjs';
import { buildAvailability, validateRange } from '../netlify/lib/slots.mjs';
import {
  validateEmail, validateName, validateNote, validatePassword, validatePhone, isTokenShape, cleanLine,
} from '../netlify/lib/validate.mjs';
import {
  burnPasswordCheck, deriveBookingToken, hashPassword, newBookingCredentials, sha256Hex, verifyPassword,
} from '../netlify/lib/crypto.mjs';
import { buildEmail, esc } from '../netlify/lib/emails.mjs';
import { createMailer } from '../netlify/lib/mailer.mjs';
import { createDb, DbError } from '../netlify/lib/db.mjs';
import { loadConfig } from '../netlify/lib/config.mjs';

const H = 3600000;

test('Zeit: Berlin ist im Winter UTC+1, im Sommer UTC+2', () => {
  assert.equal(tzOffsetMs(Date.UTC(2026, 0, 15, 12)), 1 * H);
  assert.equal(tzOffsetMs(Date.UTC(2026, 6, 15, 12)), 2 * H);
});

test('Zeit: Tage haben 96 Slots, Umstellungstage 92 bzw. 100', () => {
  assert.equal(daySlotStarts('2026-11-20').length, 96);
  assert.equal(daySlotStarts('2026-03-29').length, 92, 'Sommerzeit beginnt (23h)');
  assert.equal(daySlotStarts('2026-10-25').length, 100, 'Sommerzeit endet (25h)');
});

test('Zeit: 24/7 – erster Slot 00:00, letzter 23:45 Ortszeit', () => {
  const s = daySlotStarts('2026-11-20');
  assert.equal(new Date(s[0]).toISOString(), '2026-11-19T23:00:00.000Z');
  assert.equal(new Date(s.at(-1)).toISOString(), '2026-11-20T22:45:00.000Z');
});

test('Zeit: Ortszeit <-> UTC, Nicht-existente Zeiten werden abgelehnt', () => {
  assert.equal(parseLocalDateTime('2026-11-20T14:30'), Date.UTC(2026, 10, 20, 13, 30));
  assert.equal(parseLocalDateTime('2026-07-01T14:30'), Date.UTC(2026, 6, 1, 12, 30));
  assert.equal(parseLocalDateTime('2026-03-29T02:30'), null, 'Zeitumstellung: 02:30 existiert nicht');
  assert.equal(parseLocalDateTime('2026-02-30T10:00'), null);
  assert.equal(parseLocalDateTime('2026-11-20T24:00'), null);
  assert.equal(parseLocalDateTime('quatsch'), null);
});

test('Zeit: Datums-Hilfen', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(diffDays('2026-11-20', '2026-12-20'), 30);
  assert.equal(localDateStr(Date.UTC(2026, 10, 20, 23, 30)), '2026-11-21', '23:30 UTC ist in Berlin schon der nächste Tag');
  const [a, b] = localDayRange('2026-11-20');
  assert.equal(b - a, 24 * H);
  assert.equal(localToUtcMs(2026, 11, 20, 0, 0), a);
});

test('Zeit: deutsche Formatierung in Berliner Zeit', () => {
  const s = Date.UTC(2026, 10, 20, 13, 0);
  assert.equal(formatRangeDe(s, s + H), 'Freitag, 20. November 2026, 14:00 bis 15:00 Uhr');
});

// --- Slots -----------------------------------------------------------------
const NOW = Date.UTC(2026, 10, 20, 6, 17); // 07:17 Berlin
const state = (over = {}) => ({ durationMinutes: 60, horizonDays: 30, minLeadMinutes: 0, busy: [], ...over });
const day = (days, d) => days.find((x) => x.date === d);

test('Slots: ganzer Tag 15-Minuten-Raster, vergangene Zeiten fehlen heute', () => {
  const days = buildAvailability({ from: '2026-11-20', to: '2026-11-21', state: state(), now: NOW });
  const today = day(days, '2026-11-20');
  assert.equal(today.slots[0][0], '2026-11-20T06:30:00.000Z', 'erster freier Slot heute: 07:30 Berlin');
  assert.equal(day(days, '2026-11-21').slots.length, 96);
  assert.ok(day(days, '2026-11-21').slots.every((s) => s[1] === 1));
});

test('Slots: Belegung blockiert überlappende Startzeiten, aufeinanderfolgende bleiben frei', () => {
  // Termin 09:00-10:00 Berlin = 08:00-09:00 UTC
  const busy = [[Date.UTC(2026, 10, 21, 8), Date.UTC(2026, 10, 21, 9)]];
  const d = day(buildAvailability({ from: '2026-11-21', to: '2026-11-21', state: state({ busy }), now: NOW }), '2026-11-21');
  const free = Object.fromEntries(d.slots.map(([t, f]) => [t.slice(11, 16), f]));
  assert.equal(free['07:00'], 1, '08:00 Berlin: endet 09:00 = Beginn des Termins -> frei');
  assert.equal(free['07:15'], 0, '08:15 Berlin würde in den Termin ragen');
  assert.equal(free['08:00'], 0);
  assert.equal(free['08:45'], 0);
  assert.equal(free['09:00'], 1, '10:00 Berlin direkt nach dem Termin -> frei');
});

test('Slots: variable Dauer (30/45/90 Minuten)', () => {
  const busy = [[Date.UTC(2026, 10, 21, 9), Date.UTC(2026, 10, 21, 10)]];
  const at = (dur) => Object.fromEntries(day(buildAvailability({ from: '2026-11-21', to: '2026-11-21', state: state({ busy, durationMinutes: dur }), now: NOW }), '2026-11-21').slots.map(([t, f]) => [t.slice(11, 16), f]));
  assert.equal(at(30)['08:30'], 1);
  assert.equal(at(30)['08:45'], 0);
  assert.equal(at(45)['08:15'], 1);
  assert.equal(at(45)['08:30'], 0);
  assert.equal(at(90)['07:30'], 1);
  assert.equal(at(90)['07:45'], 0);
});

test('Slots: Buchungsfrist (30 Tage) und Mindestvorlauf', () => {
  const days = buildAvailability({ from: '2026-11-19', to: '2026-12-22', state: state(), now: NOW });
  assert.equal(day(days, '2026-11-19').bookable, false, 'gestern');
  assert.equal(day(days, '2026-11-20').bookable, true);
  assert.equal(day(days, '2026-12-20').bookable, true, 'heute + 30 Tage');
  assert.equal(day(days, '2026-12-21').bookable, false);
  const lead = buildAvailability({ from: '2026-11-20', to: '2026-11-20', state: state({ minLeadMinutes: 120 }), now: NOW })[0];
  assert.equal(lead.slots[0][0], '2026-11-20T08:30:00.000Z', '07:17 + 2h -> frühestens 09:30 Berlin');
});

test('Slots: Bereichsprüfung', () => {
  assert.equal(validateRange('2026-11-01', '2026-12-12'), null);
  assert.ok(validateRange('2026-11-01', '2026-12-13'));
  assert.ok(validateRange('2026-12-01', '2026-11-01'));
  assert.ok(validateRange('x', '2026-11-01'));
});

// --- Validierung -----------------------------------------------------------
test('Validierung: Name, E-Mail, Telefon, Notiz', () => {
  assert.equal(validateName('  Max   Muster ', { requireFullName: true }).value, 'Max Muster');
  assert.ok(validateName('Max', { requireFullName: true }).error);
  assert.ok(validateName('x'.repeat(101)).error);
  assert.equal(validateName('Max\r\nBcc: a@b.de').value, 'Max Bcc: a@b.de', 'Zeilenumbrüche entfernt');
  assert.equal(validateEmail(' Max@Example.DE ').value, 'max@example.de');
  for (const bad of ['', 'abc', 'a@b', 'a b@c.de', 'a@b.c', 'a@@b.de', 'a@b..de', 'x@y.de\nBcc:z@z.de', '<a@b.de>']) {
    assert.ok(validateEmail(bad).error, `sollte ungültig sein: ${JSON.stringify(bad)}`);
  }
  assert.equal(validateEmail('', { required: false }).value, null);
  assert.equal(validatePhone('').value, null);
  assert.equal(validatePhone('+49 170 1234567').value, '+49 170 1234567');
  assert.ok(validatePhone('abc').error);
  assert.ok(validatePhone('12').error);
  assert.equal(validateNote('  hi ').value, 'hi');
  assert.ok(validateNote('x'.repeat(1001)).error);
  assert.ok(validatePassword('kurz').error);
  assert.equal(validatePassword('ein-langes-passwort').value, 'ein-langes-passwort');
  assert.ok(validatePassword('aaaaaaaaaaaa').error);
  assert.ok(isTokenShape('abcdefghij0123456789_-ABC'));
  assert.ok(!isTokenShape('zu kurz'));
  assert.ok(!isTokenShape("x'; drop table--".padEnd(30, 'a')));
  assert.equal(cleanLine('a\u0000b'), 'ab');
});

// --- Krypto ----------------------------------------------------------------
test('Krypto: Termin-Token stabil, eindeutig, Hash passt', () => {
  const secret = 's'.repeat(40);
  const a = newBookingCredentials(secret, 'id-1');
  assert.equal(a.token, deriveBookingToken(secret, 'id-1', a.salt));
  assert.equal(a.hash, sha256Hex(a.token));
  assert.ok(a.token.length >= 43 && /^[A-Za-z0-9_-]+$/.test(a.token));
  assert.notEqual(newBookingCredentials(secret, 'id-1').token, a.token, 'Salt macht jeden Token verschieden');
  assert.notEqual(deriveBookingToken('x'.repeat(40), 'id-1', a.salt), a.token, 'ohne richtiges Secret nicht ableitbar');
  assert.notEqual(a.hash, a.token, 'gespeichert wird nur der Hash');
});

test('Krypto: Passwörter mit scrypt', async () => {
  const h = await hashPassword('mein-geheimes-passwort');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(!h.includes('mein-geheimes'));
  assert.equal(await verifyPassword('mein-geheimes-passwort', h), true);
  assert.equal(await verifyPassword('falsch', h), false);
  assert.equal(await verifyPassword('x', 'kaputt'), false);
  assert.notEqual(await hashPassword('mein-geheimes-passwort'), h, 'zufälliger Salt');
  await burnPasswordCheck('x');
});

// --- E-Mail-Vorlagen ----------------------------------------------------------
const booking = { id: 'b1', customer_name: 'Max <script>alert(1)</script> Muster', start_at: '2026-11-21T13:00:00+00:00', end_at: '2026-11-21T14:00:00+00:00', status: 'requested', token_salt: 'x' };
const settings = { business_name: 'Kellerfriseur', contact_email: 'a@b.de' };

test('E-Mails: alle Arten bauen, Inhalt stimmt, HTML wird maskiert', () => {
  const ctx = { booking, settings, siteUrl: 'https://salon.example', manageUrl: 'https://salon.example/termin#TOKEN' };
  const kinds = ['customer_received', 'admin_new_request', 'customer_confirmed', 'customer_declined', 'customer_cancel_ack', 'admin_customer_cancelled', 'customer_cancelled_by_salon', 'customer_rescheduled'];
  for (const k of kinds) {
    const m = buildEmail(k, ctx);
    assert.ok(m.subject && m.html.includes('<html') && m.text.length > 20, k);
    assert.ok(!m.html.includes('<script>'), `${k}: Skript maskiert`);
  }
  const rec = buildEmail('customer_received', ctx);
  assert.ok(rec.html.includes('Samstag, 21. November 2026'));
  assert.ok(rec.html.includes('14:00 bis 15:00 Uhr'), 'Berliner Zeit');
  assert.ok(rec.html.includes('https://salon.example/termin#TOKEN'));
  const adm = buildEmail('admin_new_request', ctx);
  assert.ok(adm.html.includes('https://salon.example/admin/'));
  assert.ok(adm.html.includes('Kunde') && adm.html.includes('Uhrzeit'));
  assert.equal(buildEmail('customer_cancel_ack', { ...ctx, booking: { ...booking, status: 'withdrawn' } }).subject, 'Du hast deine Terminanfrage zurückgezogen');
  assert.equal(buildEmail('customer_cancel_ack', { ...ctx, booking: { ...booking, status: 'cancelled' } }).subject, 'Dein Termin wurde abgesagt');
  const inv = buildEmail('admin_invite', { settings, siteUrl: 'https://x', inviteUrl: 'https://x/admin/#setup=T', inviteName: 'Lisa' });
  assert.ok(inv.html.includes('#setup=T'));
  assert.throws(() => buildEmail('gibt-es-nicht', ctx));
  assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

// --- Mailer ------------------------------------------------------------------
const resp = (status, body) => new Response(JSON.stringify(body), { status });

test('Mailer: sendet an Resend mit korrekten Feldern', async () => {
  let seen;
  const m = createMailer({ apiKey: 're_test', from: 'Salon <a@b.de>', fetchImpl: async (url, init) => { seen = { url, init }; return resp(200, { id: 'abc' }); }, sleep: async () => {} });
  const r = await m.send({ to: 'k@x.de', subject: 'S', html: '<p>h</p>', text: 't', replyTo: 'r@x.de', idempotencyKey: 'k1' });
  assert.deepEqual(r, { ok: true, id: 'abc' });
  assert.equal(seen.url, 'https://api.resend.com/emails');
  assert.equal(seen.init.headers.Authorization, 'Bearer re_test');
  assert.equal(seen.init.headers['Idempotency-Key'], 'k1');
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.to, ['k@x.de']);
  assert.equal(body.reply_to, 'r@x.de');
  assert.equal(body.from, 'Salon <a@b.de>');
});

test('Mailer: 429/5xx werden wiederholt, 403 nicht, fehlender Key meldet Fehler', async () => {
  let calls = 0;
  const flaky = createMailer({ apiKey: 'k', from: 'f', sleep: async () => {}, fetchImpl: async () => (++calls < 3 ? resp(429, { message: 'slow' }) : resp(200, { id: 'ok' })) });
  assert.equal((await flaky.send({ to: 'a@b.de', subject: 's', html: 'h', text: 't' })).ok, true);
  assert.equal(calls, 3);
  calls = 0;
  const denied = createMailer({ apiKey: 'k', from: 'f', sleep: async () => {}, fetchImpl: async () => { calls++; return resp(403, { message: 'You can only send testing emails to your own email address' }); } });
  const r = await denied.send({ to: 'a@b.de', subject: 's', html: 'h', text: 't' });
  assert.equal(r.ok, false);
  assert.equal(calls, 1);
  assert.match(r.error, /403/);
  const none = createMailer({ apiKey: '', from: 'f' });
  assert.equal((await none.send({ to: 'a@b.de', subject: 's', html: 'h', text: 't' })).ok, false);
  const down = createMailer({ apiKey: 'k', from: 'f', sleep: async () => {}, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await down.send({ to: 'a@b.de', subject: 's', html: 'h', text: 't' })).ok, false);
});

// --- DB-Client ---------------------------------------------------------------
test('DB-Client: alter Schlüssel (JWT) als apikey + Bearer, neuer sb_secret nur als apikey', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, headers: init.headers }); return resp(200, []); };
  await createDb({ url: 'https://p.supabase.co/', key: 'eyJhbGciOi.old.jwt', fetchImpl }).select('kf_settings');
  await createDb({ url: 'https://p.supabase.co', key: 'sb_secret_abc', fetchImpl }).select('kf_settings');
  assert.equal(seen[0].headers.Authorization, 'Bearer eyJhbGciOi.old.jwt');
  assert.equal(seen[0].headers.apikey, 'eyJhbGciOi.old.jwt');
  assert.equal(seen[1].headers.Authorization, undefined);
  assert.equal(seen[1].headers.apikey, 'sb_secret_abc');
  assert.ok(seen[0].url.startsWith('https://p.supabase.co/rest/v1/kf_settings?'));
});

test('DB-Client: Fehler werden als DbError mit Code geliefert, Netzfehler als db_unreachable', async () => {
  const err = createDb({ url: 'https://p', key: 'k', fetchImpl: async () => resp(400, { code: 'KF001', message: 'slot_unavailable' }) });
  await assert.rejects(() => err.rpc('x'), (e) => e instanceof DbError && e.code === 'KF001' && e.message === 'slot_unavailable');
  const down = createDb({ url: 'https://p', key: 'k', fetchImpl: async () => { throw new Error('x'); } });
  await assert.rejects(() => down.rpc('x'), (e) => e.code === 'db_unreachable' && e.status === 503);
});

test('Konfiguration: fehlende Variablen werden benannt, Werte nie', () => {
  const c = loadConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  assert.deepEqual(c.missing, ['APP_SECRET (mindestens 32 Zeichen)']);
  const ok = loadConfig({ SUPABASE_URL: 'u', SUPABASE_SECRET_KEY: 'sb_secret_new', SUPABASE_SERVICE_ROLE_KEY: 'old', APP_SECRET: 'x'.repeat(32), SITE_URL: 'https://a.de/' });
  assert.equal(ok.missing.length, 0);
  assert.equal(ok.supabaseKey, 'sb_secret_new', 'neuer Schlüssel hat Vorrang');
  assert.equal(ok.siteUrl, 'https://a.de');
});
