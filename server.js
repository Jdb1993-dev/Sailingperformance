// Lokale/self-hosted server, zonder framework-dependencies (puur Node http),
// zodat er niets is dat Vercel's auto-detectie op het verkeerde spoor kan zetten.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { getWindResponse, getSpotList, DEFAULT_STATION_CODE } = require("./lib/wind");
const { parsePolarFromPdfBuffer } = require("./lib/orcParser");

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;

// De statische app-bestanden staan in de project-root (zelfde plek als Vercel ze verwacht
// zonder buildstap). Alleen dit vaste lijstje wordt geserveerd, zodat server.js/lib/api/
// package.json etc. nooit per ongeluk als bestand opvraagbaar zijn.
const ALLOWED_FILES = new Set([
  "index.html",
  "style.css",
  "app.js",
  "polar.js",
  "manifest.json",
  "sw.js",
  "icons/icon.svg",
  "waypoints.gpx",
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".gpx": "application/gpx+xml",
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const relPath = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");

  if (!ALLOWED_FILES.has(relPath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const filePath = path.join(ROOT_DIR, relPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/wind")) {
    const url = new URL(req.url, "http://x");
    const station = url.searchParams.get("station") || DEFAULT_STATION_CODE;
    const { status, body } = await getWindResponse(station);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
    return;
  }

  if (req.url.startsWith("/api/spots")) {
    try {
      const spots = await getSpotList();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ spots }));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Kan spotlijst niet ophalen: " + err.message }));
    }
    return;
  }

  if (req.url.startsWith("/api/parse-orc") && req.method === "POST") {
    try {
      const buffer = await readRawBody(req);
      if (!buffer.length) throw new Error("Geen bestand ontvangen");
      const polar = await parsePolarFromPdfBuffer(buffer);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(polar));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message || "Kon PDF niet verwerken" }));
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Sailing Performance app draait op http://localhost:${PORT}`);
});
