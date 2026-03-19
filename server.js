const express = require('express');
const axios = require('axios');
const fs = require('fs');
const app = express();

app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

const BINANCE = 'https://api.binance.com';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const SIGNAL_COOLDOWN = 60 * 60 * 1000;
const MIN_SCORE = 10;
const MAX_SCORE = 16;
const STATS_FILE = '/tmp/stats.json';

var lastSignal = { BTCUSDT: null, ETHUSDT: null };
var lastSignalTime = { BTCUSDT: 0, ETHUSDT: 0 };
var dailyResults = { BTCUSDT: [], ETHUSDT: [] };
var activeTrades = {};
var priceAlerts = [];

// Persistencia de stats
function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      var data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      return { wins: data.wins || 0, losses: data.losses || 0, totalPnl: data.totalPnl || 0 };
    }
  } catch(e) {}
  return { wins: 0, losses: 0, totalPnl: 0 };
}

function saveStats(wins, losses, pnl) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify({ wins: wins, losses: losses, totalPnl: pnl }));
  } catch(e) {}
}

var stats = loadStats();
var winCount = stats.wins, lossCount = stats.losses, totalPnl = stats.totalPnl;

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/candles', async function(req, res) {
  try {
    var symbol = req.query.symbol || 'BTCUSDT';
    var interval = req.query.interval || '1h';
    var limit = Math.min(parseInt(req.query.limit) || 60, 1000);
    var r = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=' + interval + '&limit=' + limit);
    var candles = r.data.map(function(k) {
      return { time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) };
    });
    res.json({ success: true, candles: candles });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/price', async function(req, res) {
  try {
    var symbol = req.query.symbol || 'BTCUSDT';
    var t = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + symbol);
    var s = await axios.get(BINANCE + '/api/v3/ticker/24hr?symbol=' + symbol);
    res.json({ success: true, price: parseFloat(t.data.price), change: parseFloat(s.data.priceChangePercent) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Sinal completo com todos os indicadores
app.get('/api/signal', async function(req, res) {
  try {
    var symbol = req.query.symbol || 'BTCUSDT';
    var interval = req.query.interval || '30m';
    var resp = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=' + interval + '&limit=200');
    var candles = resp.data.map(function(k) {
      return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
    });
    var pr = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + symbol);
    var price = parseFloat(pr.data.price);
    var atr = calcATR(candles, 14);
    var macroTrend = await getMacroTrend(symbol);
    var trend15m = await get15mTrend(symbol);
    var result = generateSignal(candles, price, macroTrend, trend15m, atr);
    var closes = candles.map(function(c) { return c.close; });
    var ema20vals = calcEMALine(closes, 20);
    var ema50vals = calcEMALine(closes, 50);
    res.json({
      success: true,
      signal: result,
      price: price,
      candles: candles.slice(-60),
      ema20: ema20vals.slice(-60),
      ema50: ema50vals.slice(-60),
      macroTrend: macroTrend,
      trend15m: trend15m
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/stats', function(req, res) {
  var total = winCount + lossCount;
  res.json({
    success: true,
    wins: winCount, losses: lossCount, total: total,
    winRate: total > 0 ? Math.round(winCount / total * 100) : 0,
    totalPnl: totalPnl,
    activeTrades: Object.keys(activeTrades).length,
    dailyResults: dailyResults
  });
});

app.post('/api/alert', function(req, res) {
  priceAlerts.push(req.body);
  res.json({ success: true });
});

app.get('/', function(req, res) { res.json({ status: 'ok', version: 'v6' }); });

app.post('/telegram', async function(req, res) {
  try {
    var update = req.body;
    if (update.message) {
      var txt = update.message.text;
      if (txt === '/status') await sendStatus();
      if (txt === '/backtest' || txt === '/btc') await runBacktest('BTCUSDT');
      if (txt === '/eth') await runBacktest('ETHUSDT');
    }
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
      chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML'
    });
  } catch (e) { console.error('Telegram:', e.message); }
}

async function sendStatus() {
  var total = winCount + lossCount;
  var wr = total > 0 ? Math.round(winCount / total * 100) : 0;
  var msg = '<b>Status Bot v6</b>\n\n'
    + 'Win Rate: ' + wr + '% (' + winCount + 'W/' + lossCount + 'L)\n'
    + 'P&L: ' + (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2) + '%\n\n'
    + '<b>Ativos:</b>\n';
  var keys = Object.keys(activeTrades);
  if (!keys.length) msg += 'Nenhum\n';
  else keys.forEach(function(k) {
    var t = activeTrades[k];
    msg += t.pair + ' ' + t.signal + ' $' + t.entry.toFixed(0) + ' SL:$' + t.sl.toFixed(0) + ' TP:$' + t.tp.toFixed(0) + '\n';
  });
  await sendTelegram(msg);
}

// ── Indicadores ───────────────────────────────────────────────────────────────
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

// Retorna array de valores EMA para cada candle
function calcEMALine(closes, period) {
  var k = 2 / (period + 1);
  var result = [];
  var ema = closes[0];
  for (var i = 0; i < closes.length; i++) {
    if (i === 0) { ema = closes[0]; }
    else { ema = closes[i] * k + ema * (1 - k); }
    result.push(ema);
  }
  return result;
}

function calcATR(candles, period) {
  period = period || 14;
  if (candles.length < period + 1) return 0;
  var trs = [];
  for (var i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
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
  if (signal === 'BUY') return Math.max(Math.min(Math.min.apply(null, lows) * 0.999, price - slDist), price * 0.97);
  return Math.min(Math.max(Math.max.apply(null, highs) * 1.001, price + slDist), price * 1.03);
}

function calcRSIDivergence(candles, rsi) {
  var len = candles.length;
  if (len < 10) return 'NONE';
  var closes = candles.map(function(c) { return c.close; });
  var prevRsi = calcRSI(closes.slice(0, -3), 14);
  var prevPrice = closes[len - 4], curPrice = closes[len - 1];
  if (curPrice > prevPrice && rsi < prevRsi && rsi > 55) return 'BEARISH';
  if (curPrice < prevPrice && rsi > prevRsi && rsi < 45) return 'BULLISH';
  return 'NONE';
}

function detectPattern(candles) {
  var len = candles.length;
  if (len < 3) return 'NONE';
  var c = candles[len - 2], prev = candles[len - 3];
  var body = Math.abs(c.close - c.open), range = c.high - c.low || 0.001;
  var uw = c.high - Math.max(c.open, c.close), lw = Math.min(c.open, c.close) - c.low;
  if (prev.close < prev.open && c.close > c.open && c.open < prev.close && c.close > prev.open) return 'BULL_ENGULF';
  if (prev.close > prev.open && c.close < c.open && c.open > prev.close && c.close < prev.open) return 'BEAR_ENGULF';
  if (lw > body * 2 && uw < body * 0.5 && c.close > c.open) return 'HAMMER';
  if (uw > body * 2 && lw < body * 0.5 && c.close < c.open) return 'SHOOT_STAR';
  if (lw > range * 0.6 && body < range * 0.3) return 'PIN_BULL';
  if (uw > range * 0.6 && body < range * 0.3) return 'PIN_BEAR';
  return 'NONE';
}

function isGoodSession() {
  return new Date().getUTCHours() >= 6 && new Date().getUTCHours() <= 22;
}

function confirmCandle(candles, signal) {
  var prev = candles[candles.length - 2];
  if (!prev) return false;
  return signal === 'BUY' ? prev.close > prev.open : prev.close < prev.open;
}

async function getMacroTrend(symbol) {
  try {
    var r = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=4h&limit=50');
    var closes = r.data.map(function(k) { return +k[4]; });
    var e20 = calcEMA(closes.slice(-20), 20), e50 = calcEMA(closes.slice(-50), 50);
    var last = closes[closes.length - 1];
    return last > e20 && e20 > e50 ? 'BULL' : last < e20 && e20 < e50 ? 'BEAR' : 'NEUTRAL';
  } catch (e) { return 'NEUTRAL'; }
}

async function get15mTrend(symbol) {
  try {
    var r = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=15m&limit=30');
    var closes = r.data.map(function(k) { return +k[4]; });
    var e20 = calcEMA(closes.slice(-20), 20), last = closes[closes.length - 1];
    return last > e20 ? 'UP' : last < e20 ? 'DOWN' : 'NEUTRAL';
  } catch (e) { return 'NEUTRAL'; }
}

function generateSignal(candles, price, macroTrend, trend15m, atr) {
  var closes = candles.map(function(c) { return c.close; });
  var vp = calcVP(candles.slice(-200));
  var rsi = calcRSI(closes);
  var ema20 = calcEMA(closes.slice(-20), 20);
  var ema50 = closes.length >= 50 ? calcEMA(closes.slice(-50), 50) : ema20;
  var trend30m = closes[closes.length - 1] > closes[closes.length - 10] ? 'UP' : 'DOWN';
  var rv = candles.slice(-5).reduce(function(s, c) { return s + c.volume; }, 0);
  var pv = candles.slice(-10, -5).reduce(function(s, c) { return s + c.volume; }, 0);
  var inVA = price >= vp.val && price <= vp.vah;
  var abovePoc = price > vp.poc;
  var divergence = calcRSIDivergence(candles, rsi);
  var pattern = detectPattern(candles);
  var nearLVN = vp.lvns.some(function(l) { return Math.abs(l.price - price) / price < 0.01; });

  var buy = 0, sell = 0;
  if (abovePoc && inVA) buy += 2; if (!abovePoc && inVA) sell += 2;
  if (rsi < 35) buy += 3; else if (rsi < 45) buy += 1;
  if (rsi > 65) sell += 3; else if (rsi > 55) sell += 1;
  if (price > ema20 && price > ema50) buy += 2; else if (price < ema20 && price < ema50) sell += 2;
  if (ema20 > ema50) buy += 1; else sell += 1;
  if (trend30m === 'UP') buy += 1; else sell += 1;
  if (rv > pv * 1.1) { buy += 1; sell += 1; }
  if (macroTrend === 'BULL') buy += 2; if (macroTrend === 'BEAR') sell += 2;
  if (trend15m === 'UP') buy += 1; if (trend15m === 'DOWN') sell += 1;
  if (divergence === 'BULLISH') buy += 2; if (divergence === 'BEARISH') sell += 2;
  if (pattern === 'BULL_ENGULF' || pattern === 'HAMMER' || pattern === 'PIN_BULL') buy += 2;
  if (pattern === 'BEAR_ENGULF' || pattern === 'SHOOT_STAR' || pattern === 'PIN_BEAR') sell += 2;
  if (nearLVN) { buy += 1; sell += 1; }

  var signal = null;
  if (buy >= MIN_SCORE && buy > sell + 2) signal = 'BUY';
  if (sell >= MIN_SCORE && sell > buy + 2) signal = 'SELL';
  if (!signal) return null;
  if (signal === 'BUY' && macroTrend === 'BEAR' && buy < 12) return null;
  if (signal === 'SELL' && macroTrend === 'BULL' && sell < 12) return null;
  if (signal === 'BUY' && trend15m === 'DOWN' && macroTrend !== 'BULL') return null;
  if (signal === 'SELL' && trend15m === 'UP' && macroTrend !== 'BEAR') return null;
  if (!confirmCandle(candles, signal)) return null;

  var conf = Math.min(95, Math.round(Math.max(buy, sell) / MAX_SCORE * 100));
  var sl = calcDynamicSL(candles, signal, price, atr);
  var slPct = Math.abs(price - sl) / price;
  var tp = signal === 'BUY' ? price * (1 + slPct * 2.2) : price * (1 - slPct * 2.2);

  return {
    signal: signal, conf: conf, price: price, sl: sl, tp: tp,
    rsi: rsi.toFixed(1), ema20: ema20.toFixed(2), ema50: ema50.toFixed(2),
    poc: vp.poc, val: vp.val, vah: vp.vah,
    macroTrend: macroTrend, trend15m: trend15m, trend30m: trend30m,
    divergence: divergence, pattern: pattern, atr: atr.toFixed(2),
    slPct: (slPct * 100).toFixed(2), tpPct: (slPct * 2.2 * 100).toFixed(2),
    buyScore: buy, sellScore: sell
  };
}

// ── Trailing Stop ─────────────────────────────────────────────────────────────
async function checkActiveTrades() {
  var keys = Object.keys(activeTrades);
  for (var i = 0; i < keys.length; i++) {
    var symbol = keys[i];
    var trade = activeTrades[symbol];
    try {
      var pr = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + symbol);
      var price = parseFloat(pr.data.price);
      var pair = symbol.replace('USDT', '/USDT');
      var closed = false, pnl = 0, outcome = '';

      if (trade.signal === 'BUY') {
        var hw = trade.entry + (trade.tp - trade.entry) * 0.5;
        if (price >= hw && trade.sl < trade.entry) {
          trade.sl = trade.entry * 1.001;
          await sendTelegram('<b>Trailing Stop</b> ' + pair + '\nSL breakeven $' + trade.sl.toFixed(0));
        }
        if (price <= trade.sl) { pnl = (price - trade.entry) / trade.entry * 100; outcome = pnl >= 0 ? 'BREAKEVEN' : 'LOSS'; closed = true; }
        if (price >= trade.tp) { pnl = (price - trade.entry) / trade.entry * 100; outcome = 'WIN'; closed = true; }
      } else {
        var hw2 = trade.entry - (trade.entry - trade.tp) * 0.5;
        if (price <= hw2 && trade.sl > trade.entry) {
          trade.sl = trade.entry * 0.999;
          await sendTelegram('<b>Trailing Stop</b> ' + pair + '\nSL breakeven $' + trade.sl.toFixed(0));
        }
        if (price >= trade.sl) { pnl = (trade.entry - price) / trade.entry * 100; outcome = pnl >= 0 ? 'BREAKEVEN' : 'LOSS'; closed = true; }
        if (price <= trade.tp) { pnl = (trade.entry - price) / trade.entry * 100; outcome = 'WIN'; closed = true; }
      }

      if (closed) {
        if (outcome === 'WIN') winCount++; else lossCount++;
        totalPnl += pnl;
        saveStats(winCount, lossCount, totalPnl);
        delete activeTrades[symbol];
        var wr = Math.round(winCount / (winCount + lossCount) * 100);
        await sendTelegram('<b>' + outcome + ' ' + pair + '</b>\nEntrada: $' + trade.entry.toFixed(0) + '\nSaida: $' + price.toFixed(0) + '\nP&L: ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%\nWin Rate: ' + wr + '%');
      }
    } catch (e) { console.error('Trade check ' + symbol + ':', e.message); }
  }
}

async function checkPriceAlerts() {
  for (var i = priceAlerts.length - 1; i >= 0; i--) {
    var alert = priceAlerts[i];
    try {
      var pr = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + alert.symbol);
      var price = parseFloat(pr.data.price);
      var triggered = alert.direction === 'above' ? price >= alert.price : price <= alert.price;
      if (triggered) {
        await sendTelegram('<b>Alerta!</b>\n' + alert.symbol.replace('USDT', '/USDT') + ' ' + (alert.direction === 'above' ? 'acima' : 'abaixo') + ' $' + alert.price + '\nPreco: $' + price.toFixed(2));
        priceAlerts.splice(i, 1);
      }
    } catch (e) {}
  }
}

async function runBacktest(symbol) {
  await sendTelegram('<b>Backtest ' + symbol.replace('USDT', '/USDT') + '</b>\nA processar...');
  try {
    var r = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=30m&limit=1000');
    var candles = r.data.map(function(k) { return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }; });
    var capital = 1000, wins = 0, losses = 0, maxCapital = 1000, maxDD = 0;
    for (var i = 60; i < candles.length - 1; i++) {
      var window = candles.slice(0, i + 1);
      var price = window[window.length - 1].close;
      var atr = calcATR(window, 14);
      var result = generateSignal(window, price, 'NEUTRAL', 'NEUTRAL', atr);
      if (!result || result.conf < 75) continue;
      var outcome = null, exitPrice = 0;
      for (var j = i + 1; j < Math.min(i + 48, candles.length); j++) {
        var next = candles[j];
        if (result.signal === 'BUY') {
          if (next.low <= result.sl) { outcome = 'LOSS'; exitPrice = result.sl; break; }
          if (next.high >= result.tp) { outcome = 'WIN'; exitPrice = result.tp; break; }
        } else {
          if (next.high >= result.sl) { outcome = 'LOSS'; exitPrice = result.sl; break; }
          if (next.low <= result.tp) { outcome = 'WIN'; exitPrice = result.tp; break; }
        }
      }
      if (!outcome) continue;
      var pnl = outcome === 'WIN' ? capital * 0.02 * 2.2 : -(capital * 0.02);
      capital += pnl;
      if (outcome === 'WIN') wins++; else losses++;
      maxCapital = Math.max(maxCapital, capital);
      maxDD = Math.max(maxDD, (maxCapital - capital) / maxCapital * 100);
    }
    var total = wins + losses;
    var wr = total > 0 ? Math.round(wins / total * 100) : 0;
    var ret = ((capital - 1000) / 1000 * 100).toFixed(1);
    await sendTelegram('<b>Backtest ' + symbol.replace('USDT', '/USDT') + '</b>\n\nTrades: ' + total + '\nWins: ' + wins + ' | Losses: ' + losses + '\nWin Rate: ' + wr + '%\n$1000 -> $' + capital.toFixed(0) + '\nRetorno: ' + (ret >= 0 ? '+' : '') + ret + '%\nMax DD: ' + maxDD.toFixed(1) + '%\n' + (wr >= 50 ? 'Estrategia LUCRATIVA' : 'Ajustar parametros'));
  } catch (e) { await sendTelegram('Erro backtest: ' + e.message); }
}

async function runBot() {
  console.log('Analisar ' + new Date().toISOString());
  if (!isGoodSession()) return;
  await checkActiveTrades();
  await checkPriceAlerts();
  for (var i = 0; i < SYMBOLS.length; i++) {
    var symbol = SYMBOLS[i];
    if (activeTrades[symbol]) continue;
    try {
      var resp = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=30m&limit=200');
      var candles = resp.data.map(function(k) { return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }; });
      var pr = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + symbol);
      var price = parseFloat(pr.data.price);
      var atr = calcATR(candles, 14);
      var macroTrend = await getMacroTrend(symbol);
      var trend15m = await get15mTrend(symbol);
      var result = generateSignal(candles, price, macroTrend, trend15m, atr);
      var pair = symbol.replace('USDT', '/USDT');
      if (!result || result.conf < 80) { console.log(pair + ': WAIT'); continue; }
      var now = Date.now();
      if (lastSignal[symbol] === result.signal && (now - lastSignalTime[symbol]) < SIGNAL_COOLDOWN) continue;
      lastSignal[symbol] = result.signal;
      lastSignalTime[symbol] = now;
      dailyResults[symbol].push({ signal: result.signal, conf: result.conf });
      activeTrades[symbol] = { pair: pair, signal: result.signal, entry: price, sl: result.sl, tp: result.tp };
      var patTxt = result.pattern !== 'NONE' ? '\nPadrao: ' + result.pattern : '';
      var divTxt = result.divergence !== 'NONE' ? '\nDiv: ' + result.divergence : '';
      var msg = '<b>' + result.signal + ' ' + pair + '</b>\n\n'
        + 'Preco: $' + price.toFixed(2) + '\n'
        + 'Stop: $' + result.sl.toFixed(0) + ' (-' + result.slPct + '%)\n'
        + 'Alvo: $' + result.tp.toFixed(0) + ' (+' + result.tpPct + '%)\n'
        + 'R/R: 1:2.2 | Conf: ' + result.conf + '% | Score: ' + Math.max(result.buyScore, result.sellScore) + '/16\n'
        + 'RSI: ' + result.rsi + divTxt + patTxt + '\n'
        + 'ATR: $' + result.atr + ' | EMA20: $' + result.ema20 + '\n'
        + 'Macro: ' + result.macroTrend + ' | 15m: ' + result.trend15m + '\n'
        + 'POC: $' + result.poc.toFixed(0) + ' VA: $' + result.val.toFixed(0) + '-$' + result.vah.toFixed(0) + '\n'
        + new Date().toLocaleTimeString('pt-PT');
      await sendTelegram(msg);
      console.log(pair + ': ' + result.signal + ' conf=' + result.conf);
    } catch (e) { console.error('Erro ' + symbol + ':', e.message); }
  }
}

async function sendDailyReport() {
  var hour = new Date().getUTCHours(), min = new Date().getUTCMinutes();
  if (hour !== 8 || min > 5) return;
  var total = winCount + lossCount;
  var wr = total > 0 ? Math.round(winCount / total * 100) : 0;
  var msg = '<b>Relatorio Diario</b>\n\nWin Rate: ' + wr + '% (' + winCount + 'W/' + lossCount + 'L)\nP&L: ' + (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2) + '%\n\n';
  for (var i = 0; i < SYMBOLS.length; i++) {
    var sym = SYMBOLS[i], res = dailyResults[sym];
    if (res.length) {
      var buys = res.filter(function(r) { return r.signal === 'BUY'; }).length;
      msg += sym.replace('USDT', '/USDT') + ': ' + res.length + ' sinais (' + buys + 'B/' + (res.length - buys) + 'S)\n';
      dailyResults[sym] = [];
    }
  }
  await sendTelegram(msg);
}

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('Server v6 porta ' + PORT);
  sendTelegram('<b>Bot v6 iniciado!</b>\n\nNovo:\n- Stats persistentes\n- EMAs no grafico\n- Timeframe selector\n- Sinal completo via API\n\nComandos: /status /backtest /btc /eth');
  runBot();
  setInterval(runBot, 5 * 60 * 1000);
  setInterval(sendDailyReport, 5 * 60 * 1000);
  setTimeout(function() { runBacktest('BTCUSDT'); }, 20000);
});
