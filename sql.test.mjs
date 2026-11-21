// Tests der Datenbank selbst (echtes PostgreSQL): Doppelbuchungsschutz, Rechte, Funktionen.
// Wird übersprungen, wenn keine Test-Datenbank erreichbar ist (siehe tests/helpers/pg.mjs).

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createTestDatabase, pgAvailable, sql } from './helpers/pg.mjs';
import { sha256Hex } from '../netlify/lib/crypto.mjs';

const HAVE_PG = pgAvailable();
const opts = { skip: HAVE_PG ? false : 'Keine PostgreSQL-Testdatenbank erreichbar' };

let db;
before(async () => { if (HAVE_PG) db = await createTestDatabase(); });
after(() => { if (db) db.drop(); });

// Zukunfts-Zeitpunkt: heute (UTC) + days Tage, um hh:mm UTC (alles auf dem 15-Minuten-Raster)
const at = (days, hh, mm = 0) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + days); d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
};
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function book({ start, name = 'Max Muster', email = `${randomUUID()}@test.de`, phone = null, note = null }) {
  const id = randomUUID();
  const out = await db.sql(`select to_jsonb(public.kf_create_booking(${q(id)}, ${q(name)}, ${q(email)}, ${phone ? q(phone) : 'null'}, ${note ? q(note) : 'null'}, ${q(start)}, 'salt', ${q(sha256Hex(id))}))`);
  return JSON.parse(out);
}
async function manual({ start, end, name = 'Telefon Kunde', email = null, phone = null, admin = null }) {
  const id = randomUUID();
  const out = await db.sql(`select to_jsonb(public.kf_create_manual_booking(${q(id)}, ${q(name)}, ${email ? q(email) : 'null'}, ${phone ? q(phone) : 'null'}, null, 'intern', ${q(start)}, ${q(end)}, 'salt', ${q(sha256Hex(id))}, ${admin ? q(admin) : 'null'}))`);
  return JSON.parse(out);
}
const code = async (p) => { try { await p; return 'OK'; } catch (e) { return e.code; } };
const transition = (id, action) => db.sql(`select to_jsonb(public.kf_transition(${q(id)}, ${q(action)}, null))`).then(JSON.parse);
const activeCount = () => db.sql(`select count(*) from kf_bookings where status in ('requested','confirmed')`).then(Number);

test('SQL: zweites Ausführen der Migration bricht sicher ab und ändert nichts', opts, () => {
  const before = spawnSync('psql', ['-h', '127.0.0.1', '-p', '54329', '-U', 'pgu', '-d', db.name, '-Atc', "select count(*) from information_schema.tables where table_name like 'kf_%'"], { encoding: 'utf8' }).stdout.trim();
  const r = spawnSync('psql', ['-h', '127.0.0.1', '-p', '54329', '-U', 'pgu', '-d', db.name, '-v', 'ON_ERROR_STOP=1', '-f', db.migrationText ? new URL('../supabase/migrations/001_kellerfriseur.sql', import.meta.url).pathname : ''], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /bereits vorhanden/);
  const after = spawnSync('psql', ['-h', '127.0.0.1', '-p', '54329', '-U', 'pgu', '-d', db.name, '-Atc', "select count(*) from information_schema.tables where table_name like 'kf_%'"], { encoding: 'utf8' }).stdout.trim();
  assert.equal(before, after);
  assert.equal(before, '7');
});

test('SQL: Standard-Einstellungen (60 Min, 30 Tage, Kontaktadresse)', opts, async () => {
  const s = JSON.parse(await db.sql('select to_jsonb(s) from kf_settings s'));
  assert.equal(s.duration_minutes, 60);
  assert.equal(s.booking_horizon_days, 30);
  assert.equal(s.min_lead_minutes, 0);
  assert.equal(s.contact_email, 'lcordella818@gmail.com');
});

test('Sicherheit: anon/authenticated sehen und ändern nichts, Funktionen sind gesperrt', opts, async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const t of ['kf_bookings', 'kf_admins', 'kf_sessions', 'kf_blocks', 'kf_email_log', 'kf_settings', 'kf_rate_limits']) {
      assert.equal(await code(sql(db.name, `select * from ${t}`, { role })), '42501', `${role} darf ${t} nicht lesen`);
    }
    assert.equal(await code(sql(db.name, `insert into kf_blocks(start_at,end_at) values (now(), now()+interval '1h')`, { role })), '42501');
    assert.equal(await code(sql(db.name, `select public.kf_public_state(now(), now())`, { role })), '42501', `${role} darf RPC nicht aufrufen`);
    assert.equal(await code(sql(db.name, `select public.kf_bootstrap_owner('x@y.de')`, { role })), '42501');
  }
  assert.equal(await code(db.sql('select count(*) from kf_bookings')), 'OK', 'service_role darf');
});

test('Sicherheit: RLS ist auf allen kf_-Tabellen aktiv und es gibt keine Policies', opts, async () => {
  const rls = await db.sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'kf\\_%' and c.relkind='r' and c.relrowsecurity`);
  assert.equal(rls, '7');
  assert.equal(await db.sql(`select count(*) from pg_policies where tablename like 'kf\\_%'`), '0');
});

test('Doppelbuchung: Überschneidung wird abgelehnt, direkt aufeinanderfolgende Termine sind erlaubt', opts, async () => {
  const a = await book({ start: at(3, 9) });
  assert.equal(a.status, 'requested', 'offene Anfrage');
  assert.equal(new Date(a.end_at) - new Date(a.start_at), 3600000, 'Dauer 60 Min aus den Einstellungen');
  assert.equal(await code(book({ start: at(3, 9) })), 'KF001', 'gleiche Zeit');
  assert.equal(await code(book({ start: at(3, 9, 30) })), 'KF001', 'beginnt mitten im Termin');
  assert.equal(await code(book({ start: at(3, 8, 15) })), 'KF001', 'endet mitten im Termin');
  assert.equal(await code(book({ start: at(3, 10) })), 'OK', '10:00 direkt nach 09:00-10:00');
  assert.equal(await code(book({ start: at(3, 8) })), 'OK', '08:00-09:00 direkt davor');
});

test('Doppelbuchung: auch direkt in der Tabelle (Umgehung der Funktion) unmöglich', opts, async () => {
  const s = at(4, 9);
  const e = at(4, 10);
  const ins = (st, en, status) => db.sql(`insert into kf_bookings(id,start_at,end_at,status,source,customer_name,token_salt,token_hash) values (gen_random_uuid(), ${q(st)}, ${q(en)}, ${q(status)}, 'manual', 'X Y', 's', gen_random_uuid()::text)`);
  await ins(s, e, 'confirmed');
  assert.equal(await code(ins(at(4, 9, 30), at(4, 10, 30), 'requested')), '23P01');
  assert.equal(await code(ins(at(4, 9, 30), at(4, 10, 30), 'declined')), 'OK', 'abgelehnt blockiert nicht');
  assert.equal(await code(ins(at(4, 9, 30), at(4, 10, 30), 'withdrawn')), 'OK');
  assert.equal(await code(ins(at(4, 9, 30), at(4, 10, 30), 'cancelled')), 'OK');
  assert.equal(await code(ins(e, at(4, 11), 'confirmed')), 'OK', 'Ende exklusiv');
});

test('Doppelbuchung: 15 gleichzeitige Buchungen derselben Zeit -> genau eine gewinnt', opts, async () => {
  const start = at(5, 14);
  const results = await Promise.all(Array.from({ length: 15 }, () => code(book({ start }))));
  assert.equal(results.filter((r) => r === 'OK').length, 1);
  assert.equal(results.filter((r) => r === 'KF001').length, 14);
  assert.equal(await db.sql(`select count(*) from kf_bookings where start_at=${q(start)}`), '1');
});

test('Doppelbuchung: gleichzeitige, sich überlappende Startzeiten -> nie eine Überschneidung', opts, async () => {
  const starts = [];
  for (let day = 6; day <= 8; day++) for (const [h, m] of [[9, 0], [9, 15], [9, 30], [9, 45], [10, 0], [10, 15], [10, 30], [10, 45], [11, 0]]) {
    starts.push(at(day, h, m), at(day, h, m));
  }
  await Promise.all(starts.map((start) => code(book({ start }))));
  const overlaps = await db.sql(`select count(*) from kf_bookings a join kf_bookings b on a.id < b.id and tstzrange(a.start_at,a.end_at,'[)') && tstzrange(b.start_at,b.end_at,'[)') where a.status in ('requested','confirmed') and b.status in ('requested','confirmed')`);
  assert.equal(overlaps, '0');
  for (let day = 6; day <= 8; day++) {
    const n = await db.sql(`select count(*) from kf_bookings where start_at >= ${q(at(day, 0))} and start_at < ${q(at(day + 1, 0))}`);
    assert.ok(Number(n) >= 2 && Number(n) <= 3, `Tag ${day}: ${n} Termine (9:00-12:00 mit je 60 Min passen max. 3)`);
  }
});

test('Fehlerfälle der Online-Buchung: Vergangenheit, zu weit, krumme Startzeit, Limit pro E-Mail', opts, async () => {
  assert.equal(await code(book({ start: at(-1, 9) })), 'KF002');
  assert.equal(await code(book({ start: at(45, 9) })), 'KF003');
  assert.equal(await code(book({ start: at(10, 9, 7) })), 'KF004');
  const start = new Date(); start.setUTCDate(start.getUTCDate() + 11); start.setUTCHours(9, 0, 30, 0);
  assert.equal(await code(book({ start: start.toISOString() })), 'KF004', 'Sekunden nicht erlaubt');
  const email = 'viel@test.de';
  assert.equal(await code(book({ start: at(12, 9), email })), 'OK');
  assert.equal(await code(book({ start: at(12, 11), email })), 'OK');
  assert.equal(await code(book({ start: at(12, 13), email })), 'OK');
  assert.equal(await code(book({ start: at(12, 15), email })), 'KF008');
  assert.equal(await code(book({ start: at(12, 15), email: 'VIEL@test.de' })), 'KF008', 'Groß-/Kleinschreibung egal');
});

test('Einstellungen wirken: Dauer 45 Min und Frist 10 Tage', opts, async () => {
  await db.sql('update kf_settings set duration_minutes=45, booking_horizon_days=10');
  const r = await book({ start: at(9, 20) });
  assert.equal(new Date(r.end_at) - new Date(r.start_at), 45 * 60000);
  assert.equal(await code(book({ start: at(12, 20) })), 'KF003');
  await db.sql('update kf_settings set duration_minutes=60, booking_horizon_days=30');
});

test('Statuswechsel geben den Zeitraum frei bzw. halten ihn', opts, async () => {
  const a = await book({ start: at(13, 9) });
  assert.equal((await transition(a.id, 'accept')).status, 'confirmed');
  assert.equal(await code(book({ start: at(13, 9) })), 'KF001', 'bestätigt blockiert');
  assert.equal(await code(transition(a.id, 'accept')), 'KF006', 'schon bestätigt');
  const c = await transition(a.id, 'customer_cancel');
  assert.equal(c.status, 'cancelled');
  assert.equal(c.cancelled_by, 'customer');
  assert.equal(await code(book({ start: at(13, 9) })), 'OK', 'abgesagt gibt frei');

  const b = await book({ start: at(13, 12) });
  const w = await transition(b.id, 'customer_cancel');
  assert.equal(w.status, 'withdrawn', 'offene Anfrage -> zurückgezogen');
  assert.equal(await code(book({ start: at(13, 12) })), 'OK');

  const d = await book({ start: at(13, 15) });
  assert.equal((await transition(d.id, 'decline')).status, 'declined');
  assert.equal(await code(book({ start: at(13, 15) })), 'OK', 'abgelehnt gibt frei');
  assert.equal(await code(transition(d.id, 'customer_cancel')), 'KF006', 'abgelehnte nicht mehr änderbar');
  assert.equal(await code(transition(randomUUID(), 'accept')), 'KF009');
  assert.equal(await code(transition(d.id, 'bogus')), 'KF010');
});

test('Kunde: vergangene Termine sind nicht mehr absagbar; Admin kann bestätigte absagen', opts, async () => {
  const past = await manual({ start: at(-2, 9), end: at(-2, 10) });
  assert.equal(await code(transition(past.id, 'customer_cancel')), 'KF007');
  const fut = await manual({ start: at(14, 9), end: at(14, 10) });
  const c = await transition(fut.id, 'admin_cancel');
  assert.equal(c.status, 'cancelled');
  assert.equal(c.cancelled_by, 'admin');
});

test('Manuelle Termine: blockieren, beliebige Zeit/Dauer, Bearbeiten und Verschieben mit Konfliktschutz', opts, async () => {
  const m = await manual({ start: at(15, 9, 10), end: at(15, 9, 55), name: 'Frau Telefon' });
  assert.equal(m.status, 'confirmed');
  assert.equal(m.source, 'manual');
  assert.equal(await code(book({ start: at(15, 9) })), 'KF001');
  assert.equal(await code(manual({ start: at(15, 9, 30), end: at(15, 10, 30) })), 'KF001');
  assert.equal(await code(manual({ start: at(15, 12), end: at(15, 11) })), 'KF010', 'Ende vor Beginn');
  const other = await manual({ start: at(15, 12), end: at(15, 13) });
  const upd = (id, s, e) => db.sql(`select to_jsonb(public.kf_update_booking(${q(id)}, 'Neu Name', null, null, null, 'notiz', ${q(s)}, ${q(e)}))`).then(JSON.parse);
  assert.equal(await code(upd(other.id, at(15, 9, 30), at(15, 10, 30))), 'KF001', 'Verschieben in belegte Zeit');
  const moved = await upd(other.id, at(15, 16), at(15, 17, 30));
  assert.equal(new Date(moved.start_at).getTime(), new Date(at(15, 16)).getTime());
  assert.equal(moved.internal_note, 'notiz');
  assert.equal(await code(book({ start: at(15, 12) })), 'OK', 'alter Zeitraum ist nach dem Verschieben frei');
  const gone = await transition(other.id, 'admin_cancel');
  assert.equal(await code(upd(gone.id, at(15, 20), at(15, 21))), 'KF005', 'abgesagten Termin nicht reaktivieren');
  const keepTime = await upd(gone.id, gone.start_at, gone.end_at);
  assert.equal(keepTime.customer_name, 'Neu Name', 'Notizen eines abgesagten Termins dürfen geändert werden');
  assert.equal(await code(upd(randomUUID(), at(15, 20), at(15, 21))), 'KF009');
});

test('Sperrzeiten: blockieren Buchungen, löschen/ändern bestehende Termine NIE, Warnung bei Konflikt', opts, async () => {
  const existing = await book({ start: at(16, 11) });
  const blk = (s, e, ack) => db.sql(`select public.kf_create_block(${q(s)}, ${q(e)}, 'Urlaub', null, ${ack})`).then(JSON.parse);
  const warn = await blk(at(16, 10), at(16, 13), false);
  assert.equal(warn.created, false);
  assert.equal(warn.conflicts.length, 1);
  assert.equal(await db.sql(`select count(*) from kf_blocks where reason='Urlaub'`), '0', 'ohne Bestätigung nichts angelegt');
  const done = await blk(at(16, 10), at(16, 13), true);
  assert.equal(done.created, true);
  assert.equal(await db.sql(`select status from kf_bookings where id=${q(existing.id)}`), 'requested', 'Termin unverändert');
  assert.equal(await code(book({ start: at(16, 12) })), 'KF001', 'gesperrt');
  assert.equal(await code(book({ start: at(16, 9, 30) })), 'KF001', '09:30-10:30 ragt in die Sperre');
  assert.equal(await code(book({ start: at(16, 9) })), 'OK', '09:00-10:00 endet genau am Sperrbeginn');
  assert.equal(await code(book({ start: at(16, 13) })), 'OK', 'nach Sperrende');
  assert.equal(await code(db.sql(`select public.kf_create_block(${q(at(17, 10))}, ${q(at(17, 9))}, null, null, true)`)), 'KF010');
  // mehrere Wochen am Stück
  const long = await blk(at(20, 0), at(41, 0), false);
  assert.equal(long.created, true);
  assert.equal(await code(book({ start: at(30, 12) })), 'KF001');
  // Sperre löschen gibt frei
  await db.sql(`delete from kf_blocks where id=${q(long.block.id)}`);
  assert.equal(await code(book({ start: at(30, 12) })), 'OK');
});

test('Sperrzeit und Buchung gleichzeitig: nie ein aktiver Termin in einer ohne Warnung angelegten Sperre', opts, async () => {
  for (let i = 0; i < 8; i++) {
    const s = at(50 + i, 10); const e = at(50 + i, 12);
    await Promise.all([
      code(db.sql(`select public.kf_create_block(${q(s)}, ${q(e)}, 'race', null, false)`)),
      code(book({ start: at(50 + i, 10, 30) })),
    ]);
  }
  const bad = await db.sql(`select count(*) from kf_blocks bl join kf_bookings b on b.status in ('requested','confirmed') and tstzrange(b.start_at,b.end_at,'[)') && tstzrange(bl.start_at,bl.end_at,'[)') where bl.reason='race'`);
  // Eine Sperre mit Warnung (created=false) wird nicht angelegt; wurde sie angelegt, gab es keinen Konflikt.
  assert.equal(bad, '0');
});

test('Öffentliche Sicht enthält nur Zeiten, keine Personendaten', opts, async () => {
  await book({ start: at(18, 9), name: 'Geheim Person', email: 'geheim@test.de', phone: '0170 1234567', note: 'vertrauliche Notiz' });
  await manual({ start: at(18, 12), end: at(18, 13), name: 'Intern Person' });
  const out = await db.sql(`select public.kf_public_state(${q(at(18, 0))}, ${q(at(19, 0))})`);
  const s = JSON.parse(out);
  assert.equal(s.busy.length, 2);
  assert.ok(s.busy.every((p) => p.length === 2 && p.every(Number.isFinite)));
  for (const secret of ['Geheim', 'geheim@', '0170', 'vertrauliche', 'Intern', 'manual', 'online']) assert.ok(!out.includes(secret), `Rohausgabe darf "${secret}" nicht enthalten`);
});

test('Kundensuche: Name, E-Mail, Telefon (auch +49/0-Schreibweise), Wildcards werden entschärft', opts, async () => {
  await manual({ start: at(19, 9), end: at(19, 10), name: 'Sabine Müller-Lüdenscheidt', email: 'sabine@beispiel.de', phone: '0171 555 12 34' });
  await manual({ start: at(19, 11), end: at(19, 12), name: '100% Rabatt_Kunde', email: null, phone: null });
  const search = (term) => db.sql(`select coalesce(json_agg(customer_name), '[]') from public.kf_search_bookings(${q(term)})`).then(JSON.parse);
  assert.deepEqual(await search('müller'), ['Sabine Müller-Lüdenscheidt']);
  assert.deepEqual(await search('SABINE@BEISPIEL'), ['Sabine Müller-Lüdenscheidt']);
  assert.deepEqual(await search('0171 555'), ['Sabine Müller-Lüdenscheidt']);
  assert.deepEqual(await search('+49 171 555 12 34'), ['Sabine Müller-Lüdenscheidt']);
  assert.deepEqual(await search('100% Rabatt'), ['100% Rabatt_Kunde']);
  assert.deepEqual(await search('%'), [], 'ein einzelnes % findet nicht alles');
  assert.deepEqual(await search('a'), [], 'zu kurz');
  assert.deepEqual(await search("'; drop table kf_bookings; --"), []);
  assert.equal(await db.sql('select count(*) from kf_bookings') > '0', true, 'Tabelle existiert noch');
});

test('Erster Admin: Einrichtungslink wird erzeugt, Hash passt, zweiter Aufruf wird verhindert', opts, async () => {
  const path = await db.sql(`select public.kf_bootstrap_owner('Chef@Beispiel.de', 'Chef')`);
  assert.match(path, /^\/admin\/#setup=[0-9a-f]{64}$/);
  const token = path.split('=')[1];
  const row = JSON.parse(await db.sql(`select to_jsonb(a) from kf_admins a where role='owner'`));
  assert.equal(row.email, 'chef@beispiel.de');
  assert.equal(row.invite_token_hash, sha256Hex(token), 'SQL-Hash == Node-Hash');
  assert.equal(await code(db.sql(`select public.kf_bootstrap_owner('zweiter@x.de')`)), 'P0001');
  const again = await db.sql(`select public.kf_issue_invite('CHEF@beispiel.de')`);
  assert.match(again, /^\/admin\/#setup=[0-9a-f]{64}$/);
  assert.notEqual(again, path);
  assert.equal(await code(db.sql(`select public.kf_issue_invite('unbekannt@x.de')`)), 'P0001');
});

test('Rate-Limit-Funktion zählt pro Fenster', opts, async () => {
  const hit = () => db.sql(`select public.kf_rate_hit('test-key', 3600, 3)`);
  assert.deepEqual([await hit(), await hit(), await hit(), await hit(), await hit()], ['t', 't', 't', 'f', 'f']);
  assert.equal(await db.sql(`select public.kf_rate_hit('anderer-key', 3600, 3)`), 't');
});

test('Sitzungen: gültig, abgelaufen und deaktivierter Admin', opts, async () => {
  const admin = await db.sql(`select id from kf_admins limit 1`);
  await db.sql(`insert into kf_sessions(admin_id, token_hash, expires_at) values (${q(admin)}, 'h-ok', now() + interval '1 hour'), (${q(admin)}, 'h-old', now() - interval '1 minute')`);
  const lookup = (h) => db.sql(`select public.kf_session_lookup(${q(h)})`);
  assert.equal(JSON.parse(await lookup('h-ok')).admin.role, 'owner');
  assert.equal(await lookup('h-old'), '');
  assert.equal(await lookup('gibt-es-nicht'), '');
  await db.sql(`update kf_admins set active=false where id=${q(admin)}`);
  assert.equal(await lookup('h-ok'), '', 'deaktivierter Admin hat keine Sitzung mehr');
  await db.sql(`update kf_admins set active=true where id=${q(admin)}`);
});

test('Löschen eines Termins entfernt auch sein E-Mail-Protokoll (Datenschutz)', opts, async () => {
  const b = await book({ start: at(21, 9) });
  await db.sql(`insert into kf_email_log(booking_id, kind, to_email) values (${q(b.id)}, 'customer_received', 'x@y.de')`);
  await db.sql(`delete from kf_bookings where id=${q(b.id)}`);
  assert.equal(await db.sql(`select count(*) from kf_email_log where booking_id=${q(b.id)}`), '0');
  assert.ok(Number(await activeCount()) > 0);
});
