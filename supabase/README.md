# Pladetjek Supabase

Dette er den eneste Supabase-konfiguration, som må bruges af Pladetjek.

- Organisation: `Pladetjek`
- Projekt: `Pladetjek`
- Projekt-id: `uolrwogzfegrdjbjvsvu`
- Projekt-URL: `https://uolrwogzfegrdjbjvsvu.supabase.co`
- Region: West EU (`eu-west-1`)

`schema.sql` er den reproducerbare database-definition. Den:

- aktiverer RLS på alle Pladetjek-tabeller,
- fjerner klientadgang til Supabases interne RLS-hjælpefunktion,
- fjerner direkte klientadgang til hele advarselslisten,
- tillader kun anonyme, autentificerede brugere at kalde de to snævre RPC'er,
- begrænser oprettelse til tre advarsler pr. ti minutter,
- begrænser matchopslag til 120 pr. minut,
- lader advarsler udløbe efter én time.

Der må aldrig placeres en `secret`- eller `service_role`-nøgle i appen, `.env`,
GitHub eller APK-filen. Frontenden bruger kun projektets publishable-nøgle.

Appen bruger anonym Supabase-login. E-mail/password-login er deaktiveret i
projektet, og hver installation får sin egen vedvarende session.
