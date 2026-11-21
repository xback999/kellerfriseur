// Ein kleiner Nachbau der Supabase-REST-Schnittstelle (PostgREST) für Tests.
// Er übersetzt die wenigen vom Projekt genutzten Aufrufe in echtes SQL gegen
// eine echte PostgreSQL-Testdatenbank – als Rolle "service_role", genau wie der
// echte Server-Schlüssel. So laufen die echten SQL-Funktionen und Constraints.
//
// WICHTIG: Das ist ein Nachbau. Echte HTTP-Details von Supabase (Header,
// Fehlerformat) prüft erst der Live-Test mit deinem Projekt.

import http from 'node:http';
import { sql } from './pg.mjs';

const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Ungültiger Bezeichner: ${s}`);
  return s;
};
const table = (s) => {
  if (!/^kf_[a-z_]+$/.test(s)) throw new Error(`Ungültige Tabelle: ${s}`);
  return s;
};

function whereClause(searchParams) {
  const parts = [];
  for (const [key, val] of searchParams) {
    if (['select', 'order', 'limit'].includes(key)) continue;
    const dot = val.indexOf('.');
    const op = val.slice(0, dot);
    const arg = val.slice(dot + 1);
    const col = ident(key);
    switch (op) {
      case 'eq': parts.push(`${col} = ${lit(arg)}`); break;
      case 'neq': parts.push(`${col} <> ${lit(arg)}`); break;
      case 'gt': parts.push(`${col} > ${lit(arg)}`); break;
      case 'gte': parts.push(`${col} >= ${lit(arg)}`); break;
      case 'lt': parts.push(`${col} < ${lit(arg)}`); break;
      case 'lte': parts.push(`${col} <= ${lit(arg)}`); break;
      case 'is': parts.push(`${col} is ${arg === 'null' ? 'null' : arg === 'true' ? 'true' : 'false'}`); break;
      case 'in': {
        const items = arg.replace(/^\(|\)$/g, '').split(',').map((x) => lit(x));
        parts.push(`${col} in (${items.join(',')})`);
        break;
      }
      default: throw new Error(`Nicht unterstützter Filter: ${op}`);
    }
  }
  return parts.length ? ` where ${parts.join(' and ')}` : '';
}

export async function startFakeSupabase({ db, expectKey = 'test-service-key' }) {
  const procCache = new Map();
  const requests = [];

  async function procInfo(fn) {
    if (procCache.has(fn)) return procCache.get(fn);
    const out = await sql(db, `select proretset, prorettype::regtype::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname=${lit(fn)} limit 1`, { role: null });
    if (!out) { procCache.set(fn, null); return null; }
    const [set, type] = out.split('|');
    const info = { set: set === 't', type };
    procCache.set(fn, info);
    return info;
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: url.pathname, apikey: req.headers.apikey, authorization: req.headers.authorization });
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    try {
      if (req.headers.apikey !== expectKey) return send(401, { message: 'Invalid API key', code: 'PGRST301' });
      const m = /^\/rest\/v1\/(rpc\/)?([a-z_]+)$/.exec(url.pathname);
      if (!m) return send(404, { message: 'not found' });
      const body = raw ? JSON.parse(raw) : undefined;

      if (m[1]) {
        const fn = ident(m[2]);
        const info = await procInfo(fn);
        if (!info) return send(404, { code: 'PGRST202', message: `Could not find the function public.${fn}` });
        const args = Object.entries(body ?? {}).map(([k, v]) => `${ident(k)} := ${lit(v)}`).join(', ');
        const call = `public.${fn}(${args})`;
        let q;
        if (info.set) q = `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from ${call} t`;
        else if (info.type === 'void') q = `select ${call}`;
        else q = `select to_jsonb(${call})`;
        const out = await sql(db, q);
        if (info.type === 'void') return send(204);
        return send(200, out === '' ? null : JSON.parse(out));
      }

      const t = table(m[2]);
      const sp = url.searchParams;
      if (req.method === 'GET') {
        const cols = (sp.get('select') ?? '*').split(',').map((c) => (c === '*' ? '*' : ident(c))).join(', ');
        let q = `select ${cols} from public.${t}${whereClause(sp)}`;
        if (sp.get('order')) {
          q += ` order by ${sp.get('order').split(',').map((o) => { const [c, d] = o.split('.'); return `${ident(c)} ${d === 'desc' ? 'desc' : 'asc'}`; }).join(', ')}`;
        }
        if (sp.get('limit')) q += ` limit ${parseInt(sp.get('limit'), 10)}`;
        const out = await sql(db, `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (${q}) x`);
        return send(200, JSON.parse(out));
      }
      if (req.method === 'POST') {
        const rows = Array.isArray(body) ? body : [body];
        const cols = Object.keys(rows[0]).map(ident);
        const values = rows.map((r) => `(${cols.map((c) => lit(r[c])).join(', ')})`).join(', ');
        const out = await sql(db, `with ins as (insert into public.${t} (${cols.join(', ')}) values ${values} returning *) select coalesce(jsonb_agg(to_jsonb(ins)), '[]'::jsonb) from ins`);
        return send(201, JSON.parse(out));
      }
      if (req.method === 'PATCH' || req.method === 'DELETE') {
        const where = whereClause(sp);
        if (!where) return send(400, { code: 'PGRST106', message: 'Filter erforderlich' });
        const stmt = req.method === 'PATCH'
          ? `update public.${t} set ${Object.entries(body).map(([c, v]) => `${ident(c)} = ${lit(v)}`).join(', ')}${where} returning *`
          : `delete from public.${t}${where} returning *`;
        const out = await sql(db, `with ch as (${stmt}) select coalesce(jsonb_agg(to_jsonb(ch)), '[]'::jsonb) from ch`);
        return send(200, JSON.parse(out));
      }
      return send(405, { message: 'method not allowed' });
    } catch (err) {
      const code = err.code ?? 'XX000';
      const status = code === '23505' || code === '23P01' ? 409 : code === '42501' ? 403 : 400;
      return send(status, { code, message: err.message?.split('\n')[0] ?? String(err), details: null, hint: null });
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}
