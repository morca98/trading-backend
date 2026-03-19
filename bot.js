const axios = require(“axios”);

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE = “https://api.binance.com”;
const SYMBOLS = [“BTCUSDT”, “ETHUSDT”];
const INTERVAL = “30m”;
const CAPITAL = 1000;
const RISCO = 0.02;

async function sendTelegram(msg) {
try {
await axios.post(“https://api.telegram.org/bot” + TELEGRAM_TOKEN + “/sendMessage”, {
chat_id: TELEGRAM_CHAT_ID,
text: msg,
parse_mode: “HTML”,
});
console.log(“Telegram enviado”);
} catch (e) {
console.error(“Erro Telegram:”, e.message);
}
}

async function fetchCandles(symbol, limit) {
const { data } = await axios.get(
BINANCE + “/api/v3/klines?symbol=” + symbol + “&interval=” + INTERVAL + “&limit=” + limit
);
return data.map(function(k) {
return { time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
});
}

async function fetchPrice(symbol) {
const { data } = await axios.get(BINANCE + “/api/v3/ticker/price?symbol=” + symbol);
return parseFloat(data.price);
}

function calcRSI(closes, period) {
period = period || 14;
if (closes.length < period + 1) return 50;
var gains = 0, losses = 0;
for (var i = closes.length - period; i < closes.length; i++) {
var diff = closes[i] - closes[i - 1];
if (diff > 0) gains += diff; else losses -= diff;
}
var avgGain = gains / period, avgLoss = losses / period;
if (avgLoss === 0) return 100;
return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcEMA(closes, period) {
var k = 2 / (period + 1);
var ema = closes[0];
for (var i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
return ema;
}

function calcMACD(closes) {
if (closes.length < 26) return { hist: 0 };
var ema12 = calcEMA(closes.slice(-26), 12);
var ema26 = calcEMA(closes.slice(-26), 26);
var macd = ema12 - ema26;
var signal = calcEMA([macd, macd, macd, macd, macd, macd, macd, macd, macd], 9);
return { hist: macd - signal };
}

function calcVP(candles) {
var prices = [];
candles.forEach(function(c) { prices.push(c.high); prices.push(c.low); });
var min = Math.min.apply(null, prices);
var max = Math.max.apply(null, prices);
var N = 20, step = (max - min) / N;
var bars = [];
for (var i = 0; i < N; i++) bars.push({ price: min + step * (i + 0.5), vol: 0 });
candles.forEach(function(c) {
var idx = Math.min(Math.floor(((c.high + c.low) / 2 - min) / step), N - 1);
bars[idx].vol += c.volume;
});
var totalVol = bars.reduce(function(s, b) { return s + b.vol; }, 0);
var poc = bars.reduce(function(a, b) { return b.vol > a.vol ? b : a; });
var vaVol = 0, vaLow = poc.price, vaHigh = poc.price;
var sorted = bars.slice().sort(function(a, b) { return b.vol - a.vol; });
for (var j = 0; j < sorted.length; j++) {
vaVol += sorted[j].vol;
vaLow = Math.min(vaLow, sorted[j].price);
vaHigh = Math.max(vaHigh, sorted[j].price);
if (vaVol >= totalVol * 0.7) break;
}
return { poc: poc.price, val: vaLow, vah: vaHigh };
}

function generateSignal(candles, price) {
var closes = candles.map(function(c) { return c.close; });
var vp = calcVP(candles.slice(-20));
var poc = vp.poc, val = vp.val, vah = vp.vah;
var rsi = calcRSI(closes);
var ema20 = calcEMA(closes.slice(-20), 20);
var ema50 = calcEMA(closes.slice(-50), 50);
var macd = calcMACD(closes);
var trend = closes[closes.length - 1] > closes[closes.length - 10] ? “UP” : “DOWN”;
var rv = candles.slice(-5).reduce(function(s, c) { return s + c.volume; }, 0);
var pv = candles.slice(-10, -5).reduce(function(s, c) { return s + c.volume; }, 0);
var volMom = rv > pv * 1.1 ? “HIGH” : rv < pv * 0.9 ? “LOW” : “NORMAL”;
var inVA = price >= val && price <= vah;
var abovePoc = price > poc;

var buyScore = 0, sellScore = 0;
if (abovePoc && inVA) buyScore += 2;
if (!abovePoc && inVA) sellScore += 2;
if (rsi < 35) buyScore += 3; else if (rsi < 45) buyScore += 1;
if (rsi > 65) sellScore += 3; else if (rsi > 55) sellScore += 1;
if (price > ema20 && price > ema50) buyScore += 2;
if (price < ema20 && price < ema50) sellScore += 2;
if (ema20 > ema50) buyScore += 1; else sellScore += 1;
if (macd.hist > 0) buyScore += 2; else sellScore += 2;
if (trend === “UP”) buyScore += 1; else sellScore += 1;
if (volMom === “HIGH”) { buyScore += 1; sellScore += 1; }

var signal = null;
if (buyScore >= 7 && buyScore > sellScore + 2) signal = “BUY”;
if (sellScore >= 7 && sellScore > buyScore + 2) signal = “SELL”;
if (!signal) return null;

var conf = Math.min(95, Math.round((Math.max(buyScore, sellScore) / 12) * 100));
var slPct = 0.012, tpPct = slPct * 2.2;
var sl = signal === “BUY” ? price * (1 - slPct) : price * (1 + slPct);
var tp = signal === “BUY” ? price * (1 + tpPct) : price * (1 - tpPct);

return { signal: signal, conf: conf, price: price, sl: sl, tp: tp, rsi: rsi.toFixed(1), poc: poc };
}

async function analyse() {
console.log(“A analisar… “ + new Date().toISOString());
for (var s = 0; s < SYMBOLS.length; s++) {
var symbol = SYMBOLS[s];
try {
var candles = await fetchCandles(symbol, 100);
var price = await fetchPrice(symbol);
var result = generateSignal(candles, price);
var pair = symbol.replace(“USDT”, “/USDT”);


  if (!result) {
    console.log(pair + ": WAIT");
    continue;
  }

  var icon = result.signal === "BUY" ? "GREEN" : "RED";
  var emoji = result.signal === "BUY" ? "\u{1F7E2}" : "\u{1F534}";

  var msg = emoji + " <b>" + result.signal + " " + pair + "</b>\n\n"
    + "\uD83D\uDCB0 <b>Preco:</b> $" + price.toFixed(2) + "\n"
    + "\uD83C\uDFAF <b>Entrada:</b> $" + price.toFixed(0) + "\n"
    + "\uD83D\uDED1 <b>Stop Loss:</b> $" + result.sl.toFixed(0) + "\n"
    + "\u2705 <b>Take Profit:</b> $" + result.tp.toFixed(0) + "\n"
    + "\uD83D\uDCCA <b>R/R:</b> 1:2.2\n"
    + "\uD83D\uDCA1 <b>Confianca:</b> " + result.conf + "%\n"
    + "\uD83D\uDCC8 <b>RSI:</b> " + result.rsi + "\n"
    + "\uD83D\uDCCD <b>POC:</b> $" + result.poc.toFixed(0) + "\n"
    + "\u23F0 " + new Date().toLocaleTimeString("pt-PT");

  await sendTelegram(msg);
  console.log(pair + ": " + result.signal + " @ $" + price);
} catch (e) {
  console.error("Erro " + symbol + ":", e.message);
}

}
}

async function main() {
console.log(“Bot iniciado”);
await sendTelegram(”\uD83E\uDD16 <b>Crypto AI Bot iniciado!</b>\n\nA analisar BTC/USDT e ETH/USDT a cada 30 minutos.”);
await analyse();
setInterval(analyse, 30 * 60 * 1000);
}

main().catch(console.error);
