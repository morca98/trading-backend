const axios = require(“axios”);

// ─── Config ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE          = “https://api.binance.com”;
const SYMBOLS          = [“BTCUSDT”, “ETHUSDT”];
const INTERVAL         = “30m”;
const CAPITAL          = 1000;
const RISCO            = 0.02;

// ─── Telegram ─────────────────────────────────────────────────────────────────
async function sendTelegram(msg) {
try {
await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
chat_id: TELEGRAM_CHAT_ID,
text: msg,
parse_mode: “HTML”,
});
console.log(“Telegram enviado:”, msg.slice(0, 50));
} catch (e) {
console.error(“Erro Telegram:”, e.message);
}
}

// ─── Binance API ──────────────────────────────────────────────────────────────
async function fetchCandles(symbol, limit = 100) {
const { data } = await axios.get(
`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=${limit}`
);
return data.map(k => ({
time: k[0], open: +k[1], high: +k[2],
low: +k[3], close: +k[4], volume: +k[5],
}));
}

async function fetchPrice(symbol) {
const { data } = await axios.get(`${BINANCE}/api/v3/ticker/price?symbol=${symbol}`);
return parseFloat(data.price);
}

// ─── Indicadores ──────────────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
if (closes.length < period + 1) return 50;
let gains = 0, losses = 0;
for (let i = closes.length - period; i < closes.length; i++) {
const diff = closes[i] - closes[i - 1];
if (diff > 0) gains += diff; else losses -= diff;
}
const avgGain = gains / period, avgLoss = losses / period;
if (avgLoss === 0) return 100;
return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcEMA(closes, period) {
const k = 2 / (period + 1);
let ema = closes[0];
for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
return ema;
}

function calcMACD(closes) {
if (closes.length < 26) return { hist: 0 };
const ema12 = calcEMA(closes.slice(-26), 12);
const ema26 = calcEMA(closes.slice(-26), 26);
const macd  = ema12 - ema26;
const signal = calcEMA([…Array(8).fill(macd)], 9);
return { macd, signal, hist: macd - signal };
}

function calcVP(candles) {
const prices = candles.flatMap(c => [c.high, c.low]);
const min = Math.min(…prices), max = Math.max(…prices);
const N = 20, step = (max - min) / N;
const bars = Array.from({ length: N }, (_, i) => ({ price: min + step * (i + 0.5), vol: 0 }));
candles.forEach(c => {
const i = Math.min(Math.floor(((c.high + c.low) / 2 - min) / step), N - 1);
bars[i].vol += c.volume;
});
const totalVol = bars.reduce((s, b) => s + b.vol, 0);
const poc = bars.reduce((a, b) => b.vol > a.vol ? b : a);
let vaVol = 0, vaLow = poc.price, vaHigh = poc.price;
for (const b of […bars].sort((a, b) => b.vol - a.vol)) {
vaVol += b.vol;
vaLow  = Math.min(vaLow,  b.price);
vaHigh = Math.max(vaHigh, b.price);
if (vaVol >= totalVol * 0.7) break;
}
return { poc: poc.price, val: vaLow, vah: vaHigh };
}

// ─── Gerador de Sinal ─────────────────────────────────────────────────────────
function generateSignal(candles, price) {
const closes   = candles.map(c => c.close);
const { poc, val, vah } = calcVP(candles.slice(-20));
const rsi      = calcRSI(closes);
const ema20    = calcEMA(closes.slice(-20), 20);
const ema50    = calcEMA(closes.slice(-50), 50);
const { hist } = calcMACD(closes);
const trend    = closes[closes.length - 1] > closes[closes.length - 10] ? “UP” : “DOWN”;
const rv       = candles.slice(-5).reduce((s, c) => s + c.volume, 0);
const pv       = candles.slice(-10, -5).reduce((s, c) => s + c.volume, 0);
const volMom   = rv > pv * 1.1 ? “HIGH” : rv < pv * 0.9 ? “LOW” : “NORMAL”;
const inVA     = price >= val && price <= vah;
const abovePoc = price > poc;

let buyScore = 0, sellScore = 0;

if (abovePoc && inVA)            buyScore  += 2;
if (!abovePoc && inVA)           sellScore += 2;
if (rsi < 35)                    buyScore  += 3;
else if (rsi < 45)               buyScore  += 1;
if (rsi > 65)                    sellScore += 3;
else if (rsi > 55)               sellScore += 1;
if (price > ema20 && price > ema50) buyScore  += 2;
if (price < ema20 && price < ema50) sellScore += 2;
if (ema20 > ema50)               buyScore  += 1;
if (ema20 < ema50)               sellScore += 1;
if (hist > 0)                    buyScore  += 2;
if (hist < 0)                    sellScore += 2;
if (trend === “UP”)              buyScore  += 1;
if (trend === “DOWN”)            sellScore += 1;
if (volMom === “HIGH”) { buyScore += 1; sellScore += 1; }

const maxScore = 12;
let signal = null;
if (buyScore  >= 7 && buyScore  > sellScore + 2) signal = “BUY”;
if (sellScore >= 7 && sellScore > buyScore  + 2) signal = “SELL”;
if (!signal) return null;

const conf  = Math.min(95, Math.round((Math.max(buyScore, sellScore) / maxScore) * 100));
const slPct = 0.012;
const tpPct = slPct * 2.2;
const sl    = signal === “BUY” ? price * (1 - slPct) : price * (1 + slPct);
const tp    = signal === “BUY” ? price * (1 + tpPct) : price * (1 - tpPct);
const pnlWin  = CAPITAL * RISCO * 2.2;
const pnlLoss = CAPITAL * RISCO;

return { signal, conf, price, sl, tp, rsi: rsi.toFixed(1), pnlWin, pnlLoss, poc, val, vah };
}

// ─── Análise principal ────────────────────────────────────────────────────────
async function analyse() {
console.log(`[${new Date().toISOString()}] A analisar...`);

for (const symbol of SYMBOLS) {
try {
const [candles, price] = await Promise.all([
fetchCandles(symbol, 100),
fetchPrice(symbol),
]);

```
  const result = generateSignal(candles, price);
  const pair   = symbol.replace("USDT", "/USDT");

  if (!result) {
    console.log(`${pair}: WAIT — sem sinal`);
    continue;
  }

  const { signal, conf, sl, tp, rsi, pnlWin, pnlLoss, poc } = result;
  const icon = signal === "BUY" ? "🟢" : "🔴";

  const msg = `${icon} <b>${signal} ${pair}</b>\n\n`
    + `💰 <b>Preco:</b> $${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}\n`
    + `🎯 <b>Entrada:</b> $${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}\n`
    + `🛑 <b>Stop Loss:</b> $${sl.toLocaleString("en-US", { maximumFractionDigits: 0 })}\n`
    + `✅ <b>Take Profit:</b> $${tp.toLocaleString("en-US", { maximumFractionDigits: 0 })}\n`
    + `📊 <b>R/R:</b> 1:2.2\n`
    + `💡 <b>Confianca:</b> ${conf}%\n`
    + `📈 <b>RSI:</b> ${rsi}\n`
    + `📍 <b>POC:</b> $${poc.toFixed(0)}\n\n`
    + `💵 WIN: +$${pnlWin.toFixed(2)} | LOSS: -$${pnlLoss.toFixed(2)}\n`
    + `⏰ ${new Date().toLocaleTimeString("pt-PT")}`;

  await sendTelegram(msg);
  console.log(`${pair}: ${signal} @ $${price}`);

} catch (e) {
  console.error(`Erro ${symbol}:`, e.message);
}
```

}
}

// ─── Start ────────────────────────────────────────────────────────────────────
async function main() {
console.log(“Bot iniciado — analise a cada 30 minutos”);
await sendTelegram(“🤖 <b>Crypto AI Bot iniciado!</b>\n\nA analisar BTC/USDT e ETH/USDT a cada 30 minutos. 🔔”);
await analyse();
setInterval(analyse, 30 * 60 * 1000);
}

main().catch(console.error);
