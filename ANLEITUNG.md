# Anleitung für Einsteiger – Kellerfriseur online bringen

Sie brauchen dafür keine Programmierkenntnisse. Nehmen Sie sich ca. 60–90 Minuten Zeit und arbeiten Sie die Schritte **der Reihe nach** ab.
Die Bezeichnungen der Webseiten (Netlify, Supabase, Resend) ändern sich manchmal; wenn ein Knopf anders heißt, suchen Sie nach dem sinngemäß gleichen.

Sie brauchen drei kostenlose Konten: **GitHub** (Ablage des Codes), **Supabase** (Datenbank), **Netlify** (Webseite), später **Resend** (E-Mails).

---
## Schritt 1 – Datenbank bei Supabase einrichten
1. Auf supabase.com anmelden → **New project**. Name z. B. „kellerfriseur“, ein Datenbank-Passwort vergeben (aufschreiben!), Region „Frankfurt“ (EU).
2. Warten, bis das Projekt fertig ist.
3. Links **SQL Editor** → **New query**.
4. Die Datei `supabase/migrations/001_kellerfriseur.sql` aus dem ZIP mit einem Texteditor öffnen, **alles** kopieren, in den SQL Editor einfügen, **Run** klicken.
   Erwartet: „Success“. (Das Skript legt nur neue Tabellen mit Namen `kf_…` an und löscht nichts. Läuft es ein zweites Mal, bricht es absichtlich ab – das ist gewollt.)
5. Werte notieren (**Project Settings → API**, bzw. „API Keys“):
   - **Project URL** (`https://xxxx.supabase.co`)
   - **Geheimer Schlüssel**: der `service_role`-Schlüssel (alt) bzw. „Secret key“ `sb_secret_…` (neu). **Niemals veröffentlichen.**

## Schritt 2 – Code zu GitHub hochladen
1. Auf github.com ein **neues privates Repository** „kellerfriseur“ erstellen.
2. **uploading an existing file** wählen, den **Inhalt** des entpackten ZIP-Ordners hineinziehen (nicht den äußeren Ordner; `netlify.toml` muss direkt im Hauptverzeichnis liegen), **Commit changes**.

## Schritt 3 – Webseite bei Netlify
1. netlify.com → **Add new project → Import an existing project → GitHub** → Repository wählen.
2. Build-Einstellungen **leer lassen** (kein Build-Befehl nötig; `netlify.toml` enthält alles). Deploy starten.
3. **Project configuration → Environment variables** → folgende Werte anlegen (Vorlage: `.env.example`):

| Name | Wert |
|---|---|
| `SUPABASE_URL` | Project URL aus Schritt 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | geheimer Schlüssel aus Schritt 1 |
| `APP_SECRET` | selbst ausgedachte, zufällige Zeichenfolge, mind. 32 Zeichen. **Später nie ändern.** |
| `RESEND_API_KEY` | siehe Schritt 6 (kann zunächst fehlen) |
| `EMAIL_FROM` | zunächst `Kellerfriseur <onboarding@resend.dev>` |

4. Danach **Deploys → Trigger deploy → Deploy project** (damit die Werte wirken).
5. Prüfen: `https://IHRE-SEITE.netlify.app/api/health` soll `{"ok":true,…}` zeigen. Fehlt etwas, steht dort, was.

## Schritt 4 – Ersten Admin (Inhaber) anlegen
1. In Supabase → SQL Editor → neue Abfrage:
   `select public.kf_bootstrap_owner('IHRE@EMAIL.de', 'Ihr Name');`
2. Ergebnis ist z. B. `/admin/#setup=abc…`. Im Browser öffnen: `https://IHRE-SEITE.netlify.app/admin/#setup=abc…`
3. Passwort wählen (mind. 10 Zeichen) → Sie sind angemeldet. Der Link gilt 7 Tage und nur einmal.
   Neuer Link nötig? `select public.kf_issue_invite('IHRE@EMAIL.de');`

## Schritt 5 – Zweiten Admin (Friseurin) anlegen
Adminbereich → Reiter **Admins** → Name + E-Mail eintragen → **Einladen**. Der Einladungslink wird angezeigt (und per E-Mail verschickt, sobald E-Mail eingerichtet ist). Link an die Friseurin geben; sie wählt ihr Passwort selbst. Öffentliche Registrierung gibt es nicht.

## Schritt 6 – E-Mail mit Resend
1. resend.com → Konto anlegen → **API Keys → Create API Key** → Wert (`re_…`) in Netlify als `RESEND_API_KEY`, neu deployen.
2. **Wichtig ohne eigene Domain:** Mit dem Test-Absender `onboarding@resend.dev` liefert Resend E-Mails **nur an die E-Mail-Adresse Ihres Resend-Kontos**. Kunden und die Friseurin bekommen dann **keine** Mails. Buchungen funktionieren trotzdem; im Adminbereich (Reiter **E-Mails**) sehen Sie, was nicht zugestellt wurde.
3. Für echte Kunden-Mails braucht es eine eigene Domain (ab ca. 10 €/Jahr). Domain in Resend unter **Domains** bestätigen (DNS-Einträge beim Domain-Anbieter), dann `EMAIL_FROM` = `Kellerfriseur <termine@ihre-domain.de>` setzen und neu deployen.
4. Benachrichtigungsadresse (Standard lcordella818@gmail.com) ändern: Adminbereich → **Einstellungen** → „Kontakt-/Benachrichtigungsadresse“. Keine Programmierung nötig.

## Schritt 7 – Einstellungen
Adminbereich → **Einstellungen**: Termindauer (30/45/60/90 oder frei), wie viele Tage im Voraus buchbar (Standard 30), Name des Betriebs. **Sperrzeiten**: Tage, Zeiträume, Wochen blockieren.

## Änderungen später einspielen
Geänderte Dateien in GitHub hochladen (Datei öffnen → Stift/„Upload files“) → Netlify veröffentlicht automatisch neu. Neue SQL-Dateien (`supabase/migrations/002_…`) einmalig im SQL Editor ausführen.

## Testliste (nach dem Einrichten durchgehen)
- [ ] `/api/health` zeigt ok
- [ ] Startseite lädt, Kalender zeigt freie Zeiten (Handy + PC)
- [ ] Testbuchung mit Vor-/Nachname + E-Mail abschicken → Bestätigungsseite mit persönlichem Link
- [ ] Adminbereich: Anfrage erscheint unter „Anfragen“
- [ ] Annehmen → im Kalender grün; derselbe Zeitraum ist öffentlich nicht mehr buchbar
- [ ] Zweite Anfrage, ablehnen → Zeit wieder frei
- [ ] Persönlichen Link öffnen: offene Anfrage zurückziehen / bestätigten Termin stornieren (mit Rückfrage)
- [ ] Manuellen Termin anlegen, verschieben, löschen
- [ ] Suche nach Name/E-Mail/Telefon
- [ ] Sperrzeit anlegen → Zeit öffentlich nicht buchbar
- [ ] Zweiten Admin einladen und anmelden
- [ ] Reiter E-Mails: Versandstatus prüfen
- [ ] Tablet: Adminbereich bedienbar
