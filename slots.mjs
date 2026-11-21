// Berechnung der buchbaren Zeiten für den öffentlichen Kalender.
// Die endgültige Entscheidung trifft immer die Datenbank (siehe kf_create_booking);
// diese Funktion bestimmt nur, was angezeigt wird.

import { addDays, daySlotStarts, diffDays, isValidDateStr, localDateStr } from './time.mjs';

const MIN = 60000;
export const MAX_RANGE_DAYS = 42;

/**
 * @param {object} p
 * @param {string} p.from  'YYYY-MM-DD' (Berlin)
 * @param {string} p.to    'YYYY-MM-DD' (Berlin), inklusive
 * @param {{durationMinutes:number,horizonDays:number,minLeadMinutes:number,busy:number[][]}} p.state
 * @param {number} p.now   UTC-ms
 */
export function buildAvailability({ from, to, state, now }) {
  const today = localDateStr(now);
  const maxDate = addDays(today, state.horizonDays);
  const durMs = state.durationMinutes * MIN;
  const earliest = Math.max(now, now + state.minLeadMinutes * MIN);
  const busy = [...state.busy].sort((a, b) => a[0] - b[0]);
  const days = [];

  for (let date = from; diffDays(date, to) >= 0; date = addDays(date, 1)) {
    const bookable = diffDays(today, date) >= 0 && diffDays(date, maxDate) >= 0;
    const slots = [];
    let freeCount = 0;
    if (bookable) {
      for (const start of daySlotStarts(date)) {
        if (start <= earliest) continue; // vergangene Zeiten werden gar nicht angezeigt
        const end = start + durMs;
        const taken = busy.some(([bs, be]) => bs < end && be > start);
        if (!taken) freeCount++;
        slots.push([new Date(start).toISOString(), taken ? 0 : 1]);
      }
    }
    days.push({ date, bookable, free: freeCount, slots });
  }
  return days;
}

export function validateRange(from, to) {
  if (!isValidDateStr(from) || !isValidDateStr(to)) return 'Ungültiger Datumsbereich.';
  const n = diffDays(from, to);
  if (n < 0) return 'Das Enddatum liegt vor dem Startdatum.';
  if (n + 1 > MAX_RANGE_DAYS) return `Es können höchstens ${MAX_RANGE_DAYS} Tage auf einmal abgefragt werden.`;
  return null;
}
