# Pladetjek Supabase

Dette er den eneste Supabase-konfiguration, som må bruges af Pladetjek.

- Organisation: `Pladetjek`
- Projekt: `Pladetjek`
- Projekt-id: `uolrwogzfegrdjbjvsvu`
- Projekt-URL: `https://uolrwogzfegrdjbjvsvu.supabase.co`
- Region: West EU (`eu-west-1`)

`schema.sql` er basisdefinitionen. Eksisterende installationer skal altid have
alle filer i `migrations/` kørt i stigende tidsrækkefølge. Samlet betyder
definitionen og migrationerne, at løsningen:

- aktiverer RLS på alle Pladetjek-tabeller,
- fjerner klientadgang til Supabases interne RLS-hjælpefunktion,
- fjerner direkte klientadgang til hele advarselslisten,
- tillader anonyme sessioner at scanne uden at kunne oprette vedvarende
  indberetninger,
- kræver en e-mailbekræftet, permanent konto for advarsler og rapporter,
- begrænser oprettelse til tre advarsler pr. ti minutter,
- begrænser matchopslag til 120 pr. minut,
- gemmer aktive advarsler uden automatisk udløb,
- sletter udløbne nærhedshændelser og fjerner præcise, inaktive positioner.

Produktionsprojektet opdateres i denne rækkefølge:

1. `schema.sql` ved en helt ny installation.
2. SQL-filerne i `migrations/` i stigende tidsrækkefølge.

Migrationen `20260730212810_user_registry_feature_pack.sql` tilføjer
sammenlagte observationer, fejlrapportering, intern troværdighed og
revisionslog. Tabellerne ligger i `private`, har RLS aktiveret og har ingen
direkte tabelrettigheder til appens `authenticated`-rolle. Appen bruger kun de
smalle, eksplicit tildelte RPC-funktioner i `public`.

Migrationen `20260801144015_harden_verified_accounts_and_location_retention.sql`
kræver e-mailbekræftede indberettere på databaseniveau og opretter den interne
oprydningsfunktion. Hvis Supabase Cron (`pg_cron`) allerede er aktiveret,
planlægges oprydningen automatisk hvert tiende minut. Aktivér derfor Cron før
migrationen lægges på produktion. Funktionen kan kontrolleres manuelt som
databaseejer:

```sql
select * from private.cleanup_expired_nearby_data_internal();
```

Der må aldrig placeres en `secret`- eller `service_role`-nøgle i appen, `.env`,
GitHub eller APK-filen. Frontenden bruger kun projektets publishable-nøgle.

Appen starter med anonym Supabase-login, så scanning virker uden oprettelse.
"Opret bruger" opgraderer samme anonyme bruger med `auth.updateUser`, så
historikken ikke flyttes til en ny bruger. Magic-link-login er aktiveret uden
adgangskode. Under Authentication skal **Allow manual linking** være aktiveret,
og `dk.pladetjek.app://login-callback` skal være en tilladt redirect-URL.

Før migrationer lægges i produktion, skal projekt-id'et kontrolleres. Der må kun
deployes til `uolrwogzfegrdjbjvsvu`; et andet linket Supabase-projekt må ikke
bruges som erstatning.
