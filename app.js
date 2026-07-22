const MS_TO_KN = 1.943844;
const WIND_POLL_MS = 60_000;
const SMOOTHING_WINDOW_MS = 2000;
const DEFAULT_STATION_CODE = "6258"; // Trintelhaven Houtribdijk
const SPOT_STORAGE_KEY = "sailing-wind-spot-v1";
const TIMER_STORAGE_KEY = "sailing-race-target-v1";
const LINE_STORAGE_KEY = "sailing-startline-v1";
const WAYPOINT_STORAGE_KEY = "sailing-waypoint-v1";
const LASTFIX_STORAGE_KEY = "sailing-lastfix-v1";
const NM_IN_METERS = 1852;
const WAYPOINT_LIST_MAX = 200; // voorkomt duizenden DOM-nodes bij een landelijk GPX-bestand
const MAX_DELTA_DT_S = 10; // grotere tijdsprong tussen fixes = geen continu spoor, niet uit delta afleiden
const VMG_TREND_WINDOW_MS = 10_000; // VMG vergelijken met ~10 seconden geleden
const VMG_TREND_THRESHOLD_KN = 0.1; // kleiner verschil = "gelijk" (dempt GPS-ruis)

let polar = loadPolar();
let manualWind = null; // {tws, twd} when manual override active
let lastWind = null; // {speedKn, dirDeg, dirText, stationTimestamp, ageSeconds, stale, fetchedAtClient}
let selectedStationCode = localStorage.getItem(SPOT_STORAGE_KEY) || DEFAULT_STATION_CODE;
let spotListCache = null;
let lastFix = null; // {lat, lon, time}
let lastCourseDeg = null; // 2s gemiddelde koers, gebruikt voor weergave en TWA
let lastSpeedKn = null; // 2s gemiddelde snelheid, gebruikt voor weergave en performance%
let fixBuffer = []; // recente {time, speedKn, courseDeg} samples, voor het 2s voortschrijdend gemiddelde
let lastFixSavedAt = 0; // throttle voor het wegschrijven van de laatste positie naar localStorage
let haveLiveFix = false; // true zodra er deze sessie een echte GPS-fix binnen is (niet enkel hersteld)
let vmgHistory = []; // recente {time, vmg} samples voor de 10s-trend van VMG-naar-boei
let raceTargetTimeStr = loadRaceTarget(); // "HH:MM:SS" of null
let raceLine = loadRaceLine(); // {a: {lat,lon}|null, b: {lat,lon}|null}
let waypoints = []; // alle boeien uit waypoints.gpx: {name, lat, lon}
let selectedWaypoint = loadSelectedWaypoint(); // {name, lat, lon}|null
let lineMap = null; // Leaflet map-instantie voor de startlijn-kiezer (lazy aangemaakt)
let lineMarkerA = null;
let lineMarkerB = null;
let lineMapLayer = null; // polyline tussen A en B
let mapActiveMarker = "a"; // welk punt de volgende tik op de kaart plaatst
let gpsPermissionModalDismissed = false;

const el = (id) => document.getElementById(id);

function toRad(d) { return (d * Math.PI) / 180; }
function toDeg(r) { return (r * 180) / Math.PI; }

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function twaFromWindAndCourse(windDirDeg, courseDeg) {
  let diff = (windDirDeg - courseDeg + 360) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff;
}

// Gemiddelde van hoeken (bv. koers in graden) kan niet met een normaal gemiddelde:
// 350° en 10° moeten uitkomen op 0°, niet op 180°. Vandaar middelen via de eenheidsvector.
function circularMeanDeg(anglesDeg) {
  let sumSin = 0;
  let sumCos = 0;
  anglesDeg.forEach((a) => {
    sumSin += Math.sin(toRad(a));
    sumCos += Math.cos(toRad(a));
  });
  return (toDeg(Math.atan2(sumSin, sumCos)) + 360) % 360;
}

// --- Boei / waypoint (course to steer, distance to waypoint) ---

function loadSelectedWaypoint() {
  try {
    const raw = localStorage.getItem(WAYPOINT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveSelectedWaypoint(wp) {
  if (wp) localStorage.setItem(WAYPOINT_STORAGE_KEY, JSON.stringify(wp));
  else localStorage.removeItem(WAYPOINT_STORAGE_KEY);
}

// Leest waypoints.gpx (eenmalig, client-side) en geeft [{name, lat, lon}, ...] terug.
// Het bestand is ISO-8859-1 gecodeerd (zoals opgegeven in de XML-declaratie), vandaar de
// expliciete TextDecoder in plaats van fetch().text() (die altijd UTF-8 aanneemt).
async function loadWaypoints() {
  if (waypoints.length) return waypoints;
  const res = await fetch("waypoints.gpx");
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("iso-8859-1").decode(buf);
  const doc = new DOMParser().parseFromString(text, "application/xml");
  waypoints = Array.from(doc.querySelectorAll("wpt"))
    .map((node) => {
      const nameEl = node.querySelector("name");
      const rawName = nameEl ? nameEl.textContent : "";
      return {
        name: rawName.split("\n")[0].trim(),
        lat: parseFloat(node.getAttribute("lat")),
        lon: parseFloat(node.getAttribute("lon")),
      };
    })
    .filter((wp) => wp.name && !Number.isNaN(wp.lat) && !Number.isNaN(wp.lon));
  waypoints.sort((a, b) => a.name.localeCompare(b.name));
  return waypoints;
}

function renderWaypointList(filterText) {
  const listEl = el("waypointList");
  const f = (filterText || "").trim().toLowerCase();
  listEl.innerHTML = "";

  // Bij een landelijk bestand (10.000+ boeien) niet alles ongefilterd in de DOM proppen -
  // dat is traag op een telefoon. Pas zoeken laat de lijst zien.
  if (!f && waypoints.length > WAYPOINT_LIST_MAX) {
    listEl.innerHTML = `<div class="waypoint-empty">${waypoints.length} boeien beschikbaar &mdash; typ een naam om te zoeken.</div>`;
    return;
  }

  const filtered = f ? waypoints.filter((wp) => wp.name.toLowerCase().includes(f)) : waypoints;
  if (!filtered.length) {
    listEl.innerHTML = '<div class="waypoint-empty">Geen boei gevonden.</div>';
    return;
  }

  filtered.slice(0, WAYPOINT_LIST_MAX).forEach((wp) => {
    const item = document.createElement("div");
    item.className = "waypoint-item";
    item.textContent = wp.name;
    item.addEventListener("click", () => {
      selectedWaypoint = wp;
      saveSelectedWaypoint(wp);
      el("waypointName").textContent = wp.name;
      el("waypointModal").classList.add("hidden");
      render();
    });
    listEl.appendChild(item);
  });

  if (filtered.length > WAYPOINT_LIST_MAX) {
    const more = document.createElement("div");
    more.className = "waypoint-empty";
    more.textContent = `+${filtered.length - WAYPOINT_LIST_MAX} meer resultaten - verfijn je zoekopdracht.`;
    listEl.appendChild(more);
  }
}

async function openWaypointPicker() {
  el("waypointModal").classList.remove("hidden");
  el("waypointSearchInput").value = "";
  el("waypointList").innerHTML = '<div class="waypoint-empty">Boeien laden...</div>';
  try {
    await loadWaypoints();
    renderWaypointList("");
    el("waypointSearchInput").focus();
  } catch (err) {
    el("waypointList").innerHTML = '<div class="waypoint-empty">Kon waypoints.gpx niet laden.</div>';
  }
}

// --- Racetimer + startlijn: opslag ---

function loadRaceTarget() {
  try {
    const raw = localStorage.getItem(TIMER_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.dateStr !== new Date().toDateString()) return null; // niet meenemen naar volgende dag
    return data.time;
  } catch {
    return null;
  }
}
function saveRaceTarget(timeStr) {
  localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify({ time: timeStr, dateStr: new Date().toDateString() }));
}
function clearRaceTarget() {
  localStorage.removeItem(TIMER_STORAGE_KEY);
}

function loadRaceLine() {
  try {
    const raw = localStorage.getItem(LINE_STORAGE_KEY);
    if (!raw) return { a: null, b: null };
    const data = JSON.parse(raw);
    return { a: data.a || null, b: data.b || null };
  } catch {
    return { a: null, b: null };
  }
}
function saveRaceLine() {
  localStorage.setItem(LINE_STORAGE_KEY, JSON.stringify(raceLine));
}

// --- Startlijn op kaart (Leaflet + OpenStreetMap) ---

function lineMarkerIcon(which) {
  return L.divIcon({
    className: `map-pin map-pin-${which}`,
    html: which.toUpperCase(),
    iconSize: [24, 24],
  });
}

function initLineMapIfNeeded() {
  if (lineMap) return;
  lineMap = L.map("mapContainer");

  // Altijd meteen een geldig middelpunt/zoom zetten, nog vóórdat er markers bijkomen.
  // Zonder dit blijft de kaart zonder view staan als raceLine al gevuld is (bv. na een
  // page-refresh met een eerder opgeslagen lijn) - Leaflet laadt dan geen enkele tegel.
  if (raceLine.a && raceLine.b) {
    lineMap.fitBounds(
      [
        [raceLine.a.lat, raceLine.a.lon],
        [raceLine.b.lat, raceLine.b.lon],
      ],
      { padding: [40, 40] }
    );
  } else {
    const center = raceLine.a || raceLine.b || lastFix || { lat: 52.6, lon: 5.2 };
    lineMap.setView([center.lat, center.lon], raceLine.a || raceLine.b || lastFix ? 14 : 8);
  }

  // Esri's gratis satellietbeelden (geen API-key nodig). Let op de tegel-volgorde
  // {z}/{y}/{x} - dat is bij Esri's ArcGIS REST tile-service andersom dan bij de
  // meeste andere providers ({z}/{x}/{y}).
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  }).addTo(lineMap);
  lineMap.on("click", (e) => setLinePointFromMap(mapActiveMarker, e.latlng.lat, e.latlng.lng));
}

// Houdt de markers/lijn op de kaart in sync met raceLine, ongeacht of die via GPS-pin,
// tik-op-de-kaart of het verslepen van een marker is bijgewerkt.
function syncLineMap() {
  if (!lineMap) return;

  ["a", "b"].forEach((which) => {
    const pt = raceLine[which];
    const marker = which === "a" ? lineMarkerA : lineMarkerB;
    if (pt && !marker) {
      const newMarker = L.marker([pt.lat, pt.lon], { draggable: true, icon: lineMarkerIcon(which) }).addTo(lineMap);
      newMarker.on("dragend", (e) => {
        const ll = e.target.getLatLng();
        setLinePointFromMap(which, ll.lat, ll.lng);
      });
      if (which === "a") lineMarkerA = newMarker;
      else lineMarkerB = newMarker;
    } else if (pt && marker) {
      marker.setLatLng([pt.lat, pt.lon]);
    } else if (!pt && marker) {
      lineMap.removeLayer(marker);
      if (which === "a") lineMarkerA = null;
      else lineMarkerB = null;
    }
  });

  if (lineMapLayer) {
    lineMap.removeLayer(lineMapLayer);
    lineMapLayer = null;
  }
  if (raceLine.a && raceLine.b) {
    lineMapLayer = L.polyline(
      [
        [raceLine.a.lat, raceLine.a.lon],
        [raceLine.b.lat, raceLine.b.lon],
      ],
      { color: "#4aa3ff" }
    ).addTo(lineMap);
  }
}

function setLinePointFromMap(which, lat, lon) {
  raceLine[which] = { lat, lon };
  saveRaceLine();
  syncLineMap();
  renderRaceScreen();
  // Na het plaatsen van A automatisch naar B schakelen, zodat je vlot beide punten kan zetten.
  if (which === "a" && !raceLine.b) {
    mapActiveMarker = "b";
    updateMapModeButtons();
  }
}

function updateMapModeButtons() {
  el("mapSetABtn").classList.toggle("active", mapActiveMarker === "a");
  el("mapSetBBtn").classList.toggle("active", mapActiveMarker === "b");
}

function getRaceTargetMs() {
  if (!raceTargetTimeStr) return null;
  const [h, m, s] = raceTargetTimeStr.split(":").map(Number);
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s || 0, 0).getTime();
}

function formatCountdown(totalSeconds) {
  const clamped = Math.max(0, Math.ceil(totalSeconds));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatSigned(totalSeconds) {
  const sign = totalSeconds < 0 ? "-" : "+";
  const abs = Math.round(Math.abs(totalSeconds));
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${sign}${m}:${String(s).padStart(2, "0")}`;
}

// --- Startlijn: geometrie ---
// Lokale platte projectie (meters) rond een referentiepunt, nauwkeurig genoeg over de
// afstand van een startlijn/aanloop (hooguit een paar km).
function localXY(lat, lon, refLat, refLon) {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos(toRad(refLat));
  return { x: (lon - refLon) * metersPerDegLon, y: (lat - refLat) * metersPerDegLat };
}

// Bepaalt waar de huidige koers (als rechte lijn vanaf de boot) de startlijn kruist.
// Geeft { distanceM, onSegment } terug, of null als er geen bruikbare kruising is
// (bv. koers evenwijdig aan de lijn, of het kruispunt ligt achter de boot).
function computeLineCrossing() {
  if (!raceLine.a || !raceLine.b || !lastFix || lastCourseDeg == null) return null;

  const refLat = raceLine.a.lat;
  const refLon = raceLine.a.lon;
  const A = { x: 0, y: 0 };
  const B = localXY(raceLine.b.lat, raceLine.b.lon, refLat, refLon);
  const O = localXY(lastFix.lat, lastFix.lon, refLat, refLon);
  const heading = toRad(lastCourseDeg);
  const D = { x: Math.sin(heading), y: Math.cos(heading) }; // eenheidsvector, 0deg=noord(+y), 90deg=oost(+x)

  const E = { x: B.x - A.x, y: B.y - A.y };
  const det = E.x * D.y - E.y * D.x;
  if (Math.abs(det) < 1e-9) return null; // koers evenwijdig aan de lijn

  const dx = A.x - O.x;
  const dy = A.y - O.y;
  const t = (E.x * dy - E.y * dx) / det; // afstand (m) langs de koers tot het kruispunt
  const s = (D.x * dy - D.y * dx) / det; // positie op de lijn, 0 = punt A, 1 = punt B

  if (t < 0) return null; // kruispunt ligt achter de boot
  return { distanceM: t, onSegment: s >= 0 && s <= 1 };
}

function renderRaceScreen() {
  const targetMs = getRaceTargetMs();
  const timerValueEl = el("timerValue");
  timerValueEl.classList.remove("warn", "done");

  if (targetMs != null) {
    el("timerTargetLabel").textContent = new Date(targetMs).toTimeString().slice(0, 8);
    const remainingSec = (targetMs - Date.now()) / 1000;
    timerValueEl.textContent = formatCountdown(remainingSec);
    if (remainingSec <= 0) timerValueEl.classList.add("done");
    else if (remainingSec <= 60) timerValueEl.classList.add("warn");
  } else {
    el("timerTargetLabel").textContent = "--:--:--";
    timerValueEl.textContent = "--:--";
  }

  el("pinAStatus").textContent = raceLine.a ? "A: gezet" : "A: niet gezet";
  el("pinAStatus").classList.toggle("set", !!raceLine.a);
  el("pinBStatus").textContent = raceLine.b ? "B: gezet" : "B: niet gezet";
  el("pinBStatus").classList.toggle("set", !!raceLine.b);

  const hintEl = el("lineHint");
  const ttbEl = el("ttbValue");
  ttbEl.style.color = "";

  if (!raceLine.a || !raceLine.b) {
    el("lineDistanceValue").textContent = "-- m";
    ttbEl.textContent = "--:--";
    hintEl.textContent = "Pin beide punten van de startlijn.";
    return;
  }
  if (!lastFix || lastCourseDeg == null) {
    el("lineDistanceValue").textContent = "-- m";
    ttbEl.textContent = "--:--";
    hintEl.textContent = "Wachten op GPS...";
    return;
  }

  const crossing = computeLineCrossing();
  if (!crossing) {
    el("lineDistanceValue").textContent = "-- m";
    ttbEl.textContent = "--:--";
    hintEl.textContent = "Geen kruising met de lijn op de huidige koers.";
    return;
  }

  el("lineDistanceValue").textContent = Math.round(crossing.distanceM) + " m";
  hintEl.textContent = crossing.onSegment ? "" : "Kruispunt ligt buiten de lijn (verlengde).";

  if (targetMs != null && lastSpeedKn != null && lastSpeedKn > 0.2) {
    const speedMs = lastSpeedKn / MS_TO_KN;
    const timeToLineSec = crossing.distanceM / speedMs;
    const remainingSec = (targetMs - Date.now()) / 1000;
    const ttbSec = remainingSec - timeToLineSec;
    ttbEl.textContent = formatSigned(ttbSec);
    ttbEl.style.color = ttbSec >= 0 ? "#3cc26e" : "#e74c3c";
  } else {
    ttbEl.textContent = "--:--";
  }
}

function onPosition(pos) {
  const { latitude, longitude, speed, heading } = pos.coords;
  const now = pos.timestamp;

  let instSpeedKn = speed != null && !Number.isNaN(speed) ? speed * MS_TO_KN : null;
  let instCourseDeg = heading != null && !Number.isNaN(heading) ? heading : null;

  if (lastFix) {
    const dist = haversineMeters(lastFix.lat, lastFix.lon, latitude, longitude);
    const dt = (now - lastFix.time) / 1000;
    // Alleen snelheid/koers uit het positieverschil afleiden bij een continu spoor:
    // een grote tijdsprong (bv. een herstelde of OS-gecachte positie na een pauze)
    // zou anders een onzinnige snelheidspiek geven.
    if (dist > 5 && dt > 0 && dt < MAX_DELTA_DT_S) {
      if (instCourseDeg == null) {
        instCourseDeg = bearingDeg(lastFix.lat, lastFix.lon, latitude, longitude);
      }
      if (instSpeedKn == null) {
        instSpeedKn = (dist / dt) * MS_TO_KN;
      }
    }
  }

  lastFix = { lat: latitude, lon: longitude, time: now };
  haveLiveFix = true;
  saveLastFix();

  if (instSpeedKn != null || instCourseDeg != null) {
    fixBuffer.push({ time: now, speedKn: instSpeedKn, courseDeg: instCourseDeg });
  }
  fixBuffer = fixBuffer.filter((f) => now - f.time <= SMOOTHING_WINDOW_MS);

  const recentSpeeds = fixBuffer.map((f) => f.speedKn).filter((v) => v != null);
  const recentCourses = fixBuffer.map((f) => f.courseDeg).filter((v) => v != null);
  if (recentSpeeds.length) {
    lastSpeedKn = recentSpeeds.reduce((sum, v) => sum + v, 0) / recentSpeeds.length;
  }
  if (recentCourses.length) {
    lastCourseDeg = circularMeanDeg(recentCourses);
  }

  el("gpsStatus").textContent = "GPS: actief";
  el("gpsStatus").className = "";
  el("gpsPermissionModal").classList.add("hidden");
  gpsPermissionModalDismissed = false;
  render();
}

// Laatste positie bewaren (max 1x/10s) zodat we bij de volgende keer openen meteen
// iets kunnen tonen terwijl de echte GPS-fix nog binnenkomt. Timestamp gaat mee zodat
// de delta-beveiliging hierboven een oude herstelde positie herkent en negeert.
function saveLastFix() {
  if (!lastFix || Date.now() - lastFixSavedAt < 10_000) return;
  lastFixSavedAt = Date.now();
  try {
    localStorage.setItem(
      LASTFIX_STORAGE_KEY,
      JSON.stringify({ lat: lastFix.lat, lon: lastFix.lon, time: lastFix.time })
    );
  } catch {}
}

function restoreLastFix() {
  try {
    const raw = localStorage.getItem(LASTFIX_STORAGE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (typeof p.lat === "number" && typeof p.lon === "number") {
      // Echte (oude) timestamp behouden, niet Date.now(): dan ziet onPosition de grote
      // tijdsprong en leidt er geen valse snelheid uit af.
      lastFix = { lat: p.lat, lon: p.lon, time: typeof p.time === "number" ? p.time : 0 };
    }
  } catch {}
}

function onPositionError(err) {
  el("gpsStatus").textContent = "GPS: " + err.message;
  el("gpsStatus").className = "error";
  if (err.code === err.PERMISSION_DENIED && !gpsPermissionModalDismissed) {
    el("gpsPermissionModal").classList.remove("hidden");
  }
}

let gpsWatchId = null;

// Meteen een eventueel gecachte positie ophalen: sneller dan wachten op de eerste
// verse fix van watchPosition. maximumAge: Infinity betekent "geef me direct elke
// positie die het OS al kent" - als de telefoon net GPS gebruikte (bv. in Maps) komt
// die zo goed als instant binnen, terwijl de watch ondertussen een verse fix zoekt.
function requestQuickGpsFix() {
  if (!("geolocation" in navigator)) return;
  navigator.geolocation.getCurrentPosition(onPosition, () => {}, {
    enableHighAccuracy: true,
    maximumAge: Infinity,
    timeout: 10_000,
  });
}

function startGpsWatch() {
  if (!("geolocation" in navigator)) return;
  if (gpsWatchId != null) {
    navigator.geolocation.clearWatch(gpsWatchId);
  }
  gpsWatchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 15000,
  });
}

function startGps() {
  if (!("geolocation" in navigator)) {
    el("gpsStatus").textContent = "GPS: niet beschikbaar";
    el("gpsStatus").className = "error";
    return;
  }
  if (!haveLiveFix) {
    el("gpsStatus").textContent = lastFix ? "GPS: laatste positie, zoeken..." : "GPS: zoeken...";
    el("gpsStatus").className = "warn";
  }
  requestQuickGpsFix();
  startGpsWatch();
}

// Beide schermen (performance + racetimer) delen dezelfde GPS-status (lastFix/lastCourseDeg/
// lastSpeedKn) - er wordt maar één keer naar GPS gezocht, niet per scherm. Bij het wisselen
// van app/tabblad kan het OS de GPS-chip en/of de watchPosition-koppeling stilzwijgend hebben
// stopgezet; bij terugkomst dus meteen een snelle fix proberen en de watch herstarten.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    requestQuickGpsFix();
    startGpsWatch();
  }
});

async function pollWind() {
  if (manualWind) {
    lastWind = {
      speedKn: manualWind.tws,
      dirDeg: manualWind.twd,
      dirText: "",
      stationTimestamp: null,
      ageSeconds: 0,
      stale: false,
      manual: true,
    };
    el("windStatus").textContent = "Wind: handmatig";
    el("windStatus").className = "";
    render();
    return;
  }

  try {
    const res = await fetch(`/api/wind?station=${encodeURIComponent(selectedStationCode)}`);
    const data = await res.json();
    if (data.error && !data.speedKn) {
      el("windStatus").textContent = "Wind: fout - " + data.error;
      el("windStatus").className = "error";
      return;
    }
    lastWind = { ...data, fetchedAtClient: Date.now() };
    if (data.stale) {
      el("windStatus").textContent = `Wind: verouderd (${data.stationTimestamp || "?"})`;
      el("windStatus").className = "warn";
    } else {
      el("windStatus").textContent = `Wind: ${data.spotnaam || "Trintelhaven"} (${data.stationTimestamp || ""})`;
      el("windStatus").className = "";
    }
  } catch (e) {
    el("windStatus").textContent = "Wind: geen verbinding";
    el("windStatus").className = "error";
  }
  render();
}

function perfColor(pct) {
  if (pct == null) return "#8fb0d1";
  if (pct < 70) return "#e74c3c";
  if (pct < 90) return "#f5b942";
  if (pct <= 105) return "#3cc26e";
  return "#4aa3ff";
}

function clearVmgTrend() {
  vmgHistory = [];
  const t = el("vmgTrend");
  t.textContent = "";
  t.className = "tile-trend";
}

// Houdt een rollend logje van VMG bij en toont of de VMG t.o.v. ~10s geleden beter,
// slechter of ongeveer gelijk is. Pas als er ~10s historie is verschijnt er een teken.
function updateVmgTrend(vmg) {
  const now = Date.now();
  vmgHistory.push({ time: now, vmg });
  vmgHistory = vmgHistory.filter((s) => now - s.time <= VMG_TREND_WINDOW_MS + 3000);

  const t = el("vmgTrend");
  const oldest = vmgHistory[0];
  if (!oldest || now - oldest.time < VMG_TREND_WINDOW_MS - 2000) {
    t.textContent = "";
    t.className = "tile-trend";
    return;
  }

  // sample dat het dichtst bij 10s geleden ligt
  const targetTime = now - VMG_TREND_WINDOW_MS;
  let past = oldest;
  let best = Infinity;
  for (const s of vmgHistory) {
    const d = Math.abs(s.time - targetTime);
    if (d < best) {
      best = d;
      past = s;
    }
  }

  const diff = vmg - past.vmg;
  if (diff > VMG_TREND_THRESHOLD_KN) {
    t.textContent = "▲ beter";
    t.className = "tile-trend up";
  } else if (diff < -VMG_TREND_THRESHOLD_KN) {
    t.textContent = "▼ slechter";
    t.className = "tile-trend down";
  } else {
    t.textContent = "● gelijk";
    t.className = "tile-trend flat";
  }
}

function render() {
  el("sogValue").textContent = lastSpeedKn != null ? lastSpeedKn.toFixed(1) + " kn" : "-- kn";
  el("cogValue").textContent = lastCourseDeg != null ? Math.round(lastCourseDeg) + "°" : "--°";

  if (selectedWaypoint && lastFix) {
    const distM = haversineMeters(lastFix.lat, lastFix.lon, selectedWaypoint.lat, selectedWaypoint.lon);
    const cts = bearingDeg(lastFix.lat, lastFix.lon, selectedWaypoint.lat, selectedWaypoint.lon);
    el("ctsValue").textContent = Math.round(cts) + "°";
    el("dtwValue").textContent = (distM / NM_IN_METERS).toFixed(2) + " nm";

    // VMG naar de boei = component van je snelheid richting de boei: SOG x cos(peiling - COG).
    // Positief = je loopt in op de boei, negatief = je loopt eraf.
    if (lastSpeedKn != null && lastCourseDeg != null) {
      const vmg = lastSpeedKn * Math.cos(toRad(cts - lastCourseDeg));
      el("vmgValue").textContent = vmg.toFixed(1) + " kn";
      updateVmgTrend(vmg);
    } else {
      el("vmgValue").textContent = "-- kn";
      clearVmgTrend();
    }
  } else {
    el("ctsValue").textContent = "--°";
    el("dtwValue").textContent = "-- nm";
    el("vmgValue").textContent = "-- kn";
    clearVmgTrend();
  }

  if (lastWind) {
    el("twsValue").textContent = lastWind.speedKn.toFixed(1) + " kn";
    el("twdValue").textContent = Math.round(lastWind.dirDeg) + "°" + (lastWind.dirText ? " " + lastWind.dirText : "");
  }

  let twa = null;
  let target = null;
  let pct = null;

  if (lastWind && lastCourseDeg != null) {
    twa = twaFromWindAndCourse(lastWind.dirDeg, lastCourseDeg);
    target = getTargetSpeed(twa, lastWind.speedKn, polar);
    el("twaValue").textContent = Math.round(twa) + "°";
    el("targetValue").textContent = target.toFixed(1) + " kn";

    if (target > 0.3 && lastSpeedKn != null) {
      pct = (lastSpeedKn / target) * 100;
    }
  } else {
    el("twaValue").textContent = "--°";
    el("targetValue").textContent = "-- kn";
  }

  if (pct != null) {
    el("perfValue").textContent = Math.round(pct) + "%";
    el("perfBarFill").style.width = Math.min(150, pct) / 1.5 + "%";
    const color = perfColor(pct);
    el("perfBarFill").style.background = color;
    el("perfValue").style.color = color;
  } else if (target != null && target <= 0.3) {
    el("perfValue").textContent = "in de wind";
    el("perfValue").style.color = "#8fb0d1";
    el("perfBarFill").style.width = "0%";
  } else {
    el("perfValue").textContent = "--%";
    el("perfValue").style.color = "#eaf2fb";
    el("perfBarFill").style.width = "0%";
  }
}

// --- Settings modal ---

function buildPolarTable() {
  const table = el("polarTable");
  table.innerHTML = "";

  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th")).textContent = "TWA \\ TWS";
  polar.twsCols.forEach((tws) => {
    const th = document.createElement("th");
    th.textContent = tws + "kn";
    headRow.appendChild(th);
  });
  table.appendChild(headRow);

  polar.twaRows.forEach((twa, ri) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = twa + "°";
    tr.appendChild(th);
    polar.twsCols.forEach((_, ci) => {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.1";
      input.min = "0";
      input.value = polar.speeds[ri][ci];
      input.dataset.ri = ri;
      input.dataset.ci = ci;
      td.appendChild(input);
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
}

function readPolarTableInputs() {
  const inputs = el("polarTable").querySelectorAll("input");
  inputs.forEach((input) => {
    const ri = Number(input.dataset.ri);
    const ci = Number(input.dataset.ci);
    const v = parseFloat(input.value);
    polar.speeds[ri][ci] = Number.isNaN(v) ? 0 : v;
  });
}

async function loadSpotList() {
  const select = el("windSpotSelect");
  if (!spotListCache) {
    select.innerHTML = "<option>Spots laden...</option>";
    try {
      const res = await fetch("/api/spots");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Onbekende fout");
      spotListCache = data.spots;
    } catch (err) {
      select.innerHTML = `<option>Kon spotlijst niet laden</option>`;
      return;
    }
  }

  select.innerHTML = "";
  spotListCache.forEach((spot) => {
    const opt = document.createElement("option");
    opt.value = spot.code;
    opt.textContent = spot.name;
    select.appendChild(opt);
  });
  select.value = selectedStationCode;
}

function openSettings() {
  buildPolarTable();
  loadSpotList();
  el("settingsModal").classList.remove("hidden");
}
function closeSettings() {
  el("settingsModal").classList.add("hidden");
}

el("settingsBtn").addEventListener("click", openSettings);
el("closeSettingsBtn").addEventListener("click", closeSettings);
el("settingsModal").addEventListener("click", (e) => {
  if (e.target.id === "settingsModal") closeSettings();
});

el("savePolarBtn").addEventListener("click", () => {
  readPolarTableInputs();
  savePolar(polar);
  render();
  closeSettings();
});

el("resetPolarBtn").addEventListener("click", () => {
  polar = resetPolar();
  buildPolarTable();
  render();
});

el("orcUploadInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = el("orcUploadStatus");
  statusEl.textContent = "PDF wordt gelezen...";
  statusEl.className = "";

  try {
    const res = await fetch("/api/parse-orc", { method: "POST", body: file });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Onbekende fout");

    polar = data;
    savePolar(polar);
    buildPolarTable();
    render();
    statusEl.textContent = `Polar overgenomen uit ${file.name} (${polar.twsCols.length} windsnelheden, ${polar.twaRows.length} hoeken).`;
    statusEl.className = "success";
  } catch (err) {
    statusEl.textContent = "Uploaden mislukt: " + err.message;
    statusEl.className = "error";
  } finally {
    e.target.value = "";
  }
});

el("windSpotSelect").addEventListener("change", (e) => {
  selectedStationCode = e.target.value;
  localStorage.setItem(SPOT_STORAGE_KEY, selectedStationCode);
  el("windStatus").textContent = "Wind: laden...";
  el("windStatus").className = "";
  pollWind();
});

el("manualWindToggle").addEventListener("change", (e) => {
  el("manualWindFields").classList.toggle("hidden", !e.target.checked);
  if (e.target.checked) {
    manualWind = {
      tws: parseFloat(el("manualTws").value) || 0,
      twd: parseFloat(el("manualTwd").value) || 0,
    };
  } else {
    manualWind = null;
  }
  pollWind();
});

el("manualTws").addEventListener("input", (e) => {
  if (!manualWind) return;
  manualWind.tws = parseFloat(e.target.value) || 0;
  pollWind();
});
el("manualTwd").addEventListener("input", (e) => {
  if (!manualWind) return;
  manualWind.twd = parseFloat(e.target.value) || 0;
  pollWind();
});

// --- Boei / waypoint: bediening ---

el("waypointCard").addEventListener("click", openWaypointPicker);
el("closeWaypointModalBtn").addEventListener("click", () => el("waypointModal").classList.add("hidden"));
el("waypointModal").addEventListener("click", (e) => {
  if (e.target.id === "waypointModal") el("waypointModal").classList.add("hidden");
});
el("waypointSearchInput").addEventListener("input", (e) => renderWaypointList(e.target.value));

if (selectedWaypoint) {
  el("waypointName").textContent = selectedWaypoint.name;
}

// --- Racetimer + startlijn: bediening ---

el("timerCard").addEventListener("click", () => {
  el("timerTargetInput").value = raceTargetTimeStr || "";
  el("timerCountdownInput").value = "";
  el("timerModal").classList.remove("hidden");
});
el("closeTimerModalBtn").addEventListener("click", () => el("timerModal").classList.add("hidden"));
el("timerModal").addEventListener("click", (e) => {
  if (e.target.id === "timerModal") el("timerModal").classList.add("hidden");
});

el("saveTimerBtn").addEventListener("click", () => {
  const val = el("timerTargetInput").value;
  if (val) {
    raceTargetTimeStr = val.length === 5 ? val + ":00" : val; // HH:MM -> HH:MM:SS
    saveRaceTarget(raceTargetTimeStr);
  }
  el("timerModal").classList.add("hidden");
  renderRaceScreen();
});
el("clearTimerBtn").addEventListener("click", () => {
  raceTargetTimeStr = null;
  clearRaceTarget();
  el("timerModal").classList.add("hidden");
  renderRaceScreen();
});

el("startCountdownBtn").addEventListener("click", () => {
  const minutes = parseFloat(el("timerCountdownInput").value);
  if (!minutes || minutes <= 0) return;
  const target = new Date(Date.now() + minutes * 60_000);
  raceTargetTimeStr = [target.getHours(), target.getMinutes(), target.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  saveRaceTarget(raceTargetTimeStr);
  el("timerModal").classList.add("hidden");
  renderRaceScreen();
});

el("pinABtn").addEventListener("click", () => {
  if (!lastFix) {
    el("lineHint").textContent = "Nog geen GPS-positie beschikbaar.";
    return;
  }
  raceLine.a = { lat: lastFix.lat, lon: lastFix.lon };
  saveRaceLine();
  syncLineMap();
  renderRaceScreen();
});
el("pinBBtn").addEventListener("click", () => {
  if (!lastFix) {
    el("lineHint").textContent = "Nog geen GPS-positie beschikbaar.";
    return;
  }
  raceLine.b = { lat: lastFix.lat, lon: lastFix.lon };
  saveRaceLine();
  syncLineMap();
  renderRaceScreen();
});
el("clearLineBtn").addEventListener("click", () => {
  raceLine = { a: null, b: null };
  saveRaceLine();
  syncLineMap();
  renderRaceScreen();
});

el("chooseOnMapBtn").addEventListener("click", () => {
  mapActiveMarker = !raceLine.a ? "a" : !raceLine.b ? "b" : "a";
  updateMapModeButtons();
  el("mapModal").classList.remove("hidden");
  // De modal gaat van display:none naar zichtbaar; de container heeft op dit exacte
  // moment nog niet altijd een correcte layout-grootte (vooral op mobiel), waardoor
  // Leaflet met een verkeerde (0x0) afmeting initialiseert en geen tegels laadt.
  // Twee keer invalidateSize() met wat marge dekt zowel snelle als tragere apparaten.
  setTimeout(() => {
    initLineMapIfNeeded();
    lineMap.invalidateSize();
    syncLineMap();
  }, 100);
  setTimeout(() => {
    if (lineMap) lineMap.invalidateSize();
  }, 400);
});
el("mapSetABtn").addEventListener("click", () => {
  mapActiveMarker = "a";
  updateMapModeButtons();
});
el("mapSetBBtn").addEventListener("click", () => {
  mapActiveMarker = "b";
  updateMapModeButtons();
});
el("mapDoneBtn").addEventListener("click", () => el("mapModal").classList.add("hidden"));
el("closeMapModalBtn").addEventListener("click", () => el("mapModal").classList.add("hidden"));
el("mapModal").addEventListener("click", (e) => {
  if (e.target.id === "mapModal") el("mapModal").classList.add("hidden");
});

// --- Swipe-indicator tussen de schermen ---

const screensEl = el("screens");
const dotEls = document.querySelectorAll("#screenDots .dot");
screensEl.addEventListener("scroll", () => {
  const idx = Math.round(screensEl.scrollLeft / screensEl.clientWidth);
  dotEls.forEach((d, i) => d.classList.toggle("active", i === idx));
});
dotEls.forEach((dot) => {
  dot.addEventListener("click", () => {
    const idx = Number(dot.dataset.screen);
    screensEl.scrollTo({ left: idx * screensEl.clientWidth, behavior: "smooth" });
  });
});

// --- GPS-toestemming modal ---

(function setupGpsPermissionUi() {
  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  el("gpsInstructionsIOS").classList.toggle("hidden", !isIOS);
  el("gpsInstructionsAndroid").classList.toggle("hidden", isIOS);
})();

el("closeGpsModalBtn").addEventListener("click", () => {
  gpsPermissionModalDismissed = true;
  el("gpsPermissionModal").classList.add("hidden");
});
el("retryGpsBtn").addEventListener("click", () => {
  el("gpsPermissionModal").classList.add("hidden");
  gpsPermissionModalDismissed = false; // laat 'm weer verschijnen als het opnieuw mislukt
  startGps();
});
el("gpsPermissionModal").addEventListener("click", (e) => {
  if (e.target.id === "gpsPermissionModal") {
    gpsPermissionModalDismissed = true;
    el("gpsPermissionModal").classList.add("hidden");
  }
});

// --- boot ---
restoreLastFix(); // toon direct de laatst bekende positie terwijl de verse fix binnenkomt
render();
startGps();
pollWind();
renderRaceScreen();
setInterval(pollWind, WIND_POLL_MS);
setInterval(renderRaceScreen, 200);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
