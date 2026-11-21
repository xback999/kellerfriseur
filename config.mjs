// Liest die Einstellungen aus den Umgebungsvariablen (Netlify > Environment variables).
// Es werden keine Werte ausgegeben oder protokolliert, nur Namen fehlender Variablen.

export function loadConfig(env = process.env) {
  const clean = (v) => (typeof v === 'string' ? v.trim() : '');
  const cfg = {
    supabaseUrl: clean(env.SUPABASE_URL),
    // Neuer Name (sb_secret_...) hat Vorrang; der bisherige Name funktioniert weiterhin.
    supabaseKey: clean(env.SUPABASE_SECRET_KEY) || clean(env.SUPABASE_SERVICE_ROLE_KEY),
    appSecret: clean(env.APP_SECRET),
    resendApiKey: clean(env.RESEND_API_KEY),
    emailFrom: clean(env.EMAIL_FROM) || 'Kellerfriseur <onboarding@resend.dev>',
    siteUrl: clean(env.SITE_URL).replace(/\/+$/, ''),
  };
  const missing = [];
  if (!cfg.supabaseUrl) missing.push('SUPABASE_URL');
  if (!cfg.supabaseKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (cfg.appSecret.length < 32) missing.push('APP_SECRET (mindestens 32 Zeichen)');
  cfg.missing = missing;
  return cfg;
}
