const { parsePolarFromPdfBuffer } = require("../lib/orcParser");

async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body; // als het platform 'm al voorgeparsed heeft
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Alleen POST" });
    return;
  }
  try {
    const buffer = await readRawBody(req);
    if (!buffer.length) {
      res.status(400).json({ error: "Geen bestand ontvangen" });
      return;
    }
    const polar = await parsePolarFromPdfBuffer(buffer);
    res.status(200).json(polar);
  } catch (err) {
    res.status(400).json({ error: err.message || "Kon PDF niet verwerken" });
  }
};

module.exports.config = { api: { bodyParser: false } };
