// Minimaler Supabase/PostgREST-Client ohne Abhängigkeiten.
// Der geheime Schlüssel wird NUR hier (serverseitig) verwendet.

export class DbError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'DbError';
    this.code = code;
    this.status = status;
  }
}

export function createDb({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  const base = String(url).replace(/\/+$/, '');

  // Neue Schlüssel (sb_secret_...) sind keine JWTs und gehören NUR in den apikey-Header.
  // Alte service_role-Schlüssel (JWT) werden zusätzlich als Bearer gesendet.
  const headers = { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json' };
  if (!String(key).startsWith('sb_')) headers.Authorization = `Bearer ${key}`;

  async function request(method, path, { query, body, prefer } = {}) {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${base}/rest/v1/${path}${qs}`, {
        method,
        headers: prefer ? { ...headers, Prefer: prefer } : headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new DbError('db_unreachable', err?.name === 'AbortError' ? 'Zeitüberschreitung bei der Datenbank' : 'Datenbank nicht erreichbar', 503);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!res.ok) {
      throw new DbError(data?.code ?? `http_${res.status}`, String(data?.message ?? `Datenbankfehler (${res.status})`).slice(0, 300), res.status);
    }
    return data;
  }

  return {
    rpc: (name, args = {}) => request('POST', `rpc/${name}`, { body: args }),

    /** filters: { spalte: 'eq.wert' | 'is.null' | 'in.(a,b)' | ... } */
    async select(table, { select = '*', filters = {}, order, limit } = {}) {
      const query = { select, ...filters };
      if (order) query.order = order;
      if (limit) query.limit = String(limit);
      return (await request('GET', table, { query })) ?? [];
    },

    async insert(table, row) {
      const out = await request('POST', table, { body: row, prefer: 'return=representation' });
      return out ?? [];
    },

    async update(table, filters, patch) {
      const out = await request('PATCH', table, { query: filters, body: patch, prefer: 'return=representation' });
      return out ?? [];
    },

    async remove(table, filters) {
      const out = await request('DELETE', table, { query: filters, prefer: 'return=representation' });
      return out ?? [];
    },
  };
}
