// pdf-parse's Node-bundel bevat ook de (voor ons ongebruikte) canvas/render-functionaliteit, die
// verwijst naar browser-only API's als DOMMatrix, Path2D, ImageData, etc. Die bestaan niet in Node,
// en sommige serverless build-omgevingen missen ze daardoor bij het lezen van een PDF met
// vectorgraphics (zoals het zeilplan op een ORC-certificaat) — vandaar minimale polyfills.
if (typeof globalThis.DOMMatrix === "undefined") {
  globalThis.DOMMatrix = require("@thednp/dommatrix");
}
if (typeof globalThis.Path2D === "undefined") {
  globalThis.Path2D = class Path2D {
    moveTo() {}
    lineTo() {}
    bezierCurveTo() {}
    quadraticCurveTo() {}
    arc() {}
    arcTo() {}
    ellipse() {}
    rect() {}
    closePath() {}
  };
}
if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class ImageData {
    constructor(dataOrWidth, widthOrHeight, height) {
      if (typeof dataOrWidth === "number") {
        this.width = dataOrWidth;
        this.height = widthOrHeight;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      } else {
        this.data = dataOrWidth;
        this.width = widthOrHeight;
        this.height = height;
      }
    }
  };
}
if (typeof globalThis.OffscreenCanvas === "undefined") {
  globalThis.OffscreenCanvas = class OffscreenCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return null;
    }
  };
}
if (typeof globalThis.HTMLCanvasElement === "undefined") {
  globalThis.HTMLCanvasElement = class HTMLCanvasElement {};
}
if (typeof globalThis.Image === "undefined") {
  globalThis.Image = class Image {};
}
if (typeof globalThis.createImageBitmap === "undefined") {
  globalThis.createImageBitmap = async () => {
    throw new Error("createImageBitmap wordt niet ondersteund in deze omgeving");
  };
}

// Parseert de "Rated boat velocities in knots" tabel uit de tekst van een ORC (Club) Certificate PDF.
// Verwacht regels zoals ze in het certificaat staan, bv.:
//   Wind Velocity 4 kt 6 kt 8 kt 10 kt ...
//   Beat Angles 47.0° 44.5° 42.3° ...
//   Beat VMG 2.04 2.96 3.62 ...
//   52°  3.23 4.56 5.44 ...
//   ...
//   Run VMG 2.22 3.29 4.22 ...
//   Gybe Angles 142.4° 146.5° ...
function parseOrcPolarFromText(text) {
  let lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Sommige certificaten herhalen dezelfde hoek-labels (52°, 90°, ...) verderop voor een tabel met
  // tijdstoeslagen in sec/zeemijl, i.p.v. boegsnelheid. Alles vanaf die kop negeren.
  const timeAllowanceIdx = lines.findIndex((l) => /time allowances|secs\/nm/i.test(l));
  if (timeAllowanceIdx !== -1) {
    lines = lines.slice(0, timeAllowanceIdx);
  }

  const numbersInLine = (line) => [...line.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0]));
  const findLine = (prefix) => lines.find((l) => l.startsWith(prefix));

  const windLine = findLine("Wind Velocity");
  if (!windLine) {
    throw new Error("Kon de 'Wind Velocity' rij niet vinden. Is dit een ORC Certificate PDF?");
  }
  const twsCols = numbersInLine(windLine);
  const n = twsCols.length;
  if (n < 2) {
    throw new Error("Te weinig windsnelheid-kolommen gevonden in het PDF.");
  }

  const beatAngles = findLine("Beat Angles") ? numbersInLine(findLine("Beat Angles")).slice(0, n) : null;
  const beatVmg = findLine("Beat VMG") ? numbersInLine(findLine("Beat VMG")).slice(0, n) : null;
  const runVmg = findLine("Run VMG") ? numbersInLine(findLine("Run VMG")).slice(0, n) : null;
  const gybeAngles = findLine("Gybe Angles") ? numbersInLine(findLine("Gybe Angles")).slice(0, n) : null;

  // Directe boegsnelheid-rijen: elke regel die begint met een hoek, bv. "52°" of "135°".
  const angleRowRe = /^(\d+(?:\.\d+)?)°/;
  const angleRows = [];
  for (const line of lines) {
    const m = line.match(angleRowRe);
    if (!m) continue;
    const values = numbersInLine(line.slice(m[0].length)).slice(0, n);
    if (values.length === n) {
      angleRows.push({ twa: parseFloat(m[1]), speeds: values });
    }
  }
  if (!angleRows.length) {
    throw new Error("Kon geen boegsnelheid-rijen (bv. 52°, 90°, 150°) vinden in het PDF.");
  }
  // Bij twijfel (bv. onverwacht dubbele labels) alleen de eerste (echte) rij per hoek gebruiken.
  const seenTwa = new Set();
  const dedupedAngleRows = angleRows.filter((row) => {
    if (seenTwa.has(row.twa)) return false;
    seenTwa.add(row.twa);
    return true;
  });
  dedupedAngleRows.sort((a, b) => a.twa - b.twa);

  const toRad = (d) => (d * Math.PI) / 180;
  const round2 = (x) => Math.round(x * 100) / 100;
  const twaRows = [0];
  const speeds = [twsCols.map(() => 0)]; // TWA=0: recht op de neus, geen vaart mogelijk

  // Beat VMG is de snelheid-langs-de-wind bij de optimale kruishoek (die per windsnelheid verschilt).
  // Terugrekenen naar boegsnelheid op die hoek: boegsnelheid = VMG / cos(hoek).
  if (beatAngles && beatVmg && beatAngles.length === n && beatVmg.length === n) {
    const avgBeat = beatAngles.reduce((a, b) => a + b, 0) / n;
    const beatSpeeds = beatVmg.map((vmg, i) => round2(vmg / Math.cos(toRad(beatAngles[i]))));
    twaRows.push(Math.round(avgBeat * 10) / 10);
    speeds.push(beatSpeeds);
  }

  dedupedAngleRows.forEach((row) => {
    twaRows.push(row.twa);
    speeds.push(row.speeds);
  });

  // Gybe angle is de hoek tussen de twee optimale gijp-koersen; elke koers wijkt (90 + gybe/2) af van
  // de wind. Run VMG terugrekenen naar boegsnelheid: boegsnelheid = VMG / cos(180 - hoek).
  if (gybeAngles && runVmg && gybeAngles.length === n && runVmg.length === n) {
    const runAngles = gybeAngles.map((g) => 90 + g / 2);
    const avgRun = runAngles.reduce((a, b) => a + b, 0) / n;
    const runSpeeds = runVmg.map((vmg, i) => round2(vmg / Math.cos(toRad(180 - runAngles[i]))));
    twaRows.push(Math.round(avgRun * 10) / 10);
    speeds.push(runSpeeds);
    twaRows.push(180);
    speeds.push(runSpeeds); // vlakke aanname tussen de diepste gemeten hoek en recht voor de wind
  }

  return { twsCols, twaRows, speeds };
}

// Neemt de ruwe bytes van een geuploade PDF en geeft er polar-data {twsCols, twaRows, speeds} uit.
async function parsePolarFromPdfBuffer(buffer) {
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    // De "Rated boat velocities in knots" tabel staat altijd op pagina 1 van een ORC-certificaat.
    // Latere pagina's herhalen dezelfde hoek-labels (bv. voor tijdstoeslagen in sec/zeemijl) met
    // heel andere waarden, dus expliciet tot pagina 1 beperken om die niet mee te lezen.
    const result = await parser.getText({ partial: [1] });
    return parseOrcPolarFromText(result.text);
  } finally {
    await parser.destroy();
  }
}

module.exports = { parseOrcPolarFromText, parsePolarFromPdfBuffer };
