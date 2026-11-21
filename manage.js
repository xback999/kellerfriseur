// Persönliche Terminverwaltung des Kunden (Link: /termin#TOKEN). Kein Konto, kein Passwort.

import { alertBox, api, clear, confirmDialog, fmtRange, h, statusBadge } from './common.js';

const app = document.getElementById('app');
const token = decodeURIComponent(location.hash.replace(/^#/, ''));
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

const STATUS_TEXT = {
  requested: 'Deine Anfrage ist eingegangen. Du bekommst Bescheid, sobald sie bearbeitet wurde.',
  confirmed: 'Dein Termin ist bestätigt. Wir freuen uns auf dich!',
  declined: 'Leider konnten wir deinen Wunschtermin nicht bestätigen. Bitte wähle gern einen anderen Zeitpunkt.',
  withdrawn: 'Du hast diese Anfrage zurückgezogen.',
  cancelled: 'Dieser Termin wurde abgesagt.',
};

function invalid(msg = 'Dieser Link ist ungültig.') {
  clear(app).append(alertBox('error', msg), h('p', null, h('a', { href: '/' }, 'Zur Terminbuchung')));
}

function render(view, flash) {
  clear(app);
  const start = Date.parse(view.start); const end = Date.parse(view.end);
  const past = start <= Date.now();
  const active = view.status === 'requested' || view.status === 'confirmed';
  const card = h('div', { class: 'card', id: 'booking-card' },
    h('p', null, statusBadge(view.status)),
    h('h2', null, `Hallo ${view.name.split(' ')[0]}`),
    h('div', { class: 'summary', id: 'when' }, fmtRange(start, end)),
    h('p', { id: 'status-text' }, active && past ? 'Dieser Termin liegt in der Vergangenheit.' : STATUS_TEXT[view.status] ?? ''));
  if (view.canCancel) {
    const label = view.action === 'withdraw' ? 'Anfrage zurückziehen' : 'Termin absagen';
    card.append(h('button', { class: 'btn danger secondary block', type: 'button', id: 'cancel-btn', onclick: () => cancel(view) }, label));
  }
  if (flash) app.append(alertBox('ok', flash));
  app.append(card, h('p', null, h('a', { href: '/' }, 'Neuen Termin anfragen')));
}

async function cancel(view) {
  const withdraw = view.action === 'withdraw';
  const ok = await confirmDialog({
    title: withdraw ? 'Anfrage wirklich zurückziehen?' : 'Termin wirklich absagen?',
    text: withdraw ? 'Deine Anfrage wird zurückgezogen und der Zeitraum wieder freigegeben.' : 'Dein Termin wird abgesagt und der Zeitraum sofort wieder freigegeben. Das kann nicht rückgängig gemacht werden.',
    okLabel: withdraw ? 'Ja, zurückziehen' : 'Ja, absagen', cancelLabel: 'Zurück', danger: true,
  });
  if (!ok) return;
  try {
    const res = await api('POST', '/manage/cancel', { confirm: true }, { token });
    render(res, withdraw ? 'Deine Anfrage wurde zurückgezogen.' : 'Dein Termin wurde abgesagt. Der Zeitraum ist wieder frei.');
  } catch (err) {
    app.prepend(alertBox('error', err.message));
    try { render(await api('GET', '/manage', undefined, { token })); } catch { /* Meldung bleibt */ }
  }
}

async function init() {
  if (!TOKEN_RE.test(token)) return invalid();
  try { render(await api('GET', '/manage', undefined, { token })); } catch (err) {
    if (err.status === 404) invalid();
    else clear(app).append(alertBox('error', err.message), h('button', { class: 'btn secondary', type: 'button', onclick: init }, 'Erneut versuchen'));
  }
}
init();
