// Polar diagram voor de Piranha (MG 26, NED 1926) - overgenomen uit het officiele ORC
// Club Certificate (ORC Ref 04310004TT6). Snelheden in knopen.
// Upload je eigen ORC-certificaat in Instellingen om dit te vervangen door de polar van jouw boot.
const DEFAULT_POLAR = {
  twsCols: [4, 6, 8, 10, 12, 14, 16, 20, 24],
  twaRows: [0, 39.9, 52, 60, 75, 90, 110, 120, 135, 150, 171.6, 180],
  speeds: [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [2.88, 3.88, 4.55, 4.99, 5.19, 5.28, 5.32, 5.34, 5.29],
    [3.14, 4.29, 5.07, 5.48, 5.7, 5.81, 5.86, 5.89, 5.86],
    [3.36, 4.49, 5.25, 5.62, 5.81, 5.94, 6.01, 6.07, 6.06],
    [3.49, 4.61, 5.35, 5.73, 5.94, 6.1, 6.22, 6.37, 6.44],
    [3.38, 4.51, 5.39, 5.81, 6.04, 6.17, 6.33, 6.63, 6.81],
    [3.32, 4.59, 5.46, 5.9, 6.19, 6.45, 6.69, 7, 7.17],
    [3.19, 4.44, 5.35, 5.84, 6.16, 6.45, 6.75, 7.22, 7.48],
    [2.83, 4.05, 4.98, 5.63, 5.99, 6.28, 6.59, 7.23, 7.74],
    [2.38, 3.52, 4.46, 5.23, 5.73, 6.04, 6.32, 6.91, 7.48],
    [2.16, 3.16, 3.98, 4.67, 5.22, 5.62, 5.92, 6.43, 6.98],
    [2.16, 3.16, 3.98, 4.67, 5.22, 5.62, 5.92, 6.43, 6.98],
  ],
};

const POLAR_STORAGE_KEY = "sailing-polar-v1";

function loadPolar() {
  try {
    const raw = localStorage.getItem(POLAR_STORAGE_KEY);
    if (!raw) return clonePolar(DEFAULT_POLAR);
    const parsed = JSON.parse(raw);
    if (!parsed.twsCols || !parsed.twaRows || !parsed.speeds) return clonePolar(DEFAULT_POLAR);
    return parsed;
  } catch {
    return clonePolar(DEFAULT_POLAR);
  }
}

function savePolar(polar) {
  localStorage.setItem(POLAR_STORAGE_KEY, JSON.stringify(polar));
}

function resetPolar() {
  localStorage.removeItem(POLAR_STORAGE_KEY);
  return clonePolar(DEFAULT_POLAR);
}

function clonePolar(p) {
  return { twsCols: [...p.twsCols], twaRows: [...p.twaRows], speeds: p.speeds.map((r) => [...r]) };
}

// Lineaire interpolatie tussen twee punten
function lerp(x0, y0, x1, y1, x) {
  if (x1 === x0) return y0;
  const t = (x - x0) / (x1 - x0);
  return y0 + t * (y1 - y0);
}

// Vind index van omringende waarden in een gesorteerde array, geclamped aan de randen
function bracket(arr, v) {
  if (v <= arr[0]) return [0, 0];
  if (v >= arr[arr.length - 1]) return [arr.length - 1, arr.length - 1];
  for (let i = 0; i < arr.length - 1; i++) {
    if (v >= arr[i] && v <= arr[i + 1]) return [i, i + 1];
  }
  return [arr.length - 1, arr.length - 1];
}

// Bilineaire interpolatie: geeft targetsnelheid (kn) voor gegeven TWA (0-180) en TWS (kn)
function getTargetSpeed(twaAbs, twsKn, polar) {
  const twa = Math.min(180, Math.max(0, twaAbs));
  const [ci0, ci1] = bracket(polar.twsCols, twsKn);
  const [ri0, ri1] = bracket(polar.twaRows, twa);

  const q00 = polar.speeds[ri0][ci0];
  const q01 = polar.speeds[ri0][ci1];
  const q10 = polar.speeds[ri1][ci0];
  const q11 = polar.speeds[ri1][ci1];

  const top = lerp(polar.twsCols[ci0], q00, polar.twsCols[ci1], q01, twsKn);
  const bottom = lerp(polar.twsCols[ci0], q10, polar.twsCols[ci1], q11, twsKn);
  return lerp(polar.twaRows[ri0], top, polar.twaRows[ri1], bottom, twa);
}
