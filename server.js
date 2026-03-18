const express = require(“express”);
const cors = require(“cors”);
const axios = require(“axios”);

const app = express();

app.use((req, res, next) => {
res.header(“Access-Control-Allow-Origin”, “*”);
res.header(“Access-Control-Allow-Methods”, “GET, OPTIONS”);
res.header(“Access-Control-Allow-Headers”, “Content-Type”);
if (req.method === “OPTIONS”) return res.sendStatus(200);
next();
});
app.use(express.json());

const BINANCE = “https://api.binance.com”;

app.get(”/api/candles”, async (req, res) => {
try {
const { symbol = “BTCUSDT”, interval = “1h”, limit = 60 } = req.query;
const { data } = await axios.get(
`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
);
const candles = data.map((k) => ({
time:   k[0],
open:   parseFloat(k[1]),
high:   parseFloat(k[2]),
low:    parseFloat(k[3]),
close:  parseFloat(k[4]),
volume: parseFloat(k[5]),
}));
res.json({ success: true, candles });
} catch (err) {
res.status(500).json({ success: false, error: err.message });
}
});

app.get(”/api/price”, async (req, res) => {
try {
const { symbol = “BTCUSDT” } = req.query;
const [ticker, stats] = await Promise.all([
axios.get(`${BINANCE}/api/v3/ticker/price?symbol=${symbol}`),
axios.get(`${BINANCE}/api/v3/ticker/24hr?symbol=${symbol}`),
]);
res.json({
success: true,
price:  parseFloat(ticker.data.price),
change: parseFloat(stats.data.priceChangePercent),
});
} catch (err) {
res.status(500).json({ success: false, error: err.message });
}
});

app.get(”/”, (req, res) => res.json({ status: “ok” }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(“Server running on port “ + PORT));
