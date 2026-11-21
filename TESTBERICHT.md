# Testbericht

## Automatisch getestet (87 Tests, alle bestanden)
Umgebung: echtes PostgreSQL 16, simulierte Supabase-REST-Schnittstelle, Chromium (Playwright) auf Handy-, Tablet- und Desktop-Größe, strenge Content-Security-Policy.
- **Datenbank (21):** keine Doppelbuchung (inkl. 15 gleichzeitige Buchungen → genau eine gewinnt), 15-Minuten-Raster, Vergangenheit/Horizont, Statuswechsel, Sperrzeiten, Suche, Rate-Limit, RLS/Rechte.
- **API (23):** Buchung, Validierung, Honeypot, Token-Verwaltung, Admin-Login/Sperre, Einladung, Annehmen/Ablehnen/Stornieren, E-Mail-Fehler verlieren keine Buchung, Zeitzonen (Sommer-/Winterzeit).
- **Oberfläche (16):** komplette Abläufe Kunde und Admin, Kalenderansichten, Sperrzeiten, Einstellungen, E-Mail-Protokoll, keine Seiten-Überläufe, keine CSP-Verstöße.
- **Unit/Statisch (27):** Zeit-/Slot-Logik, Validierung, Krypto, keine Geheimnisse im Frontend, Konfiguration.
Beim Testen gefundene und behobene Fehler: Browser-Validierung blockierte Fehlermeldungen; Slot-Konflikt blendete Meldung aus; E-Mail-Wiederholung sprang in falschen Reiter; Farbe/Scroll-Details im Kalender.

## NICHT testbar (fehlende Zugangsdaten / Umgebung) – bitte bei der Einrichtung prüfen
- Echtes Supabase-Projekt (Test lief gegen lokales PostgreSQL; REST-Aufrufe gegen Simulation, Schlüsselformat `sb_` vs. JWT nicht live geprüft).
- Echter Resend-Versand und Zustellung (nur Logik/Fehlerfälle mit Attrappe).
- Netlify-Deployment inkl. Functions und Header (netlify.toml nicht mit `netlify dev` geprüft).
- Echte Geräte (nur emulierte Größen).

## Einrichtung durch Sie nötig
Supabase-Projekt + SQL, GitHub, Netlify + Umgebungsvariablen, erster Admin, Resend-Schlüssel; für Kunden-E-Mails eine eigene Domain (siehe Anleitung, Schritt 6).
