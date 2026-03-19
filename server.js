/**

- ============================================
- BINANCE TRADING BOT — BACKEND SEGURO
- Node.js + Express + WebSocket
- ============================================
- Instalação:
- npm install express cors axios crypto-js dotenv ws
- node server.js
  */

require(“dotenv”).config();
const express = require(“express”);
const cors = require(“cors”);
const axios = require(“axios”);
const crypto = require(“crypto”);
const WebSocket = require(“ws”);

const app = express();
app.use(cors({ origin: “http://localhost:3000” })); // só aceita seu frontend
app.use(express.json());

const BASE_URL = “https://api.binance.com”;
const API_KEY = process.env.BINANCE_API_KEY;
const SECRET_KEY = process.env.BINANCE_SECRET_KEY;

// ─── Utilitário: assinar requisições ────────────────────────────────────────
function sign(queryString) {
return crypto
.createHmac(“sha256”, SECRET_KEY)
.update(queryString)
.digest(“hex”);
}

// ─── GET /api/candles?symbol=BTCUSDT&interval=1h&limit=60 ───────────────────
// Dados de mercado — NÃO requer assinatura
app.get(”/api/candles”, async (req, res) => {
try {
const { symbol = “BTCUSDT”, interval = “1h”, limit = 60 } = req.query;
const url = `${BASE_URL}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
const { data } = await axios.get(url);

```
// Normalizar formato
const candles = data.map((k) => ({
  time: k[0],
  open: parseFloat(k[1]),
  high: parseFloat(k[2]),
  low: parseFloat(k[3]),
  close: parseFloat(k[4]),
  volume: parseFloat(k[5]),
}));

res.json({ success: true, candles });
```

} catch (err) {
res.status(500).json({ success: false, error: err.message });
}
});

// ─── GET /api/price?symbol=BTCUSDT ──────────────────────────────────────────
app.get(”/api/price”, async (req, res) => {
try {
const { symbol = “BTCUSDT” } = req.query;
const { data } = await axios.get(`${BASE_URL}/api/v3/ticker/price?symbol=${symbol}`);
res.json({ success: true, price: parseFloat(data.price) });
} catch (err) {
res.status(500).json({ success: false, error: err.message });
}
});

// ─── GET /api/account ───────────────────────────────────────────────────────
// Saldo da conta — requer assinatura
app.get(”/api/account”, async (req, res) => {
try {
const timestamp = Date.now();
const query = `timestamp=${timestamp}`;
const signature = sign(query);

```
const { data } = await axios.get(
  `${BASE_URL}/api/v3/account?${query}&signature=${signature}`,
  { headers: { "X-MBX-APIKEY": API_KEY } }
);

// Retornar apenas saldos não-zero
const balances = data.balances.filter(
  (b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0
);

res.json({ success: true, balances });
```

} catch (err) {
res.status(500).json({ success: false, error: err.message });
}
});

// ─── POST /api/order ────────────────────────────────────────────────────────
// Criar ordem — requer assinatura
// Body: { symbol, side, type, quantity, price? }
app.post(”/api/order”, async (req, res) => {
try {
const { symbol, side, type = “MARKET”, quantity, price } = req.body;

```
if (!symbol || !side || !quantity) {
  return res.status(400).json({ success: false, error: "Parâmetros inválidos" });
}

const timestamp = Date.now();
let params = `symbol=${symbol}&side=${side}&type=${type}&quantity=${quantity}&timestamp=${timestamp}`;

if (type === "LIMIT" && price) {
  params += `&price=${price}&timeInForce=GTC`;
}

const signature = sign(params);

const { data } = await axios.post(
  `${BASE_URL}/api/v3/order?${params}&signature=${signature}`,
  null,
  { headers: { "X-MBX-APIKEY": API_KEY } }
);

res.json({ success: true, order: data });
```

} catch (err) {
const msg = err.response?.data?.msg || err.message;
res.status(500).json({ success: false, error: msg });
}
});

// ─── GET /api/orders?symbol=BTCUSDT ─────────────────────────────────────────
// Histórico de ordens abertas
app.get(”/api/orders”, async (req, res) => {
try {
const { symbol = “BTCUSDT” } = req.query;
const timestamp = Date.now();
const query = `symbol=${symbol}&timestamp=${timestamp}`;
const signature = sign(query);

```
const { data } = await axios.get(
  `${BASE_URL}/api/v3/openOrders?${query}&signature=${signature}`,
  { headers: { "X-MBX-APIKEY": API_KEY } }
);

res.json({ success: true, orders: data });
```

} catch (err) {
res.status(500).json({ success: false, error: err.message });
}
});

// ─── DELETE /api/order ───────────────────────────────────────────────────────
// Cancelar ordem
app.delete(”/api/order”, async (req, res) => {
try {
const { symbol, orderId } = req.body;
const timestamp = Date.now();
const query = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
const signature = sign(query);

```
const { data } = await axios.delete(
  `${BASE_URL}/api/v3/order?${query}&signature=${signature}`,
  { headers: { "X-MBX-APIKEY": API_KEY } }
);

res.json({ success: true, order: data });
```

} catch (err) {
res.status(500).json({ success: false, error: err.message });
}
});

// ─── WebSocket Proxy — preço em tempo real ──────────────────────────────────
// Conecta na Binance e repassa para os clientes do frontend
const wss = new WebSocket.Server({ port: 8080 });
const binanceStreams = new Map();

wss.on(“connection”, (clientWs) => {
console.log(“Frontend conectado ao WebSocket proxy”);

clientWs.on(“message”, (msg) => {
const { action, symbol } = JSON.parse(msg);
const stream = `${symbol.toLowerCase()}@ticker`;

```
if (action === "subscribe") {
  if (binanceStreams.has(symbol)) return;

  const binanceWs = new WebSocket(
    `wss://stream.binance.com:9443/ws/${stream}`
  );

  binanceWs.on("message", (data) => {
    const ticker = JSON.parse(data);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        symbol,
        price: parseFloat(ticker.c),
        change: parseFloat(ticker.P),
        volume: parseFloat(ticker.v),
      }));
    }
  });

  binanceStreams.set(symbol, binanceWs);
}

if (action === "unsubscribe") {
  const ws = binanceStreams.get(symbol);
  if (ws) { ws.close(); binanceStreams.delete(symbol); }
}
```

});

clientWs.on(“close”, () => {
binanceStreams.forEach((ws) => ws.close());
binanceStreams.clear();
});
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
console.log(`✅ Backend rodando em http://localhost:${PORT}`);
console.log(`✅ WebSocket proxy em ws://localhost:8080`);
});
