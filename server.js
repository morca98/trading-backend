const express = require(‘express’);
const axios = require(‘axios’);
const fs = require(‘fs’);
const app = express();

app.use(function(req, res, next) {
res.header(‘Access-Control-Allow-Origin’, ‘*’);
res.header(‘Access-Control-Allow-Methods’, ‘GET, POST, OPTIONS’);
res.header(‘Access-Control-Allow-Headers’, ‘Content-Type’);
if (req.method === ‘OPTIONS’) return res.sendStatus(200);
next();
});
app.use(express.json());

const BINANCE = ‘https://api.binance.com’;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SYMBOLS = [‘BTCUSDT’, ‘ETHUSDT’];
const SIGNAL_COOLDOWN = 60 * 60 * 1000;
const MIN_SCORE = 10;
const MAX_SCORE = 16;
const STATS_FILE = ‘/tmp/stats.json’;

var lastSignal = { BTCUSDT: null, ETHUSDT: null };
var lastSignalTime = { BTCUSDT: 0, ETHUSDT: 0 };
var dailyResults = { BTCUSDT: [], ETHUSDT: [] };
var activeTrades = {};
var priceAlerts = [];

function loadStats() {
try {
if (fs.existsSync(STATS_FILE)) {
var data = JSON.parse(fs.readFileSync(STATS_FILE, ‘utf8’));
return { wins: data.wins || 0, losses: data.losses || 0, totalPnl: data.totalPnl || 0 };
}
} catch(e) {}
return { wins: 0, losses: 0, totalPnl: 0 };
}

function saveStats(wins, losses, pnl) {
try { fs.writeFileSync(STATS_FILE, JSON.stringify({ wins: wins, losses: losses, totalPnl: pnl })); } catch(e) {}
}

var stats = loadStats();
var winCount = stats.wins, lossCount = stats.losses, totalPnl = stats.totalPnl;

// ── API ───────────────────────────────────────────────────────────────────────
app.get(’/api/candles’, async function(req, res) {
try {
var symbol = req.query.symbol || ‘BTCUSDT’;
var interval = req.query.interval || ‘1h’;
var limit = Math.min(parseInt(req.query.limit) || 60, 1000);
var r = await axios.get(BINANCE + ‘/api/v3/klines?symbol=’ + symbol + ‘&interval=’ + interval + ‘&limit=’ + limit);
var candles = r.data.map(function(k) {
return { time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) };
});
res.json({ success: true, candles: candles });
} catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get(’/api/price’, async function(req, res) {
try {
var symbol = req.query.symbol || ‘BTCUSDT’;
var t = await axios.get(BINANCE + ‘/api/v3/ticker/price?symbol=’ + symbol);
var s = await axios.get(BINANCE + ‘/api/v3/ticker/24hr?symbol=’ + symbol);
res.json({ success: true, price: parseFloat(t.data.price), change: parseFloat(s.data.priceChangePercent) });
} catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Sinal completo com chamadas em PARALELO
app.get(’/api/signal’, async function(req, res) {
try {
var symbol = req.query.symbol || ‘BTCUSDT’;
var interval = req.query.interval || ‘30m’;

```
// Todas as chamadas em paralelo
var results = await Promise.all([
  axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=' + interval + '&limit=200'),
  axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + symbol),
  axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=4h&limit=50'),
  axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=15m&limit=30')
]);

var candles = results[0].data.map(function(k) {
  return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
});
var price = parseFloat(results[1].data.price);
var candles4h = results[2].data.map(function(k) { return { close: +k[4] }; });
var candles15m = results[3].data.map(function(k) { return { close: +k[4] }; });

var macroTrend = calcTrend(candles4h.map(function(c){return c.close;}));
var trend15m = calcTrend(candles15m.map(function(c){return c.close;}));
var atr = calcATR(candles, 14);
var signal = generateSignal(candles, price, macroTrend, trend15m, atr);

var closes = candles.map(function(c) { return c.close; });
var ema20vals = calcEMALine(closes, 20);
var ema50vals = calcEMALine(closes, 50);

res.json({
  success: true, signal: signal, price: price,
  candles: candles.slice(-60),
  ema20: ema20vals.slice(-60),
  ema50: ema50vals.slice(-60),
  macroTrend: macroTrend, trend15m: trend15m
});
```

} catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Orderbook
app.get(’/api/orderbook’, async function(req, res) {
try {
var symbol = req.query.symbol || ‘BTCUSDT’;
var r = await axios.get(BINANCE + ‘/api/v3/depth?symbol=’ + symbol + ‘&limit=20’);
var bids = r.data.bids.map(function(b) { return { price: parseFloat(b[0]), qty: parseFloat(b[1]) }; });
var asks = r.data.asks.map(function(a) { return { price: parseFloat(a[0]), qty: parseFloat(a[1]) }; });
var totalBid = bids.reduce(function(s, b) { return s + b.qty; }, 0);
var totalAsk = asks.reduce(function(s, a) { return s + a.qty; }, 0);
var ratio = totalBid / (totalBid + totalAsk) * 100;
res.json({ success: true, bids: bids, asks: asks, totalBid: totalBid, totalAsk: totalAsk, ratio: ratio.toFixed(1) });
} catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Backtest endpoint
app.get(’/api/backtest’, async function(req, res) {
try {
var symbol = req.query.symbol || ‘BTCUSDT’;
var r = await axios.get(BINANCE + ‘/api/v3/klines?symbol=’ + symbol + ‘&interval=30m&limit=1000’);
var candles = r.data.map(function(k) {
return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
});
var capital = 1000, wins = 0, losses = 0, maxCapital = 1000, maxDD = 0;
var trades = [];
for (var i = 60; i < candles.length - 1; i++) {
var window = candles.slice(0, i + 1);
var price = window[window.length - 1].close;
var atr = calcATR(window, 14);
var result = generateSignal(window, price, ‘NEUTRAL’, ‘NEUTRAL’, atr);
if (!result || result.conf < 75) continue;
var outcome = null, exitPrice = 0;
for (var j = i + 1; j < Math.min(i + 48, candles.length); j++) {
var next = candles[j];
if (result.signal === ‘BUY’) {
if (next.low <= result.sl) { outcome = ‘LOSS’; exitPrice = result.sl; break; }
if (next.high >= result.tp) { outcome = ‘WIN’; exitPrice = result.tp; break; }
} else {
if (next.high >= result.sl) { outcome = ‘LOSS’; exitPrice = result.sl; break; }
if (next.low <= result.tp) { outcome = ‘WIN’; exitPrice = result.tp; break; }
}
}
if (!outcome) continue;
var pnl = outcome === ‘WIN’ ? capital * 0.02 * 2.2 : -(capital * 0.02);
capital += pnl;
if (outcome === ‘WIN’) wins++; else losses++;
maxCapital = Math.max(maxCapital, capital);
maxDD = Math.max(maxDD, (maxCapital - capital) / maxCapital * 100);
trades.push({ signal: result.signal, outcome: outcome, entry: price, exit: exitPrice, pnl: pnl, capital: capital, time: candles[i].time });
}
var total = wins + losses;
res.json({
success: true, symbol: symbol,
total: total, wins: wins, losses: losses,
winRate: total > 0 ? Math.round(wins / total * 100) : 0,
capital: capital, maxDD: maxDD,
return: ((capital - 1000) / 1000 * 100),
trades: trades.slice(-50)
});
} catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get(’/api/stats’, function(req, res) {
var total = winCount + lossCount;
res.json({ success: true, wins: winCount, losses: lossCount, total: total, winRate: total > 0 ? Math.round(winCount / total * 100) : 0, totalPnl: totalPnl, activeTrades: Object.keys(activeTrades).length, dailyResults: dailyResults });
});

app.post(’/api/alert’, function(req, res) { priceAlerts.push(req.body); res.json({ success: true }); });

app.get(’/’, function(req, res) { res.json({ status: ‘ok’, version: ‘v7’ }); });

app.post(’/telegram’, async function(req, res) {
try {
var txt = req.body && req.body.message ? req.body.message.text : ‘’;
if (txt === ‘/status’) await sendStatus();
if (txt === ‘/backtest’ || txt === ‘/btc’) await runBacktest(‘BTCUSDT’);
if (txt === ‘/eth’) await runBacktest(‘ETHUSDT’);
res.json({ ok: true });
} catch (e) { res.json({ ok: false }); }
});

async function sendTelegram(msg) {
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
try { await axios.post(‘https://api.telegram.org/bot’ + TELEGRAM_TOKEN + ‘/sendMessage’, { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: ‘HTML’ }); } catch (e) {}
}

async function sendStatus() {
var total = winCount + lossCount;
var wr = total > 0 ? Math.round(winCount / total * 100) : 0;
var msg = ’<b>Bot v7</b>\nWin Rate: ’ + wr + ‘% (’ + winCount + ‘W/’ + lossCount + ’L)\nP&L: ’ + (totalPnl >= 0 ? ‘+’ : ‘’) + totalPnl.toFixed(2) + ’%\n\nAtivos: ’ + Object.keys(activeTrades).length;
await sendTelegram(msg);
}

// ── Indicadores ───────────────────────────────────────────────────────────────
function calcTrend(closes) {
if (closes.length < 20) return ‘NEUTRAL’;
var e20 = calcEMA(closes.slice(-20), 20);
var e50 = closes.length >= 50 ? calcEMA(closes.slice(-50), 50) : e20;
var last = closes[closes.length - 1];
if (last > e20 && e20 > e50) return ‘BULL’;
if (last < e20 && e20 < e50) return ‘BEAR’;
if (last > e20) return ‘UP’;
if (last < e20) return ‘DOWN’;
return ‘NEUTRAL’;
}

function calcRSI(closes, period) {
period = period || 14;
if (closes.length < period + 1) return 50;
var gains = 0, losses = 0;
for (var i = closes.length - period; i < closes.length; i++) {
var diff = closes[i] - closes[i - 1];
if (diff > 0) gains += diff; else losses -= diff;
}
var avgLoss = losses / period;
if (avgLoss === 0) return 100;
return 100 - 100 / (1 + (gains / period) / avgLoss);
}

function calcEMA(closes, period) {
var k = 2 / (period + 1), ema = closes[0];
for (var i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
return ema;
}

function calcEMALine(closes, period) {
var k = 2 / (period + 1), ema = closes[0], result = [];
for (var i = 0; i < closes.length; i++) {
if (i > 0) ema = closes[i] * k + ema * (1 - k);
result.push(ema);
}
return result;
}

function calcATR(candles, period) {
period = period || 14;
if (candles.length < period + 1) return 0;
var trs = [];
for (var i = 1; i < candles.length; i++) {
trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close)));
}
var atr = trs.slice(0, period).reduce(function(s, v) { return s + v; }, 0) / period;
for (var j = period; j < trs.length; j++) atr = (atr * (period - 1) + trs[j]) / period;
return atr;
}

function calcVP(candles) {
var prices = [];
candles.forEach(function(c) { prices.push(c.high); prices.push(c.low); });
var min = Math.min.apply(null, prices), max = Math.max.apply(null, prices);
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
bars.slice().sort(function(a, b) { return b.vol - a.vol; }).forEach(function(b) {
if (vaVol < totalVol * 0.7) { vaVol += b.vol; vaLow = Math.min(vaLow, b.price); vaHigh = Math.max(vaHigh, b.price); }
});
var avgVol = totalVol / bars.length;
return { poc: poc.price, val: vaLow, vah: vaHigh, lvns: bars.filter(function(b) { return b.vol < avgVol * 0.35; }), bars: bars, maxVol: Math.max.apply(null, bars.map(function(b) { return b.vol; })) };
}

function calcDynamicSL(candles, signal, price, atr) {
var slDist = atr * 1.5;
var lows = candles.slice(-5).map(function(c) { return c.low; });
var highs = candles.slice(-5).map(function(c) { return c.high; });
if (signal === ‘BUY’) return Math.max(Math.min(Math.min.apply(null, lows) * 0.999, price - slDist), price * 0.97);
return Math.min(Math.max(Math.max.apply(null, highs) * 1.001, price + slDist), price * 1.03);
}

function calcRSIDivergence(candles, rsi) {
var len = candles.length;
if (len < 10) return ‘NONE’;
var closes = candles.map(function(c) { return c.close; });
var prevRsi = calcRSI(closes.slice(0, -3), 14);
var prevPrice = closes[len - 4], curPrice = closes[len - 1];
if (curPrice > prevPrice && rsi < prevRsi && rsi > 55) return ‘BEARISH’;
if (curPrice < prevPrice && rsi > prevRsi && rsi < 45) return ‘BULLISH’;
return ‘NONE’;
}

function detectPattern(candles) {
var len = candles.length;
if (len < 3) return ‘NONE’;
var c = candles[len - 2], prev = candles[len - 3];
var body = Math.abs(c.close - c.open), range = c.high - c.low || 0.001;
var uw = c.high - Math.max(c.open, c.close), lw = Math.min(c.open, c.close) - c.low;
if (prev.close < prev.open && c.close > c.open && c.open < prev.close && c.close > prev.open) return ‘BULL_ENGULF’;
if (prev.close > prev.open && c.close < c.open && c.open > prev.close && c.close < prev.open) return ‘BEAR_ENGULF’;
if (lw > body * 2 && uw < body * 0.5 && c.close > c.open) return ‘HAMMER’;
if (uw > body * 2 && lw < body * 0.5 && c.close < c.open) return ‘SHOOT_STAR’;
if (lw > range * 0.6 && body < range * 0.3) return ‘PIN_BULL’;
if (uw > range * 0.6 && body < range * 0.3) return ‘PIN_BEAR’;
return ‘NONE’;
}

function isGoodSession() { return new Date().getUTCHours() >= 6 && new Date().getUTCHours() <= 22; }

function confirmCandle(candles, signal) {
var prev = candles[candles.length - 2];
if (!prev) return false;
return signal === ‘BUY’ ? prev.close > prev.open : prev.close < prev.open;
}

function generateSignal(candles, price, macroTrend, trend15m, atr) {
var closes = candles.map(function(c) { return c.close; });
var vp = calcVP(candles.slice(-200));
var rsi = calcRSI(closes);
var ema20 = calcEMA(closes.slice(-20), 20);
var ema50 = closes.length >= 50 ? calcEMA(closes.slice(-50), 50) : ema20;
var trend30m = closes[closes.length - 1] > closes[closes.length - 10] ? ‘UP’ : ‘DOWN’;
var rv = candles.slice(-5).reduce(function(s, c) { return s + c.volume; }, 0);
var pv = candles.slice(-10, -5).reduce(function(s, c) { return s + c.volume; }, 0);
var inVA = price >= vp.val && price <= vp.vah, abovePoc = price > vp.poc;
var divergence = calcRSIDivergence(candles, rsi);
var pattern = detectPattern(candles);
var nearLVN = vp.lvns.some(function(l) { return Math.abs(l.price - price) / price < 0.01; });

var buy = 0, sell = 0;
if (abovePoc && inVA) buy += 2; if (!abovePoc && inVA) sell += 2;
if (rsi < 35) buy += 3; else if (rsi < 45) buy += 1;
if (rsi > 65) sell += 3; else if (rsi > 55) sell += 1;
if (price > ema20 && price > ema50) buy += 2; else if (price < ema20 && price < ema50) sell += 2;
if (ema20 > ema50) buy += 1; else sell += 1;
if (trend30m === ‘UP’) buy += 1; else sell += 1;
if (rv > pv * 1.1) { buy += 1; sell += 1; }
if (macroTrend === ‘BULL’) buy += 2; if (macroTrend === ‘BEAR’) sell += 2;
if (trend15m === ‘UP’) buy += 1; if (trend15m === ‘DOWN’) sell += 1;
if (divergence === ‘BULLISH’) buy += 2; if (divergence === ‘BEARISH’) sell += 2;
if (pattern === ‘BULL_ENGULF’ || pattern === ‘HAMMER’ || pattern === ‘PIN_BULL’) buy += 2;
if (pattern === ‘BEAR_ENGULF’ || pattern === ‘SHOOT_STAR’ || pattern === ‘PIN_BEAR’) sell += 2;
if (nearLVN) { buy += 1; sell += 1; }

var signal = null;
if (buy >= MIN_SCORE && buy > sell + 2) signal = ‘BUY’;
if (sell >= MIN_SCORE && sell > buy + 2) signal = ‘SELL’;
if (!signal) return null;
if (signal === ‘BUY’ && macroTrend === ‘BEAR’ && buy < 12) return null;
if (signal === ‘SELL’ && macroTrend === ‘BULL’ && sell < 12) return null;
if (signal === ‘BUY’ && trend15m === ‘DOWN’ && macroTrend !== ‘BULL’) return null;
if (signal === ‘SELL’ && trend15m === ‘UP’ && macroTrend !== ‘BEAR’) return null;
if (!confirmCandle(candles, signal)) return null;

var conf = Math.min(95, Math.round(Math.max(buy, sell) / MAX_SCORE * 100));
var sl = calcDynamicSL(candles, signal, price, atr);
var slPct = Math.abs(price - sl) / price;
var tp = signal === ‘BUY’ ? price * (1 + slPct * 2.2) : price * (1 - slPct * 2.2);

return { signal: signal, conf: conf, price: price, sl: sl, tp: tp, rsi: rsi.toFixed(1), ema20: ema20.toFixed(2), ema50: ema50.toFixed(2), poc: vp.poc, val: vp.val, vah: vp.vah, macroTrend: macroTrend, trend15m: trend15m, trend30m: trend30m, divergence: divergence, pattern: pattern, atr: atr.toFixed(2), slPct: (slPct * 100).toFixed(2), tpPct: (slPct * 2.2 * 100).toFixed(2), buyScore: buy, sellScore: sell };
}

async function checkActiveTrades() {
var keys = Object.keys(activeTrades);
for (var i = 0; i < keys.length; i++) {
var symbol = keys[i], trade = activeTrades[symbol];
try {
var pr = await axios.get(BINANCE + ‘/api/v3/ticker/price?symbol=’ + symbol);
var price = parseFloat(pr.data.price), pair = symbol.replace(‘USDT’, ‘/USDT’);
var closed = false, pnl = 0, outcome = ‘’;
if (trade.signal === ‘BUY’) {
var hw = trade.entry + (trade.tp - trade.entry) * 0.5;
if (price >= hw && trade.sl < trade.entry) { trade.sl = trade.entry * 1.001; await sendTelegram(’<b>Trailing</b> ’ + pair + ’ SL $’ + trade.sl.toFixed(0)); }
if (price <= trade.sl) { pnl = (price - trade.entry) / trade.entry * 100; outcome = pnl >= 0 ? ‘BREAKEVEN’ : ‘LOSS’; closed = true; }
if (price >= trade.tp) { pnl = (price - trade.entry) / trade.entry * 100; outcome = ‘WIN’; closed = true; }
} else {
var hw2 = trade.entry - (trade.entry - trade.tp) * 0.5;
if (price <= hw2 && trade.sl > trade.entry) { trade.sl = trade.entry * 0.999; await sendTelegram(’<b>Trailing</b> ’ + pair + ’ SL $’ + trade.sl.toFixed(0)); }
if (price >= trade.sl) { pnl = (trade.entry - price) / trade.entry * 100; outcome = pnl >= 0 ? ‘BREAKEVEN’ : ‘LOSS’; closed = true; }
if (price <= trade.tp) { pnl = (trade.entry - price) / trade.entry * 100; outcome = ‘WIN’; closed = true; }
}
if (closed) {
if (outcome === ‘WIN’) winCount++; else lossCount++;
totalPnl += pnl;
saveStats(winCount, lossCount, totalPnl);
delete activeTrades[symbol];
await sendTelegram(’<b>’ + outcome + ’ ’ + pair + ’</b>\nP&L: ’ + (pnl >= 0 ? ‘+’ : ‘’) + pnl.toFixed(2) + ’%\nWin Rate: ’ + Math.round(winCount / (winCount + lossCount) * 100) + ‘%’);
}
} catch (e) {}
}
}

async function checkPriceAlerts() {
for (var i = priceAlerts.length - 1; i >= 0; i–) {
var alert = priceAlerts[i];
try {
var pr = await axios.get(BINANCE + ‘/api/v3/ticker/price?symbol=’ + alert.symbol);
var price = parseFloat(pr.data.price);
if ((alert.direction === ‘above’ && price >= alert.price) || (alert.direction === ‘below’ && price <= alert.price)) {
await sendTelegram(’<b>Alerta!</b>\n’ + alert.symbol.replace(‘USDT’, ‘/USDT’) + ’ $’ + price.toFixed(2));
priceAlerts.splice(i, 1);
}
} catch (e) {}
}
}

async function runBacktest(symbol) {
await sendTelegram(’<b>Backtest ’ + symbol.replace(‘USDT’, ‘/USDT’) + ‘</b>\nA processar…’);
try {
var r = await axios.get(BINANCE + ‘/api/v3/klines?symbol=’ + symbol + ‘&interval=30m&limit=1000’);
var candles = r.data.map(function(k) { return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }; });
var capital = 1000, wins = 0, losses = 0, maxDD = 0, maxCap = 1000;
for (var i = 60; i < candles.length - 1; i++) {
var w = candles.slice(0, i + 1), price = w[w.length - 1].close;
var result = generateSignal(w, price, ‘NEUTRAL’, ‘NEUTRAL’, calcATR(w, 14));
if (!result || result.conf < 75) continue;
var outcome = null;
for (var j = i + 1; j < Math.min(i + 48, candles.length); j++) {
var next = candles[j];
if (result.signal === ‘BUY’) { if (next.low <= result.sl) { outcome = ‘LOSS’; break; } if (next.high >= result.tp) { outcome = ‘WIN’; break; } }
else { if (next.high >= result.sl) { outcome = ‘LOSS’; break; } if (next.low <= result.tp) { outcome = ‘WIN’; break; } }
}
if (!outcome) continue;
var pnl = outcome === ‘WIN’ ? capital * 0.02 * 2.2 : -(capital * 0.02);
capital += pnl; if (outcome === ‘WIN’) wins++; else losses++;
maxCap = Math.max(maxCap, capital); maxDD = Math.max(maxDD, (maxCap - capital) / maxCap * 100);
}
var total = wins + losses, wr = total > 0 ? Math.round(wins / total * 100) : 0;
await sendTelegram(’<b>Backtest ’ + symbol.replace(‘USDT’, ‘/USDT’) + ’</b>\nTrades: ’ + total + ’\nWin Rate: ’ + wr + ‘%\n$1000 -> $’ + capital.toFixed(0) + ’\nRetorno: ’ + ((capital - 1000) / 1000 * 100).toFixed(1) + ’%\nMax DD: ’ + maxDD.toFixed(1) + ‘%\n’ + (wr >= 50 ? ‘LUCRATIVA’ : ‘Ajustar’));
} catch (e) { await sendTelegram(’Erro: ’ + e.message); }
}

async function runBot() {
if (!isGoodSession()) return;
await checkActiveTrades();
await checkPriceAlerts();
for (var i = 0; i < SYMBOLS.length; i++) {
var symbol = SYMBOLS[i];
if (activeTrades[symbol]) continue;
try {
var results = await Promise.all([
axios.get(BINANCE + ‘/api/v3/klines?symbol=’ + symbol + ‘&interval=30m&limit=200’),
axios.get(BINANCE + ‘/api/v3/ticker/price?symbol=’ + symbol),
axios.get(BINANCE + ‘/api/v3/klines?symbol=’ + symbol + ‘&interval=4h&limit=50’),
axios.get(BINANCE + ‘/api/v3/klines?symbol=’ + symbol + ‘&interval=15m&limit=30’)
]);
var candles = results[0].data.map(function(k) { return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }; });
var price = parseFloat(results[1].data.price);
var macroTrend = calcTrend(results[2].data.map(function(k) { return +k[4]; }));
var trend15m = calcTrend(results[3].data.map(function(k) { return +k[4]; }));
var atr = calcATR(candles, 14);
var result = generateSignal(candles, price, macroTrend, trend15m, atr);
var pair = symbol.replace(‘USDT’, ‘/USDT’);
if (!result || result.conf < 80) { console.log(pair + ‘: WAIT’); continue; }
var now = Date.now();
if (lastSignal[symbol] === result.signal && (now - lastSignalTime[symbol]) < SIGNAL_COOLDOWN) continue;
lastSignal[symbol] = result.signal; lastSignalTime[symbol] = now;
dailyResults[symbol].push({ signal: result.signal, conf: result.conf });
activeTrades[symbol] = { pair: pair, signal: result.signal, entry: price, sl: result.sl, tp: result.tp };
var msg = ‘<b>’ + result.signal + ’ ’ + pair + ‘</b>\n\nPreco: $’ + price.toFixed(2) + ‘\nStop: $’ + result.sl.toFixed(0) + ’ (-’ + result.slPct + ‘%)\nAlvo: $’ + result.tp.toFixed(0) + ’ (+’ + result.tpPct + ’%)\nConf: ’ + result.conf + ’% | Score: ’ + Math.max(result.buyScore, result.sellScore) + ‘/16\nRSI: ’ + result.rsi + ’ | ATR: $’ + result.atr + ‘\nMacro: ’ + result.macroTrend + ’ | 15m: ’ + result.trend15m + ‘\nPOC: $’ + result.poc.toFixed(0) + ’ VA: $’ + result.val.toFixed(0) + ‘-$’ + result.vah.toFixed(0) + ‘\n’ + new Date().toLocaleTimeString(‘pt-PT’);
await sendTelegram(msg);
console.log(pair + ‘: ’ + result.signal + ’ conf=’ + result.conf);
} catch (e) { console.error(’Erro ’ + symbol + ‘:’, e.message); }
}
}

async function sendDailyReport() {
var h = new Date().getUTCHours(), m = new Date().getUTCMinutes();
if (h !== 8 || m > 5) return;
var total = winCount + lossCount, wr = total > 0 ? Math.round(winCount / total * 100) : 0;
var msg = ’<b>Relatorio Diario</b>\nWin Rate: ’ + wr + ’% | P&L: ’ + (totalPnl >= 0 ? ‘+’ : ‘’) + totalPnl.toFixed(2) + ‘%\n\n’;
for (var i = 0; i < SYMBOLS.length; i++) {
var sym = SYMBOLS[i], res = dailyResults[sym];
if (res.length) { var b = res.filter(function(r) { return r.signal === ‘BUY’; }).length; msg += sym.replace(‘USDT’, ‘/USDT’) + ‘: ’ + res.length + ’ (’ + b + ‘B/’ + (res.length - b) + ‘S)\n’; dailyResults[sym] = []; }
}
await sendTelegram(msg);
}

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
console.log(‘Server v7 porta ’ + PORT);
sendTelegram(’<b>Bot v7!</b>\nParalelo: sinais 3x mais rapidos\nOrderbook API\nBacktest via site\nNotificacoes browser\n\n/status /backtest /btc /eth’);
runBot();
setInterval(runBot, 5 * 60 * 1000);
setInterval(sendDailyReport, 5 * 60 * 1000);
setTimeout(function() { runBacktest(‘BTCUSDT’); }, 20000);
});
