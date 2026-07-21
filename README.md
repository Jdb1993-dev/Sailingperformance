# Sailing Performance

Webapp (PWA) die op je telefoon laat zien hoe goed een zeilboot het doet t.o.v. het polar diagram:

- **GPS** (telefoon): actuele snelheid (SOG) en koers (COG).
- **Wind**: live van [actuelewind.nl](https://www.actuelewind.nl), elke minuut vernieuwd. Standaard spot *Trintelhaven Houtribdijk*, maar in Instellingen kiezen uit alle (54) spots van de site.
- **Polar diagram**: standaard de **Piranha (MG 26, NED 1926)**, overgenomen uit het officiele ORC Club Certificate. Upload je eigen **ORC-certificaat (PDF)** in Instellingen voor de polar van jouw eigen schip. Ook handmatig volledig aanpasbaar.
- **Performance %**: 2-seconden-gemiddelde GPS-snelheid gedeeld door de target-snelheid uit de polar voor de actuele TWA/TWS (koers/snelheid worden gemiddeld om GPS-ruis te dempen).
- **Racetimer + startlijn**: swipe naar het tweede scherm voor een aftel-klok naar een instelbare starttijd, en een startlijn-tool (twee gepinde punten) die de afstand tot de lijn op je huidige koers en de "time to burn" (hoeveel tijd je te veel/te weinig hebt om precies op tijd op de lijn te zijn) berekent.
- **Course to steer / Distance to waypoint**: tik op de boei-kaart (eerste scherm) om een boei te zoeken en selecteren uit `waypoints.gpx`. Toont de kompaskoers en afstand (nm) in rechte lijn naar die boei.

## Waarom een server nodig is

actuelewind.nl heeft geen officiële publieke API en staat geen cross-origin requests toe (geen CORS-headers). Daarom draait er een klein servertje dat de winddata ophaalt en doorgeeft aan de app (`/api/wind`), gecached voor 55 sec in lijn met actuelewind.nl zelf.

De gedeelde ophaal-logica staat in `lib/wind.js` (geen dependencies, puur `fetch`). Die wordt op twee manieren aangeroepen:
- `server.js` — plain Node `http`-server, voor lokaal draaien of hosten op bv. Render.
- `api/wind.js` — Vercel serverless functie, voor de Vercel-deploy.

Bewust **geen Express of andere dependencies**: de eerste Vercel-deploy faalde met `Error: No entrypoint found which imports express` omdat Vercel bij het zien van `express` in `package.json` automatisch probeerde te raden welk bestand de Express-app was, en de mist inging. Zonder dat soort dependencies heeft Vercel niets te raden.

## Lokaal draaien

Vereist [Node.js](https://nodejs.org) (LTS, 18+). Op deze laptop stond dat nog niet geïnstalleerd — installeer het eerst.

```
cd Sailingperformance
npm install
npm start
```

Open daarna `http://localhost:3000` in de browser. Voor GPS-toegang op een telefoon via je lokale netwerk heb je HTTPS nodig (localhost zelf is geen probleem op een laptop/desktop).

## Deployen naar Vercel (voor gebruik op het water)

Voor gebruik op de boot moet de telefoon de app via internet (4G) kunnen bereiken, met HTTPS (vereist voor GPS in de browser). Het project is al klaar voor Vercel:

- `api/wind.js` — de wind-proxy als serverless functie (zelfde logica als `server.js`, dat blijft ook werken voor lokaal testen).
- De statische app-bestanden (`index.html`, `style.css`, `app.js`, ...) staan in de **project-root**, niet in een `public/` map — zonder buildstap serveert Vercel de root zelf als statische site, een losstaande `outputDirectory` in `vercel.json` werkt dan niet (dat leverde eerder een 404 op).

Stappen (eenmalig, via jouw eigen gratis accounts):

1. **Maak een GitHub-repo** en push deze projectmap ertoe (bv. via GitHub Desktop, of `git init && git add . && git commit -m "init" && git remote add origin <url> && git push`).
2. Ga naar **[vercel.com](https://vercel.com)**, log in met je GitHub-account.
3. Klik **"Add New... > Project"**, selecteer de repo. Vercel herkent het project automatisch (geen framework-instellingen nodig) en klikt op **Deploy**.
4. Na een paar seconden krijg je een URL zoals `https://jouw-project.vercel.app` — open die op je telefoon en kies **"Toevoegen aan beginscherm"** voor de app-ervaring.

Elke keer dat je een wijziging naar GitHub pusht, deployt Vercel automatisch een nieuwe versie.

## ORC-certificaat uploaden

In Instellingen → Polar diagram kun je een ORC (Club) Certificate PDF uploaden. De server (`lib/orcParser.js`, gebruikt door zowel `server.js` als `api/parse-orc.js`) leest de "Rated boat velocities in knots"-tabel op pagina 1:

- De directe hoek-rijen (52°, 60°, 75°, 90°, 110°, 120°, 135°, 150°, ...) worden 1-op-1 overgenomen.
- "Beat VMG"/"Beat Angles" en "Run VMG"/"Gybe Angles" worden teruggerekend naar boegsnelheid op de (gemiddelde) kruis- resp. gijphoek, zodat ook het kruisen en diep voor de wind zeilen in de polar zitten.
- Pagina 2 (tijdstoeslagen in sec/zeemijl) wordt bewust genegeerd — die tabel gebruikt dezelfde hoek-labels maar heeft totaal andere waarden, en zou anders per ongeluk meegelezen worden.

Werkt met het standaard ORC Club Certificate-sjabloon; bij een sterk afwijkende lay-out (ander land/systeem) kan het parsen mislukken — de app toont dan een foutmelding i.p.v. verkeerde cijfers.

**Vercel-specifieke kanttekening**: `pdf-parse` (voor het lezen van de PDF) bevat browser-only code die op Vercel tot twee subtiele fouten leidde: `DOMMatrix is not defined` (opgelost met een polyfill, zie de top van `lib/orcParser.js`) en `Cannot find module ...pdf.worker.mjs` (opgelost via `functions.includeFiles` in `vercel.json`, die het hele pdf-parse/pdfjs-dist-pakket meeneemt in de functiebundel). Beide fixes staan al in dit project.

## Racetimer + startlijn

Tweede scherm (swipe of tik op de dot onderin):

- **Timer**: tik op de klok om een starttijd (uu:mm:ss, vandaag) in te stellen. Groot: minuten:seconden tot die tijd. Rechtsboven klein: de ingestelde tijd zelf. Wordt onthouden voor de rest van de dag (localStorage), maar niet meegenomen naar de volgende dag.
- **Startlijn**: "Pin punt A" en "Pin punt B" leggen de twee uiteinden van de startlijn vast op je huidige GPS-positie (bv. bij de pin-boei en het startschip langsvaren). Of tik op **"Kies op kaart..."** om A en B aan te wijzen op een kaart (Leaflet + OpenStreetMap, gratis en zonder API-key — dus geen Google Maps nodig) — handig als je de lijn al vooraf kent. Beide manieren zijn te combineren, en pinnen zijn achteraf te verslepen op de kaart om ze bij te stellen. Zodra beide gezet zijn:
  - **Afstand tot lijn**: de afstand (in meters) tot het punt waar je *huidige koers* de startlijn kruist — niet de kortste (loodrechte) afstand.
  - **Time to burn**: `(tijd tot start) - (afstand / huidige snelheid)`. Positief (groen) = je bent te vroeg, moet nog tijd doden. Negatief (rood) = je bent te laat, moet opschieten.
  - Als je koers de lijn niet snijdt (weg van de lijn, of evenwijdig), of het kruispunt ligt buiten de twee gepinde punten (het verlengde van de lijn), toont de app dat expliciet i.p.v. een misleidend getal.
  - Geometrie: lat/lon worden lokaal plat geprojecteerd (meters, nauwkeurig genoeg over lijn-/aanloopafstanden) voor de lijn-kruising-berekening in `app.js` (`localXY`/`computeLineCrossing`).

## Course to steer / distance to waypoint

Op het eerste scherm: tik op de boei-kaart (onder de performance-tegel) om een boei te selecteren. De lijst komt uit `waypoints.gpx` (in de project-root, wordt client-side gelezen en geparsed met `DOMParser` — geen server nodig) en is doorzoekbaar op naam. Zodra een boei gekozen is:

- **Course to steer**: rechte kompaskoers (bearing) van je huidige GPS-positie naar de boei.
- **Distance to WP**: afstand in zeemijl, rechte lijn (geen rekening met stroming/leeway of een tussenliggende route).

De keuze wordt onthouden (localStorage). Vervang `waypoints.gpx` door je eigen export (bv. uit OpenCPN/Nautin) om een andere boeienset te gebruiken — elk `<wpt>` met een `<name>` en `lat`/`lon` wordt herkend.

## Beperkingen om te weten

- GPS geeft **SOG/COG** (snelheid/koers over de grond, 2s-gemiddelde), geen snelheid door het water — bij stroming wijkt dit af van de "echte" boegsnelheid.
- De standaard polar is die van de Piranha (MG 26) — upload je eigen ORC-certificaat als je een andere boot vaart.
- actuelewind.nl is een onofficiële databron (geen publieke API) — bij wijzigingen aan hun site kan `/api/wind` stuk gaan.
- Het weerstation zelf update ongeveer elke 10 minuten; de app polt elke minuut zodat je nooit langer dan nodig op verse data wacht, maar de waarde verandert niet elke minuut.
