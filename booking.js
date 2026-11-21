// Kundenseite: Kalender (Woche/Monat) -> Uhrzeit -> Formular -> Anfrage senden.

import {
  ApiError, WEEKDAYS, addDays, addMonths, alertBox, api, clear, copyText, dateStr, dayNumber, diffDays, dow, field,
  fmtDateStrLong, h, monthFirst, monthTitle, startOfWeek, timeStr, fmtRange,
} from './common.js';

const app = document.getElementById('app');
const S = {
  view: 'month', cursor: null, today: dateStr(Date.now()), horizon: 30, duration: 60,
  days: new Map(), selDate: null, selSlot: null, loadError: null, form: {}, submitting: false, notice: null,
};
S.cursor = S.today;

const calEl = h('section', { 'aria-label': 'Kalender' });
const timesEl = h('section', { class: 'times', 'aria-live': 'polite' });
const formEl = h('section');
app.append(calEl, timesEl, formEl);

const maxDate = () => addDays(S.today, S.horizon);

function range() {
  if (S.view === 'month') { const from = startOfWeek(monthFirst(S.cursor)); return [from, addDays(from, 41)]; }
  const from = startOfWeek(S.cursor); return [from, addDays(from, 6)];
}

async function load() {
  const [from, to] = range();
  S.loadError = null;
  try {
    const data = await api('GET', `/availability?from=${from}&to=${to}`);
    S.today = data.today; S.horizon = data.horizonDays; S.duration = data.durationMinutes;
    for (const d of data.days) S.days.set(d.date, d);
  } catch (err) {
    S.loadError = err instanceof ApiError ? err.message : 'Die Zeiten konnten nicht geladen werden.';
  }
  renderAll();
}

// ---------- Kalender ----------
function dayState(date) {
  const d = S.days.get(date);
  if (!d || !d.bookable) return 'off';
  return d.free > 0 ? 'free' : 'full';
}

function dayButton(date, { other = false, weekMode = false } = {}) {
  const st = dayState(date);
  const sel = S.selDate === date;
  const label = `${fmtDateStrLong(date)}, ${st === 'free' ? 'freie Zeiten' : st === 'full' ? 'keine freie Zeit' : 'nicht buchbar'}`;
  const b = h('button', {
    type: 'button', class: `daybtn ${st}${sel ? ' selected' : ''}${date === S.today ? ' today' : ''}${other ? ' other' : ''}`,
    'data-date': date, 'aria-label': label, 'aria-pressed': sel ? 'true' : 'false', disabled: st === 'off',
    onclick: () => selectDay(date),
  },
  weekMode ? h('span', { class: 'wd' }, WEEKDAYS[dow(date)]) : null,
  weekMode ? h('span', { class: 'num' }, dayNumber(date)) : String(dayNumber(date)),
  h('span', { class: 'sub' }, st === 'free' ? 'frei' : st === 'full' ? 'belegt' : ''));
  return b;
}

function renderCal() {
  clear(calEl);
  const first = monthFirst(S.cursor);
  const weekStart = startOfWeek(S.cursor);
  const periodStart = S.view === 'month' ? first : weekStart;
  const canPrev = periodStart > (S.view === 'month' ? monthFirst(S.today) : startOfWeek(S.today));
  const nextStart = S.view === 'month' ? addMonths(first, 1) : addDays(weekStart, 7);
  const canNext = nextStart <= maxDate();
  const step = (dir) => {
    S.cursor = S.view === 'month' ? addMonths(first, dir) : addDays(weekStart, 7 * dir);
    load();
  };
  const title = S.view === 'month' ? monthTitle(first) : `${fmtDateStrLong(weekStart).replace(/^\S+,\s*/, '')} – ${fmtDateStrLong(addDays(weekStart, 6)).replace(/^\S+,\s*/, '')}`;

  calEl.append(h('div', { class: 'cal-head' },
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Ansicht' },
      h('button', { type: 'button', 'aria-pressed': String(S.view === 'week'), 'data-view': 'week', onclick: () => { S.view = 'week'; S.cursor = S.selDate ?? S.today; load(); } }, 'Woche'),
      h('button', { type: 'button', 'aria-pressed': String(S.view === 'month'), 'data-view': 'month', onclick: () => { S.view = 'month'; S.cursor = S.selDate ?? S.cursor; load(); } }, 'Monat')),
    h('div', { class: 'cal-title', 'aria-live': 'polite' }, title),
    h('div', { class: 'nav-btns' },
      h('button', { type: 'button', class: 'btn secondary', 'aria-label': 'Zurück', 'data-nav': 'prev', disabled: !canPrev, onclick: () => step(-1) }, '‹'),
      h('button', { type: 'button', class: 'btn secondary', 'data-nav': 'today', onclick: () => { S.cursor = S.today; load(); } }, 'Heute'),
      h('button', { type: 'button', class: 'btn secondary', 'aria-label': 'Weiter', 'data-nav': 'next', disabled: !canNext, onclick: () => step(1) }, '›'))));

  if (S.loadError) {
    calEl.append(alertBox('error', S.loadError, ' ', h('button', { class: 'btn small secondary', type: 'button', onclick: load }, 'Erneut versuchen')));
    return;
  }

  if (S.view === 'month') {
    const grid = h('div', { class: 'month' });
    for (const w of WEEKDAYS) grid.append(h('div', { class: 'dow' }, w));
    const start = startOfWeek(first);
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      if (i >= 35 && d.slice(0, 7) !== first.slice(0, 7)) break; // keine leere 6. Zeile
      grid.append(dayButton(d, { other: d.slice(0, 7) !== first.slice(0, 7) }));
    }
    calEl.append(grid);
  } else {
    const grid = h('div', { class: 'week' });
    for (let i = 0; i < 7; i++) grid.append(dayButton(addDays(weekStart, i), { weekMode: true }));
    calEl.append(grid);
  }
}

// ---------- Uhrzeiten ----------
function selectDay(date) {
  S.selDate = date; S.selSlot = null;
  renderCal(); renderTimes(); renderForm();
  timesEl.scrollIntoView({ block: 'nearest' });
}

const GROUPS = [['Nacht', 0, 6], ['Vormittag', 6, 12], ['Nachmittag', 12, 18], ['Abend', 18, 24]];

function renderTimes() {
  clear(timesEl);
  if (S.loadError) return;
  if (S.notice) timesEl.append(alertBox(S.notice.kind, S.notice.text));
  if (!S.selDate) { timesEl.append(h('p', { class: 'muted' }, 'Bitte wähle einen Tag im Kalender.')); return; }
  const d = S.days.get(S.selDate);
  timesEl.append(h('h2', null, fmtDateStrLong(S.selDate)));
  if (!d || !d.bookable) { timesEl.append(alertBox('info', 'Dieser Tag kann nicht gebucht werden.')); return; }
  if (!d.free) timesEl.append(alertBox('info', 'An diesem Tag ist leider keine Zeit mehr frei. Bitte wähle einen anderen Tag.'));
  timesEl.append(h('p', { class: 'muted small' }, `Ein Termin dauert ${S.duration} Minuten.`));
  for (const [name, from, to] of GROUPS) {
    const items = d.slots.filter(([iso]) => { const hr = Number(timeStr(Date.parse(iso)).slice(0, 2)); return hr >= from && hr < to; });
    if (!items.length) continue;
    const chips = h('div', { class: 'chips' });
    for (const [iso, free] of items) {
      chips.append(h('button', {
        type: 'button', class: `chip${S.selSlot === iso ? ' selected' : ''}`, 'data-start': iso, disabled: !free,
        'aria-pressed': S.selSlot === iso ? 'true' : 'false', 'aria-label': `${timeStr(Date.parse(iso))} Uhr${free ? '' : ', belegt'}`,
        onclick: () => selectSlot(iso),
      }, timeStr(Date.parse(iso))));
    }
    timesEl.append(h('div', { class: 'times-group' }, h('div', { class: 'label' }, name), chips));
  }
  timesEl.append(h('div', { class: 'legend' }, h('span', null, h('i'), 'frei'), h('span', null, h('i', { class: 'busy' }), 'belegt')));
}

function selectSlot(iso) {
  S.selSlot = iso; S.notice = null;
  renderTimes(); renderForm();
  const first = formEl.querySelector('input');
  formEl.scrollIntoView({ block: 'start' });
  if (first) first.focus({ preventScroll: true });
}

// ---------- Formular ----------
const EMAIL_RE = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\.]{2,}$/;

function renderForm() {
  clear(formEl);
  if (!S.selSlot) return;
  const start = Date.parse(S.selSlot);
  const end = start + S.duration * 60000;
  const errBox = h('div', { 'aria-live': 'assertive' });
  const mk = (id, type, key, extra = {}) => {
    const el = h(type === 'textarea' ? 'textarea' : 'input', { id, name: key, type: type === 'textarea' ? null : type, ...extra });
    el.value = S.form[key] ?? '';
    el.addEventListener('input', () => { S.form[key] = el.value; });
    return el;
  };
  const trap = h('div', { class: 'trap', 'aria-hidden': 'true' }, h('label', { for: 'website' }, 'Bitte leer lassen'), h('input', { id: 'website', name: 'website', type: 'text', tabindex: '-1', autocomplete: 'off' }));
  const submit = h('button', { class: 'btn block', type: 'submit', id: 'submit' }, 'Terminanfrage senden');

  const form = h('form', { class: 'card', novalidate: true, id: 'booking-form' },
    h('h2', null, 'Deine Angaben'),
    h('div', { class: 'summary', id: 'summary' }, fmtRange(start, end)),
    errBox,
    h('div', { class: 'row' },
      field('Vorname *', mk('first', 'text', 'first', { autocomplete: 'given-name', required: true, maxlength: '50' })),
      field('Nachname *', mk('last', 'text', 'last', { autocomplete: 'family-name', required: true, maxlength: '50' }))),
    field('E-Mail-Adresse *', mk('email', 'email', 'email', { autocomplete: 'email', required: true, maxlength: '254', inputmode: 'email' })),
    field('Telefonnummer', mk('phone', 'tel', 'phone', { autocomplete: 'tel', maxlength: '40', inputmode: 'tel' }), '(freiwillig)'),
    field('Notizen', mk('note', 'textarea', 'note', { maxlength: '1000' }), '(freiwillig)'),
    trap, submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (S.submitting) return;
    clear(errBox);
    const first = (S.form.first ?? '').trim(); const last = (S.form.last ?? '').trim();
    const email = (S.form.email ?? '').trim(); const phone = (S.form.phone ?? '').trim();
    const fail = (m) => { errBox.append(alertBox('error', m)); errBox.scrollIntoView({ block: 'nearest' }); };
    if (first.length < 1 || last.length < 1) return fail('Bitte gib Vor- und Nachnamen an.');
    if (!EMAIL_RE.test(email)) return fail('Bitte gib eine gültige E-Mail-Adresse an.');
    if (phone && !/^[0-9+()\-/. ]{5,40}$/.test(phone)) return fail('Bitte gib eine gültige Telefonnummer an oder lass das Feld leer.');
    S.submitting = true; submit.disabled = true; submit.textContent = 'Wird gesendet …';
    try {
      const res = await api('POST', '/bookings', { name: `${first} ${last}`, email, phone, note: S.form.note ?? '', start: S.selSlot, website: form.elements.website.value });
      showSuccess(res, email);
    } catch (err) {
      S.submitting = false; submit.disabled = false; submit.textContent = 'Terminanfrage senden';
      if (err.code === 'slot_unavailable' || err.code === 'start_in_past') {
        // Das Formular verschwindet, weil die Zeit weg ist: die Meldung steht deshalb bei den Uhrzeiten.
        S.selSlot = null;
        S.notice = { kind: 'error', text: `${err.message} Deine Angaben bleiben erhalten – wähle einfach eine andere Zeit.` };
        await load();
        timesEl.scrollIntoView({ block: 'start' });
      } else fail(err.message);
    }
  });
  formEl.append(form);
}

function showSuccess(res) {
  const link = res.managePath ? `${location.origin}${res.managePath}` : null;
  try {
    if (link) {
      const list = JSON.parse(localStorage.getItem('kf_links') || '[]');
      list.push({ link, start: res.start });
      localStorage.setItem('kf_links', JSON.stringify(list.slice(-10)));
    }
  } catch { /* ohne Speicher weiter */ }
  clear(app);
  const copyBtn = h('button', { class: 'btn secondary', type: 'button', id: 'copy-link' }, 'Link kopieren');
  copyBtn.addEventListener('click', async () => { copyBtn.textContent = (await copyText(link)) ? 'Kopiert ✓' : 'Bitte Link markieren und kopieren'; });
  app.append(h('div', { class: 'card success', id: 'success' },
    h('div', { class: 'tick', 'aria-hidden': 'true' }, '✓'),
    h('h2', null, 'Anfrage übermittelt'),
    h('p', null, 'Deine Terminanfrage wurde erfolgreich übermittelt. Du erhältst eine Rückmeldung per E-Mail, sobald dein Termin bearbeitet wurde.'),
    h('p', { class: 'summary' }, fmtRange(Date.parse(res.start), Date.parse(res.end))),
    link ? h('p', { class: 'muted small' }, 'Über deinen persönlichen Link kannst du den Stand jederzeit einsehen, deine Anfrage zurückziehen oder den Termin absagen:') : null,
    link ? h('div', { class: 'actions', style: null }, h('a', { class: 'btn', href: res.managePath, id: 'manage-link' }, 'Meinen Termin verwalten'), copyBtn) : null,
    h('p', { class: 'small' }, h('a', { href: '/' }, 'Weiteren Termin buchen'))));
}

function renderAll() { renderCal(); renderTimes(); renderForm(); }

renderAll();
load();
