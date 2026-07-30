# PLADETJEK

Kamerabaseret kontrol af danske nummerplader mod et fælles, brugerbaseret
advarselsregister. Appen viser kun et resultat, når den scannede eller manuelt
indtastede nummerplade matcher en aktiv advarsel, som en bruger har oprettet.

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

## Register

Den første version bruger kun Pladetjeks fælles brugerregister i Supabase.
Nummerplade.dk, DMR, Bilbogen og andre eksterne køretøjsregistre er ikke en del
af opslaget.

Et manuelt registertjek viser et eventuelt match i appen, men udsender ikke en
nærhedsnotifikation. En 5 km-notifikation kan kun oprettes, når kameraet fysisk
har genkendt nummerpladen og fundet et præcist match.

## Lokal kørsel

1. Kopiér `.env.example` til `.env`.
2. Kontrollér Supabase-adressen og publishable-nøglen.
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

Kameraet og tekstgenkendelsen kører lokalt i Android-appen. Kun den genkendte
nummerplade sendes til det præcise Supabase-matchopslag.

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

- Brugeradvarsler gemmes i Pladetjeks separate Supabase-projekt uden automatisk
  udløb. Den lokale JSON-backend bruges kun som udviklingsfallback.
- Klienterne kan ikke hente eller gennemse hele nummerpladeregisteret.
- Et matchopslag returnerer højst én aktiv advarsel for den præcise nummerplade.
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
