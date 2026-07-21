const MS_TO_KN = 1.943844;
const WIND_POLL_MS = 60_000;
const SMOOTHING_WINDOW_MS = 2000;
const DEFAULT_STATION_CODE = "6258"; // Trintelhaven Houtribdijk
const SPOT_STORAGE_KEY = "sailing-wind-spot-v1";

let polar = loadPolar();
let manualWind = null; // {tws, twd} when manual override active
let lastWind = null; // {speedKn, dirDeg, dirText, stationTimestamp, ageSeconds, stale, fetchedAtClient}
let selectedStationCode = localStorage.getItem(SPOT_STORAGE_KEY) || DEFAULT_STATION_CODE;
let spotListCache = null;
let lastFix = null; // {lat, lon, time}
let lastCourseDeg = null; // 2s gemiddelde koers, gebruikt voor weergave en TWA
let lastSpeedKn = null; // 2s gemiddelde snelheid, gebruikt voor weergave en performance%
let fixBuffer = []; // recente {time, speedKn, courseDeg} samples, voor het 2s voortschrijdend gemiddelde

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

function onPosition(pos) {
  const { latitude, longitude, speed, heading } = pos.coords;
  const now = pos.timestamp;

  let instSpeedKn = speed != null && !Number.isNaN(speed) ? speed * MS_TO_KN : null;
  let instCourseDeg = heading != null && !Number.isNaN(heading) ? heading : null;

  if (lastFix) {
    const dist = haversineMeters(lastFix.lat, lastFix.lon, latitude, longitude);
    const dt = (now - lastFix.time) / 1000;
    if (dist > 5) {
      if (instCourseDeg == null) {
        instCourseDeg = bearingDeg(lastFix.lat, lastFix.lon, latitude, longitude);
      }
      if (instSpeedKn == null && dt > 0) {
        instSpeedKn = (dist / dt) * MS_TO_KN;
      }
    }
  }

  lastFix = { lat: latitude, lon: longitude, time: now };

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
  render();
}

function onPositionError(err) {
  el("gpsStatus").textContent = "GPS: " + err.message;
  el("gpsStatus").className = "error";
}

function startGps() {
  if (!("geolocation" in navigator)) {
    el("gpsStatus").textContent = "GPS: niet beschikbaar";
    el("gpsStatus").className = "error";
    return;
  }
  navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 15000,
  });
}

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

function render() {
  el("sogValue").textContent = lastSpeedKn != null ? lastSpeedKn.toFixed(1) + " kn" : "-- kn";
  el("cogValue").textContent = lastCourseDeg != null ? Math.round(lastCourseDeg) + "°" : "--°";

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

// --- boot ---
startGps();
pollWind();
setInterval(pollWind, WIND_POLL_MS);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
