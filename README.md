# PLADETJEK

Kamera- og nummerpladeopslag til danske køretøjer. Browseren håndterer kameraet,
mens alle registeropslag går gennem den lokale server, så API-tokenet aldrig
bliver sendt til klienten.

## Matchbaserede advarsler

En bruger kan i sektionen **Tilføj advarsel** gemme en nummerplade og en kort
observationstekst. Nummerpladen kan indtastes manuelt eller scannes med samme
lokale Android-genkendelse som hovedscanneren. Det sender ikke straks en alarm
til andre.

Advarslen vises først, når en anden bruger:

1. starter kameraet i Android-appen,
2. scanner den samme nummerplade, og
3. serveren finder et aktivt, præcist match.

Android-appen bruger den gratis, lokalt pakkede
[Google ML Kit-tekstgenkendelse](https://developers.google.com/ml-kit/vision/text-recognition/v2/android).
Kamerabilledet sendes derfor ikke til OCR-servere. Appen sender kun den
genkendte nummerplade til det præcise matchopslag.

Scanneren analyserer kun området i den synlige ramme. Et OCR-resultat accepteres
først, når format, placering, størrelse, hældning og genkendelsessikkerhed passer
til en nummerplade, og den samme plade er set i flere kamerabilleder.

Nummerplader og advarselstekster gemmes uden automatisk udløb i
det separate Supabase-projekt `Pladetjek` (`uolrwogzfegrdjbjvsvu`). Klienterne
kan ikke hente hele listen over aktive advarsler; RLS og to snævre RPC-kald
tillader kun oprettelse og et præcist match på den aktivt scannede nummerplade.

### OBS-match i nærheden

Android-brugere kan frivilligt aktivere lokation og pushnotifikationer under
**Profil**. Når scanneren finder et præcist match, får andre tilmeldte telefoner
med en højst 30 minutter gammel position inden for 5 km pushbeskeden
**“OBS – osten lugter i nærheden af dig”**.

Præcise positioner og push-tokens ligger kun i Supabases private skema og kan
ikke læses af appklienter. Modtageren får kun en afrundet afstand, tidspunktet
for matchet og et område afrundet til cirka 100–200 meter. Afsenderen modtager
ikke sin egen pushbesked, og gentagne match samme sted dæmpes i 15 minutter.
Selve match-/pushhændelsen er tidsbegrænset; den gemte nummerpladeadvarsel er
fortsat aktiv.

## Datakilder

- Køretøjsdata: `GET https://api.nrpla.de/{registreringsnummer}`
- Forsikring/DMR: `GET https://api.nrpla.de/dmr/registration/{registreringsnummer}`
- Pant og panthaver: `GET https://api.nrpla.de/tinglysning/{stelnummer}`
- Fallback for pant: `GET https://api.nrpla.de/debt/{vehicle_id}`

`nummerplade.dk` har ikke et dokumenteret køretøjs-API. Integrationen bruger
derfor det dokumenterede Nummerplade API fra `nummerpladeapi.dk`, der stiller
DMR- og Tinglysningsdata til rådighed.

## Lokal kørsel

1. Kopiér `.env.example` til `.env`.
2. Indsæt en gyldig `NUMMERPLADE_API_TOKEN`.
3. Kør `npm install`.
4. Kør `npm run dev`.
5. Åbn `http://127.0.0.1:5173`.

Til en produktionslignende lokal kørsel:

```text
npm run build
npm start
```

Serveren åbner som standard på `http://127.0.0.1:8787`.

## Android

Android-projektet ligger i `android/` og bruger pakkenavnet `dk.pladetjek.app`.

1. Angiv en offentligt tilgængelig HTTPS-backend som `VITE_API_BASE_URL`.
2. Kør `npm run android:build`.
3. Installer den færdige `Pladetjek.apk` fra projektets øverste mappe.

Kameraet kører lokalt i Android-appen. Registeropslag kræver en backend, fordi
API-tokenet ikke må pakkes ind i APK-filen. Debug-APK'en kan åbnes uden backend,
men viser da, at datakilden mangler.

## Opdateringer

Android-appen kontrollerer
`https://raw.githubusercontent.com/stralner2711-a11y/pladetjek/main/version.json`
ved opstart og via knappen **Opdatering**.

En opdatering installeres kun, når alle disse kontroller består:

- APK-linket peger på et release i det officielle Pladetjek-repository.
- SHA-256-kontrolsummen svarer til den downloadede fil.
- APK-pakken hedder `dk.pladetjek.app`.
- APK'en har et højere `versionCode`.
- APK'en er signeret med samme nøgle som den installerede app.

Se [docs/OPDATERINGER.md](docs/OPDATERINGER.md) for udgivelse, tvungne
opdateringer og de vigtige regler om versionskode og signeringsnøgle.

## Datasikkerhed

- API-tokenet må kun ligge på serveren.
- Debitorers navn, CPR og fødselsdato videresendes ikke til klienten.
- Kun kreditors navn/CVR og hæftelsens hovedstol vises.
- Opslag caches kun i hukommelsen i 30 sekunder og skrives ikke til disk.
- Brugeradvarsler gemmes i Pladetjeks separate Supabase-projekt uden automatisk
  udløb. Den lokale JSON-backend bruges kun som udviklingsfallback.
- Hver installation får automatisk sin egen anonyme Supabase-session.
- En permanent konto bruger et sikkert e-mail-link uden adgangskode.
- Andre brugere ser kun det valgte brugernavn eller `Anonym bruger`.
- E-mail, internt bruger-id, roller og moderation udleveres kun via beskyttede
  creator/admin-funktioner.
- Nærhedsadvarsler kræver aktivt samtykke. Den seneste præcise position bruges
  kun privat i radiusberegningen, accepteres højst 30 minutter og slettes ved
  fravalg; modtageren ser kun afrundede positionsdata.
- Beskrivelsen må højst være 240 tegn og bør ikke indeholde navne eller andre
  personoplysninger.
- En dokumenteret slettepolitik bør tilføjes, før løsningen åbnes for en større
  offentlig brugergruppe.

### Creator og administratorer

Roller gemmes i `private.user_roles` og aldrig i brugerens redigerbare metadata.
Suspenderede brugere kan ikke oprette eller matche fælles advarsler.

Creator-rollen kan ikke kræves fra appen. Når creator-e-mailen er kendt, køres
følgende én gang i Supabase SQL Editor:

```sql
select private.assign_creator_by_email('din-email@example.dk');
```

Kommandoen kan køres før eller efter kontoen oprettes. Android-login kræver
desuden denne tilladte redirect-URL under Supabase Authentication:

```text
dk.pladetjek.app://login-callback
```

Supabases indbyggede e-mailtjeneste er egnet til begrænset test. Før mange
brugere inviteres, bør projektet forbindes til en egen SMTP-udbyder.

Et resultat fra Bilbogen viser en tinglyst hæftelse, ikke nødvendigvis den
aktuelle restgæld. Kritiske resultater bør efterkontrolleres i Bilbogen.
