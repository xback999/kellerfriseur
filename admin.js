// Adminbereich: Anfragen, Kalender (Monat/Woche/Tag), Termine, Suche, Sperrzeiten, Einstellungen, E-Mails, Admins, Konto.

import {
  ApiError, STATUS_LABEL, WEEKDAYS, addDays, addMonths, alertBox, api, clear, confirmDialog, copyText, dateStr, dayNumber, dayRangeMs,
  diffDays, dow, field, fmtDateLong, fmtDateShort, fmtDateStrDm, fmtDateStrLong, fmtRange, h, monthFirst, monthTitle, openDialog,
  pad, parts, startOfWeek, statusBadge, timeStr, uid, wallMinutes,
} from './common.js';

const root = document.getElementById('root');
const S = { admin: null, tab: 'requests', settings: null, requestCount: 0, renderId: 0, content: null, tabsEl: null };
const CAL = { mode: 'month', date: dateStr(Date.now()), history: false };
const HOUR_PX = 48;
const MIN_PX = HOUR_PX / 60;
const active = (st) => st === 'requested' || st === 'confirmed';

// ======================================================================
// Start, Anmeldung, Einrichtung
// ======================================================================
async function boot() {
  const m = /^#setup=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (m) return showSetup(m[1]);
  try {
    S.admin = (await api('GET', '/admin/me')).admin;
  } catch (err) {
    return showLogin(err.status === 401 ? '' : err.message);
  }
  await startApp();
}

function shell(title, ...kids) {
  clear(root).append(
    h('header', { class: 'topbar' }, h('div', { class: 'wrap' }, h('span', { class: 'brand' }, 'Kellerfriseur – Admin'))),
    h('main', null, h('div', { class: 'wrap narrow' }, h('h1', null, title), ...kids)));
}

function showLogin(message) {
  const err = h('div', { 'aria-live': 'assertive' });
  if (message) err.append(alertBox('error', message));
  const email = h('input', { type: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn block', type: 'submit' }, 'Anmelden');
  const form = h('form', { class: 'card', id: 'login-form', novalidate: true }, field('E-Mail-Adresse', email), field('Passwort', pw), btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(err); btn.disabled = true;
    try {
      S.admin = (await api('POST', '/admin/login', { email: email.value, password: pw.value })).admin;
      await startApp();
    } catch (ex) { err.append(alertBox('error', ex.message)); btn.disabled = false; pw.value = ''; pw.focus(); }
  });
  shell('Anmelden', err, form);
  email.focus();
}

function showSetup(token) {
  const err = h('div', { 'aria-live': 'assertive' });
  const p1 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '10' });
  const p2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const btn = h('button', { class: 'btn block', type: 'submit' }, 'Passwort speichern und anmelden');
  const form = h('form', { class: 'card', id: 'setup-form', novalidate: true },
    h('p', null, 'Lege jetzt dein persönliches Passwort fest (mindestens 10 Zeichen).'),
    field('Neues Passwort', p1), field('Passwort wiederholen', p2), btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(err);
    if (p1.value !== p2.value) return err.append(alertBox('error', 'Die beiden Passwörter sind nicht gleich.'));
    btn.disabled = true;
    try {
      S.admin = (await api('POST', '/admin/setup', { token, password: p1.value })).admin;
      history.replaceState(null, '', location.pathname);
      await startApp();
    } catch (ex) { err.append(alertBox('error', ex.message)); btn.disabled = false; }
  });
  shell('Willkommen', err, form);
}

async function logout() {
  try { await api('POST', '/admin/logout', {}); } catch { /* egal */ }
  S.admin = null; showLogin('');
}

function sessionExpired() { S.admin = null; showLogin('Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.'); }

// ======================================================================
// Rahmen mit Tabs
// ======================================================================
const TABS = [
  ['requests', 'Anfragen'], ['calendar', 'Kalender'], ['new', 'Neuer Termin'], ['search', 'Suche'],
  ['blocks', 'Sperrzeiten'], ['settings', 'Einstellungen'], ['emails', 'E-Mails'], ['admins', 'Admins'], ['account', 'Konto'],
];
const VIEWS = {};

async function startApp() {
  try { S.settings = (await api('GET', '/admin/settings')).settings; } catch (err) { if (err.status === 401) return sessionExpired(); }
  S.tab = 'requests';
  const tabsEl = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Bereiche' });
  const content = h('div', { class: 'wrap wide', id: 'content', role: 'tabpanel' });
  S.tabsEl = tabsEl; S.content = content;
  clear(root).append(
    h('header', { class: 'topbar' }, h('div', { class: 'wrap wide' },
      h('span', { class: 'brand' }, 'Kellerfriseur – Admin'),
      h('span', { class: 'small' }, `${S.admin.name} `, h('button', { class: 'btn small secondary', type: 'button', id: 'logout', onclick: logout }, 'Abmelden')))),
    tabsEl, h('main', null, content));
  drawTabs();
  show('requests');
  refreshCount();
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (!document.hidden && S.admin) { refreshCount(); if (S.tab === 'requests' && !document.querySelector('dialog')) show('requests', true); } }, 60000);
}

function drawTabs() {
  clear(S.tabsEl);
  for (const [id, label] of TABS) {
    if (id === 'admins' && S.admin.role !== 'owner') continue;
    S.tabsEl.append(h('button', { class: 'tab', type: 'button', role: 'tab', 'data-tab': id, 'aria-selected': String(S.tab === id), onclick: () => show(id) },
      label, id === 'requests' && S.requestCount ? h('span', { class: 'badge-count', id: 'req-count' }, S.requestCount) : null));
  }
}

async function refreshCount() {
  try { S.requestCount = (await api('GET', '/admin/requests')).requests.length; drawTabs(); } catch (err) { if (err.status === 401) sessionExpired(); }
}

async function show(tab, silent = false) {
  S.tab = tab; drawTabs();
  const my = ++S.renderId;
  if (!silent) clear(S.content).append(h('p', { class: 'muted' }, 'Wird geladen …'));
  const box = h('div');
  try {
    await VIEWS[tab](box, () => my === S.renderId);
    if (my !== S.renderId) return;
    clear(S.content).append(box);
  } catch (err) {
    if (my !== S.renderId) return;
    if (err.status === 401) return sessionExpired();
    clear(S.content).append(alertBox('error', err.message), h('button', { class: 'btn secondary', type: 'button', onclick: () => show(tab) }, 'Erneut versuchen'));
  }
}
const reload = () => { refreshCount(); return show(S.tab, true); };

// ======================================================================
// Hilfen: Termin-Details und Formular
// ======================================================================
function kv(rows) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of rows) if (v !== null && v !== undefined && v !== '') dl.append(h('dt', null, k), h('dd', null, v));
  return dl;
}

function showBooking(b, { onChange } = {}) {
  const after = async () => { dlg.close(); if (onChange) await onChange(); else await reload(); };
  const err = h('div', { 'aria-live': 'assertive' });
  const run = (fn) => async () => { clear(err); try { await fn(); await after(); } catch (ex) { if (ex.status === 401) { dlg.close(); return sessionExpired(); } err.append(alertBox('error', ex.message)); } };
  const start = Date.parse(b.start); const end = Date.parse(b.end);
  const actions = h('div', { class: 'actions' });
  if (b.status === 'requested') {
    actions.append(
      h('button', { class: 'btn', type: 'button', id: 'accept', onclick: run(() => api('POST', `/admin/bookings/${b.id}/accept`, {})) }, 'Termin annehmen'),
      h('button', { class: 'btn danger secondary', type: 'button', id: 'decline', onclick: run(() => api('POST', `/admin/bookings/${b.id}/decline`, {})) }, 'Termin ablehnen'));
  }
  if (active(b.status) || true) {
    actions.append(h('button', { class: 'btn secondary', type: 'button', id: 'edit', onclick: () => { dlg.close(); editBooking(b, onChange); } }, active(b.status) ? 'Bearbeiten / Verschieben' : 'Bearbeiten'));
  }
  if (b.status === 'confirmed') {
    actions.append(h('button', { class: 'btn danger secondary', type: 'button', id: 'cancel-booking', onclick: async () => {
      if (await confirmDialog({ title: 'Termin absagen?', text: `${b.name}: ${fmtRange(start, end)}. Der Zeitraum wird sofort wieder frei.`, okLabel: 'Ja, absagen', danger: true })) await run(() => api('POST', `/admin/bookings/${b.id}/cancel`, {}))();
    } }, 'Absagen'));
  }
  actions.append(h('button', { class: 'btn danger secondary', type: 'button', id: 'delete-booking', onclick: async () => {
    if (await confirmDialog({ title: 'Endgültig löschen?', text: `${b.name}: ${fmtRange(start, end)}. Der Eintrag wird unwiderruflich gelöscht.`, okLabel: 'Ja, löschen', danger: true })) await run(() => api('DELETE', `/admin/bookings/${b.id}`))();
  } }, 'Löschen'));
  actions.append(h('button', { class: 'btn secondary', type: 'button', onclick: () => dlg.close() }, 'Schließen'));

  const dlg = openDialog(h('div', { id: 'booking-detail' },
    h('h2', null, b.name),
    h('p', null, statusBadge(b.status), ' ', b.source === 'manual' ? h('span', { class: 'badge manual' }, 'Manuell eingetragen') : null),
    kv([['Datum', fmtDateLong(start)], ['Uhrzeit', `${timeStr(start)} bis ${timeStr(end)} Uhr`], ['E-Mail', b.email], ['Telefon', b.phone], ['Notiz des Kunden', b.note], ['Interne Notiz', b.internalNote],
      ['Abgesagt von', b.cancelledBy === 'customer' ? 'Kunde' : b.cancelledBy === 'admin' ? 'Salon' : null]]),
    err, actions), { big: true });
}

const DURATIONS = [30, 45, 60, 90];

function bookingForm({ booking = null, preset = null, onDone, onCancel }) {
  const edit = Boolean(booking);
  const timeEditable = !edit || active(booking.status);
  const s0 = booking ? Date.parse(booking.start) : null;
  const dur0 = booking ? Math.round((Date.parse(booking.end) - s0) / 60000) : (S.settings?.durationMinutes ?? 60);
  const err = h('div', { 'aria-live': 'assertive' });
  const name = h('input', { type: 'text', maxlength: '100', required: true, value: booking?.name ?? '' });
  const email = h('input', { type: 'email', maxlength: '254', value: booking?.email ?? '' });
  const phone = h('input', { type: 'tel', maxlength: '40', value: booking?.phone ?? '' });
  const date = h('input', { type: 'date', required: true, value: s0 ? dateStr(s0) : (preset?.date ?? dateStr(Date.now())), disabled: !timeEditable });
  const time = h('input', { type: 'time', required: true, value: s0 ? timeStr(s0) : (preset?.time ?? '09:00'), disabled: !timeEditable });
  const dsel = h('select', { disabled: !timeEditable }, ...DURATIONS.map((m) => h('option', { value: String(m) }, `${m} Minuten`)), h('option', { value: 'custom' }, 'Frei (eigene Minuten)'));
  const custom = h('input', { type: 'number', min: '5', max: '720', step: '1', value: String(dur0), disabled: !timeEditable });
  dsel.value = DURATIONS.includes(dur0) ? String(dur0) : 'custom';
  const customField = field('Dauer in Minuten', custom);
  customField.hidden = dsel.value !== 'custom';
  dsel.addEventListener('change', () => { customField.hidden = dsel.value !== 'custom'; });
  const note = h('textarea', { maxlength: '1000' }); note.value = booking?.note ?? '';
  const internal = h('textarea', { maxlength: '2000' }); internal.value = booking?.internalNote ?? '';
  const notify = h('input', { type: 'checkbox', checked: true, id: uid('n') });
  const btn = h('button', { class: 'btn', type: 'submit', id: 'save-booking' }, edit ? 'Änderungen speichern' : 'Termin eintragen');

  const form = h('form', { class: edit ? '' : 'card', novalidate: true, id: 'booking-edit-form' },
    h('h2', null, edit ? 'Termin bearbeiten' : 'Neuer Termin (manuell)'),
    !timeEditable ? alertBox('info', 'Dieser Termin ist nicht mehr aktiv. Datum und Uhrzeit können nicht mehr geändert werden.') : null,
    err,
    field('Kundenname *', name),
    h('div', { class: 'row' }, field('E-Mail-Adresse', email, '(falls vorhanden)'), field('Telefonnummer', phone, '(falls vorhanden)')),
    h('div', { class: 'row3' }, field('Datum *', date), field('Startzeit *', time), field('Dauer', dsel)),
    customField,
    field('Interne Notiz', internal, '(nie für Kunden sichtbar)'),
    edit ? field('Notiz des Kunden', note) : null,
    h('div', { class: 'check field' }, notify, h('label', { for: notify.id }, edit ? 'Kunden bei Verschiebung per E-Mail informieren' : 'Kunden per E-Mail informieren (falls E-Mail-Adresse vorhanden)')),
    h('div', { class: 'actions' }, btn, onCancel ? h('button', { class: 'btn secondary', type: 'button', onclick: onCancel }, 'Abbrechen') : null));

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(err);
    const minutes = dsel.value === 'custom' ? Number(custom.value) : Number(dsel.value);
    if (name.value.trim().length < 2) return err.append(alertBox('error', 'Bitte gib den Namen des Kunden an.'));
    if (timeEditable && (!date.value || !time.value)) return err.append(alertBox('error', 'Bitte gib Datum und Startzeit an.'));
    if (timeEditable && !(Number.isInteger(minutes) && minutes >= 5 && minutes <= 720)) return err.append(alertBox('error', 'Die Dauer muss zwischen 5 und 720 Minuten liegen.'));
    const body = { name: name.value, email: email.value.trim() || null, phone: phone.value, internalNote: internal.value, notifyCustomer: notify.checked };
    if (edit) body.note = note.value;
    if (timeEditable) { body.start = `${date.value}T${time.value}`; body.durationMinutes = minutes; }
    btn.disabled = true;
    try {
      const res = edit ? await api('PATCH', `/admin/bookings/${booking.id}`, body) : await api('POST', '/admin/bookings', body);
      await onDone(res.booking);
    } catch (ex) {
      btn.disabled = false;
      if (ex.status === 401) return sessionExpired();
      err.append(alertBox('error', ex.code === 'slot_unavailable' || ex.status === 409 ? 'Dieser Zeitraum ist bereits durch einen anderen Termin belegt.' : ex.message));
    }
  });
  return form;
}

function editBooking(b, onChange) {
  const dlg = openDialog(bookingForm({ booking: b, onCancel: () => dlg.close(), onDone: async () => { dlg.close(); if (onChange) await onChange(); else await reload(); } }), { big: true });
}

function createBookingDialog(preset) {
  const dlg = openDialog(bookingForm({ preset, onCancel: () => dlg.close(), onDone: async () => { dlg.close(); await reload(); } }), { big: true });
}

// ======================================================================
// Anfragen
// ======================================================================
VIEWS.requests = async (box) => {
  const { requests } = await api('GET', '/admin/requests');
  S.requestCount = requests.length; drawTabs();
  box.append(h('h1', null, 'Offene Terminanfragen'));
  if (!requests.length) { box.append(alertBox('info', 'Keine offenen Anfragen. Neue Anfragen erscheinen hier.')); return; }
  const list = h('ul', { class: 'list', id: 'request-list' });
  for (const r of requests) {
    const s = Date.parse(r.start);
    list.append(h('li', null, h('button', { class: 'item', type: 'button', 'data-id': r.id, onclick: () => showBooking(r) },
      h('span', null, h('span', { class: 'name' }, r.name), h('br'), h('span', { class: 'when' }, `${fmtDateShort(s)} · ${timeStr(s)} Uhr`)),
      statusBadge('requested'))));
  }
  box.append(list);
};

// ======================================================================
// Kalender
// ======================================================================
function calRange() {
  if (CAL.mode === 'month') { const f = startOfWeek(monthFirst(CAL.date)); return [f, addDays(f, 41)]; }
  if (CAL.mode === 'week') { const f = startOfWeek(CAL.date); return [f, addDays(f, 6)]; }
  return [CAL.date, CAL.date];
}

VIEWS.calendar = async (box) => {
  const [from, to] = calRange();
  const data = await api('GET', `/admin/calendar?from=${from}&to=${to}${CAL.history ? '&history=1' : ''}`);
  const today = dateStr(Date.now());
  const step = (dir) => {
    if (CAL.mode === 'month') CAL.date = addMonths(CAL.date, dir);
    else CAL.date = addDays(CAL.date, (CAL.mode === 'week' ? 7 : 1) * dir);
    show('calendar');
  };
  const title = CAL.mode === 'month' ? monthTitle(CAL.date)
    : CAL.mode === 'week' ? `${fmtDateStrDm(from)} – ${fmtDateStrDm(to)} ${to.slice(0, 4)}` : fmtDateStrLong(CAL.date);
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Ansicht' },
    ...[['month', 'Monat'], ['week', 'Woche'], ['day', 'Tag']].map(([m, l]) => h('button', { type: 'button', 'data-mode': m, 'aria-pressed': String(CAL.mode === m), onclick: () => { CAL.mode = m; show('calendar'); } }, l)));
  const hist = h('input', { type: 'checkbox', id: 'hist', checked: CAL.history });
  hist.addEventListener('change', () => { CAL.history = hist.checked; show('calendar'); });
  box.append(
    h('div', { class: 'admin-cal-head' }, seg,
      h('div', { class: 'nav-btns' },
        h('button', { class: 'btn secondary', type: 'button', 'aria-label': 'Zurück', id: 'cal-prev', onclick: () => step(-1) }, '‹'),
        h('button', { class: 'btn secondary', type: 'button', id: 'cal-today', onclick: () => { CAL.date = today; show('calendar'); } }, 'Heute'),
        h('button', { class: 'btn secondary', type: 'button', 'aria-label': 'Weiter', id: 'cal-next', onclick: () => step(1) }, '›')),
      h('strong', { id: 'cal-title' }, title),
      h('span', { class: 'check' }, hist, h('label', { for: 'hist' }, 'Historie')),
      h('button', { class: 'btn small', type: 'button', id: 'cal-new', onclick: () => createBookingDialog({ date: CAL.mode === 'day' ? CAL.date : today }) }, '+ Termin')),
    h('div', { class: 'legend' },
      h('span', null, h('i', { class: 'lg-y' }), 'Offen'), h('span', null, h('i', { class: 'lg-g' }), 'Bestätigt'), h('span', null, h('i', { class: 'lg-r' }), 'Abgesagt'), h('span', null, h('i', { class: 'lg-b' }), 'Gesperrt')));
  if (CAL.mode === 'month') box.append(monthView(from, data, today));
  else box.append(timeGrid(CAL.mode === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(from, i)) : [CAL.date], data, today));
};

const eventsOnDay = (date, items) => { const [ds, de] = dayRangeMs(date); return items.filter((i) => Date.parse(i.start) < de && Date.parse(i.end) > ds); };

function monthView(from, data, today) {
  const grid = h('div', { class: 'grid-month', id: 'month-grid' });
  for (const w of WEEKDAYS) grid.append(h('div', { class: 'dow' }, w));
  const month = CAL.date.slice(0, 7);
  for (let i = 0; i < 42; i++) {
    const d = addDays(from, i);
    if (i >= 35 && d.slice(0, 7) !== month) break;
    const cell = h('div', { class: `mcell${d.slice(0, 7) !== month ? ' other' : ''}${d === today ? ' today' : ''}`, role: 'button', tabindex: '0', 'data-date': d, 'aria-label': fmtDateStrLong(d), onclick: () => { CAL.mode = 'day'; CAL.date = d; show('calendar'); }, onkeydown: (e) => { if (e.key === 'Enter') { CAL.mode = 'day'; CAL.date = d; show('calendar'); } } },
      h('span', { class: 'dn' }, dayNumber(d)));
    const blocks = eventsOnDay(d, data.blocks);
    if (blocks.length) cell.append(h('span', { class: 'ev block' }, 'Gesperrt'));
    const evs = eventsOnDay(d, data.bookings);
    for (const b of evs.slice(0, 3)) {
      cell.append(h('button', { class: `ev ${b.status}`, type: 'button', 'data-id': b.id, onclick: (e) => { e.stopPropagation(); showBooking(b); } }, `${timeStr(Date.parse(b.start))} ${b.name}`));
    }
    if (evs.length > 3) cell.append(h('span', { class: 'more' }, `+ ${evs.length - 3} weitere`));
    grid.append(cell);
  }
  return grid;
}

function timeGrid(days, data, today) {
  const wrap = h('div', { class: 'tgrid-scroll', id: 'time-grid' });
  const grid = h('div', { class: `tgrid${days.length === 1 ? ' single' : ''}` });
  grid.style.gridTemplateColumns = `52px repeat(${days.length}, minmax(${days.length > 1 ? 120 : 0}px, 1fr))`;
  grid.append(h('div', { class: 'hdr corner' }));
  for (const d of days) {
    grid.append(h('button', { class: `hdr${d === today ? ' today' : ''}`, type: 'button', 'data-date': d, onclick: () => { CAL.mode = 'day'; CAL.date = d; show('calendar'); } },
      `${WEEKDAYS[dow(d)]} ${dayNumber(d)}.`));
  }
  const hours = h('div', { class: 'hours' });
  for (let hr = 1; hr < 24; hr++) { const sp = h('span', null, `${pad(hr)}:00`); sp.style.top = `${hr * HOUR_PX}px`; hours.append(sp); }
  grid.append(hours);
  for (const d of days) {
    const col = h('div', { class: 'col', 'data-date': d });
    col.addEventListener('click', (e) => {
      if (e.target !== col) return;
      const min = Math.floor(e.offsetY / MIN_PX / 15) * 15;
      createBookingDialog({ date: d, time: `${pad(Math.floor(min / 60))}:${pad(min % 60)}` });
    });
    const [ds, de] = dayRangeMs(d);
    const clip = (i) => { const s = Date.parse(i.start); const e = Date.parse(i.end); const a = s <= ds ? 0 : wallMinutes(s); let b = e >= de ? 1440 : wallMinutes(e); b = Math.max(b, a + 20); return { ...i, a, b }; };
    for (const bl of eventsOnDay(d, data.blocks).map(clip)) {
      const el = h('div', { class: 'evt ev block', title: bl.reason ? `Gesperrt: ${bl.reason}` : 'Gesperrt' }, h('b', null, 'Gesperrt'), bl.reason ?? '');
      el.style.top = `${bl.a * MIN_PX}px`; el.style.height = `${(bl.b - bl.a) * MIN_PX}px`; el.style.left = '0'; el.style.width = '100%'; el.style.pointerEvents = 'none'; el.style.opacity = '.75';
      col.append(el);
    }
    const evs = eventsOnDay(d, data.bookings).map(clip).sort((x, y) => x.a - y.a);
    const lanes = [];
    for (const ev of evs) { let l = lanes.findIndex((end) => end <= ev.a); if (l < 0) { l = lanes.length; lanes.push(0); } lanes[l] = ev.b; ev.lane = l; }
    for (const ev of evs) {
      const s = Date.parse(ev.start); const e = Date.parse(ev.end);
      const el = h('button', { class: `evt ev ${ev.status}`, type: 'button', 'data-id': ev.id, title: `${ev.name}, ${timeStr(s)}–${timeStr(e)}`, onclick: (x) => { x.stopPropagation(); showBooking(ev); } },
        h('b', null, `${timeStr(s)} ${ev.name}`), ev.b - ev.a >= 45 ? STATUS_LABEL[ev.status] : '');
      el.style.top = `${ev.a * MIN_PX}px`; el.style.height = `${(ev.b - ev.a) * MIN_PX - 2}px`;
      el.style.left = `${(ev.lane / lanes.length) * 100}%`; el.style.width = `${100 / lanes.length}%`;
      col.append(el);
    }
    if (d === today) { const nl = h('div', { class: 'now-line' }); nl.style.top = `${wallMinutes(Date.now()) * MIN_PX}px`; col.append(nl); }
    grid.append(col);
  }
  wrap.append(grid);
  setTimeout(() => { wrap.scrollTop = 7 * HOUR_PX - 14; }, 0);
  return wrap;
}

// ======================================================================
// Neuer Termin / Suche
// ======================================================================
VIEWS.new = async (box) => {
  box.append(bookingForm({ onDone: async (b) => {
    refreshCount();
    await show('new');
    S.content.prepend(alertBox('ok', `Termin für ${b.name} am ${fmtDateShort(Date.parse(b.start))} um ${timeStr(Date.parse(b.start))} Uhr eingetragen.`));
  } }));
};

VIEWS.search = async (box) => {
  const q = h('input', { type: 'search', id: 'search-q', placeholder: 'Name, E-Mail oder Telefonnummer', autocomplete: 'off' });
  const out = h('div', { id: 'search-results' });
  const go = async () => {
    clear(out);
    if (q.value.trim().length < 2) return out.append(alertBox('info', 'Bitte gib mindestens 2 Zeichen ein.'));
    try {
      const { customers } = await api('GET', `/admin/search?q=${encodeURIComponent(q.value.trim())}`);
      if (!customers.length) return out.append(alertBox('info', 'Kein Kunde gefunden.'));
      for (const c of customers) {
        const now = Date.now();
        const future = c.bookings.filter((b) => Date.parse(b.end) > now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
        const past = c.bookings.filter((b) => Date.parse(b.end) <= now);
        const section = (title, items) => items.length ? h('div', null, h('h3', null, title), h('ul', { class: 'list' }, items.map((b) => h('li', null, h('button', { class: 'item', type: 'button', 'data-id': b.id, onclick: () => showBooking(b, { onChange: go }) },
          h('span', null, h('span', { class: 'name' }, `${fmtDateShort(Date.parse(b.start))} · ${timeStr(Date.parse(b.start))} Uhr`)), statusBadge(b.status)))))) : null;
        out.append(h('div', { class: 'card customer' }, h('h2', null, c.name), h('p', { class: 'muted' }, [c.email, c.phone].filter(Boolean).join(' · ')), section('Zukünftige Termine', future), section('Bisherige Termine', past)));
      }
    } catch (ex) { if (ex.status === 401) return sessionExpired(); out.append(alertBox('error', ex.message)); }
  };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  box.append(h('h1', null, 'Kundensuche'), h('div', { class: 'card' }, field('Suche', q), h('button', { class: 'btn', type: 'button', id: 'search-go', onclick: go }, 'Suchen')), out);
};

// ======================================================================
// Sperrzeiten
// ======================================================================
const isWholeDays = (s, e) => dateStr(s) === dateStr(s) && timeStr(s) === '00:00' && timeStr(e) === '00:00';

VIEWS.blocks = async (box) => {
  const { blocks } = await api('GET', '/admin/blocks');
  const msg = h('div', { 'aria-live': 'polite' });
  const mode = h('select', { id: 'block-mode' }, h('option', { value: 'days' }, 'Ganze Tage (z. B. Urlaub, Krankheit)'), h('option', { value: 'range' }, 'Bestimmter Zeitraum (z. B. 11:00 bis 14:00)'));
  const today = dateStr(Date.now());
  const d1 = h('input', { type: 'date', id: 'block-d1', required: true, value: today });
  const d2 = h('input', { type: 'date', id: 'block-d2', value: today });
  const t1 = h('input', { type: 'time', id: 'block-t1', value: '09:00' });
  const t2 = h('input', { type: 'time', id: 'block-t2', value: '12:00' });
  const reason = h('input', { type: 'text', id: 'block-reason', maxlength: '200', placeholder: 'z. B. Urlaub' });
  const timeRow = h('div', { class: 'row' }, field('Von (Uhrzeit)', t1), field('Bis (Uhrzeit)', t2));
  const dateRow = h('div', { class: 'row' }, field('Von (Datum)', d1), field('Bis (Datum, inklusive)', d2));
  const sync = () => { timeRow.hidden = mode.value === 'days'; };
  mode.addEventListener('change', sync); sync();
  d1.addEventListener('change', () => { if (!d2.value || d2.value < d1.value) d2.value = d1.value; });

  const submit = async (ack) => {
    clear(msg);
    const body = mode.value === 'days'
      ? { startDate: d1.value, endDate: d2.value || d1.value, reason: reason.value, acknowledgeConflicts: ack }
      : { start: `${d1.value}T${t1.value}`, end: `${(d2.value || d1.value)}T${t2.value}`, reason: reason.value, acknowledgeConflicts: ack };
    if (!d1.value) return msg.append(alertBox('error', 'Bitte gib ein Datum an.'));
    try {
      const res = await api('POST', '/admin/blocks', body);
      await reload();
      return res;
    } catch (ex) {
      if (ex.status === 401) return sessionExpired();
      if (ex.code === 'conflicts') {
        const warn = alertBox('warn', ex.message, h('ul', null, ex.data.conflicts.map((c) => h('li', null, `${c.name}: ${fmtDateShort(Date.parse(c.start))}, ${timeStr(Date.parse(c.start))}–${timeStr(Date.parse(c.end))} Uhr (${STATUS_LABEL[c.status]})`))),
          h('button', { class: 'btn', type: 'button', id: 'block-force', onclick: () => submit(true) }, 'Trotzdem sperren (Termine bleiben bestehen)'));
        return msg.append(warn);
      }
      msg.append(alertBox('error', ex.message));
    }
  };

  box.append(h('h1', null, 'Sperrzeiten'),
    h('form', { class: 'card', id: 'block-form', onsubmit: (e) => { e.preventDefault(); submit(false); } },
      h('p', { class: 'muted' }, 'Grundsätzlich ist 24 Stunden am Tag und 7 Tage die Woche buchbar. Hier trägst du ein, wann du NICHT verfügbar bist. Bestehende Termine werden dabei nie gelöscht.'),
      field('Art der Sperre', mode), dateRow, timeRow, field('Grund (nur für dich sichtbar)', reason), msg,
      h('button', { class: 'btn', type: 'submit', id: 'block-save' }, 'Sperrzeit eintragen')),
    h('h2', null, 'Aktuelle und künftige Sperrzeiten'));
  if (!blocks.length) box.append(h('p', { class: 'muted' }, 'Keine Sperrzeiten eingetragen.'));
  const list = h('ul', { class: 'list', id: 'block-list' });
  for (const b of blocks) {
    const s = Date.parse(b.start); const e = Date.parse(b.end);
    const whole = isWholeDays(s, e);
    const label = whole ? `${fmtDateShort(s)} bis ${fmtDateShort(e - 60000)}` : `${fmtDateShort(s)}, ${timeStr(s)} bis ${dateStr(s) === dateStr(e) ? '' : `${fmtDateShort(e)}, `}${timeStr(e)} Uhr`;
    list.append(h('li', null, h('div', { class: 'item' },
      h('span', null, h('span', { class: 'name' }, label), b.reason ? h('br') : null, b.reason ? h('span', { class: 'when' }, b.reason) : null),
      h('button', { class: 'btn small danger secondary', type: 'button', 'data-id': b.id, onclick: async () => {
        if (await confirmDialog({ title: 'Sperrzeit löschen?', text: `${label} wird wieder buchbar.`, okLabel: 'Ja, löschen', danger: true })) { try { await api('DELETE', `/admin/blocks/${b.id}`); await reload(); } catch (ex) { msg.append(alertBox('error', ex.message)); } }
      } }, 'Löschen'))));
  }
  box.append(list);
};

// ======================================================================
// Einstellungen
// ======================================================================
VIEWS.settings = async (box) => {
  const { settings } = await api('GET', '/admin/settings');
  S.settings = settings;
  const msg = h('div', { 'aria-live': 'polite' });
  const dsel = h('select', { id: 'set-duration' }, ...DURATIONS.map((m) => h('option', { value: String(m) }, `${m} Minuten`)), h('option', { value: 'custom' }, 'Frei (eigene Minuten)'));
  const custom = h('input', { type: 'number', id: 'set-duration-custom', min: '5', max: '720', value: String(settings.durationMinutes) });
  dsel.value = DURATIONS.includes(settings.durationMinutes) ? String(settings.durationMinutes) : 'custom';
  const customField = field('Termindauer in Minuten (5–720)', custom);
  customField.hidden = dsel.value !== 'custom';
  dsel.addEventListener('change', () => { customField.hidden = dsel.value !== 'custom'; });
  const horizon = h('input', { type: 'number', id: 'set-horizon', min: '1', max: '365', value: String(settings.horizonDays) });
  const lead = h('input', { type: 'number', id: 'set-lead', min: '0', max: '10080', value: String(settings.minLeadMinutes) });
  const contact = h('input', { type: 'email', id: 'set-contact', value: settings.contactEmail });
  const bname = h('input', { type: 'text', id: 'set-name', maxlength: '80', value: settings.businessName });
  box.append(h('h1', null, 'Einstellungen'), h('form', { class: 'card', id: 'settings-form', onsubmit: async (e) => {
    e.preventDefault(); clear(msg);
    try {
      const res = await api('PUT', '/admin/settings', { durationMinutes: dsel.value === 'custom' ? Number(custom.value) : Number(dsel.value), horizonDays: Number(horizon.value), minLeadMinutes: Number(lead.value), contactEmail: contact.value, businessName: bname.value });
      S.settings = res.settings; msg.append(alertBox('ok', 'Einstellungen gespeichert.'));
    } catch (ex) { if (ex.status === 401) return sessionExpired(); msg.append(alertBox('error', ex.message)); }
  } },
  msg, field('Termindauer', dsel), customField,
  field('Wie viele Tage im Voraus dürfen Kunden buchen?', horizon, '(Standard: 30)'),
  field('Mindestvorlauf in Minuten', lead, '(0 = Kunden dürfen sofort buchen)'),
  field('Kontakt- und Benachrichtigungsadresse', contact, '(Antworten auf E-Mails gehen hierhin)'),
  field('Name des Salons', bname),
  h('button', { class: 'btn', type: 'submit', id: 'settings-save' }, 'Speichern')));
};

// ======================================================================
// E-Mail-Protokoll
// ======================================================================
const MAIL_KIND = {
  customer_received: 'Eingangsbestätigung an Kunde', admin_new_request: 'Neue Anfrage an Admin', customer_confirmed: 'Terminbestätigung an Kunde',
  customer_declined: 'Absage an Kunde', customer_cancel_ack: 'Absagebestätigung an Kunde', admin_customer_cancelled: 'Kundenabsage an Admin',
  customer_cancelled_by_salon: 'Absage durch Salon an Kunde', customer_rescheduled: 'Verschiebung an Kunde', admin_invite: 'Einladung Admin',
};
const MAIL_STATUS = { sent: 'Gesendet', failed: 'Fehlgeschlagen', pending: 'Ausstehend' };

VIEWS.emails = async (box) => {
  const filter = box.dataset.filter ?? 'all';
  const { emails } = await api('GET', `/admin/emails?status=${filter}`);
  const sel = h('select', { id: 'mail-filter' }, ...[['all', 'Alle'], ['failed', 'Nur fehlgeschlagene'], ['sent', 'Nur gesendete'], ['pending', 'Ausstehende']].map(([v, l]) => h('option', { value: v }, l)));
  sel.value = filter;
  sel.addEventListener('change', () => { VIEWS.emails.filter = sel.value; box.dataset.filter = sel.value; clear(box); VIEWS.emails(box).catch((e) => box.append(alertBox('error', e.message))); });
  const msg = h('div', { 'aria-live': 'polite' });
  box.append(h('h1', null, 'E-Mail-Protokoll'), h('p', { class: 'muted' }, 'Jede E-Mail wird hier festgehalten. Fehlgeschlagene kannst du erneut senden – der Termin selbst geht nie verloren.'), field('Anzeigen', sel), msg);
  if (!emails.length) { box.append(alertBox('info', 'Keine E-Mails in dieser Auswahl.')); return; }
  const tbody = h('tbody');
  for (const m of emails) {
    tbody.append(h('tr', null,
      h('td', { class: 'nowrap' }, `${fmtDateShort(Date.parse(m.createdAt))} ${timeStr(Date.parse(m.createdAt))}`),
      h('td', null, MAIL_KIND[m.kind] ?? m.kind, m.booking ? h('div', { class: 'muted small' }, m.booking.name) : null),
      h('td', null, m.to),
      h('td', null, h('span', { class: `badge ${m.status}` }, MAIL_STATUS[m.status]), m.error ? h('div', { class: 'small muted' }, m.error) : null),
      h('td', null, m.retryable ? h('button', { class: 'btn small secondary', type: 'button', 'data-id': m.id, onclick: async (e) => {
        e.target.disabled = true; clear(msg);
        try { const r = await api('POST', `/admin/emails/${m.id}/retry`, {}); msg.append(r.ok ? alertBox('ok', 'E-Mail wurde gesendet.') : alertBox('error', `Senden fehlgeschlagen: ${r.error}`)); setTimeout(() => { if (S.tab === 'emails') show('emails', true); }, 800); }
        catch (ex) { msg.append(alertBox('error', ex.message)); e.target.disabled = false; }
      } }, 'Erneut senden') : '')));
  }
  box.append(h('div', { class: 'table-wrap' }, h('table', { class: 't', id: 'mail-table' }, h('thead', null, h('tr', null, ...['Zeit', 'Art', 'Empfänger', 'Status', ''].map((x) => h('th', null, x)))), tbody)));
};

// ======================================================================
// Admins (nur Hauptadministrator)
// ======================================================================
VIEWS.admins = async (box) => {
  const { admins } = await api('GET', '/admin/admins');
  const msg = h('div', { 'aria-live': 'polite' });
  const name = h('input', { type: 'text', id: 'inv-name', maxlength: '100', required: true });
  const email = h('input', { type: 'email', id: 'inv-email', required: true });
  const showLink = (url) => msg.append(alertBox('ok', 'Einrichtungslink erstellt. Gib ihn der Person weiter (7 Tage gültig). Falls der E-Mail-Versand eingerichtet ist, wurde er auch per E-Mail verschickt.',
    h('div', { class: 'copybox', id: 'invite-url' }, url), h('button', { class: 'btn small secondary', type: 'button', onclick: async (e) => { e.target.textContent = (await copyText(url)) ? 'Kopiert ✓' : 'Bitte Link markieren und kopieren'; } }, 'Link kopieren')));
  const wrap = (fn) => async () => { clear(msg); try { await fn(); } catch (ex) { if (ex.status === 401) return sessionExpired(); msg.append(alertBox('error', ex.message)); } };

  box.append(h('h1', null, 'Administratoren'), msg);
  const list = h('ul', { class: 'list', id: 'admin-list' });
  for (const a of admins) {
    list.append(h('li', null, h('div', { class: 'card' },
      h('strong', null, a.name), ' ', h('span', { class: 'badge manual' }, a.role === 'owner' ? 'Hauptadministrator' : 'Administrator'), ' ',
      a.pendingSetup ? h('span', { class: 'badge pending' }, 'Einrichtung offen') : null, a.active ? null : h('span', { class: 'badge failed' }, 'Deaktiviert'),
      h('div', { class: 'muted' }, a.email), h('div', { class: 'small muted' }, a.lastLoginAt ? `Zuletzt angemeldet: ${fmtDateShort(Date.parse(a.lastLoginAt))} ${timeStr(Date.parse(a.lastLoginAt))}` : 'Noch nie angemeldet'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn small secondary', type: 'button', 'data-act': 'notify', onclick: wrap(async () => { await api('PATCH', `/admin/admins/${a.id}`, { notify: !a.notify }); await show('admins', true); }) }, a.notify ? 'Benachrichtigungen: an' : 'Benachrichtigungen: aus'),
        h('button', { class: 'btn small secondary', type: 'button', 'data-act': 'invite', onclick: wrap(async () => showLink((await api('POST', `/admin/admins/${a.id}/invite`, {})).inviteUrl)) }, a.pendingSetup ? 'Neuer Einrichtungslink' : 'Passwort zurücksetzen'),
        a.role !== 'owner' && a.id !== S.admin.id ? h('button', { class: `btn small ${a.active ? 'danger ' : ''}secondary`, type: 'button', 'data-act': 'toggle', onclick: wrap(async () => {
          if (a.active && !(await confirmDialog({ title: 'Konto deaktivieren?', text: `${a.name} kann sich danach nicht mehr anmelden.`, okLabel: 'Deaktivieren', danger: true }))) return;
          await api('PATCH', `/admin/admins/${a.id}`, { active: !a.active }); await show('admins', true);
        }) }, a.active ? 'Deaktivieren' : 'Aktivieren') : null))));
  }
  box.append(list, h('form', { class: 'card', id: 'invite-form', onsubmit: (e) => { e.preventDefault(); wrap(async () => { const res = await api('POST', '/admin/admins', { name: name.value, email: email.value }); showLink(res.inviteUrl); name.value = ''; email.value = ''; })(); } },
    h('h2', null, 'Neuen Administrator einladen'), field('Name', name), field('E-Mail-Adresse', email), h('button', { class: 'btn', type: 'submit', id: 'invite-send' }, 'Einladung erstellen')));
};

// ======================================================================
// Konto
// ======================================================================
VIEWS.account = async (box) => {
  const msg = h('div', { 'aria-live': 'polite' });
  const cur = h('input', { type: 'password', id: 'pw-cur', autocomplete: 'current-password', required: true });
  const n1 = h('input', { type: 'password', id: 'pw-new', autocomplete: 'new-password', required: true, minlength: '10' });
  const n2 = h('input', { type: 'password', id: 'pw-new2', autocomplete: 'new-password', required: true });
  let diag = null;
  try { diag = await api('GET', '/admin/diagnostics'); } catch (ex) { if (ex.status === 401) throw ex; }
  box.append(h('h1', null, 'Mein Konto'), h('p', null, `Angemeldet als ${S.admin.name} (${S.admin.email}), ${S.admin.role === 'owner' ? 'Hauptadministrator' : 'Administrator'}.`),
    h('form', { class: 'card', id: 'pw-form', onsubmit: async (e) => {
      e.preventDefault(); clear(msg);
      if (n1.value !== n2.value) return msg.append(alertBox('error', 'Die neuen Passwörter sind nicht gleich.'));
      try { await api('POST', '/admin/password', { currentPassword: cur.value, newPassword: n1.value }); cur.value = n1.value = n2.value = ''; msg.append(alertBox('ok', 'Passwort geändert. Andere Geräte wurden abgemeldet.')); }
      catch (ex) { if (ex.status === 401) return sessionExpired(); msg.append(alertBox('error', ex.message)); }
    } }, h('h2', null, 'Passwort ändern'), msg, field('Aktuelles Passwort', cur), field('Neues Passwort', n1, '(mindestens 10 Zeichen)'), field('Neues Passwort wiederholen', n2), h('button', { class: 'btn', type: 'submit', id: 'pw-save' }, 'Passwort ändern')));
  if (diag) {
    box.append(h('div', { class: 'card soft', id: 'diagnostics' }, h('h2', null, 'Systemstatus'),
      alertBox(diag.database ? 'ok' : 'error', diag.database ? 'Datenbank: verbunden' : 'Datenbank: NICHT erreichbar'),
      alertBox(diag.mailConfigured ? 'ok' : 'warn', diag.mailConfigured ? `E-Mail-Versand: eingerichtet (Absender: ${diag.mailFrom})` : 'E-Mail-Versand: nicht eingerichtet (Resend-Schlüssel fehlt in Netlify). Buchungen funktionieren trotzdem.'),
      diag.usingResendTestSender ? alertBox('warn', 'Es wird noch die Resend-Testadresse als Absender genutzt. Damit kommen E-Mails nur bei dir selbst an, nicht bei Kunden. Dafür braucht es eine eigene, bestätigte Domain.') : null,
      diag.siteUrlConfigured ? null : alertBox('warn', 'SITE_URL ist nicht gesetzt. Links in E-Mails verwenden dann die aktuelle Adresse.')));
  }
  box.append(h('button', { class: 'btn secondary', type: 'button', onclick: logout }, 'Abmelden'));
};

boot();
