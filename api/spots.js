const { getSpotList } = require("../lib/wind");

module.exports = async (req, res) => {
  try {
    const spots = await getSpotList();
    res.status(200).json({ spots });
  } catch (err) {
    res.status(502).json({ error: "Kan spotlijst niet ophalen: " + err.message });
  }
};
