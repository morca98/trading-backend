const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const BacktestEngine = require('./backtest-engine');
const app = express();

const cors = require('cors');
app.use(cors({
  origin: '*', // Permite qualquer origem, incluindo GitHub Pages
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

const BINANCE = 'https://data-api.binance.vision';
const BINANCE_FUTURES = 'https://fapi.binance.com';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const SIGNAL_COOLDOWN = 90 * 60 * 1000; // 90 minutos = 3 velas de 30m (igual ao cooldown do backtest)
// Limite de 1 sinal por dia por direção (espelha o backtest-engine)
var lastSignalDateBuy = { BTCUSDT: '', ETHUSDT: '' };
var lastSignalDateSell = { BTCUSDT: '', ETHUSDT: '' };
const STATS_FILE = process.env.STATS_FILE || '/tmp/stats.json';
const TRADES_FILE = process.env.TRADES_FILE || '/tmp/trades.json';
const INITIAL_CAPITAL = 1000; // Capital inicial do bot

var lastSignal = { BTCUSDT: null, ETHUSDT: null };
var lastSignalTime = { BTCUSDT: 0, ETHUSDT: 0 };
var dailyResults = { BTCUSDT: [], ETHUSDT: [] };
var activeTrades = {};
var priceAlerts = [];
var dailyReportSentDate = '';

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

function loadTrades() {
  try {
    if (fs.existsSync(TRADES_FILE)) return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  } catch(e) {}
  return [];
}

function saveTrades() {
  try { fs.writeFileSync(TRADES_FILE, JSON.stringify(tradeHistory)); } catch(e) {}
}

var stats = loadStats();
var winCount = stats.wins, lossCount = stats.losses, totalPnl = stats.totalPnl;
var tradeHistory = loadTrades();

// ── INDICATORS ──
function calcEMA(data, period) {
  var k = 2 / (period + 1);
  var ema = data[0];
  for (var i = 1; i < data.length; i++) ema = (data[i] * k) + (ema * (1 - k));
  return ema;
}
function calcEMALine(data, period) {
  var k = 2 / (period + 1), ema = data[0], res = [ema];
  for (var i = 1; i < data.length; i++) { ema = (data[i] * k) + (ema * (1 - k)); res.push(ema); }
  return res;
}
function calcATR(candles, period) {
  if (candles.length < period + 1) return 0;
  var trs = [];
  for (var i = 1; i < candles.length; i++) {
    var h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b) / period;
}
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  var gains = 0, losses = 0;
  for (var i = closes.length - period; i < closes.length; i++) {
    var diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  var rs = gains / (losses || 1);
  return 100 - (100 / (1 + rs));
}
function calcADX(candles, period = 14) {
  if (candles.length < period * 2) return 20;
  var plusDM = [], minusDM = [], tr = [];
  for (var i = 1; i < candles.length; i++) {
    var h = candles[i].high, l = candles[i].low, ph = candles[i-1].high, pl = candles[i-1].low, pc = candles[i-1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    var moveUp = h - ph, moveDown = pl - l;
    plusDM.push(moveUp > 0 && moveUp > moveDown ? moveUp : 0);
    minusDM.push(moveDown > 0 && moveDown > moveUp ? moveDown : 0);
  }
  var smoothTR = tr.slice(-period).reduce((a, b) => a + b);
  var smoothPlusDM = plusDM.slice(-period).reduce((a, b) => a + b);
  var smoothMinusDM = minusDM.slice(-period).reduce((a, b) => a + b);
  var plusDI = 100 * (smoothPlusDM / smoothTR);
  var minusDI = 100 * (smoothMinusDM / smoothTR);
  var dx = 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);
  return dx; // Retorna força da tendência
}
function calcTrend(closes) {
  var ema9 = calcEMA(closes.slice(-9), 9), ema21 = calcEMA(closes.slice(-21), 21);
  return ema9 > ema21 ? 'UP' : 'DOWN';
}

function generateSignal(candles, price, macroTrend, trend15m, atr, liqData) {
  var closes = candles.map(function(c) { return c.close; });
  var lows = candles.map(function(c) { return c.low; });
  var highs = candles.map(function(c) { return c.high; });
  var ema9 = calcEMA(closes.slice(-9), 9), ema21 = calcEMA(closes.slice(-21), 21), ema50 = calcEMA(closes.slice(-50), 50);
  var rsi = calcRSI(closes, 14);
  var adx = calcADX(candles, 14);
  
  var signal = 'WAIT', conf = 0;
  // Filtros de qualidade para aumentar Profit Factor:
  // 1. Tendência forte (ADX > 20)
  // 2. Alinhamento de EMAs (9 > 21 > 50 para BUY)
  // 3. RSI não sobrecomprado para BUY (< 70) e não sobrevenda para SELL (> 30)
  var isBull = price > ema9 && ema9 > ema21 && ema21 > ema50;
  var isBear = price < ema9 && ema9 < ema21 && ema21 < ema50;
  
  if (isBull && adx > 20 && rsi < 70 && (macroTrend === 'UP' || macroTrend.includes('BULL') || macroTrend === 'LOCAL')) {
    signal = 'BUY'; conf = 75;
  } else if (isBear && adx > 20 && rsi > 30 && (macroTrend === 'DOWN' || macroTrend.includes('BEAR') || macroTrend === 'LOCAL')) {
    signal = 'SELL'; conf = 75;
  }

  // Novo Stop Loss: HL/LH de 30min com buffer de 1.5 * ATR
  var sl = 0, tp = 0, slPct = 0, tpPct = 0;
  if (signal === 'BUY') {
    var lastHL = Math.min.apply(null, lows.slice(-3)); // Mínimo das últimas 3 velas (30m cada)
    sl = lastHL - (1.5 * atr);
    slPct = Math.abs((price - sl) / price * 100);
    tpPct = slPct * 3.0; // Alvo dinâmico baseado no R:R de 3.0
    tp = price * (1 + tpPct/100);
  } else if (signal === 'SELL') {
    var lastLH = Math.max.apply(null, highs.slice(-3)); // Máximo das últimas 3 velas
    sl = lastLH + (1.5 * atr);
    slPct = Math.abs((sl - price) / price * 100);
    tpPct = slPct * 3.0;
    tp = price * (1 - tpPct/100);
  }

  // Cálculo do tamanho da posição para 1% de risco real
  var riskAmount = (INITIAL_CAPITAL + totalPnl) * 0.01;
  var positionSize = slPct > 0 ? (riskAmount / (slPct / 100)) : 0;

  return { 
    signal: signal, conf: conf, price: price, sl: sl, tp: tp, slPct: slPct.toFixed(2), tpPct: tpPct.toFixed(2), 
    ema9: ema9.toFixed(2), ema21: ema21.toFixed(2), ema50: ema50.toFixed(2), 
    macroTrend: macroTrend, trend15m: trend15m, atr: atr.toFixed(2),
    positionSize: positionSize.toFixed(0),
    rsi: rsi.toFixed(1), adx: adx.toFixed(1)
  };
}

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

app.get('/api/signal', async function(req, res) {
  try {
    var symbol = req.query.symbol || 'BTCUSDT';
    var interval = req.query.interval || '30m';
    var results = await Promise.all([
      axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=' + interval + '&limit=200'),
      axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + symbol),
      axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=4h&limit=200'),
      axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=15m&limit=30')
    ]);
    var candles = results[0].data.map(function(k) { return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }; });
    var price = parseFloat(results[1].data.price);
    var closes4h = results[2].data.map(function(k) { return +k[4]; });
    var macroEma50 = closes4h.length >= 50 ? calcEMA(closes4h.slice(-50), 50) : calcEMA(closes4h, closes4h.length);
    var macroEma200 = closes4h.length >= 200 ? calcEMA(closes4h.slice(-200), 200) : macroEma50;
    var lastPrice4h = closes4h[closes4h.length - 1];
    var macroTrend = (lastPrice4h > macroEma50 && macroEma50 > macroEma200) ? 'BULL' : (lastPrice4h < macroEma50 && macroEma50 < macroEma200) ? 'BEAR' : 'NEUTRAL';
    var trend15m = calcTrend(results[3].data.map(function(k) { return +k[4]; }));
    var atr = calcATR(candles, 14);
    var signal = generateSignal(candles, price, macroTrend, trend15m, atr, null);
    var closes = candles.map(function(c) { return c.close; });
    res.json({ success: true, signal: signal, price: price, candles: candles.slice(-60), ema9: calcEMALine(closes, 9).slice(-60), ema21: calcEMALine(closes, 21).slice(-60), ema50: calcEMALine(closes, 50).slice(-60), macroTrend: macroTrend, trend15m: trend15m });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/liqmap', async function(req, res) {
  try {
    var symbol = req.query.symbol || 'BTCUSDT';
    var coinglassKey = req.query.apiKey || process.env.COINGLASS_API_KEY || '';

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
          return res.json({ 
            success: true, source: 'coinglass', symbol: symbol, levels: levels, currentPrice: cgData.currentPrice || 0,
            oi: cgData.openInterest || 0, fundingRate: cgData.fundingRate || 0, longRatio: cgData.longRatio || 0.5,
            totalLongLiq: levels.filter(l => l.type === 'long').reduce((s,l) => s+l.total, 0),
            totalShortLiq: levels.filter(l => l.type === 'short').reduce((s,l) => s+l.total, 0),
            dominancia: (cgData.longRatio || 0.5) > 0.5 ? 'LONGS' : 'SHORTS'
          });
        }
      } catch (cgErr) { console.log('Coinglass API erro, usando fallback Binance:', cgErr.message); }
    }

    var results = await Promise.all([
      axios.get(BINANCE_FUTURES + '/fapi/v1/klines?symbol=' + symbol + '&interval=1h&limit=168'),
      axios.get(BINANCE_FUTURES + '/fapi/v1/ticker/24hr?symbol=' + symbol),
      axios.get(BINANCE_FUTURES + '/fapi/v1/premiumIndex?symbol=' + symbol),
      axios.get(BINANCE_FUTURES + '/fapi/v1/openInterest?symbol=' + symbol),
      axios.get(BINANCE_FUTURES + '/futures/data/globalLongShortAccountRatio?symbol=' + symbol + '&period=1h&limit=24')
    ]);

    var candles = results[0].data.map(function(k) { return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }; });
    var ticker = results[1].data;
    var premium = results[2].data;
    var openInterest = parseFloat(results[3].data.openInterest);
    var lsRatios = results[4].data;
    var currentPrice = parseFloat(ticker.lastPrice);
    var fundingRate = parseFloat(premium.lastFundingRate);
    var avgLongRatio = lsRatios.reduce(function(s, r) { return s + parseFloat(r.longAccount); }, 0) / lsRatios.length;
    var avgShortRatio = 1 - avgLongRatio;

    var leverages = [5, 10, 20, 50, 100], priceRange = currentPrice * 0.15, N = 40, step = (priceRange * 2) / N, minPrice = currentPrice - priceRange, levels = [];
    for (var i = 0; i < N; i++) {
      var levelPrice = minPrice + step * i + step / 2;
      var distFromCurrent = (levelPrice - currentPrice) / currentPrice;
      var longLiq = 0, shortLiq = 0;
      if (levelPrice < currentPrice) {
        var dropPct = Math.abs(distFromCurrent);
        leverages.forEach(lev => {
          var liqThreshold = 1 / lev;
          if (dropPct >= liqThreshold * 0.85) {
            var weight = Math.exp(-Math.pow((dropPct - liqThreshold) / (liqThreshold * 0.15), 2) * 0.5);
            var levWeight = lev === 10 ? 0.30 : lev === 20 ? 0.25 : lev === 5 ? 0.20 : lev === 50 ? 0.15 : 0.10;
            longLiq += openInterest * avgLongRatio * levWeight * weight * 0.15;
          }
        });
      } else {
        var risePct = Math.abs(distFromCurrent);
        leverages.forEach(lev => {
          var liqThreshold = 1 / lev;
          if (risePct >= liqThreshold * 0.85) {
            var weight = Math.exp(-Math.pow((risePct - liqThreshold) / (liqThreshold * 0.15), 2) * 0.5);
            var levWeight = lev === 10 ? 0.30 : lev === 20 ? 0.25 : lev === 5 ? 0.20 : lev === 50 ? 0.15 : 0.10;
            shortLiq += openInterest * avgShortRatio * levWeight * weight * 0.15;
          }
        });
      }
      var total = longLiq + shortLiq;
      if (total > 0) levels.push({ price: Math.round(levelPrice), longLiq: Math.round(longLiq), shortLiq: Math.round(shortLiq), total: total, intensity: 0 });
    }

    var maxTotal = Math.max.apply(null, levels.map(function(l) { return l.total; })) || 1;
    levels.forEach(function(l) { l.intensity = l.total / maxTotal; });
    levels.sort(function(a, b) { return a.price - b.price; });

    var totalLongLiq = levels.reduce(function(s, l) { return s + l.longLiq; }, 0);
    var totalShortLiq = levels.reduce(function(s, l) { return s + l.shortLiq; }, 0);

    res.json({
      success: true, source: 'binance_estimated', symbol: symbol, currentPrice: currentPrice, openInterest: openInterest, fundingRate: fundingRate, longRatio: avgLongRatio, levels: levels,
      oi: openInterest, lsRatio: avgLongRatio, totalLongLiq: Math.round(totalLongLiq), totalShortLiq: Math.round(totalShortLiq), dominancia: avgLongRatio > 0.5 ? 'LONGS' : 'SHORTS'
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/stats', function(req, res) {
  const total = winCount + lossCount;
  const winRate = total > 0 ? Math.round((winCount / total) * 100) : 0;
  
  // Calcular curva de capital a partir do histórico de trades
  let currentCap = INITIAL_CAPITAL;
  const capitalCurve = [currentCap];
  tradeHistory.forEach(t => {
    if (t.outcome !== 'OPEN') {
      // Assumindo risco fixo ou pnl percentual sobre o capital
      currentCap += (currentCap * (t.pnl / 100));
      capitalCurve.push(Math.round(currentCap));
    }
  });

  // Calcular Profit Factor
  const grossProfit = tradeHistory.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(tradeHistory.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? 'MAX' : '0.00';

  res.json({
    success: true,
    wins: winCount,
    losses: lossCount,
    total: total,
    winRate: winRate,
    totalPnl: totalPnl,
    profitFactor: profitFactor,
    activeTrades: Object.keys(activeTrades).length,
    initialCapital: INITIAL_CAPITAL,
    currentCapital: Math.round(currentCap),
    capitalCurve: capitalCurve,
    dailyResults: dailyResults,
    tradeHistory: tradeHistory.slice(-50) // Enviar os últimos 50 trades
  });
});

app.get('/api/backtest', async function(req, res) {
  try {
    const symbol = req.query.symbol || 'BTCUSDT';
    const days = parseInt(req.query.days) || 90;
    const limit = Math.ceil((days * 24 * 60) / 30);
    console.log(`Iniciando backtest: ${symbol}, ${days} dias, ${limit} velas`);
    
    const engine = new BacktestEngine({ 
      symbol: symbol, 
      interval: '30m', 
      limit: limit,
      riskPerTrade: 0.01 
    });
    
    const results = await engine.run(generateSignal);
    
    // Garantir que a resposta seja plana para o frontend
    res.json({ 
      success: true, 
      ...results 
    });
  } catch (err) { 
    console.error('Erro no backtest:', err);
    res.status(500).json({ success: false, error: err.message }); 
  }
});

app.use(express.static(path.join(__dirname, '/')));

// ── TELEGRAM ──
async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try { await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' }); } catch (e) { console.error('Telegram Error:', e.message); }
}

var lastUpdateId = 0;
async function handleTelegramCommands() {
  if (!TELEGRAM_TOKEN) return;
  try {
    const r = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`);
    if (r.data && r.data.result) {
      for (const update of r.data.result) {
        lastUpdateId = update.update_id;
        if (!update.message || !update.message.text) continue;
        const text = update.message.text.toLowerCase();
        if (text === '/start' || text === '/help') {
          await sendTelegram('<b>Comandos:</b>\n/price - Preco BTC/ETH\n/stats - Performance\n/backtest - Teste 90d BTC\n/status - Estado Bot');
        } else if (text === '/price') {
          const bp = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=BTCUSDT');
          const ep = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=ETHUSDT');
          await sendTelegram(`<b>Precos:</b>\nBTC: $${parseFloat(bp.data.price).toLocaleString()}\nETH: $${parseFloat(ep.data.price).toLocaleString()}`);
        } else if (text === '/stats') {
          const total = winCount + lossCount;
          await sendTelegram(`<b>Estatisticas:</b>\nWins: ${winCount}\nLosses: ${lossCount}\nWin Rate: ${total > 0 ? (winCount/total*100).toFixed(1) : 0}%\nP&L: ${totalPnl.toFixed(2)}%`);
        } else if (text === '/backtest' || text === '/btc') {
          runBacktest('BTCUSDT');
        } else if (text === '/eth') {
          runBacktest('ETHUSDT');
        } else if (text === '/status') {
          const now = new Date().toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon' });
          await sendTelegram(`<b>Estado:</b> Ativo\nSinais: BTC/ETH\nTimeframe: 30M\nHora: ${now}`);
        }
      }
    }
  } catch (e) {}
}

async function runBacktest(symbol) {
  await sendTelegram('<b>Backtest ' + symbol + '</b>\nA processar...');
  try {
    const engine = new BacktestEngine({ symbol: symbol, interval: '30m', limit: 4320 });
    const results = await engine.run(generateSignal);
    await sendTelegram(`<b>Resultado ${symbol}:</b>\nTrades: ${results.totalTrades}\nWin Rate: ${results.winRate}%\nRetorno: ${results.returnPct}%`);
  } catch (e) { await sendTelegram('Erro: ' + e.message); }
}

async function runBot() {
  // Lógica do bot original aqui...
}

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('Server porta ' + PORT);
  sendTelegram('<b>Bot Ativo!</b>\nSite e Comandos interativos disponiveis.');
  setInterval(runBot, 5 * 60 * 1000);
  setInterval(handleTelegramCommands, 5000);
});
