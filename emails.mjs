// E-Mail-Vorlagen (HTML + Text). Alle eingefügten Werte werden maskiert.

import { formatDateDe, formatTimeDe } from './time.mjs';

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const ACCENT = '#2f6f6a';

function layout({ business, title, intro, rows = [], button, outro, footer }) {
  const rowHtml = rows.map(([k, v]) => `
        <tr>
          <td style="padding:8px 0;color:#6b7280;font-size:14px;width:110px;vertical-align:top">${esc(k)}</td>
          <td style="padding:8px 0;color:#1f2933;font-size:16px;font-weight:600">${esc(v)}</td>
        </tr>`).join('');
  const buttonHtml = button ? `
      <p style="margin:28px 0 8px">
        <a href="${esc(button.url)}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;padding:14px 26px;border-radius:10px;font-size:16px;font-weight:600">${esc(button.label)}</a>
      </p>` : '';
  const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f4">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f4;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
        <tr><td style="background:${ACCENT};padding:18px 28px;color:#ffffff;font-size:18px;font-weight:700">${esc(business)}</td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 14px;font-size:22px;color:#1f2933">${esc(title)}</h1>
          <p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:#374151">${esc(intro)}</p>
          ${rows.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;margin:8px 0">${rowHtml}</table>` : ''}
          ${buttonHtml}
          ${outro ? `<p style="margin:20px 0 0;font-size:15px;line-height:1.55;color:#374151">${esc(outro)}</p>` : ''}
        </td></tr>
        <tr><td style="padding:16px 28px 24px;font-size:12px;line-height:1.5;color:#9ca3af">${esc(footer)}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const text = [
    business, '', title, '', intro, '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(button ? ['', `${button.label}: ${button.url}`] : []),
    ...(outro ? ['', outro] : []),
    '', footer,
  ].join('\n');
  return { html, text };
}

/**
 * @param {string} kind
 * @param {{booking:object, settings:object, siteUrl:string, manageUrl?:string, inviteUrl?:string, inviteName?:string}} ctx
 */
export function buildEmail(kind, ctx) {
  const { booking: b, settings, siteUrl } = ctx;
  const business = settings?.business_name || 'Kellerfriseur';
  const footer = `Diese E-Mail wurde automatisch von ${business} versendet. Bei Fragen antworte einfach auf diese Nachricht.`;
  const start = b ? new Date(b.start_at).getTime() : 0;
  const end = b ? new Date(b.end_at).getTime() : 0;
  const when = b ? [['Datum', formatDateDe(start)], ['Uhrzeit', `${formatTimeDe(start)} bis ${formatTimeDe(end)} Uhr`]] : [];
  const manageButton = ctx.manageUrl ? { label: 'Meinen Termin verwalten', url: ctx.manageUrl } : undefined;
  const adminUrl = `${siteUrl}/admin/`;
  const first = b ? String(b.customer_name).split(' ')[0] : '';

  let subject; let parts;
  switch (kind) {
    case 'customer_received':
      subject = 'Deine Terminanfrage ist eingegangen';
      parts = { title: 'Deine Terminanfrage ist eingegangen', intro: `Hallo ${first}, vielen Dank für deine Anfrage. Der Zeitraum ist für dich vorgemerkt. Du erhältst eine weitere E-Mail, sobald dein Termin bearbeitet wurde.`, rows: when, button: manageButton, outro: 'Über den Button kannst du deine Anfrage jederzeit einsehen oder zurückziehen.' };
      break;
    case 'admin_new_request':
      subject = `Neue Terminanfrage: ${b.customer_name}`;
      parts = { title: 'Neue Terminanfrage', intro: 'Es ist eine neue Terminanfrage eingegangen.', rows: [['Kunde', b.customer_name], ...when], button: { label: 'Zum Adminbereich', url: adminUrl } };
      break;
    case 'customer_confirmed':
      subject = 'Dein Termin ist bestätigt';
      parts = { title: 'Dein Termin ist bestätigt', intro: `Hallo ${first}, dein Termin wurde bestätigt. Wir freuen uns auf dich!`, rows: when, button: manageButton, outro: 'Falls du den Termin nicht wahrnehmen kannst, sag ihn bitte über den Button ab.' };
      break;
    case 'customer_declined':
      subject = 'Zu deiner Terminanfrage';
      parts = { title: 'Dein Wunschtermin ist leider nicht möglich', intro: `Hallo ${first}, leider können wir deinen angefragten Termin nicht bestätigen. Das tut uns leid. Bitte wähle gern einen anderen Zeitpunkt.`, rows: when, button: { label: 'Neuen Termin anfragen', url: siteUrl } };
      break;
    case 'customer_cancel_ack': {
      const withdrawn = b.status === 'withdrawn';
      subject = withdrawn ? 'Du hast deine Terminanfrage zurückgezogen' : 'Dein Termin wurde abgesagt';
      parts = { title: withdrawn ? 'Anfrage zurückgezogen' : 'Termin abgesagt', intro: `Hallo ${first}, ${withdrawn ? 'deine Terminanfrage wurde zurückgezogen' : 'dein Termin wurde abgesagt'}. Der Zeitraum ist wieder frei.`, rows: when, button: { label: 'Neuen Termin anfragen', url: siteUrl } };
      break;
    }
    case 'admin_customer_cancelled': {
      const withdrawn = b.status === 'withdrawn';
      subject = `${withdrawn ? 'Anfrage zurückgezogen' : 'Termin abgesagt'}: ${b.customer_name}`;
      parts = { title: withdrawn ? 'Kunde hat die Anfrage zurückgezogen' : 'Kunde hat den Termin abgesagt', intro: 'Der Zeitraum ist wieder frei.', rows: [['Kunde', b.customer_name], ...when], button: { label: 'Zum Adminbereich', url: adminUrl } };
      break;
    }
    case 'customer_cancelled_by_salon':
      subject = 'Dein Termin wurde abgesagt';
      parts = { title: 'Dein Termin wurde leider abgesagt', intro: `Hallo ${first}, wir müssen deinen Termin leider absagen. Das tut uns leid. Bitte wähle gern einen neuen Zeitpunkt.`, rows: when, button: { label: 'Neuen Termin anfragen', url: siteUrl } };
      break;
    case 'customer_rescheduled':
      subject = 'Dein Termin wurde geändert';
      parts = { title: 'Dein Termin wurde geändert', intro: `Hallo ${first}, dein Termin wurde verschoben. Hier sind die neuen Angaben:`, rows: when, button: manageButton, outro: 'Falls die neue Zeit nicht passt, sag den Termin bitte über den Button ab.' };
      break;
    case 'admin_invite':
      subject = `Einladung zum Adminbereich von ${business}`;
      parts = { title: 'Du wurdest als Administrator eingeladen', intro: `Hallo ${ctx.inviteName || ''}, du kannst jetzt den Adminbereich von ${business} nutzen. Lege über den Button dein Passwort fest. Der Link ist 7 Tage gültig.`.replace('Hallo ,', 'Hallo,'), button: { label: 'Passwort festlegen', url: ctx.inviteUrl } };
      break;
    default:
      throw new Error(`Unbekannte E-Mail-Art: ${kind}`);
  }
  const { html, text } = layout({ business, footer, ...parts });
  return { subject, html, text };
}

/** Welche Empfänger-Art gehört zu welcher Vorlage (für Wiederholung/Protokoll). */
export const CUSTOMER_KINDS = new Set(['customer_received', 'customer_confirmed', 'customer_declined', 'customer_cancel_ack', 'customer_cancelled_by_salon', 'customer_rescheduled']);
export const KINDS_WITH_MANAGE_LINK = new Set(['customer_received', 'customer_confirmed', 'customer_rescheduled']);
