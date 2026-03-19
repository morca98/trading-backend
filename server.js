const express = require('express');
const axios = require('axios');
const app = express();

app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
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

var lastSignal = { BTCUSDT: null, ETHUSDT: null };
var lastSignalTime = { BTCUSDT: 0, ETHUSDT: 0 };
var dailyResults = { BTCUSDT: [], ETHUSDT: [] };
var winCount = 0, lossCount = 0, totalPnl = 0;
var activeTrades = {};
var priceAlerts = [];

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/candles', async function(req, res) {
  try {
    var symbol = req.query.symbol || 'BTCUSDT';
    var interval = req.query.interval || '1h';
    var limit = req.query.limit || 60;
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

// Endpoint de signal para o site usar a mesma logica
app.get('/api/signal', async function(req, res) {
  try {
    var symbol = req.query.symbol || 'BTCUSDT';
    var resp = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=30m&limit=200');
    var candles = resp.data.map(function(k) {
      return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
    });
    var pr = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + symbol);
    var price = parseFloat(pr.data.price);
    var atr = calcATR(candles, 14);
    var macroTrend = await getMacroTrend(symbol);
    var trend15m = await get15mTrend(symbol);
    var result = generateSignal(candles, price, macroTrend, trend15m, atr);
    res.json({ success: true, signal: result, price: price, candles: candles.slice(-60) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Performance stats
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

// Alertas de preco
app.post('/api/alert', function(req, res) {
  var alert = req.body;
  priceAlerts.push(alert);
  res.json({ success: true });
});

app.get('/', function(req, res) { res.json({ status: 'ok', version: 'v5' }); });

app.post('/telegram', async function(req, res) {
  try {
    var update = req.body;
    if (update.message) {
      var txt = update.message.text;
      if (txt === '/status') await sendStatus();
      if (txt === '/backtest') await runBacktest('BTCUSDT');
      if (txt === '/btc') await runBacktest('BTCUSDT');
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
  } catch (e) { console.error('Telegram erro:', e.message); }
}

async function sendStatus() {
  var total = winCount + lossCount;
  var winRate = total > 0 ? Math.round(winCount / total * 100) : 0;
  var msg = '<b>Status do Bot v5</b>\n\n'
    + 'Trades: ' + total + ' | Win Rate: ' + winRate + '%\n'
    + 'Wins: ' + winCount + ' | Losses: ' + lossCount + '\n'
    + 'P&L Total: ' + (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2) + '%\n\n'
    + '<b>Trades Ativos:</b>\n';
  var keys = Object.keys(activeTrades);
  if (!keys.length) msg += 'Nenhum\n';
  else keys.forEach(function(k) {
    var t = activeTrades[k];
    msg += t.pair + ' ' + t.signal + ' @ $' + t.entry.toFixed(0) + ' SL:$' + t.sl.toFixed(0) + ' TP:$' + t.tp.toFixed(0) + '\n';
  });
  msg += '\nComandos: /backtest /status';
  await sendTelegram(msg);
}

// ── Indicadores (partilhados com site via /api/signal) ───────────────────────
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

function calcATR(candles, period) {
  period = period || 14;
  if (candles.length < period + 1) return 0;
  var trs = [];
  for (var i = 1; i < candles.length; i++) {
    var hl = candles[i].high - candles[i].low;
    var hc = Math.abs(candles[i].high - candles[i - 1].close);
    var lc = Math.abs(candles[i].low - candles[i - 1].close);
    trs.push(Math.max(hl, hc, lc));
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
  var lvns = bars.filter(function(b) { return b.vol < avgVol * 0.35; });
  return { poc: poc.price, val: vaLow, vah: vaHigh, lvns: lvns, bars: bars, maxVol: Math.max.apply(null, bars.map(function(b){return b.vol;})) };
}

function calcDynamicSL(candles, signal, price, atr) {
  var slDistance = atr * 1.5;
  var lows = candles.slice(-5).map(function(c) { return c.low; });
  var highs = candles.slice(-5).map(function(c) { return c.high; });
  if (signal === 'BUY') {
    var sl = Math.min(Math.min.apply(null, lows) * 0.999, price - slDistance);
    return Math.max(sl, price * 0.97);
  } else {
    var sl2 = Math.max(Math.max.apply(null, highs) * 1.001, price + slDistance);
    return Math.min(sl2, price * 1.03);
  }
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
  var body = Math.abs(c.close - c.open), range = c.high - c.low;
  var uw = c.high - Math.max(c.open, c.close), lw = Math.min(c.open, c.close) - c.low;
  if (prev.close < prev.open && c.close > c.open && c.open < prev.close && c.close > prev.open) return 'BULL_ENGULF';
  if (prev.close > prev.open && c.close < c.open && c.open > prev.close && c.close < prev.open) return 'BEAR_ENGULF';
  if (lw > body * 2 && uw < body * 0.5 && c.close > c.open) return 'HAMMER';
  if (uw > body * 2 && lw < body * 0.5 && c.close < c.open) return 'SHOOT_STAR';
  if (lw > range * 0.6 && body < range * 0.3) return 'PIN_BULL';
  if (uw > range * 0.6 && body < range * 0.3) return 'PIN_BEAR';
  if (body < range * 0.1) return 'DOJI';
  return 'NONE';
}

function isGoodSession() {
  var hour = new Date().getUTCHours();
  return hour >= 6 && hour <= 22;
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
    var ema20 = calcEMA(closes.slice(-20), 20), ema50 = calcEMA(closes.slice(-50), 50);
    var last = closes[closes.length - 1];
    if (last > ema20 && ema20 > ema50) return 'BULL';
    if (last < ema20 && ema20 < ema50) return 'BEAR';
    return 'NEUTRAL';
  } catch (e) { return 'NEUTRAL'; }
}

async function get15mTrend(symbol) {
  try {
    var r = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=15m&limit=30');
    var closes = r.data.map(function(k) { return +k[4]; });
    var ema20 = calcEMA(closes.slice(-20), 20), last = closes[closes.length - 1];
    return last > ema20 ? 'UP' : last < ema20 ? 'DOWN' : 'NEUTRAL';
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
    poc: vp.poc, val: vp.val, vah: vp.vah, vp: vp,
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
      if (trade.signal === 'BUY') {
        var halfway = trade.entry + (trade.tp - trade.entry) * 0.5;
        if (price >= halfway && trade.sl < trade.entry) {
          trade.sl = trade.entry * 1.001;
          await sendTelegram('<b>Trailing Stop</b> ' + pair + '\nSL -> breakeven $' + trade.sl.toFixed(0) + '\nPreco: $' + price.toFixed(2));
        }
        if (price <= trade.sl) {
          var pnl = (price - trade.entry) / trade.entry * 100;
          if (pnl < 0) lossCount++; else winCount++;
          totalPnl += pnl;
          delete activeTrades[symbol];
          await sendTelegram('<b>' + (pnl >= 0 ? 'BREAKEVEN' : 'LOSS') + ' ' + pair + '</b>\nEntrada: $' + trade.entry.toFixed(0) + '\nSaida: $' + price.toFixed(0) + '\nP&L: ' + pnl.toFixed(2) + '%\nWin Rate: ' + Math.round(winCount / (winCount + lossCount) * 100) + '%');
        }
        if (price >= trade.tp) {
          var pnl2 = (price - trade.entry) / trade.entry * 100;
          winCount++; totalPnl += pnl2;
          delete activeTrades[symbol];
          await sendTelegram('<b>WIN ' + pair + '</b>\nEntrada: $' + trade.entry.toFixed(0) + '\nSaida: $' + price.toFixed(0) + '\nP&L: +' + pnl2.toFixed(2) + '%\nWin Rate: ' + Math.round(winCount / (winCount + lossCount) * 100) + '%');
        }
      } else {
        var halfway2 = trade.entry - (trade.entry - trade.tp) * 0.5;
        if (price <= halfway2 && trade.sl > trade.entry) {
          trade.sl = trade.entry * 0.999;
          await sendTelegram('<b>Trailing Stop</b> ' + pair + '\nSL -> breakeven $' + trade.sl.toFixed(0));
        }
        if (price >= trade.sl) {
          var pnl3 = (trade.entry - price) / trade.entry * 100;
          if (pnl3 < 0) lossCount++; else winCount++;
          totalPnl += pnl3;
          delete activeTrades[symbol];
          await sendTelegram('<b>' + (pnl3 >= 0 ? 'BREAKEVEN' : 'LOSS') + ' ' + pair + '</b>\nP&L: ' + pnl3.toFixed(2) + '%\nWin Rate: ' + Math.round(winCount / (winCount + lossCount) * 100) + '%');
        }
        if (price <= trade.tp) {
          var pnl4 = (trade.entry - price) / trade.entry * 100;
          winCount++; totalPnl += pnl4;
          delete activeTrades[symbol];
          await sendTelegram('<b>WIN ' + pair + '</b>\nP&L: +' + pnl4.toFixed(2) + '%\nWin Rate: ' + Math.round(winCount / (winCount + lossCount) * 100) + '%');
        }
      }
    } catch (e) { console.error('Erro trade ' + symbol + ':', e.message); }
  }
}

// ── Alertas de preco ──────────────────────────────────────────────────────────
async function checkPriceAlerts() {
  if (!priceAlerts.length) return;
  for (var i = priceAlerts.length - 1; i >= 0; i--) {
    var alert = priceAlerts[i];
    try {
      var pr = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + alert.symbol);
      var price = parseFloat(pr.data.price);
      var triggered = alert.direction === 'above' ? price >= alert.price : price <= alert.price;
      if (triggered) {
        await sendTelegram('<b>Alerta de Preco</b>\n' + alert.symbol.replace('USDT', '/USDT') + ' ' + (alert.direction === 'above' ? 'acima' : 'abaixo') + ' de $' + alert.price + '\nPreco atual: $' + price.toFixed(2));
        priceAlerts.splice(i, 1);
      }
    } catch (e) {}
  }
}

// ── Backtesting ───────────────────────────────────────────────────────────────
async function runBacktest(symbol) {
  await sendTelegram('<b>Backtest ' + symbol.replace('USDT', '/USDT') + '</b>\nA processar 30 dias...');
  try {
    var r = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=30m&limit=1000');
    var candles = r.data.map(function(k) {
      return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
    });
    var capital = 1000, wins = 0, losses = 0, maxCapital = 1000, maxDD = 0;
    for (var i = 60; i < candles.length - 1; i++) {
      var window = candles.slice(0, i + 1);
      var price = window[window.length - 1].close;
      var atr = calcATR(window, 14);
      var result = generateSignal(window, price, 'NEUTRAL', 'NEUTRAL', atr);
      if (!result || result.conf < 75) continue;
      var sl = result.sl, tp = result.tp, signal = result.signal;
      var outcome = null, exitPrice = 0;
      for (var j = i + 1; j < Math.min(i + 48, candles.length); j++) {
        var next = candles[j];
        if (signal === 'BUY') {
          if (next.low <= sl) { outcome = 'LOSS'; exitPrice = sl; break; }
          if (next.high >= tp) { outcome = 'WIN'; exitPrice = tp; break; }
        } else {
          if (next.high >= sl) { outcome = 'LOSS'; exitPrice = sl; break; }
          if (next.low <= tp) { outcome = 'WIN'; exitPrice = tp; break; }
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
    var winRate = total > 0 ? Math.round(wins / total * 100) : 0;
    var ret = ((capital - 1000) / 1000 * 100).toFixed(1);
    await sendTelegram('<b>Resultado Backtest ' + symbol.replace('USDT', '/USDT') + '</b>\n\nTrades: ' + total + '\nWins: ' + wins + ' | Losses: ' + losses + '\nWin Rate: ' + winRate + '%\nCapital: $1000 -> $' + capital.toFixed(0) + '\nRetorno: ' + (ret >= 0 ? '+' : '') + ret + '%\nMax DD: ' + maxDD.toFixed(1) + '%\n\n' + (winRate >= 50 ? 'Estrategia LUCRATIVA' : 'Estrategia precisa de ajuste'));
  } catch (e) { await sendTelegram('Erro backtest: ' + e.message); }
}

// ── Bot loop ──────────────────────────────────────────────────────────────────
async function runBot() {
  console.log('Analisar... ' + new Date().toISOString());
  if (!isGoodSession()) return;
  await checkActiveTrades();
  await checkPriceAlerts();
  for (var i = 0; i < SYMBOLS.length; i++) {
    var symbol = SYMBOLS[i];
    if (activeTrades[symbol]) continue;
    try {
      var resp = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=30m&limit=200');
      var candles = resp.data.map(function(k) {
        return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
      });
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
        + 'ATR: $' + result.atr + '\n'
        + 'Macro 4h: ' + result.macroTrend + ' | 15m: ' + result.trend15m + '\n'
        + 'POC: $' + result.poc.toFixed(0) + ' | VA: $' + result.val.toFixed(0) + '-$' + result.vah.toFixed(0) + '\n'
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
    var sym = SYMBOLS[i], pair = sym.replace('USDT', '/USDT');
    var res = dailyResults[sym];
    if (res.length) {
      var buys = res.filter(function(r) { return r.signal === 'BUY'; }).length;
      msg += pair + ': ' + res.length + ' sinais (' + buys + 'B/' + (res.length - buys) + 'S)\n';
      dailyResults[sym] = [];
    }
  }
  await sendTelegram(msg);
}

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('Server v5 na porta ' + PORT);
  sendTelegram('<b>Bot v5 iniciado!</b>\n\nUnificacao de logica site+bot\nAlertas de preco\nBacktest melhorado\nPerformance stats\n\nComandos: /status /backtest /btc /eth');
  runBot();
  setInterval(runBot, 5 * 60 * 1000);
  setInterval(sendDailyReport, 5 * 60 * 1000);
  setTimeout(function() { runBacktest('BTCUSDT'); }, 15000);
});
