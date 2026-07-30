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

Produktionsprojektet opdateres i denne rækkefølge:

1. `schema.sql` ved en helt ny installation.
2. SQL-filerne i `migrations/` i stigende tidsrækkefølge.

Migrationen `20260730212810_user_registry_feature_pack.sql` tilføjer
sammenlagte observationer, fejlrapportering, intern troværdighed og
revisionslog. Tabellerne ligger i `private`, har RLS aktiveret og har ingen
direkte tabelrettigheder til appens `authenticated`-rolle. Appen bruger kun de
smalle, eksplicit tildelte RPC-funktioner i `public`.

Der må aldrig placeres en `secret`- eller `service_role`-nøgle i appen, `.env`,
GitHub eller APK-filen. Frontenden bruger kun projektets publishable-nøgle.

Appen bruger anonym Supabase-login. E-mail/password-login er deaktiveret i
projektet, og hver installation får sin egen vedvarende session.
