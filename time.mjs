// Zeit-Hilfen. Alles wird intern als UTC gespeichert; Tage, Uhrzeiten und
// Sommerzeit-Wechsel werden immer in "Europe/Berlin" berechnet – unabhängig
// von der Zeitzone des Servers oder des Browsers.

export const TZ = 'Europe/Berlin';
export const SLOT_MINUTES = 15;
const MIN = 60000;

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function tzParts(ms) {
  const p = {};
  for (const x of partsFmt.formatToParts(new Date(ms))) {
    if (x.type !== 'literal') p[x.type] = parseInt(x.value, 10);
  }
  return p;
}

/** Versatz Berlin-Zeit minus UTC in Millisekunden zum Zeitpunkt ms. */
export function tzOffsetMs(ms) {
  const p = tzParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Berliner Wandzeit -> UTC-Millisekunden (sommerzeitsicher). */
export function localToUtcMs(y, mo, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMs(guess);
  let ms = guess - off1;
  const off2 = tzOffsetMs(ms);
  if (off2 !== off1) ms = guess - off2;
  return ms;
}

export function pad(n) { return String(n).padStart(2, '0'); }

/** 'YYYY-MM-DD' (Berliner Datum) eines Zeitpunkts. */
export function localDateStr(ms) {
  const p = tzParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function diffDays(aStr, bStr) {
  const [y1, m1, d1] = aStr.split('-').map(Number);
  const [y2, m2, d2] = bStr.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/** [Beginn, Beginn des Folgetags) eines Berliner Kalendertags in UTC-ms. */
export function localDayRange(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = localToUtcMs(y, m, d, 0, 0);
  const next = addDays(dateStr, 1).split('-').map(Number);
  const end = localToUtcMs(next[0], next[1], next[2], 0, 0);
  return [start, end];
}

/**
 * 'YYYY-MM-DDTHH:mm' (Berliner Wandzeit) -> UTC-ms, sonst null.
 * Zeiten, die es wegen der Zeitumstellung nicht gibt (z. B. 02:30 am letzten
 * Märzsonntag), werden abgelehnt.
 */
export function parseLocalDateTime(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})$/.exec(s.trim());
  if (!m || !isValidDateStr(m[1])) return null;
  const h = Number(m[2]);
  const mi = Number(m[3]);
  if (h > 23 || mi > 59) return null;
  const [y, mo, d] = m[1].split('-').map(Number);
  const ms = localToUtcMs(y, mo, d, h, mi);
  const back = tzParts(ms);
  if (back.year !== y || back.month !== mo || back.day !== d || back.hour !== h || back.minute !== mi) return null;
  return ms;
}

/** Alle Slot-Startzeiten (UTC-ms, 15-Minuten-Raster) eines Berliner Tages. */
export function daySlotStarts(dateStr) {
  const [start, end] = localDayRange(dateStr);
  const out = [];
  for (let t = start; t < end; t += SLOT_MINUTES * MIN) out.push(t);
  return out;
}

const fmtDate = new Intl.DateTimeFormat('de-DE', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});
const fmtTime = new Intl.DateTimeFormat('de-DE', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function formatDateDe(ms) { return fmtDate.format(new Date(ms)); }
export function formatTimeDe(ms) { return fmtTime.format(new Date(ms)); }

/** z. B. "Freitag, 21. November 2026, 14:00 bis 15:00 Uhr" */
export function formatRangeDe(startMs, endMs) {
  return `${formatDateDe(startMs)}, ${formatTimeDe(startMs)} bis ${formatTimeDe(endMs)} Uhr`;
}
