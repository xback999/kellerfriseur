# Kellerfriseur – Terminbuchung

Netlify (Webseite + Functions) · Supabase (Datenbank) · Resend (E-Mail) · reines HTML/CSS/JS, keine npm-Pakete.

- Kundenseite: `/` (nur Buchung), persönlicher Terminlink: `/termin/#TOKEN`
- Adminbereich: `/admin/`
- Anleitung für Einsteiger: `docs/ANLEITUNG.md` · Testbericht: `docs/TESTBERICHT.md`
- Datenbank: `supabase/migrations/001_kellerfriseur.sql` · Umgebungsvariablen: `.env.example`
- Tests: `npm test` (benötigt lokales PostgreSQL und Chromium/Playwright; nur für Entwickler)
