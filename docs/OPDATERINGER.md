# Opdateringssystem til Pladetjek

Appen har et indbygget opdateringssystem til Android-installationer, der er
distribueret uden om Google Play. Den første APK kan overføres via OneDrive.
Efterfølgende versioner kan hentes og installeres direkte fra appen.

## Sådan virker det

1. Appen henter `version.json` fra det officielle GitHub-repository.
2. `activeVersionCode` sammenlignes med APK'ens installerede versionskode.
3. Hvis der findes en nyere version, vises ændringslisten i appen.
4. Android kan bede brugeren om at tillade installation fra Pladetjek.
5. APK'en downloades til appens private cache.
6. SHA-256, pakkenavn, versionskode og app-signatur kontrolleres.
7. Androids normale installationsvindue åbnes.

Den downloadede APK må højst fylde 100 MB. Opdateringssystemet accepterer kun:

`https://github.com/stralner2711-a11y/pladetjek/releases/download/.../*.apk`

## Udgiv en ny version

Eksempel for version 1.1.0:

1. Hæv `versionCode` i `android/app/build.gradle` fra 1 til 2.
2. Hæv `versionName` samme sted og `version` i `package.json` til `1.1.0`.
3. Kør `npm test`.
4. Kør `npm run android:build` på den samme computer og med den samme
   signeringsnøgle som første APK.
5. Omdøb den byggede fil til `Pladetjek.apk`.
6. Beregn SHA-256:

   ```powershell
   Get-FileHash -Algorithm SHA256 .\Pladetjek.apk
   ```

7. Opret GitHub-release `v1.1.0`, og upload `Pladetjek.apk`.
8. Opdatér `version.json`:

   ```json
   {
     "activeVersion": "1.1.0",
     "activeVersionCode": 2,
     "minimumSupportedVersionCode": 1,
     "apkDownloadUrl": "https://github.com/stralner2711-a11y/pladetjek/releases/download/v1.1.0/Pladetjek.apk",
     "releasePageUrl": "https://github.com/stralner2711-a11y/pladetjek/releases/tag/v1.1.0",
     "sha256": "APK-FILENS-SHA-256-MED-SMÅ-BOGSTAVER",
     "changelog": ["Beskriv ændringen kort"],
     "forceUpdate": false,
     "updatedAt": "2026-07-30"
   }
   ```

9. Kontrollér, at GitHub-release og APK er offentligt tilgængelige.
10. Læg først derefter den nye `version.json` på `main`.

Rækkefølgen er vigtig: APK'en skal være tilgængelig, før manifestet annoncerer
den. Ellers ser brugerne en opdatering, som endnu ikke kan downloades.

## Valgfri eller tvungen opdatering

- Normal opdatering: `forceUpdate` er `false`. Brugeren kan vælge **Senere**.
- Tvungen opdatering: `forceUpdate` er `true`.
- Minimumsversion: Sæt `minimumSupportedVersionCode` til den laveste version,
  der fortsat må bruges. En installeret version under tallet kan ikke afvise
  opdateringen.

Brug kun tvungen opdatering ved fejl, der gør ældre versioner usikre eller
ubrugelige.

## Signeringsnøglen må ikke mistes

Denne første fil er en debug-signeret APK til privat installation. Nye
debug-APK'er bygget på samme Windows-bruger benytter normalt samme lokale
Android-debugnøgle og kan derfor installeres oven på den.

Hvis debugnøglen mistes, kan Android ikke godkende en ny version som opdatering.
Telefonen vil da kræve, at den gamle app afinstalleres først. Det sletter appens
lokale data.

Før bredere distribution bør projektet skifte til en permanent release-nøgle.
Det skal ske **før** brugerne installerer den første bredt distribuerede APK.
Nøglen og adgangskoden skal sikkerhedskopieres separat og må aldrig lægges i Git.

## Google Play

Tilladelsen `REQUEST_INSTALL_PACKAGES` er beregnet til denne private
sideloade-distribution. Hvis appen senere udgives i Google Play, skal den
erstattes med Google Plays officielle in-app update-mekanisme.
