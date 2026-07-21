const { getWindResponse, DEFAULT_STATION_CODE } = require("../lib/wind");

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://x");
  const station = url.searchParams.get("station") || DEFAULT_STATION_CODE;
  const { status, body } = await getWindResponse(station);
  res.status(status).json(body);
};
