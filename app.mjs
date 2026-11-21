// Die komplette API (öffentlich, Kunden-Link, Admin) als eine testbare Funktion.
// netlify/functions/api.mjs verdrahtet sie mit echter Datenbank und echtem Mailer.

import { buildAvailability, validateRange } from './slots.mjs';
import {
  addDays, isValidDateStr, localDateStr, localDayRange, parseLocalDateTime, TZ,
} from './time.mjs';
import {
  burnPasswordCheck, deriveBookingToken, hashPassword, hmacKey, newBookingCredentials,
  newId, randomToken, sha256Hex, verifyPassword,
} from './crypto.mjs';
import {
  cleanLine, isTokenShape, isUuid, validateEmail, validateInt, validateName, validateNote,
  validatePassword, validatePhone,
} from './validate.mjs';
import { buildEmail, KINDS_WITH_MANAGE_LINK } from './emails.mjs';

const MIN = 60000;
const SESSION_COOKIE = 'kf_session';
const SESSION_HOURS = 12;

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Datenbank-Fehlercodes (siehe SQL) -> verständliche API-Fehler
const DB_ERRORS = {
  KF001: [409, 'slot_unavailable', 'Dieser Zeitraum ist leider nicht mehr verfügbar. Bitte wähle eine andere Zeit.'],
  '23P01': [409, 'slot_unavailable', 'Dieser Zeitraum ist leider nicht mehr verfügbar. Bitte wähle eine andere Zeit.'],
  KF002: [422, 'start_in_past', 'Diese Zeit liegt in der Vergangenheit oder ist zu kurzfristig.'],
  KF003: [422, 'beyond_horizon', 'Dieser Tag liegt zu weit in der Zukunft.'],
  KF004: [422, 'bad_start', 'Diese Startzeit ist nicht gültig.'],
  KF005: [409, 'not_active', 'Dieser Termin ist nicht mehr aktiv und kann nicht verschoben werden.'],
  KF006: [409, 'state_changed', 'Der Status dieses Termins hat sich inzwischen geändert. Bitte aktualisiere die Seite.'],
  KF007: [409, 'not_changeable', 'Dieser Termin kann nicht mehr geändert werden.'],
  KF008: [429, 'too_many_requests', 'Für diese E-Mail-Adresse bestehen bereits mehrere offene oder bestätigte Termine.'],
  KF009: [404, 'not_found', 'Der Eintrag wurde nicht gefunden.'],
  KF010: [422, 'invalid', 'Die Angaben sind nicht gültig.'],
  '23514': [422, 'invalid', 'Die Angaben sind nicht gültig.'],
  '23505': [409, 'duplicate', 'Dieser Eintrag existiert bereits.'],
};

const BOOKING_COLS = 'id,start_at,end_at,status,source,customer_name,customer_email,customer_phone,customer_note,internal_note,cancelled_by,decided_at,created_at';

const iso = (v) => new Date(v).toISOString();

function adminBookingView(r) {
  return {
    id: r.id,
    start: iso(r.start_at),
    end: iso(r.end_at),
    status: r.status,
    source: r.source,
    name: r.customer_name,
    email: r.customer_email ?? null,
    phone: r.customer_phone ?? null,
    note: r.customer_note ?? null,
    internalNote: r.internal_note ?? null,
    cancelledBy: r.cancelled_by ?? null,
    decidedAt: r.decided_at ? iso(r.decided_at) : null,
    createdAt: r.created_at ? iso(r.created_at) : null,
  };
}

export function createApp({ db, config, mailer, now = () => Date.now(), log = console }) {
  // ------------------------------------------------------------------
  // Hilfsfunktionen
  // ------------------------------------------------------------------
  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      },
    });

  function clientIp(req, context) {
    return (
      req.headers.get('x-nf-client-connection-ip')
      || context?.ip
      || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
      || 'unknown'
    );
  }

  async function limit(name, ident, windowSec, max) {
    const key = `${name}:${hmacKey(config.appSecret, ident)}`;
    const ok = await db.rpc('kf_rate_hit', { p_key: key, p_window_seconds: windowSec, p_max: max });
    if (ok === false) {
      throw new ApiError(429, 'rate_limited', 'Zu viele Anfragen. Bitte warte einen Moment und versuche es dann erneut.');
    }
  }

  async function readJson(req) {
    const ct = (req.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('application/json')) throw new ApiError(415, 'unsupported_media_type', 'Ungültiger Inhaltstyp.');
    const text = await req.text();
    if (text.length > 20000) throw new ApiError(413, 'too_large', 'Die Anfrage ist zu groß.');
    if (!text.trim()) return {};
    let v;
    try { v = JSON.parse(text); } catch { throw new ApiError(400, 'bad_json', 'Ungültige Anfrage.'); }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ApiError(400, 'bad_json', 'Ungültige Anfrage.');
    return v;
  }

  const must = (r) => {
    if (r.error) throw new ApiError(422, 'invalid', r.error);
    return r.value;
  };

  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.get('cookie') || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  function sessionCookie(value, secure, maxAge) {
    return `${SESSION_COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  async function getSettings() {
    const rows = await db.select('kf_settings', { filters: { id: 'eq.1' } });
    if (!rows[0]) throw new ApiError(500, 'not_installed', 'Die Datenbank ist nicht vollständig eingerichtet.');
    return rows[0];
  }

  async function adminRecipients(settings) {
    const rows = await db.select('kf_admins', { select: 'email', filters: { active: 'eq.true', notify: 'eq.true' } });
    const set = new Set(rows.map((r) => r.email.toLowerCase()));
    if (settings.contact_email) set.add(settings.contact_email.toLowerCase());
    return [...set];
  }

  // ------------------------------------------------------------------
  // E-Mails: erst protokollieren, dann senden. Ein Fehler beim Versand
  // verliert niemals eine Buchung; er wird im Protokoll festgehalten.
  // ------------------------------------------------------------------
  async function deliver(row, kind, booking, settings, env, extra = {}) {
    let content;
    try {
      content = buildEmail(kind, {
        booking, settings, siteUrl: env.siteUrl,
        manageUrl: booking && KINDS_WITH_MANAGE_LINK.has(kind)
          ? `${env.siteUrl}/termin#${deriveBookingToken(config.appSecret, booking.id, booking.token_salt)}` : undefined,
        ...extra,
      });
    } catch (err) {
      await db.update('kf_email_log', { id: `eq.${row.id}` }, { status: 'failed', attempts: row.attempts + 1, last_error: String(err.message).slice(0, 300) });
      return { ok: false };
    }
    const res = await mailer.send({
      to: row.to_email, ...content, replyTo: settings.contact_email,
      idempotencyKey: `${row.id}-${row.attempts + 1}`,
    });
    await db.update('kf_email_log', { id: `eq.${row.id}` }, res.ok
      ? { status: 'sent', attempts: row.attempts + 1, provider_id: res.id, sent_at: new Date().toISOString(), last_error: null }
      : { status: 'failed', attempts: row.attempts + 1, last_error: String(res.error).slice(0, 300) });
    return res;
  }

  /** Sendet eine E-Mail-Art an mehrere Empfänger. Wirft nie. */
  async function dispatch(kind, booking, recipients, settings, env, extra) {
    for (const to of recipients.filter(Boolean)) {
      try {
        const [row] = await db.insert('kf_email_log', { booking_id: booking?.id ?? null, kind, to_email: to });
        await deliver(row, kind, booking, settings, env, extra);
      } catch (err) {
        log.error(`[mail] ${kind}: ${err?.code ?? err?.name ?? 'Fehler'}`);
      }
    }
  }

  // ------------------------------------------------------------------
  // Öffentlich
  // ------------------------------------------------------------------
  async function health() {
    let dbOk = false;
    try { await db.select('kf_settings', { select: 'id', filters: { id: 'eq.1' } }); dbOk = true; } catch { /* leer */ }
    return json(200, { ok: dbOk, db: dbOk });
  }

  async function availability(req, url, ctx) {
    await limit('avail', ctx.ip, 60, 120);
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    const bad = validateRange(from, to);
    if (bad) throw new ApiError(400, 'bad_range', bad);
    const fromMs = localDayRange(from)[0];
    const toMs = localDayRange(to)[1];
    const state = await db.rpc('kf_public_state', { p_from: new Date(fromMs).toISOString(), p_to: new Date(toMs).toISOString() });
    if (!state) throw new ApiError(500, 'not_installed', 'Die Datenbank ist nicht vollständig eingerichtet.');
    const t = now();
    return json(200, {
      timezone: TZ,
      today: localDateStr(t),
      durationMinutes: state.durationMinutes,
      horizonDays: state.horizonDays,
      days: buildAvailability({ from, to, state, now: t }),
    });
  }

  async function createBooking(req, url, ctx) {
    await limit('book-ip-min', ctx.ip, 60, 4);
    await limit('book-ip-hour', ctx.ip, 3600, 12);
    const body = await readJson(req);

    if (typeof body.website === 'string' && body.website.trim() !== '') {
      // Honeypot: Bots füllen unsichtbare Felder aus. Wir tun so, als wäre alles gut.
      return json(201, { ok: true, status: 'requested' });
    }

    const name = must(validateName(body.name, { requireFullName: true }));
    const email = must(validateEmail(body.email));
    const phone = must(validatePhone(body.phone));
    const note = must(validateNote(body.note, 1000, 'Deine Nachricht'));
    if (typeof body.start !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(body.start)
        || Number.isNaN(Date.parse(body.start))) {
      throw new ApiError(422, 'invalid', 'Bitte wähle eine Startzeit aus.');
    }
    const startIso = new Date(body.start).toISOString();

    await limit('book-email', email, 86400, 6);

    const id = newId();
    const cred = newBookingCredentials(config.appSecret, id);
    const row = await db.rpc('kf_create_booking', {
      p_id: id, p_name: name, p_email: email, p_phone: phone, p_note: note,
      p_start: startIso, p_salt: cred.salt, p_token_hash: cred.hash,
    });

    const settings = await getSettings();
    await dispatch('customer_received', row, [email], settings, ctx);
    await dispatch('admin_new_request', row, await adminRecipients(settings), settings, ctx);

    return json(201, {
      ok: true, status: 'requested', start: iso(row.start_at), end: iso(row.end_at),
      managePath: `/termin#${cred.token}`,
    });
  }

  function customerView(r) {
    const active = r.status === 'requested' || r.status === 'confirmed';
    const canCancel = active && new Date(r.start_at).getTime() > now();
    return {
      name: r.customer_name,
      status: r.status,
      start: iso(r.start_at),
      end: iso(r.end_at),
      canCancel,
      action: canCancel ? (r.status === 'requested' ? 'withdraw' : 'cancel') : null,
    };
  }

  async function loadByToken(req, ctx) {
    await limit('manage', ctx.ip, 60, 60);
    const token = req.headers.get('x-booking-token') || '';
    if (!isTokenShape(token)) throw new ApiError(404, 'not_found', 'Dieser Link ist ungültig.');
    const rows = await db.select('kf_bookings', { filters: { token_hash: `eq.${sha256Hex(token)}` }, limit: 1 });
    if (!rows[0]) throw new ApiError(404, 'not_found', 'Dieser Link ist ungültig.');
    return rows[0];
  }

  async function manageGet(req, url, ctx) {
    return json(200, customerView(await loadByToken(req, ctx)));
  }

  async function manageCancel(req, url, ctx) {
    const found = await loadByToken(req, ctx);
    const body = await readJson(req);
    if (body.confirm !== true) throw new ApiError(400, 'confirm_required', 'Bitte bestätige die Absage.');
    const row = await db.rpc('kf_transition', { p_id: found.id, p_action: 'customer_cancel', p_admin: null });
    const settings = await getSettings();
    await dispatch('customer_cancel_ack', row, [row.customer_email], settings, ctx);
    await dispatch('admin_customer_cancelled', row, await adminRecipients(settings), settings, ctx);
    return json(200, customerView(row));
  }

  // ------------------------------------------------------------------
  // Admin: Anmeldung & Sitzungen
  // ------------------------------------------------------------------
  async function startSession(adminId, secure) {
    const token = randomToken(32);
    await db.insert('kf_sessions', {
      admin_id: adminId, token_hash: sha256Hex(token),
      expires_at: new Date(now() + SESSION_HOURS * 3600 * 1000).toISOString(),
    });
    return sessionCookie(token, secure, SESSION_HOURS * 3600);
  }

  async function login(req, url, ctx) {
    await limit('login-ip', ctx.ip, 600, 12);
    const body = await readJson(req);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const fail = () => new ApiError(401, 'bad_credentials', 'E-Mail-Adresse oder Passwort ist falsch.');
    if (!email || !password || password.length > 200) throw fail();

    const [admin] = await db.select('kf_admins', { filters: { email: `eq.${email}` }, limit: 1 });
    if (!admin || !admin.password_hash || !admin.active) {
      await burnPasswordCheck(password);
      throw fail();
    }
    if (admin.locked_until && new Date(admin.locked_until).getTime() > now()) {
      throw new ApiError(429, 'locked', 'Zu viele Fehlversuche. Das Konto ist für 15 Minuten gesperrt.');
    }
    if (!(await verifyPassword(password, admin.password_hash))) {
      const fails = (admin.failed_logins ?? 0) + 1;
      await db.update('kf_admins', { id: `eq.${admin.id}` }, fails >= 8
        ? { failed_logins: 0, locked_until: new Date(now() + 15 * MIN).toISOString() }
        : { failed_logins: fails });
      throw fail();
    }
    await db.update('kf_admins', { id: `eq.${admin.id}` }, { failed_logins: 0, locked_until: null, last_login_at: new Date(now()).toISOString() });
    const cookie = await startSession(admin.id, ctx.secure);
    db.rpc('kf_cleanup').catch(() => {});
    return json(200, { admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role, notify: admin.notify } }, { 'Set-Cookie': cookie });
  }

  async function setup(req, url, ctx) {
    await limit('setup-ip', ctx.ip, 600, 10);
    const body = await readJson(req);
    const token = body.token;
    if (!isTokenShape(token)) throw new ApiError(400, 'invalid_token', 'Dieser Einrichtungslink ist ungültig oder abgelaufen.');
    const [admin] = await db.select('kf_admins', { filters: { invite_token_hash: `eq.${sha256Hex(token)}` }, limit: 1 });
    if (!admin || !admin.active || !admin.invite_expires_at || new Date(admin.invite_expires_at).getTime() < now()) {
      throw new ApiError(400, 'invalid_token', 'Dieser Einrichtungslink ist ungültig oder abgelaufen.');
    }
    const password = must(validatePassword(body.password, admin.email));
    await db.update('kf_admins', { id: `eq.${admin.id}` }, {
      password_hash: await hashPassword(password),
      invite_token_hash: null, invite_expires_at: null, failed_logins: 0, locked_until: null,
      last_login_at: new Date(now()).toISOString(),
    });
    await db.remove('kf_sessions', { admin_id: `eq.${admin.id}` });
    const cookie = await startSession(admin.id, ctx.secure);
    return json(200, { admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role, notify: admin.notify } }, { 'Set-Cookie': cookie });
  }

  async function logout(req, url, ctx) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token && isTokenShape(token)) await db.remove('kf_sessions', { token_hash: `eq.${sha256Hex(token)}` });
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', ctx.secure, 0) });
  }

  async function requireAdmin(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token || !isTokenShape(token)) throw new ApiError(401, 'unauthenticated', 'Bitte melde dich an.');
    const res = await db.rpc('kf_session_lookup', { p_hash: sha256Hex(token) });
    if (!res) throw new ApiError(401, 'unauthenticated', 'Bitte melde dich an.');
    return { ...res.admin, sessionId: res.sessionId, tokenHash: sha256Hex(token) };
  }

  const requireOwner = (a) => {
    if (a.role !== 'owner') throw new ApiError(403, 'forbidden', 'Dafür ist der Hauptadministrator nötig.');
  };

  // ------------------------------------------------------------------
  // Admin: Termine
  // ------------------------------------------------------------------
  async function loadFull(id) {
    if (!isUuid(id)) throw new ApiError(404, 'not_found', 'Der Eintrag wurde nicht gefunden.');
    const [row] = await db.select('kf_bookings', { filters: { id: `eq.${id}` }, limit: 1 });
    if (!row) throw new ApiError(404, 'not_found', 'Der Eintrag wurde nicht gefunden.');
    return row;
  }

  async function adminMe(req, url, ctx, admin) {
    return json(200, { admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role, notify: admin.notify } });
  }

  async function adminRequests() {
    const rows = await db.select('kf_bookings', { select: BOOKING_COLS, filters: { status: 'eq.requested' }, order: 'start_at.asc', limit: 200 });
    return json(200, { requests: rows.map(adminBookingView) });
  }

  async function adminCalendar(req, url) {
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (!isValidDateStr(from) || !isValidDateStr(to) || to < from) throw new ApiError(400, 'bad_range', 'Ungültiger Datumsbereich.');
    if (new Date(to).getTime() - new Date(from).getTime() > 100 * 86400000) throw new ApiError(400, 'bad_range', 'Der Zeitraum ist zu groß.');
    const startIso = new Date(localDayRange(from)[0]).toISOString();
    const endIso = new Date(localDayRange(to)[1]).toISOString();
    const history = url.searchParams.get('history') === '1';
    const statuses = history ? 'requested,confirmed,cancelled,declined,withdrawn' : 'requested,confirmed,cancelled';
    const [bookings, blocks] = await Promise.all([
      db.select('kf_bookings', { select: BOOKING_COLS, filters: { status: `in.(${statuses})`, start_at: `lt.${endIso}`, end_at: `gt.${startIso}` }, order: 'start_at.asc', limit: 2000 }),
      db.select('kf_blocks', { filters: { start_at: `lt.${endIso}`, end_at: `gt.${startIso}` }, order: 'start_at.asc', limit: 500 }),
    ]);
    return json(200, {
      bookings: bookings.map(adminBookingView),
      blocks: blocks.map((b) => ({ id: b.id, start: iso(b.start_at), end: iso(b.end_at), reason: b.reason ?? null })),
    });
  }

  function readContact(body, { forCreate }) {
    const out = {};
    if (forCreate || 'name' in body) out.name = must(validateName(body.name));
    if (forCreate || 'email' in body) out.email = must(validateEmail(body.email, { required: false }));
    if (forCreate || 'phone' in body) out.phone = must(validatePhone(body.phone));
    if (forCreate || 'note' in body) out.note = must(validateNote(body.note, 1000, 'Die Kundennotiz'));
    if (forCreate || 'internalNote' in body) out.internalNote = must(validateNote(body.internalNote, 2000, 'Die interne Notiz'));
    return out;
  }

  function readTimes(body, fallback) {
    let startMs = fallback?.startMs;
    if ('start' in body) {
      startMs = parseLocalDateTime(body.start);
      if (startMs == null) throw new ApiError(422, 'invalid', 'Bitte gib ein gültiges Datum mit Uhrzeit an (die Uhrzeit existiert evtl. wegen der Zeitumstellung nicht).');
    }
    let durMin = fallback?.durationMin;
    if ('durationMinutes' in body) durMin = must(validateInt(body.durationMinutes, { min: 5, max: 720, label: 'Die Dauer (in Minuten)' }));
    if (startMs == null || durMin == null) throw new ApiError(422, 'invalid', 'Bitte gib Startzeit und Dauer an.');
    return { startMs, endMs: startMs + durMin * MIN, durationMin: durMin };
  }

  async function adminCreateBooking(req, url, ctx, admin) {
    const body = await readJson(req);
    const c = readContact(body, { forCreate: true });
    const t = readTimes(body);
    const id = newId();
    const cred = newBookingCredentials(config.appSecret, id);
    const row = await db.rpc('kf_create_manual_booking', {
      p_id: id, p_name: c.name, p_email: c.email, p_phone: c.phone, p_note: c.note, p_internal: c.internalNote,
      p_start: new Date(t.startMs).toISOString(), p_end: new Date(t.endMs).toISOString(),
      p_salt: cred.salt, p_token_hash: cred.hash, p_admin: admin.id,
    });
    if (row.customer_email && body.notifyCustomer !== false) {
      await dispatch('customer_confirmed', row, [row.customer_email], await getSettings(), ctx);
    }
    return json(201, { booking: adminBookingView(row) });
  }

  async function adminGetBooking(req, url, ctx, admin, params) {
    const row = await loadFull(params.id);
    return json(200, { booking: adminBookingView(row) });
  }

  async function adminUpdateBooking(req, url, ctx, admin, params) {
    const old = await loadFull(params.id);
    const body = await readJson(req);
    const c = readContact(body, { forCreate: false });
    const oldStart = new Date(old.start_at).getTime();
    const oldEnd = new Date(old.end_at).getTime();
    const timeTouched = 'start' in body || 'durationMinutes' in body;
    const t = timeTouched
      ? readTimes(body, { startMs: oldStart, durationMin: Math.round((oldEnd - oldStart) / MIN) })
      : { startMs: oldStart, endMs: oldEnd };
    const row = await db.rpc('kf_update_booking', {
      p_id: old.id,
      p_name: c.name ?? old.customer_name,
      p_email: 'email' in c ? c.email : old.customer_email,
      p_phone: 'phone' in c ? c.phone : old.customer_phone,
      p_note: 'note' in c ? c.note : old.customer_note,
      p_internal: 'internalNote' in c ? c.internalNote : old.internal_note,
      p_start: new Date(t.startMs).toISOString(), p_end: new Date(t.endMs).toISOString(),
    });
    const moved = t.startMs !== oldStart || t.endMs !== oldEnd;
    if (moved && (row.status === 'requested' || row.status === 'confirmed') && row.customer_email && body.notifyCustomer !== false) {
      await dispatch('customer_rescheduled', row, [row.customer_email], await getSettings(), ctx);
    }
    return json(200, { booking: adminBookingView(row) });
  }

  async function adminTransition(action, req, ctx, admin, params) {
    const body = await readJson(req);
    const id = (await loadFull(params.id)).id;
    const row = await db.rpc('kf_transition', { p_id: id, p_action: action, p_admin: admin.id });
    const kind = { accept: 'customer_confirmed', decline: 'customer_declined', admin_cancel: 'customer_cancelled_by_salon' }[action];
    if (row.customer_email && body.notifyCustomer !== false) {
      await dispatch(kind, row, [row.customer_email], await getSettings(), ctx);
    }
    return json(200, { booking: adminBookingView(row) });
  }

  async function adminDeleteBooking(req, url, ctx, admin, params) {
    const row = await loadFull(params.id);
    await db.remove('kf_bookings', { id: `eq.${row.id}` });
    return json(200, { ok: true });
  }

  async function adminSearch(req, url) {
    const q = cleanLine(url.searchParams.get('q') ?? '');
    if (q.length < 2) throw new ApiError(400, 'query_too_short', 'Bitte gib mindestens 2 Zeichen ein.');
    const rows = await db.rpc('kf_search_bookings', { p_q: q.slice(0, 100) });
    const groups = new Map();
    for (const r of rows) { // rows sind nach Startzeit absteigend sortiert
      const digits = (r.customer_phone || '').replace(/\D/g, '');
      const key = r.customer_email ? `e:${r.customer_email.toLowerCase()}` : digits ? `p:${digits}` : `n:${r.customer_name.toLowerCase()}`;
      if (!groups.has(key)) {
        groups.set(key, { name: r.customer_name, email: r.customer_email ?? null, phone: r.customer_phone ?? null, bookings: [] });
      }
      groups.get(key).bookings.push(adminBookingView(r));
    }
    return json(200, { customers: [...groups.values()] });
  }

  // ------------------------------------------------------------------
  // Admin: Sperrzeiten, Einstellungen, E-Mail-Protokoll, Admin-Konten
  // ------------------------------------------------------------------
  async function adminListBlocks(req, url) {
    const filters = url.searchParams.get('past') === '1' ? {} : { end_at: `gt.${new Date(now()).toISOString()}` };
    const rows = await db.select('kf_blocks', { filters, order: 'start_at.asc', limit: 500 });
    return json(200, { blocks: rows.map((b) => ({ id: b.id, start: iso(b.start_at), end: iso(b.end_at), reason: b.reason ?? null })) });
  }

  async function adminCreateBlock(req, url, ctx, admin) {
    const body = await readJson(req);
    let startMs; let endMs;
    if (body.startDate !== undefined) {
      const endDate = body.endDate || body.startDate;
      if (!isValidDateStr(body.startDate) || !isValidDateStr(endDate) || endDate < body.startDate) {
        throw new ApiError(422, 'invalid', 'Bitte gib einen gültigen Datumsbereich an.');
      }
      startMs = localDayRange(body.startDate)[0];
      endMs = localDayRange(endDate)[1];
    } else {
      startMs = parseLocalDateTime(body.start);
      endMs = parseLocalDateTime(body.end);
      if (startMs == null || endMs == null) throw new ApiError(422, 'invalid', 'Bitte gib Beginn und Ende mit gültiger Uhrzeit an.');
      if (endMs <= startMs) throw new ApiError(422, 'invalid', 'Das Ende muss nach dem Beginn liegen.');
    }
    if (endMs - startMs > 400 * 86400000) throw new ApiError(422, 'invalid', 'Eine Sperrzeit darf höchstens 400 Tage lang sein.');
    const reason = must(validateNote(body.reason, 200, 'Der Grund'));
    const res = await db.rpc('kf_create_block', {
      p_start: new Date(startMs).toISOString(), p_end: new Date(endMs).toISOString(),
      p_reason: reason, p_admin: admin.id, p_ack: body.acknowledgeConflicts === true,
    });
    if (!res.created) {
      return json(409, {
        error: 'conflicts',
        message: 'In diesem Zeitraum liegen bereits Termine. Sie bleiben bestehen und werden NICHT gelöscht.',
        conflicts: res.conflicts.map((c) => ({ id: c.id, name: c.name, status: c.status, start: new Date(c.start).toISOString(), end: new Date(c.end).toISOString() })),
      });
    }
    return json(201, { block: { id: res.block.id, start: iso(res.block.start_at), end: iso(res.block.end_at), reason: res.block.reason ?? null }, conflictCount: res.conflicts.length });
  }

  async function adminDeleteBlock(req, url, ctx, admin, params) {
    if (!isUuid(params.id)) throw new ApiError(404, 'not_found', 'Der Eintrag wurde nicht gefunden.');
    const rows = await db.remove('kf_blocks', { id: `eq.${params.id}` });
    if (!rows.length) throw new ApiError(404, 'not_found', 'Der Eintrag wurde nicht gefunden.');
    return json(200, { ok: true });
  }

  const settingsView = (s) => ({
    durationMinutes: s.duration_minutes, horizonDays: s.booking_horizon_days,
    minLeadMinutes: s.min_lead_minutes, contactEmail: s.contact_email, businessName: s.business_name,
  });

  async function adminGetSettings() {
    return json(200, { settings: settingsView(await getSettings()) });
  }

  async function adminPutSettings(req) {
    const body = await readJson(req);
    const patch = {};
    if ('durationMinutes' in body) patch.duration_minutes = must(validateInt(body.durationMinutes, { min: 5, max: 720, label: 'Die Termindauer (Minuten)' }));
    if ('horizonDays' in body) patch.booking_horizon_days = must(validateInt(body.horizonDays, { min: 1, max: 365, label: 'Die Buchungsfrist (Tage)' }));
    if ('minLeadMinutes' in body) patch.min_lead_minutes = must(validateInt(body.minLeadMinutes, { min: 0, max: 10080, label: 'Der Mindestvorlauf (Minuten)' }));
    if ('contactEmail' in body) patch.contact_email = must(validateEmail(body.contactEmail));
    if ('businessName' in body) {
      const n = cleanLine(body.businessName);
      if (n.length < 1 || n.length > 80) throw new ApiError(422, 'invalid', 'Der Name darf 1 bis 80 Zeichen lang sein.');
      patch.business_name = n;
    }
    if (!Object.keys(patch).length) throw new ApiError(400, 'nothing_to_update', 'Es wurde nichts geändert.');
    const [row] = await db.update('kf_settings', { id: 'eq.1' }, patch);
    return json(200, { settings: settingsView(row) });
  }

  async function adminEmails(req, url) {
    const status = url.searchParams.get('status') ?? 'all';
    const filters = ['pending', 'sent', 'failed'].includes(status) ? { status: `eq.${status}` } : {};
    const logs = await db.select('kf_email_log', { filters, order: 'created_at.desc', limit: 150 });
    const ids = [...new Set(logs.map((l) => l.booking_id).filter(Boolean))];
    const names = {};
    if (ids.length) {
      const rows = await db.select('kf_bookings', { select: 'id,customer_name,start_at', filters: { id: `in.(${ids.join(',')})` } });
      for (const r of rows) names[r.id] = { name: r.customer_name, start: iso(r.start_at) };
    }
    return json(200, {
      emails: logs.map((l) => ({
        id: l.id, kind: l.kind, to: l.to_email, status: l.status, attempts: l.attempts, error: l.last_error ?? null,
        createdAt: iso(l.created_at), sentAt: l.sent_at ? iso(l.sent_at) : null,
        booking: l.booking_id ? names[l.booking_id] ?? null : null,
        retryable: l.status !== 'sent' && l.kind !== 'admin_invite',
      })),
    });
  }

  async function adminRetryEmail(req, url, ctx, admin, params) {
    if (!isUuid(params.id)) throw new ApiError(404, 'not_found', 'Der Eintrag wurde nicht gefunden.');
    const [row] = await db.select('kf_email_log', { filters: { id: `eq.${params.id}` }, limit: 1 });
    if (!row) throw new ApiError(404, 'not_found', 'Der Eintrag wurde nicht gefunden.');
    if (row.status === 'sent') throw new ApiError(409, 'already_sent', 'Diese E-Mail wurde bereits gesendet.');
    if (row.kind === 'admin_invite' || !row.booking_id) {
      throw new ApiError(409, 'not_retryable', 'Einladungen kannst du nicht wiederholen. Erzeuge unter „Admins“ eine neue Einladung.');
    }
    const booking = await loadFull(row.booking_id);
    const res = await deliver(row, row.kind, booking, await getSettings(), ctx);
    return json(200, { ok: Boolean(res.ok), error: res.ok ? null : res.error ?? 'Versand fehlgeschlagen' });
  }

  const adminView = (a) => ({
    id: a.id, email: a.email, name: a.name, role: a.role, active: a.active, notify: a.notify,
    pendingSetup: !a.password_hash, lastLoginAt: a.last_login_at ? iso(a.last_login_at) : null,
  });

  async function adminList(req, url, ctx, admin) {
    requireOwner(admin);
    const rows = await db.select('kf_admins', { order: 'created_at.asc' });
    return json(200, { admins: rows.map(adminView) });
  }

  async function issueInvite(adminRow, ctx, settings) {
    const token = randomToken(32);
    await db.update('kf_admins', { id: `eq.${adminRow.id}` }, {
      invite_token_hash: sha256Hex(token), invite_expires_at: new Date(now() + 7 * 86400000).toISOString(),
    });
    const inviteUrl = `${ctx.siteUrl}/admin/#setup=${token}`;
    await dispatch('admin_invite', null, [adminRow.email], settings, ctx, { inviteUrl, inviteName: adminRow.name });
    return inviteUrl;
  }

  async function adminInvite(req, url, ctx, admin) {
    requireOwner(admin);
    const body = await readJson(req);
    const name = must(validateName(body.name));
    const email = must(validateEmail(body.email));
    const [created] = await db.insert('kf_admins', { email, name, role: 'admin' });
    const inviteUrl = await issueInvite(created, ctx, await getSettings());
    return json(201, { admin: adminView(created), inviteUrl });
  }

  async function adminReinvite(req, url, ctx, admin, params) {
    requireOwner(admin);
    if (!isUuid(params.id)) throw new ApiError(404, 'not_found', 'Der Eintrag wurde nicht gefunden.');
    const [target] = await db.select('kf_admins', { filters: { id: `eq.${params.id}` }, limit: 1 });
    if (!target) throw new ApiError(404, 'not_found', 'Der Eintrag wurde nicht gefunden.');
    const inviteUrl = await issueInvite(target, ctx, await getSettings());
    return json(200, { inviteUrl });
  }

  async function adminPatchAdmin(req, url, ctx, admin, params) {
    if (!isUuid(params.id)) throw new ApiError(404, 'not_found', 'Der Eintrag wurde nicht gefunden.');
    const body = await readJson(req);
    const own = params.id === admin.id;
    if (!own) requireOwner(admin);
    const [target] = await db.select('kf_admins', { filters: { id: `eq.${params.id}` }, limit: 1 });
    if (!target) throw new ApiError(404, 'not_found', 'Der Eintrag wurde nicht gefunden.');
    const patch = {};
    if ('notify' in body) patch.notify = body.notify === true;
    if ('active' in body) {
      if (own || target.role === 'owner') throw new ApiError(409, 'forbidden', 'Dieses Konto kann nicht deaktiviert werden.');
      patch.active = body.active === true;
    }
    if (!Object.keys(patch).length) throw new ApiError(400, 'nothing_to_update', 'Es wurde nichts geändert.');
    const [row] = await db.update('kf_admins', { id: `eq.${target.id}` }, patch);
    if (patch.active === false) await db.remove('kf_sessions', { admin_id: `eq.${target.id}` });
    return json(200, { admin: adminView(row) });
  }

  async function adminChangePassword(req, url, ctx, admin) {
    await limit('pw-change', admin.id, 600, 10);
    const body = await readJson(req);
    const [row] = await db.select('kf_admins', { filters: { id: `eq.${admin.id}` }, limit: 1 });
    if (!row || !(await verifyPassword(String(body.currentPassword ?? ''), row.password_hash ?? ''))) {
      throw new ApiError(403, 'bad_credentials', 'Das aktuelle Passwort ist nicht korrekt.');
    }
    const pw = must(validatePassword(body.newPassword, row.email));
    await db.update('kf_admins', { id: `eq.${admin.id}` }, { password_hash: await hashPassword(pw) });
    await db.remove('kf_sessions', { admin_id: `eq.${admin.id}`, token_hash: `neq.${admin.tokenHash}` });
    return json(200, { ok: true });
  }

  async function adminDiagnostics() {
    let dbOk = false;
    try { await getSettings(); dbOk = true; } catch { /* leer */ }
    return json(200, {
      database: dbOk,
      appSecretOk: config.appSecret.length >= 32,
      mailConfigured: Boolean(mailer.configured),
      mailFrom: mailer.from,
      usingResendTestSender: /@resend\.dev/i.test(mailer.from || ''),
      siteUrlConfigured: Boolean(config.siteUrl),
    });
  }

  // ------------------------------------------------------------------
  // Routing
  // ------------------------------------------------------------------
  const R = (method, path, handler, auth = false) => ({
    method, auth, handler,
    re: new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`),
  });

  const routes = [
    R('GET', '/health', health),
    R('GET', '/availability', availability),
    R('POST', '/bookings', createBooking),
    R('GET', '/manage', manageGet),
    R('POST', '/manage/cancel', manageCancel),

    R('POST', '/admin/login', login),
    R('POST', '/admin/setup', setup),
    R('POST', '/admin/logout', logout),
    R('GET', '/admin/me', adminMe, true),
    R('POST', '/admin/password', adminChangePassword, true),
    R('GET', '/admin/diagnostics', adminDiagnostics, true),

    R('GET', '/admin/requests', adminRequests, true),
    R('GET', '/admin/calendar', adminCalendar, true),
    R('POST', '/admin/bookings', adminCreateBooking, true),
    R('GET', '/admin/bookings/:id', adminGetBooking, true),
    R('PATCH', '/admin/bookings/:id', adminUpdateBooking, true),
    R('DELETE', '/admin/bookings/:id', adminDeleteBooking, true),
    R('POST', '/admin/bookings/:id/accept', (q, u, c, a, p) => adminTransition('accept', q, c, a, p), true),
    R('POST', '/admin/bookings/:id/decline', (q, u, c, a, p) => adminTransition('decline', q, c, a, p), true),
    R('POST', '/admin/bookings/:id/cancel', (q, u, c, a, p) => adminTransition('admin_cancel', q, c, a, p), true),
    R('GET', '/admin/search', adminSearch, true),

    R('GET', '/admin/blocks', adminListBlocks, true),
    R('POST', '/admin/blocks', adminCreateBlock, true),
    R('DELETE', '/admin/blocks/:id', adminDeleteBlock, true),

    R('GET', '/admin/settings', adminGetSettings, true),
    R('PUT', '/admin/settings', adminPutSettings, true),

    R('GET', '/admin/emails', adminEmails, true),
    R('POST', '/admin/emails/:id/retry', adminRetryEmail, true),

    R('GET', '/admin/admins', adminList, true),
    R('POST', '/admin/admins', adminInvite, true),
    R('POST', '/admin/admins/:id/invite', adminReinvite, true),
    R('PATCH', '/admin/admins/:id', adminPatchAdmin, true),
  ];

  function sameOrigin(req, url) {
    const origin = req.headers.get('origin');
    if (origin) {
      const allowed = new Set([url.origin]);
      if (config.siteUrl) allowed.add(config.siteUrl);
      if (!allowed.has(origin)) return false;
    }
    const site = req.headers.get('sec-fetch-site');
    if (site && !['same-origin', 'none', 'same-site'].includes(site)) return false;
    return true;
  }

  async function handle(req, context) {
    const url = new URL(req.url);
    const reqId = newId().slice(0, 8);
    try {
      if (config.missing.length) {
        throw new ApiError(500, 'config_error', 'Die Website ist noch nicht vollständig eingerichtet.', { missing: config.missing });
      }
      const path = url.pathname.replace(/^\/api/, '') || '/';
      const method = req.method.toUpperCase();

      let matched = null; let params = {}; let pathKnown = false;
      for (const r of routes) {
        const m = r.re.exec(path);
        if (!m) continue;
        pathKnown = true;
        if (r.method === method) { matched = r; params = m.groups ?? {}; break; }
      }
      if (!matched) {
        if (pathKnown) throw new ApiError(405, 'method_not_allowed', 'Diese Methode ist nicht erlaubt.');
        throw new ApiError(404, 'not_found', 'Nicht gefunden.');
      }
      if (method !== 'GET' && !sameOrigin(req, url)) {
        throw new ApiError(403, 'bad_origin', 'Die Anfrage wurde abgelehnt.');
      }

      const ctx = {
        ip: clientIp(req, context),
        siteUrl: config.siteUrl || url.origin,
        secure: url.protocol === 'https:',
      };
      const admin = matched.auth ? await requireAdmin(req) : null;
      return await matched.handler(req, url, ctx, admin, params);
    } catch (err) {
      if (err instanceof ApiError) {
        return json(err.status, { error: err.code, message: err.message, ...err.extra });
      }
      if (err && err.name === 'DbError') {
        // Fehlercode (z. B. KF001) oder, falls nur der Text ankommt, der Kurzname (z. B. "slot_unavailable").
        const hit = DB_ERRORS[err.code] ?? Object.values(DB_ERRORS).find((v) => v[1] === err.message);
        if (hit) return json(hit[0], { error: hit[1], message: hit[2] });
        log.error(`[api ${reqId}] ${req.method} ${url.pathname} Datenbankfehler ${err.code}: ${String(err.message).slice(0, 120)}`);
        return json(err.status === 503 ? 503 : 500, { error: 'server_error', message: 'Es ist ein Fehler aufgetreten. Bitte versuche es später noch einmal.', ref: reqId });
      }
      log.error(`[api ${reqId}] ${req.method} ${url.pathname} ${err?.name ?? 'Fehler'}: ${String(err?.message ?? '').slice(0, 120)}`);
      return json(500, { error: 'server_error', message: 'Es ist ein Fehler aufgetreten. Bitte versuche es später noch einmal.', ref: reqId });
    }
  }

  return { handle };
}
