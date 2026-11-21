// Test-Hilfen für eine ECHTE lokale PostgreSQL-Datenbank (nur für Tests).
// Konfiguration über Umgebungsvariablen (Standardwerte passen zur Testumgebung):
//   KF_TEST_PGHOST, KF_TEST_PGPORT, KF_TEST_PGUSER
// Ist keine Datenbank erreichbar, werden die zugehörigen Tests übersprungen.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATION = join(HERE, '..', '..', 'supabase', 'migrations', '001_kellerfriseur.sql');

const HOST = process.env.KF_TEST_PGHOST ?? '127.0.0.1';
const PORT = process.env.KF_TEST_PGPORT ?? '54329';
const USER = process.env.KF_TEST_PGUSER ?? 'pgu';

const base = (db) => ['-h', HOST, '-p', PORT, '-U', USER, '-d', db, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'];

export function pgAvailable() {
  const r = spawnSync('psql', [...base('postgres'), '-c', 'select 1'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0;
}

function parseError(stderr) {
  const m = /ERROR:\s+(\w{5}):\s+([^\n]*)/.exec(stderr);
  return m ? { code: m[1], message: m[2].trim() } : { code: 'XX000', message: stderr.trim().slice(0, 300) };
}

/** Führt SQL als Rolle (Standard: service_role) aus und liefert stdout. Wirft { code, message } bei SQL-Fehlern. */
export function sql(db, statement, { role = 'service_role' } = {}) {
  return new Promise((resolve, reject) => {
    const args = [...base(db)];
    if (role) args.push('-c', `set role ${role}`);
    args.push('-c', statement);
    const p = spawn('psql', args, { env: { ...process.env, PGOPTIONS: '-c timezone=UTC' } });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(Object.assign(new Error(err), parseError(err)))));
  });
}

export async function createTestDatabase() {
  const name = `kf_t_${randomBytes(5).toString('hex')}`;
  const admin = (statement) => spawnSync('psql', [...base('postgres'), '-c', statement], { encoding: 'utf8' });
  // Supabase-typische Rollen sicherstellen (falls noch nicht vorhanden)
  for (const r of ['anon', 'authenticated']) admin(`do $$ begin create role ${r} nologin; exception when duplicate_object then null; end $$`);
  admin('do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$');
  const c = admin(`create database ${name}`);
  if (c.status !== 0) throw new Error(`Testdatenbank konnte nicht angelegt werden: ${c.stderr}`);
  const m = spawnSync('psql', [...base(name), '-f', MIGRATION], { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '-c timezone=UTC' } });
  if (m.status !== 0) throw new Error(`Migration fehlgeschlagen: ${m.stderr}`);
  return {
    name,
    sql: (statement, opts) => sql(name, statement, opts),
    drop: () => admin(`drop database if exists ${name} with (force)`),
    migrationText: () => readFileSync(MIGRATION, 'utf8'),
  };
}
