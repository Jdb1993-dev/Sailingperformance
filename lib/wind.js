// Gedeelde logica om actuele wind op te halen bij actuelewind.nl voor een gekozen spot.
// Wordt gebruikt door zowel server.js (lokaal/Render) als api/wind.js + api/spots.js (Vercel).
const DEFAULT_STATION_CODE = "6258"; // Trintelhaven Houtribdijk
const MS_TO_KN = 1.943844;
const CACHE_TTL_MS = 55_000; // upstream is zelf ook max 60s gecached

// De upstream call geeft in één keer ALLE spots terug, dus die cachen we als geheel.
let overviewCache = { data: null, fetchedAt: 0 };
// Per station het laatst gelukte resultaat, als fallback wanneer een nieuwe upstream-call faalt.
const lastGoodByStation = {};

function upstreamUrl() {
  return `https://www.actuelewind.nl/api/getSpotOverview.php?t=web&p=web&ss=0&${Date.now()}`;
}

async function fetchOverview() {
  const now = Date.now();
  if (overviewCache.data && now - overviewCache.fetchedAt < CACHE_TTL_MS) {
    return overviewCache.data;
  }
  const res = await fetch(upstreamUrl(), {
    headers: { "User-Agent": "Mozilla/5.0 (sailing-performance-app)" },
  });
  if (!res.ok) throw new Error(`upstream status ${res.status}`);
  const json = await res.json();
  overviewCache = { data: json, fetchedAt: now };
  return json;
}

// Lijst van alle beschikbare spots {code, name}, voor de spot-kiezer in de app.
async function getSpotList() {
  const json = await fetchOverview();
  return Object.entries(json.wind)
    .map(([code, v]) => ({ code, name: v.windspot.spotnaam }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Geeft altijd bruikbare data terug (desnoods verouderd uit cache) met een {status, body} shape,
// zodat elke server-laag er hetzelfde mee kan omgaan.
async function getWindResponse(stationCode = DEFAULT_STATION_CODE) {
  try {
    const json = await fetchOverview();
    const spot = json.wind && json.wind[stationCode];
    if (!spot || !spot.winddata || !spot.winddata.length) {
      throw new Error(`Onbekend spot-station: ${stationCode}`);
    }
    const latest = spot.winddata[0];
    const result = {
      stationCode,
      spotnaam: spot.windspot.spotnaam,
      speedKn: Math.round(latest.windsnelheidMS * MS_TO_KN * 10) / 10,
      gustKn: latest.windstotenMS != null ? Math.round(latest.windstotenMS * MS_TO_KN * 10) / 10 : null,
      dirDeg: latest.windrichtingGR,
      dirText: latest.windrichting,
      stationTimestamp: latest.tijdstip,
    };
    lastGoodByStation[stationCode] = { data: result, fetchedAt: Date.now() };
    return { status: 200, body: { ...result, stale: false, ageSeconds: 0 } };
  } catch (err) {
    const cached = lastGoodByStation[stationCode];
    if (cached) {
      return {
        status: 200,
        body: {
          ...cached.data,
          stale: true,
          ageSeconds: Math.round((Date.now() - cached.fetchedAt) / 1000),
          error: err.message,
        },
      };
    }
    return { status: 502, body: { error: "Kan winddata niet ophalen: " + err.message } };
  }
}

module.exports = { getWindResponse, getSpotList, DEFAULT_STATION_CODE };
