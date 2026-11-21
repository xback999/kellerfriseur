// E-Mail-Versand über die Resend-REST-API (ohne Paket).

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export function createMailer({ apiKey, from, fetchImpl = globalThis.fetch, sleep = sleepDefault, timeoutMs = 6000 }) {
  async function send({ to, subject, html, text, replyTo, idempotencyKey }) {
    if (!apiKey) return { ok: false, error: 'RESEND_API_KEY ist nicht gesetzt.' };

    let lastError = 'Unbekannter Fehler';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(700 * attempt);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from,
            to: [to],
            subject,
            html,
            text,
            ...(replyTo ? { reply_to: replyTo } : {}),
          }),
          signal: ctrl.signal,
        });
        const raw = await res.text();
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
        if (res.ok) return { ok: true, id: data?.id ?? null };
        lastError = `Resend ${res.status}: ${String(data?.message ?? raw ?? '').slice(0, 250)}`;
        // Nur bei Überlastung/Serverfehlern erneut versuchen, nicht bei 4xx wie 403/422.
        if (res.status !== 429 && res.status < 500) return { ok: false, error: lastError };
      } catch (err) {
        lastError = err?.name === 'AbortError' ? 'Zeitüberschreitung beim E-Mail-Versand' : 'E-Mail-Dienst nicht erreichbar';
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, error: lastError };
  }

  return { send, from, configured: Boolean(apiKey) };
}
