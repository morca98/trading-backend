const express = require('express');
const axios = require('axios');
const fs = require('fs');
const BacktestEngine = require('./backtest-engine');
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
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const SIGNAL_COOLDOWN = 60 * 60 * 1000;
const MIN_SCORE = 10;
const MAX_SCORE = 16;
const STATS_FILE = '/tmp/stats.json';

var lastSignal = { BTCUSDT: null, ETHUSDT: null, SOLUSDT: null };
var lastSignalTime = { BTCUSDT: 0, ETHUSDT: 0, SOLUSDT: 0 };
var dailyResults = { BTCUSDT: [], ETHUSDT: [], SOLUSDT: [] };
var activeTrades = {};
var priceAlerts = [];

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
  try { fs.writeFileSync(STATS_FILE, JSON.stringify({ wins: wins, losses: losses, totalPnl: pnl })); } catch(e) {}
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

// Sinal completo com chamadas em PARALELO
app.get('/api/signal', async function(req, res) {
  try {
    var symbol = req.query.symbol || 'BTCUSDT';
    var interval = req.query.interval || '30m';

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
    var signal = generateSignal(candles, price, macroTrend, trend15m, atr, null);

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
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Liquidation Map
var BINANCE_FUTURES = 'https://fapi.binance.com';

app.get('/api/liqmap', async function(req, res) {
  try {
    var symbol = req.query.symbol || 'BTCUSDT';
    var coinglassKey = req.query.apiKey || process.env.COINGLASS_API_KEY || '';

    // Tentar API do Coinglass se tiver API key
    if (coinglassKey) {
      try {
        var cgSymbol = 'Binance_' + symbol;
        var cgr = await axios.get('https://open-api.coinglass.com/public/v2/liqMap?symbol=' + cgSymbol + '&interval=1d', {
          headers: { 'coinglassSecret': coinglassKey, 'accept': 'application/json' },
          timeout: 8000
        });
        if (cgr.data && cgr.data.success && cgr.data.data) {
          var cgData = cgr.data.data;
          var levels = [];
          if (cgData.longLiquidationLevels) {
            cgData.longLiquidationLevels.forEach(function(l) {
              levels.push({ price: l.price, longLiq: l.amount || 0, shortLiq: 0, total: l.amount || 0, type: 'long' });
            });
          }
          if (cgData.shortLiquidationLevels) {
            cgData.shortLiquidationLevels.forEach(function(l) {
              var existing = levels.find(function(x) { return Math.abs(x.price - l.price) / l.price < 0.001; });
              if (existing) { existing.shortLiq = l.amount || 0; existing.total += l.amount || 0; }
              else levels.push({ price: l.price, longLiq: 0, shortLiq: l.amount || 0, total: l.amount || 0, type: 'short' });
            });
          }
          levels.sort(function(a, b) { return a.price - b.price; });
          var maxTotal = Math.max.apply(null, levels.map(function(l) { return l.total; })) || 1;
          levels.forEach(function(l) { l.intensity = l.total / maxTotal; });
          return res.json({ success: true, source: 'coinglass', symbol: symbol, levels: levels, currentPrice: cgData.currentPrice || 0 });
        }
      } catch (cgErr) {
        console.log('Coinglass API erro, usando fallback Binance:', cgErr.message);
      }
    }

    // Fallback: calcular liquidation map estimado com dados públicos da Binance Futures
    var results = await Promise.all([
      axios.get(BINANCE_FUTURES + '/fapi/v1/klines?symbol=' + symbol + '&interval=1h&limit=168'),
      axios.get(BINANCE_FUTURES + '/fapi/v1/ticker/24hr?symbol=' + symbol),
      axios.get(BINANCE_FUTURES + '/futures/data/globalLongShortAccountRatio?symbol=' + symbol + '&period=1h&limit=24'),
      axios.get(BINANCE_FUTURES + '/fapi/v1/premiumIndex?symbol=' + symbol),
      axios.get(BINANCE_FUTURES + '/fapi/v1/openInterest?symbol=' + symbol)
    ]);

    var candles = results[0].data.map(function(k) {
      return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
    });
    var ticker = results[1].data;
    var lsRatios = results[2].data;
    var premium = results[3].data;
    var openInterest = parseFloat(results[4].data.openInterest);
    var currentPrice = parseFloat(ticker.lastPrice);
    var fundingRate = parseFloat(premium.lastFundingRate);

    // Calcular ratio medio de long/short das ultimas 24h
    var avgLongRatio = lsRatios.reduce(function(s, r) { return s + parseFloat(r.longAccount); }, 0) / lsRatios.length;
    var avgShortRatio = 1 - avgLongRatio;

    // Estimar niveis de liquidacao usando alavancagem tipica (5x, 10x, 20x, 50x, 100x)
    var leverages = [5, 10, 20, 50, 100];
    var priceRange = currentPrice * 0.20; // +/- 20% do preco atual
    var N = 40; // numero de niveis de preco
    var step = (priceRange * 2) / N;
    var minPrice = currentPrice - priceRange;
    var levels = [];

    // Distribuicao de OI estimada por nivel de preco
    // Longs sao liquidados quando preco cai, shorts quando sobe
    for (var i = 0; i < N; i++) {
      var levelPrice = minPrice + step * i + step / 2;
      var distFromCurrent = (levelPrice - currentPrice) / currentPrice;

      // Calcular liquidacoes de longs (abaixo do preco atual)
      var longLiq = 0;
      if (levelPrice < currentPrice) {
        var dropPct = Math.abs(distFromCurrent);
        leverages.forEach(function(lev) {
          var liqThreshold = 1 / lev; // Threshold de liquidacao
          if (dropPct >= liqThreshold * 0.85) {
            // Peso baseado na distribuicao normal ao redor do threshold
            var weight = Math.exp(-Math.pow((dropPct - liqThreshold) / (liqThreshold * 0.15), 2) * 0.5);
            // Distribuicao de OI por alavancagem (mais traders em 10x e 20x)
            var levWeight = lev === 10 ? 0.30 : lev === 20 ? 0.25 : lev === 5 ? 0.20 : lev === 50 ? 0.15 : 0.10;
            longLiq += openInterest * avgLongRatio * levWeight * weight * 0.15;
          }
        });
      }

      // Calcular liquidacoes de shorts (acima do preco atual)
      var shortLiq = 0;
      if (levelPrice > currentPrice) {
        var risePct = Math.abs(distFromCurrent);
        leverages.forEach(function(lev) {
          var liqThreshold = 1 / lev;
          if (risePct >= liqThreshold * 0.85) {
            var weight = Math.exp(-Math.pow((risePct - liqThreshold) / (liqThreshold * 0.15), 2) * 0.5);
            var levWeight = lev === 10 ? 0.30 : lev === 20 ? 0.25 : lev === 5 ? 0.20 : lev === 50 ? 0.15 : 0.10;
            shortLiq += openInterest * avgShortRatio * levWeight * weight * 0.15;
          }
        });
      }

      // Adicionar liquidacoes historicas reais dos candles (wicks)
      var nearCandles = candles.filter(function(c) {
        return c.low <= levelPrice && c.high >= levelPrice;
      });
      var volAtLevel = nearCandles.reduce(function(s, c) { return s + c.volume; }, 0);
      var volBoost = volAtLevel > 0 ? Math.log(1 + volAtLevel / 1000) * 0.1 : 0;

      var total = longLiq + shortLiq + volBoost;
      if (total > 0) {
        levels.push({
          price: Math.round(levelPrice),
          longLiq: Math.round(longLiq),
          shortLiq: Math.round(shortLiq),
          total: total,
          intensity: 0
        });
      }
    }

    // Normalizar intensidade
    var maxTotal = Math.max.apply(null, levels.map(function(l) { return l.total; })) || 1;
    levels.forEach(function(l) { l.intensity = l.total / maxTotal; });
    levels.sort(function(a, b) { return a.price - b.price; });

    // Calcular estatisticas
    var totalLongLiq = levels.reduce(function(s, l) { return s + l.longLiq; }, 0);
    var totalShortLiq = levels.reduce(function(s, l) { return s + l.shortLiq; }, 0);
    var topLevels = levels.slice().sort(function(a, b) { return b.total - a.total; }).slice(0, 5);

    res.json({
      success: true,
      source: 'binance_estimated',
      symbol: symbol,
      currentPrice: currentPrice,
      openInterest: openInterest,
      fundingRate: fundingRate,
      longRatio: avgLongRatio,
      shortRatio: avgShortRatio,
      levels: levels,
      totalLongLiq: Math.round(totalLongLiq),
      totalShortLiq: Math.round(totalShortLiq),
      topLevels: topLevels,
      note: coinglassKey ? 'Coinglass indisponivel, usando estimativa Binance' : 'Estimativa baseada em dados publicos Binance Futures'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Backtest endpoint
app.get('/api/backtest', async function(req, res) {
  try {
    const symbol = req.query.symbol || 'BTCUSDT';
    const interval = req.query.interval || '30m';
    const limit = parseInt(req.query.limit) || 1000;
    const risk = parseFloat(req.query.risk) || 0.02;
    
    const engine = new BacktestEngine({
      symbol: symbol,
      interval: interval,
      limit: limit,
      riskPerTrade: risk
    });
    
    const results = await engine.run(generateSignal);
    res.json({ success: true, ...results });
  } catch (err) { 
    console.error('Backtest API Error:', err);
    res.status(500).json({ success: false, error: err.message }); 
  }
});

app.get('/api/stats', function(req, res) {
  var total = winCount + lossCount;
  res.json({ success: true, wins: winCount, losses: lossCount, total: total, winRate: total > 0 ? Math.round(winCount / total * 100) : 0, totalPnl: totalPnl, activeTrades: Object.keys(activeTrades).length, dailyResults: dailyResults });
});

app.post('/api/alert', function(req, res) { priceAlerts.push(req.body); res.json({ success: true }); });

app.get('/', function(req, res) { res.json({ status: 'ok', version: 'v7' }); });

app.post('/telegram', async function(req, res) {
  try {
    var txt = req.body && req.body.message ? req.body.message.text : '';
    if (txt === '/status') await sendStatus();
    if (txt === '/backtest' || txt === '/btc') await runBacktest('BTCUSDT');
    if (txt === '/eth') await runBacktest('ETHUSDT');
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try { await axios.post('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' }); } catch (e) {}
}

async function sendStatus() {
  var total = winCount + lossCount;
  var wr = total > 0 ? Math.round(winCount / total * 100) : 0;
  var msg = '<b>Bot v7</b>\nWin Rate: ' + wr + '% (' + winCount + 'W/' + lossCount + 'L)\nP&L: ' + (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2) + '%\n\nAtivos: ' + Object.keys(activeTrades).length;
  await sendTelegram(msg);
}

// ── Indicadores ───────────────────────────────────────────────────────────────
function calcTrend(closes) {
  if (closes.length < 20) return 'NEUTRAL';
  var e20 = calcEMA(closes.slice(-20), 20);
  var e50 = closes.length >= 50 ? calcEMA(closes.slice(-50), 50) : e20;
  var last = closes[closes.length - 1];
  if (last > e20 && e20 > e50) return 'BULL';
  if (last < e20 && e20 < e50) return 'BEAR';
  if (last > e20) return 'UP';
  if (last < e20) return 'DOWN';
  return 'NEUTRAL';
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
  var N = 40, step = (max - min) / N; // Aumentado para 40 bars para maior precisão
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
  // Identificar HVNs (High Volume Nodes) como níveis chave adicionais
  var hvns = bars.filter(function(b) { return b.vol > avgVol * 1.5 && Math.abs(b.price - poc.price) / poc.price > 0.01; });
  return { poc: poc.price, val: vaLow, vah: vaHigh, lvns: bars.filter(function(b) { return b.vol < avgVol * 0.35; }), hvns: hvns, bars: bars, maxVol: Math.max.apply(null, bars.map(function(b) { return b.vol; })) };
}

function calcKeyLevels(candles, vp) {
  var levels = [];
  var currentPrice = candles[candles.length - 1].close;

  // 1. Níveis do Volume Profile
  levels.push({ price: vp.poc, type: 'POC', strength: 100 });
  levels.push({ price: vp.vah, type: 'VAH', strength: 80 });
  levels.push({ price: vp.val, type: 'VAL', strength: 80 });
  vp.hvns.forEach(function(h) { levels.push({ price: h.price, type: 'HVN', strength: 60 }); });

  // 2. Suportes e Resistências Clássicos (Fractais)
  for (var i = 5; i < candles.length - 5; i++) {
    var isHigh = true, isLow = true;
    for (var j = 1; j <= 5; j++) {
      if (candles[i].high < candles[i-j].high || candles[i].high < candles[i+j].high) isHigh = false;
      if (candles[i].low > candles[i-j].low || candles[i].low > candles[i+j].low) isLow = false;
    }
    if (isHigh) levels.push({ price: candles[i].high, type: 'RES', strength: 50 });
    if (isLow) levels.push({ price: candles[i].low, type: 'SUP', strength: 50 });
  }

  // 3. Agrupar níveis próximos para evitar duplicidade
  var grouped = [];
  levels.sort(function(a, b) { return a.price - b.price; });
  if (levels.length > 0) {
    var current = levels[0];
    for (var k = 1; k < levels.length; k++) {
      if (Math.abs(levels[k].price - current.price) / current.price < 0.005) {
        if (levels[k].strength > current.strength) {
          current.price = (current.price + levels[k].price) / 2;
          current.strength = Math.min(100, current.strength + 10);
        }
      } else {
        grouped.push(current);
        current = levels[k];
      }
    }
    grouped.push(current);
  }

  // Filtrar apenas níveis relevantes ao preço atual (+/- 5%)
  return grouped.filter(function(l) {
    return Math.abs(l.price - currentPrice) / currentPrice < 0.05;
  }).sort(function(a, b) {
    return Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice);
  }).slice(0, 8);
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

function isGoodSession() { return new Date().getUTCHours() >= 6 && new Date().getUTCHours() <= 22; }

function confirmCandle(candles, signal) {
  var prev = candles[candles.length - 2];
  if (!prev) return false;
  return signal === 'BUY' ? prev.close > prev.open : prev.close < prev.open;
}

function generateSignal(candles, price, macroTrend, trend15m, atr, liqData) {
  var closes = candles.map(function(c) { return c.close; });
  var vp = calcVP(candles.slice(-200));
  var keyLevels = calcKeyLevels(candles, vp);
  var rsi = calcRSI(closes);
  var ema20 = calcEMA(closes.slice(-20), 20);
  var ema50 = closes.length >= 50 ? calcEMA(closes.slice(-50), 50) : ema20;
  var trend30m = closes[closes.length - 1] > closes[closes.length - 10] ? 'UP' : 'DOWN';
  var rv = candles.slice(-5).reduce(function(s, c) { return s + c.volume; }, 0);
  var pv = candles.slice(-10, -5).reduce(function(s, c) { return s + c.volume; }, 0);
  var inVA = price >= vp.val && price <= vp.vah, abovePoc = price > vp.poc;
  var divergence = calcRSIDivergence(candles, rsi);
  var pattern = detectPattern(candles);
  
  // Detecção de proximidade de níveis chave
  var nearSupport = keyLevels.filter(function(l) { return (l.type === 'SUP' || l.type === 'VAL' || l.type === 'POC') && price > l.price && (price - l.price) / price < 0.01; });
  var nearResistance = keyLevels.filter(function(l) { return (l.type === 'RES' || l.type === 'VAH' || l.type === 'POC') && price < l.price && (l.price - price) / price < 0.01; });

  var buy = 0, sell = 0; 
  
  // 1. Contexto de Volume Profile
  if (abovePoc && inVA) buy += 2; if (!abovePoc && inVA) sell += 2;
  if (price > vp.vah) buy += 1; 
  if (price < vp.val) sell += 1;
  
  // 2. RSI e Divergências
  if (rsi < 30) buy += 3; else if (rsi < 40) buy += 1;
  if (rsi > 70) sell += 3; else if (rsi > 60) sell += 1;
  if (divergence === 'BULLISH') buy += 3; if (divergence === 'BEARISH') sell += 3;
  
  // 3. Médias Móveis e Tendência
  if (price > ema20 && price > ema50) buy += 2; else if (price < ema20 && price < ema50) sell += 2;
  if (ema20 > ema50) buy += 1; else sell += 1;
  if (macroTrend === 'BULL') buy += 2; if (macroTrend === 'BEAR') sell += 2;
  if (trend15m === 'UP') buy += 1; if (trend15m === 'DOWN') sell += 1;
  
  // 4. Volume e Padrões de Candles
  if (rv > pv * 1.2) { if (trend30m === 'UP') buy += 2; else sell += 2; }
  if (pattern === 'BULL_ENGULF' || pattern === 'HAMMER' || pattern === 'PIN_BULL') buy += 3;
  if (pattern === 'BEAR_ENGULF' || pattern === 'SHOOT_STAR' || pattern === 'PIN_BEAR') sell += 3;
  
  // 5. Níveis Chave (Suporte/Resistência)
  if (nearSupport.length > 0) buy += 3;
  if (nearResistance.length > 0) sell += 3;
  
  // 6. Liquidation Map (Sentimento e Liquidez)
  if (liqData) {
    if (liqData.lsRatio < 0.45) buy += 2; // Muitos shorts, possível short squeeze
    if (liqData.lsRatio > 0.55) sell += 2; // Muitos longs, possível long flush
  }

  var signal = null;
  var score = Math.max(buy, sell);
  var conf = Math.round((score / 25) * 100); 

  if (buy >= MIN_SCORE && buy > sell + 3) signal = 'BUY';
  if (sell >= MIN_SCORE && sell > buy + 3) signal = 'SELL';
  
  if (!signal) return null;
  
  if (signal === 'BUY' && macroTrend === 'BEAR' && buy < 14) return null;
  if (signal === 'SELL' && macroTrend === 'BULL' && sell < 14) return null;
  if (signal === 'BUY' && rsi > 65) return null;
  if (signal === 'SELL' && rsi < 35) return null;
  
  if (!confirmCandle(candles, signal)) return null;

  var sl = calcDynamicSL(candles, signal, price, atr);
  
  if (signal === 'BUY' && nearSupport.length > 0) {
    var bestSup = nearSupport[0].price * 0.998;
    if (bestSup < price && bestSup > sl) sl = bestSup;
  } else if (signal === 'SELL' && nearResistance.length > 0) {
    var bestRes = nearResistance[0].price * 1.002;
    if (bestRes > price && bestRes < sl) sl = bestRes;
  }

  var slPct = Math.abs(price - sl) / price;
  var tp = signal === 'BUY' ? price * (1 + slPct * 2.5) : price * (1 - slPct * 2.5);

  return { signal: signal, conf: conf, price: price, sl: sl, tp: tp, rsi: rsi.toFixed(1), ema20: ema20.toFixed(2), ema50: ema50.toFixed(2), poc: vp.poc, val: vp.val, vah: vp.vah, macroTrend: macroTrend, trend15m: trend15m, trend30m: trend30m, divergence: divergence, pattern: pattern, atr: atr.toFixed(2), slPct: (slPct * 100).toFixed(2), tpPct: (slPct * 2.5 * 100).toFixed(2), buyScore: buy, sellScore: sell };
}

async function checkActiveTrades() {
  var keys = Object.keys(activeTrades);
  for (var i = 0; i < keys.length; i++) {
    var symbol = keys[i], trade = activeTrades[symbol];
    try {
      var pr = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + symbol);
      var price = parseFloat(pr.data.price), pair = symbol.replace('USDT', '/USDT');
      var closed = false, pnl = 0, outcome = '';
      if (trade.signal === 'BUY') {
        // Trailing Stop Progressivo
        var profitPct = (price - trade.entry) / trade.entry * 100;
        if (profitPct >= 1.0 && trade.sl < trade.entry) { trade.sl = trade.entry * 1.002; await sendTelegram('<b>Trailing BE+</b> ' + pair + ' SL $' + trade.sl.toFixed(0)); }
        else if (profitPct >= 2.0 && trade.sl < trade.entry * 1.01) { trade.sl = trade.entry * 1.01; await sendTelegram('<b>Trailing +1%</b> ' + pair + ' SL $' + trade.sl.toFixed(0)); }
        
        if (price <= trade.sl) { pnl = (price - trade.entry) / trade.entry * 100; outcome = pnl >= 0 ? 'WIN (SL)' : 'LOSS'; closed = true; }
        if (price >= trade.tp) { pnl = (price - trade.entry) / trade.entry * 100; outcome = 'WIN (TP)'; closed = true; }
      } else {
        // Trailing Stop Progressivo para Shorts
        var profitPctS = (trade.entry - price) / trade.entry * 100;
        if (profitPctS >= 1.0 && trade.sl > trade.entry) { trade.sl = trade.entry * 0.998; await sendTelegram('<b>Trailing BE+</b> ' + pair + ' SL $' + trade.sl.toFixed(0)); }
        else if (profitPctS >= 2.0 && trade.sl > trade.entry * 0.99) { trade.sl = trade.entry * 0.99; await sendTelegram('<b>Trailing +1%</b> ' + pair + ' SL $' + trade.sl.toFixed(0)); }
        
        if (price >= trade.sl) { pnl = (trade.entry - price) / trade.entry * 100; outcome = pnl >= 0 ? 'WIN (SL)' : 'LOSS'; closed = true; }
        if (price <= trade.tp) { pnl = (trade.entry - price) / trade.entry * 100; outcome = 'WIN (TP)'; closed = true; }
      }
      if (closed) {
        if (outcome === 'WIN') winCount++; else lossCount++;
        totalPnl += pnl;
        saveStats(winCount, lossCount, totalPnl);
        delete activeTrades[symbol];
        await sendTelegram('<b>' + outcome + ' ' + pair + '</b>\nP&L: ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%\nWin Rate: ' + Math.round(winCount / (winCount + lossCount) * 100) + '%');
      }
    } catch (e) {}
  }
}

async function checkPriceAlerts() {
  for (var i = priceAlerts.length - 1; i >= 0; i--) {
    var alert = priceAlerts[i];
    try {
      var pr = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + alert.symbol);
      var price = parseFloat(pr.data.price);
      if ((alert.direction === 'above' && price >= alert.price) || (alert.direction === 'below' && price <= alert.price)) {
        await sendTelegram('<b>Alerta!</b>\n' + alert.symbol.replace('USDT', '/USDT') + ' $' + price.toFixed(2));
        priceAlerts.splice(i, 1);
      }
    } catch (e) {}
  }
}

async function runBacktest(symbol) {
  await sendTelegram('<b>Backtest ' + symbol.replace('USDT', '/USDT') + '</b>\nA processar...');
  try {
    const engine = new BacktestEngine({ symbol: symbol, limit: 1000 });
    const results = await engine.run(generateSignal);
    
    const msg = '<b>Backtest ' + symbol.replace('USDT', '/USDT') + '</b>\n' +
                'Trades: ' + results.totalTrades + '\n' +
                'Win Rate: ' + results.winRate + '%\n' +
                'Profit Factor: ' + results.profitFactor + '\n' +
                '$1000 -> $' + parseFloat(results.finalCapital).toFixed(0) + '\n' +
                'Retorno: ' + results.returnPct + '%\n' +
                'Max DD: ' + results.maxDD + '%\n' +
                (parseFloat(results.winRate) >= 50 ? 'LUCRATIVA' : 'Ajustar');
    
    await sendTelegram(msg);
  } catch (e) { 
    console.error('Backtest Error:', e);
    await sendTelegram('Erro: ' + e.message); 
  }
}

async function getLiqData(symbol) {
  try {
    var r = await axios.get(BINANCE_FUTURES + '/fapi/v1/openInterest?symbol=' + symbol);
    var r2 = await axios.get(BINANCE_FUTURES + '/futures/data/globalLongShortAccountRatio?symbol=' + symbol + '&period=1h&limit=1');
    return { oi: parseFloat(r.data.openInterest), lsRatio: parseFloat(r2.data[0].longAccount) };
  } catch (e) { return null; }
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
        axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=30m&limit=200'),
        axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + symbol),
        axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=4h&limit=50'),
        axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=15m&limit=30'),
        getLiqData(symbol)
      ]);
      var candles = results[0].data.map(function(k) { return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }; });
      var price = parseFloat(results[1].data.price);
      var macroTrend = calcTrend(results[2].data.map(function(k) { return +k[4]; }));
      var trend15m = calcTrend(results[3].data.map(function(k) { return +k[4]; }));
      var liqData = results[4];
      var atr = calcATR(candles, 14);
      var result = generateSignal(candles, price, macroTrend, trend15m, atr, liqData);
      var pair = symbol.replace('USDT', '/USDT');
      if (!result || result.conf < 80) { console.log(pair + ': WAIT'); continue; }
      var now = Date.now();
      if (lastSignal[symbol] === result.signal && (now - lastSignalTime[symbol]) < SIGNAL_COOLDOWN) continue;
      lastSignal[symbol] = result.signal; lastSignalTime[symbol] = now;
      dailyResults[symbol].push({ signal: result.signal, conf: result.conf });
      activeTrades[symbol] = { pair: pair, signal: result.signal, entry: price, sl: result.sl, tp: result.tp, time: now };
      var msg = '<b>' + result.signal + ' ' + pair + '</b>\n\nPreco: $' + price.toFixed(2) + '\nStop: $' + result.sl.toFixed(0) + ' (-' + result.slPct + '%)\nAlvo: $' + result.tp.toFixed(0) + ' (+' + result.tpPct + '%)\nConf: ' + result.conf + '%\nScore: ' + Math.max(result.buyScore, result.sellScore) + '/25\nRSI: ' + result.rsi + ' | ATR: $' + result.atr + '\nMacro: ' + result.macroTrend + ' | 15m: ' + result.trend15m + '\nPOC: $' + result.poc.toFixed(0) + ' VA: $' + result.val.toFixed(0) + '-$' + result.vah.toFixed(0) + '\n' + new Date().toLocaleTimeString('pt-PT');
      await sendTelegram(msg);
      console.log(pair + ': ' + result.signal + ' conf=' + result.conf);
    } catch (e) { console.error('Erro ' + symbol + ':', e.message); }
  }
}

async function sendDailyReport() {
  var h = new Date().getUTCHours(), m = new Date().getUTCMinutes();
  if (h !== 8 || m > 5) return;
  var total = winCount + lossCount, wr = total > 0 ? Math.round(winCount / total * 100) : 0;
  var msg = '<b>Relatorio Diario</b>\nWin Rate: ' + wr + '% | P&L: ' + (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2) + '%\n\n';
  for (var i = 0; i < SYMBOLS.length; i++) {
    var sym = SYMBOLS[i], res = dailyResults[sym];
    if (res.length) { var b = res.filter(function(r) { return r.signal === 'BUY'; }).length; msg += sym.replace('USDT', '/USDT') + ': ' + res.length + ' (' + b + 'B/' + (res.length - b) + 'S)\n'; dailyResults[sym] = []; }
  }
  await sendTelegram(msg);
}

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('Server v7 porta ' + PORT);
  sendTelegram('<b>Bot v7!</b>\nParalelo: sinais 3x mais rapidos\nOrderbook API\nBacktest via site\nNotificacoes browser\n\n/status /backtest /btc /eth');
  runBot();
  setInterval(runBot, 5 * 60 * 1000);
  setInterval(sendDailyReport, 5 * 60 * 1000);
  setTimeout(function() { runBacktest('BTCUSDT'); }, 20000);
});
