// Kryptografie-Hilfen (nur Node-Bordmittel, keine Pakete).

import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';

export function sha256Hex(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function newId() { return randomUUID(); }

/**
 * Persönlicher Termin-Link-Token. Er wird aus dem geheimen APP_SECRET, der
 * Termin-ID und einem zufälligen Salt abgeleitet. In der Datenbank steht NUR
 * der SHA-256-Hash dieses Tokens (und der Salt); ohne APP_SECRET lässt sich
 * der Token daraus nicht rekonstruieren. So bleibt jeder Link in jeder
 * E-Mail identisch und gültig, ohne dass der Token selbst gespeichert wird.
 */
export function deriveBookingToken(secret, bookingId, salt) {
  return createHmac('sha256', secret).update(`booking:${bookingId}:${salt}`).digest('base64url');
}

export function newBookingCredentials(secret, bookingId) {
  const salt = randomBytes(16).toString('hex');
  const token = deriveBookingToken(secret, bookingId, salt);
  return { salt, token, hash: sha256Hex(token) };
}

/** HMAC für Rate-Limit-Schlüssel (IP-Adressen werden nie im Klartext gespeichert). */
export function hmacKey(secret, value) {
  return createHmac('sha256', secret).update(String(value)).digest('hex').slice(0, 32);
}

// --- Passwörter: scrypt -------------------------------------------------
const N = 16384, R = 8, P = 1, KEYLEN = 64;

function scryptAsync(password, salt, n, r, p, keylen) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [alg, n, r, p, saltB64, keyB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p), expected.length);
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Dummy-Prüfung, damit "Konto unbekannt" genauso lange dauert wie "Passwort falsch". */
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}
