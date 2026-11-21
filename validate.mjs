// Serverseitige Eingabeprüfung. Alle Funktionen liefern { value } oder { error }.

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g;

export function cleanLine(s) {
  return String(s ?? '').replace(CONTROL, '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function cleanText(s) {
  return String(s ?? '').replace(CONTROL, '').replace(/\r\n?/g, '\n').trim();
}

export function validateName(v, { requireFullName = false } = {}) {
  if (typeof v !== 'string') return { error: 'Bitte gib deinen Namen an.' };
  const value = cleanLine(v);
  if (value.length < 2) return { error: 'Bitte gib deinen Namen an.' };
  if (value.length > 100) return { error: 'Der Name ist zu lang (höchstens 100 Zeichen).' };
  if (requireFullName && value.split(' ').filter(Boolean).length < 2) {
    return { error: 'Bitte gib Vor- und Nachnamen an.' };
  }
  return { value };
}

const EMAIL_RE = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\.]{2,}$/;

export function validateEmail(v, { required = true } = {}) {
  const raw = typeof v === 'string' ? v.trim() : '';
  if (!raw) return required ? { error: 'Bitte gib deine E-Mail-Adresse an.' } : { value: null };
  if (raw.length > 254 || /[\r\n]/.test(raw) || !EMAIL_RE.test(raw)) {
    return { error: 'Bitte gib eine gültige E-Mail-Adresse an.' };
  }
  const domain = raw.split('@')[1];
  if (domain.includes('..') || domain.startsWith('.') || domain.startsWith('-')) {
    return { error: 'Bitte gib eine gültige E-Mail-Adresse an.' };
  }
  return { value: raw.toLowerCase() };
}

export function validatePhone(v) {
  const raw = typeof v === 'string' ? cleanLine(v) : '';
  if (!raw) return { value: null };
  if (raw.length > 40 || !/^[0-9+()\-/. ]{5,40}$/.test(raw) || raw.replace(/\D/g, '').length < 5) {
    return { error: 'Bitte gib eine gültige Telefonnummer an (oder lass das Feld leer).' };
  }
  return { value: raw };
}

export function validateNote(v, max = 1000, label = 'Die Notiz') {
  const raw = typeof v === 'string' ? cleanText(v) : '';
  if (!raw) return { value: null };
  if (raw.length > max) return { error: `${label} ist zu lang (höchstens ${max} Zeichen).` };
  return { value: raw };
}

export function validatePassword(pw, email = '') {
  if (typeof pw !== 'string' || pw.length < 10) return { error: 'Das Passwort muss mindestens 10 Zeichen lang sein.' };
  if (pw.length > 200) return { error: 'Das Passwort ist zu lang.' };
  if (email && pw.toLowerCase() === email.toLowerCase()) return { error: 'Das Passwort darf nicht deine E-Mail-Adresse sein.' };
  if (/^(.)\1+$/.test(pw)) return { error: 'Bitte wähle ein sichereres Passwort.' };
  return { value: pw };
}

export function validateInt(v, { min, max, label }) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    return { error: `${label} muss eine ganze Zahl zwischen ${min} und ${max} sein.` };
  }
  return { value: n };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

/** Token aus Links / Einladungen: nur URL-sichere Zeichen. */
export function isTokenShape(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(v); }
