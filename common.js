// Gemeinsame Hilfen für alle Seiten. Keine externen Bibliotheken.
// Wichtig: Daten werden NIE per innerHTML eingefügt, nur über textContent (h()).

export const TZ = 'Europe/Berlin';
export const pad = (n) => String(n).padStart(2, '0');

// ---------- DOM ----------
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function alertBox(kind, text, ...extra) { return h('div', { class: `alert ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text, ...extra); }

let idCounter = 0;
export const uid = (p = 'f') => `${p}${++idCounter}`;

export function field(label, input, hint) {
  if (!input.id) input.id = uid();
  return h('div', { class: 'field' }, h('label', { for: input.id }, label, hint ? h('span', { class: 'hint' }, ` ${hint}`) : null), input);
}

// ---------- Dialoge ----------
export function openDialog(content, { big = false, onClose } = {}) {
  const dlg = h('dialog', { class: big ? 'big' : '' }, content);
  document.body.append(dlg);
  dlg.addEventListener('close', () => { dlg.remove(); if (onClose) onClose(); });
  dlg.showModal();
  return dlg;
}

export function confirmDialog({ title, text, okLabel = 'OK', cancelLabel = 'Zurück', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const dlg = openDialog(
      h('div', null,
        h('h2', null, title),
        h('p', null, text),
        h('div', { class: 'actions' },
          h('button', { class: 'btn secondary', type: 'button', onclick: () => dlg.close() }, cancelLabel),
          h('button', { class: `btn${danger ? ' danger' : ''}`, type: 'button', onclick: () => { result = true; dlg.close(); } }, okLabel))),
      { onClose: () => resolve(result) });
  });
}

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, code, message, data) { super(message); this.status = status; this.code = code; this.data = data; }
}

export async function api(method, path, body, { token } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Booking-Token': token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'Keine Verbindung zum Server. Bitte prüfe deine Internetverbindung und versuche es erneut.');
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? 'Es ist ein Fehler aufgetreten. Bitte versuche es später noch einmal.', data);
  }
  return data;
}

// ---------- Zeit (immer Europe/Berlin) ----------
const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
export function parts(ms) {
  const p = {};
  for (const x of partsFmt.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = parseInt(x.value, 10);
  return p;
}
export const dateStr = (ms) => { const p = parts(ms); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; };
export const timeStr = (ms) => { const p = parts(ms); return `${pad(p.hour)}:${pad(p.minute)}`; };
export const wallMinutes = (ms) => { const p = parts(ms); return p.hour * 60 + p.minute; };

export function localToUtcMs(y, mo, d, hh = 0, mi = 0) {
  const off = (ms) => { const p = parts(ms); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000; };
  const guess = Date.UTC(y, mo - 1, d, hh, mi);
  const o1 = off(guess);
  let ms = guess - o1;
  const o2 = off(ms);
  if (o2 !== o1) ms = guess - o2;
  return ms;
}

const split = (s) => s.split('-').map(Number);
export function addDays(s, n) { const [y, m, d] = split(s); const dt = new Date(Date.UTC(y, m - 1, d + n)); return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`; }
export function diffDays(a, b) { const [y1, m1, d1] = split(a); const [y2, m2, d2] = split(b); return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000); }
export function dow(s) { const [y, m, d] = split(s); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; } // Montag = 0
export const startOfWeek = (s) => addDays(s, -dow(s));
export const monthFirst = (s) => `${s.slice(0, 8)}01`;
export function addMonths(s, n) { const [y, m] = split(s); const dt = new Date(Date.UTC(y, m - 1 + n, 1)); return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-01`; }
export function dayRangeMs(s) { const [y, m, d] = split(s); const [y2, m2, d2] = split(addDays(s, 1)); return [localToUtcMs(y, m, d), localToUtcMs(y2, m2, d2)]; }

const fmtLong = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtLongUtc = new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDm = new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC', day: 'numeric', month: 'long' });
const fmtMonth = new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const asUtc = (s) => { const [y, m, d] = split(s); return new Date(Date.UTC(y, m - 1, d, 12)); };
export const fmtDateLong = (ms) => fmtLong.format(new Date(ms));
export const fmtDateShort = (ms) => fmtShort.format(new Date(ms));
export const fmtDateStrLong = (s) => fmtLongUtc.format(asUtc(s));
export const fmtDateStrDm = (s) => fmtDm.format(asUtc(s));
export const monthTitle = (s) => fmtMonth.format(asUtc(s));
export const dayNumber = (s) => split(s)[2];
export const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const fmtRange = (startMs, endMs) => `${fmtDateLong(startMs)}, ${timeStr(startMs)} bis ${timeStr(endMs)} Uhr`;

export const STATUS_LABEL = { requested: 'Offen', confirmed: 'Bestätigt', declined: 'Abgelehnt', withdrawn: 'Zurückgezogen', cancelled: 'Abgesagt' };
export function statusBadge(status) { return h('span', { class: `badge ${status}` }, STATUS_LABEL[status] ?? status); }

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* Fallback */ }
  const ta = h('textarea', { class: 'trap', 'aria-hidden': 'true' });
  ta.value = text; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove(); return ok;
}
