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
// Limite de 1 sinal por dia removido para aumentar sinais
// var lastSignalDateBuy = { BTCUSDT: '', ETHUSDT: '' };
// var lastSignalDateSell = { BTCUSDT: '', ETHUSDT: '' };
// Usar diretorio persistente: data/ (nao em /tmp que e volatil no Railway)
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {}
}
const STATS_FILE = process.env.STATS_FILE || path.join(DATA_DIR, 'stats.json');
const TRADES_FILE = process.env.TRADES_FILE || path.join(DATA_DIR, 'trades.json');
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

function generateSignal(candles, price, macroTrend, trend15m, atr, liqData, symbol) {
  var closes = candles.map(function(c) { return c.close; });
  var lows = candles.map(function(c) { return c.low; });
  var highs = candles.map(function(c) { return c.high; });
  var ema9 = calcEMA(closes.slice(-9), 9), ema21 = calcEMA(closes.slice(-21), 21), ema50 = calcEMA(closes.slice(-50), 50);
  var rsi = calcRSI(closes, 14);
  var adx = calcADX(candles, 14);
  
  // Parâmetros Dinâmicos por Símbolo (Otimização Dual)
  var isEth = (symbol && symbol.includes('ETH'));
  var minADX = isEth ? 35 : 30;
  var atrMult = isEth ? 2.0 : 1.5;
  var rrRatio = isEth ? 2.0 : 2.5;
  var useTP1 = isEth; // Ativar Realização Parcial (TP1) apenas para o ETH

  var signal = 'WAIT', conf = 0;
  var isStrongBull = price > ema9 && ema9 > ema21 && ema21 > ema50;
  var isStrongBear = price < ema9 && ema9 < ema21 && ema21 < ema50;

  if (isStrongBull && adx > minADX && rsi < 65 && (macroTrend === 'UP' || macroTrend.includes('BULL'))) {
    signal = 'BUY'; conf = 85;
  } else if (isStrongBear && adx > minADX && rsi > 35 && (macroTrend === 'DOWN' || macroTrend.includes('BEAR'))) {
    signal = 'SELL'; conf = 85;
  }

  var sl = 0, tp = 0, slPct = 0, tpPct = 0;
  if (signal === 'BUY') {
    var lastHL = Math.min.apply(null, lows.slice(-3));
    sl = lastHL - (atrMult * atr);
    slPct = Math.abs((price - sl) / price * 100);
    tpPct = slPct * rrRatio;
    tp = price * (1 + tpPct/100);
  } else if (signal === 'SELL') {
    var lastLH = Math.max.apply(null, highs.slice(-3));
    sl = lastLH + (atrMult * atr);
    slPct = Math.abs((sl - price) / price * 100);
    tpPct = slPct * rrRatio;
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
    rsi: rsi.toFixed(1), adx: adx.toFixed(1),
    useTP1: useTP1, // Informar sobre a Realização Parcial (50% @ 1:1 RR)
    tp1Pct: slPct
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
    var signal = generateSignal(candles, price, macroTrend, trend15m, atr, null, symbol);
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
  const totalClosed = winCount + lossCount;
  const totalOpen = tradeHistory.filter(t => t.outcome === 'OPEN').length;
  const total = tradeHistory.length; // Total de todos os trades (abertos + fechados)
  const winRate = totalClosed > 0 ? Math.round((winCount / totalClosed) * 100) : 0;
  
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

// ── TELEGRAM ──────────────────────────────────────────────────────────────────

// Envia mensagem Markdown para o Telegram
async function sendTelegram(msg, parseMode) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
      parse_mode: parseMode || 'Markdown'
    });
  } catch (e) { console.error('Telegram Error:', e.message); }
}

// Barra de confiança visual (igual ao BotAcoesUnificado)
function confidenceBar(conf) {
  const filled = Math.round(conf / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// Formata número com separadores de milhar
function fmtNum(n, decimals) {
  return parseFloat(n).toLocaleString('pt-PT', { minimumFractionDigits: decimals || 0, maximumFractionDigits: decimals || 0 });
}

// ── COMANDOS ──────────────────────────────────────────────────────────────────

async function cmdStart() {
  const now = new Date().toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon' });
  const msg =
    '🟢 *MORCA BOT CRIPTO* — Online\n' +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    `⏰ Iniciado: ${now}\n` +
    `🔄 Scan: cada 5 minutos\n` +
    `📊 Símbolos: ${SYMBOLS.join(', ')} | Risco: 1% operação\n` +
    `🎯 Estratégia: *MORCA CRYPTO MASTER V1*\n` +
    '✅ *Bot pronto para operar.*\n\n' +
    '*Comandos disponíveis:*\n' +
    '/status — Estado detalhado do bot\n' +
    '/scan — Iniciar scan manual BTC e ETH\n' +
    '/price — Preços actuais BTC/ETH\n' +
    '/trades — Ver últimos sinais gerados\n' +
    '/stats — Estatísticas de performance\n' +
    '/capital — Ver ou alterar capital disponível\n' +
    '/backtest — Simulação histórica da estratégia\n' +
    '/help — Guia completo da estratégia';
  await sendTelegram(msg);
}

async function cmdStatus() {
  const now = new Date().toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon' });
  const total = winCount + lossCount;
  const winRate = total > 0 ? (winCount / total * 100).toFixed(1) : '0.0';
  const capital = INITIAL_CAPITAL + totalPnl;
  const msg =
    '📊 *MORCA BOT CRIPTO — Status*\n' +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    `🟢 Online: ${now}\n` +
    `💰 Capital: $${fmtNum(capital, 2)}\n` +
    `⚙️ Risco/trade: 1%\n` +
    `📋 Símbolos: ${SYMBOLS.join(', ')}\n` +
    `🔄 Scan: cada 5 minutos\n` +
    `📈 Sinais hoje: ${tradeHistory.filter(t => t.date === new Date().toLocaleDateString('pt-PT')).length}\n` +
    `🏆 Win Rate: ${winRate}% (${winCount}W / ${lossCount}L)\n` +
    `💹 P&L Total: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%\n\n` +
    '*Comandos disponíveis:*\n' +
    '/status — Estado detalhado do bot\n' +
    '/scan — Iniciar scan manual BTC e ETH\n' +
    '/price — Preços actuais BTC/ETH\n' +
    '/trades — Ver últimos sinais gerados\n' +
    '/stats — Estatísticas de performance\n' +
    '/capital — Ver ou alterar capital disponível\n' +
    '/backtest — Simulação histórica da estratégia\n' +
    '/help — Guia completo da estratégia';
  await sendTelegram(msg);
}

async function cmdPrice() {
  try {
    const [btcP, ethP, btcS, ethS] = await Promise.all([
      axios.get(BINANCE + '/api/v3/ticker/price?symbol=BTCUSDT'),
      axios.get(BINANCE + '/api/v3/ticker/price?symbol=ETHUSDT'),
      axios.get(BINANCE + '/api/v3/ticker/24hr?symbol=BTCUSDT'),
      axios.get(BINANCE + '/api/v3/ticker/24hr?symbol=ETHUSDT')
    ]);
    const btcPrice = parseFloat(btcP.data.price);
    const ethPrice = parseFloat(ethP.data.price);
    const btcChg = parseFloat(btcS.data.priceChangePercent);
    const ethChg = parseFloat(ethS.data.priceChangePercent);
    const btcEmoji = btcChg >= 0 ? '📈' : '📉';
    const ethEmoji = ethChg >= 0 ? '📈' : '📉';
    const msg =
      '💱 *Preços em Tempo Real*\n' +
      '━━━━━━━━━━━━━━━━━━━━\n' +
      `${btcEmoji} *BTC/USDT:* \`$${fmtNum(btcPrice, 2)}\` (${btcChg >= 0 ? '+' : ''}${btcChg.toFixed(2)}%)\n` +
      `${ethEmoji} *ETH/USDT:* \`$${fmtNum(ethPrice, 2)}\` (${ethChg >= 0 ? '+' : ''}${ethChg.toFixed(2)}%)\n` +
      `\n_Atualizado: ${new Date().toLocaleTimeString('pt-PT', { timeZone: 'Europe/Lisbon' })}_`;
    await sendTelegram(msg);
  } catch (e) { await sendTelegram('❌ Erro ao obter preços: ' + e.message); }
}

async function cmdTrades() {
  if (!tradeHistory || tradeHistory.length === 0) {
    await sendTelegram('Nenhum sinal registado ainda.');
    return;
  }
  const recent = tradeHistory.slice(-5).reverse();
  let msg = '📋 *Últimos Sinais*\n\n';
  for (const t of recent) {
    const emoji = t.outcome === 'WIN' ? '✅' : t.outcome === 'LOSS' ? '❌' : '⏳';
    msg += `${emoji} *${t.symbol}* @ \`$${fmtNum(t.entry, 2)}\`\n`;
    msg += `   SL: \`$${fmtNum(t.sl, 2)}\` | TP: \`$${fmtNum(t.tp, 2)}\`\n`;
    if (t.pnl !== undefined) msg += `   P&L: ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}%\n`;
    msg += '\n';
  }
  await sendTelegram(msg);
}

async function cmdStats() {
  const total = winCount + lossCount;
  const winRate = total > 0 ? (winCount / total * 100).toFixed(1) : '0.0';
  const capital = INITIAL_CAPITAL + totalPnl;
  const grossProfit = tradeHistory.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(tradeHistory.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? 'MAX' : '0.00';
  const pnlEmoji = totalPnl >= 0 ? '📈' : '📉';
  const wrEmoji = parseFloat(winRate) >= 50 ? '🟢' : '🔴';
  const msg =
    '📊 *Estatísticas de Performance*\n' +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    `📋 Total de trades: *${total}*\n` +
    `${wrEmoji} Win Rate: *${winRate}%*\n` +
    `✅ Ganhos: *${winCount}* | ❌ Perdas: *${lossCount}*\n` +
    `⏳ Em aberto: *${Object.keys(activeTrades).length}*\n` +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    `${pnlEmoji} P&L Total: *${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%*\n` +
    `⚡ Profit Factor: *${pf}*\n` +
    `💰 Capital Atual: *$${fmtNum(capital, 2)}*\n` +
    `💵 Capital Inicial: *$${fmtNum(INITIAL_CAPITAL, 2)}*`;
  await sendTelegram(msg);
}

async function cmdCapital(args) {
  if (args && args.length > 0) {
    const novo = parseFloat(args[0]);
    if (isNaN(novo) || novo <= 0) {
      await sendTelegram('❌ Uso: /capital 10000\nExemplo: /capital 5000');
    } else {
      // Actualiza o P&L para reflectir o novo capital base
      totalPnl = novo - INITIAL_CAPITAL;
      saveStats(winCount, lossCount, totalPnl);
      await sendTelegram(`✅ Capital actualizado: *$${fmtNum(novo, 2)}*`);
    }
  } else {
    const capital = INITIAL_CAPITAL + totalPnl;
    await sendTelegram(`💰 *Capital Actual:* \`$${fmtNum(capital, 2)}\`\n_Capital inicial: $${fmtNum(INITIAL_CAPITAL, 2)}_`);
  }
}

async function cmdScan() {
  await sendTelegram('🔍 *A iniciar scan manual...*\n_Aguarde um momento._');
  try {
    const results = await Promise.all(
      SYMBOLS.map(async (symbol) => {
        const r = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`, { timeout: 1 }).catch(() => null);
        // Obter sinal via API interna
        const sigRes = await axios.get(`http://localhost:${process.env.PORT || 3001}/api/signal?symbol=${symbol}`).catch(() => null);
        return { symbol, signal: sigRes ? sigRes.data.signal : null };
      })
    );
    let signalCount = 0;
    let details = '';
    for (const r of results) {
      if (r.signal && r.signal.signal !== 'WAIT') {
        signalCount++;
        const s = r.signal;
        
        // Persistência: Adicionar ao histórico e guardar em ficheiro (apenas se não houver sinal recente)
        const now = Date.now();
        if (now - (lastSignalTime[r.symbol] || 0) >= SIGNAL_COOLDOWN) {
          lastSignalTime[r.symbol] = now;
          const tp1PriceScan = s.useTP1 ? (s.signal === 'BUY' ? s.price * (1 + s.tp1Pct/100) : s.price * (1 - s.tp1Pct/100)) : null;
          tradeHistory.push({
            time: now,
            date: new Date().toLocaleDateString('pt-PT'),
            symbol: r.symbol,
            signal: s.signal,
            entry: s.price,
            price: s.price,
            sl: s.sl,
            tp: s.tp,
            tp1: tp1PriceScan,
            slPct: s.slPct,
            tpPct: s.tpPct,
            tp1Pct: s.tp1Pct,
            useTP1: s.useTP1,
            positionSize: s.positionSize,
            conf: s.conf,
            macroTrend: s.macroTrend,
            trend15m: s.trend15m,
            rsi: s.rsi,
            adx: s.adx,
            atr: s.atr,
            outcome: 'OPEN',
            pnl: 0
          });
          saveTrades();
        }

        details += `\n  • *${r.symbol}* — ${s.signal} @ \`$${fmtNum(s.price, 2)}\``;
        
        // Adicionar detalhes de SL e TP
        details += `\n    🛑 SL: \`$${fmtNum(s.sl, 2)}\` (${s.slPct}%)`;
        
        if (s.useTP1) {
          // Lógica de Realização Parcial (ex: ETH Pro)
          const tp1Price = s.signal === 'BUY' ? s.price * (1 + s.tp1Pct/100) : s.price * (1 - s.tp1Pct/100);
          details += `\n    🎯 TP1 (50%): \`$${fmtNum(tp1Price, 2)}\` (${parseFloat(s.tp1Pct).toFixed(2)}%)`;
          details += `\n    🎯 TP2 (Final): \`$${fmtNum(s.tp, 2)}\` (${s.tpPct}%)`;
        } else {
          details += `\n    🎯 TP: \`$${fmtNum(s.tp, 2)}\` (${s.tpPct}%)`;
        }
        details += `\n`;
      }
    }
    const now = new Date().toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon' });
    let msg =
      `🔍 *Relatório de Scan* — ${now}\n` +
      '━━━━━━━━━━━━━━━━━━━━\n' +
      `📊 Símbolos analisados: *${SYMBOLS.length}*\n` +
      `🎯 Sinais encontrados: *${signalCount}*\n` +
      `🔄 Próximo scan: em *5 minutos*`;
    if (details) msg += `\n\n📋 *Sinais:*${details}`;
    await sendTelegram(msg);
  } catch (e) {
    await sendTelegram('❌ Erro no scan: ' + e.message);
  }
}

async function cmdBacktest(args) {
  let days = 90;
  let symbol = 'BTCUSDT';

  if (args && args.length > 0) {
    if (/^\d+$/.test(args[0])) {
      days = parseInt(args[0]);
      if (args[1]) symbol = args[1].toUpperCase();
    } else {
      symbol = args[0].toUpperCase();
    }
  }

  if (![30, 60, 90].includes(days)) {
    await sendTelegram(
      '❌ Período inválido. Use: 30, 60 ou 90\n' +
      'Exemplos:\n' +
      '/backtest 30\n' +
      '/backtest 90 BTCUSDT\n' +
      '/backtest 60'
    );
    return;
  }

  if (!SYMBOLS.includes(symbol)) {
    await sendTelegram(`❌ Símbolo inválido: *${symbol}*\nDisponíveis: ${SYMBOLS.join(', ')}`);
    return;
  }

  await sendTelegram(`⏳ *A executar backtest de ${symbol} nos últimos ${days} dias...*\n_Isto pode demorar 1-2 minutos._`);

  try {
    const limit = Math.ceil((days * 24 * 60) / 30);
    const engine = new BacktestEngine({ symbol, interval: '30m', limit, riskPerTrade: 0.01 });
    const r = await engine.run(generateSignal);

    const pnlEmoji = r.returnPct >= 0 ? '📈' : '📉';
    const wrEmoji = r.winRate >= 50 ? '🟢' : '🔴';

    let msg =
      `📊 *Backtest — ${symbol} — Últimos ${days} dias*\n` +
      '─────────────────────────────\n' +
      `📋 Total de trades: *${r.totalTrades}*\n` +
      '─────────────────────────────\n' +
      `${wrEmoji} Win Rate: *${r.winRate}%*\n` +
      `✅ Ganhos: *${r.wins}* | ❌ Perdas: *${r.losses}*\n` +
      '─────────────────────────────\n' +
      `${pnlEmoji} Retorno Total: *${r.returnPct >= 0 ? '+' : ''}${r.returnPct}%*\n` +
      `📉 Drawdown Máx: *${r.maxDD}%*\n` +
      `⚡ Profit Factor: *${r.profitFactor}*\n` +
      `💰 Capital Final: *$${fmtNum(r.finalCapital, 2)}*\n` +
      '─────────────────────────────\n' +
      `_Capital base: $${fmtNum(INITIAL_CAPITAL, 2)} | R:R 1:2 | Risco 1%_`;

    await sendTelegram(msg);

    // Enviar últimos 5 trades se existirem
    if (r.trades && r.trades.length > 0) {
      const top5 = r.trades.slice(-5).reverse();
      let tradesMsg = '📋 *Últimos 5 Trades:*\n\n';
      for (const t of top5) {
        const emoji = t.outcome === 'WIN' ? '✅' : t.outcome === 'LOSS' ? '❌' : '⏳';
        tradesMsg +=
          `${emoji} *${t.symbol || symbol}* — ${t.entryTime || ''}\n` +
          `   Entrada: \`$${fmtNum(t.entry, 2)}\` → Saída: \`$${fmtNum(t.exit || t.entry, 2)}\`\n` +
          `   P&L: ${(t.pnl || 0) >= 0 ? '+' : ''}${(t.pnl || 0).toFixed(2)}%\n\n`;
      }
      await sendTelegram(tradesMsg);
    }
  } catch (e) {
    console.error('[Backtest] Erro:', e);
    await sendTelegram('❌ Erro ao executar o backtest: ' + e.message.slice(0, 200) + '\nTente: /backtest 30 BTCUSDT');
  }
}

async function cmdHelp() {
  const msg =
    '📖 *MORCA BOT CRIPTO — Ajuda*\n' +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    '*Estratégia (MORCA CRYPTO MASTER V1):*\n' +
    '1️⃣ Tendência macro 4H (Forte BULL/BEAR)\n' +
    '2️⃣ Alinhamento Triplo 30M (9 > 21 > 50)\n' +
    '3️⃣ ADX > 30 (Filtro ADX+ Alta Convicção)\n' +
    '4️⃣ RSI < 65 (BUY) ou RSI > 35 (SELL)\n' +
    '5️⃣ Cooldown dinâmico de 90min\n\n' +
    '*Gestão de Risco:*\n' +
    '• R:R 1:2.5 | Risco 1% operação | SL dinâmico (ATR)\n\n' +
    '*Comandos:*\n' +
    '/start — Início e lista de comandos\n' +
    '/status — Estado detalhado do bot\n' +
    '/scan — Scan manual BTC e ETH\n' +
    '/price — Preços actuais BTC/ETH\n' +
    '/trades — Ver últimos sinais gerados\n' +
    '/stats — Estatísticas de performance\n' +
    '/capital [valor] — Ver ou alterar capital disponível\n' +
    '/backtest [dias] [symbol] — Backtest detalhado\n\n' +
    '*Exemplos de backtest:*\n' +
    '/backtest 30\n' +
    '/backtest 90 BTCUSDT\n' +
    '/backtest 60 ETHUSDT\n\n' +
    '_Símbolos disponíveis: BTCUSDT, ETHUSDT_';
  await sendTelegram(msg);
}

// ── LOOP DE POLLING ───────────────────────────────────────────────────────────

var lastUpdateId = 0;
async function handleTelegramCommands() {
  if (!TELEGRAM_TOKEN) return;
  try {
    const r = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`
    );
    if (!r.data || !r.data.result) return;
    for (const update of r.data.result) {
      lastUpdateId = update.update_id;
      if (!update.message || !update.message.text) continue;

      const raw = update.message.text.trim();
      // Suporta comandos com @BotName e argumentos
      const parts = raw.split(/\s+/);
      const cmd = parts[0].split('@')[0].toLowerCase();
      const args = parts.slice(1);

      if (cmd === '/start') {
        await cmdStart();
      } else if (cmd === '/status') {
        await cmdStatus();
      } else if (cmd === '/price') {
        await cmdPrice();
      } else if (cmd === '/trades') {
        await cmdTrades();
      } else if (cmd === '/stats') {
        await cmdStats();
      } else if (cmd === '/capital') {
        await cmdCapital(args);
      } else if (cmd === '/scan') {
        await cmdScan();
      } else if (cmd === '/backtest' || cmd === '/btc' || cmd === '/eth') {
        // /btc e /eth como atalhos
        if (cmd === '/btc') { await cmdBacktest(['90', 'BTCUSDT']); }
        else if (cmd === '/eth') { await cmdBacktest(['90', 'ETHUSDT']); }
        else { await cmdBacktest(args); }
      } else if (cmd === '/help') {
        await cmdHelp();
      }
    }
  } catch (e) { console.error('[Telegram polling]', e.message); }
}

// ── NOTIFICAÇÕES AUTOMÁTICAS ─────────────────────────────────────────────────

async function runBot() {
  try {
    const results = await Promise.all(
      SYMBOLS.map(async (symbol) => {
        const sigRes = await axios.get(`http://localhost:${process.env.PORT || 3001}/api/signal?symbol=${symbol}`).catch(() => null);
        return { symbol, signal: sigRes ? sigRes.data.signal : null };
      })
    );

    for (const r of results) {
      if (r.signal && r.signal.signal !== 'WAIT') {
        const s = r.signal;
        const now = Date.now();
        
        // Evitar sinais duplicados (cooldown de 90 min)
        if (now - (lastSignalTime[r.symbol] || 0) < SIGNAL_COOLDOWN) continue;
        
        lastSignalTime[r.symbol] = now;
        lastSignal[r.symbol] = s;

        // Persistência: Adicionar ao histórico e guardar em ficheiro
        const tp1Price = s.useTP1 ? (s.signal === 'BUY' ? s.price * (1 + s.tp1Pct/100) : s.price * (1 - s.tp1Pct/100)) : null;
        tradeHistory.push({
          time: now,
          date: new Date().toLocaleDateString('pt-PT'),
          symbol: r.symbol,
          signal: s.signal,
          entry: s.price,
          price: s.price,
          sl: s.sl,
          tp: s.tp,
          tp1: tp1Price,
          slPct: s.slPct,
          tpPct: s.tpPct,
          tp1Pct: s.tp1Pct,
          useTP1: s.useTP1,
          positionSize: s.positionSize,
          conf: s.conf,
          macroTrend: s.macroTrend,
          trend15m: s.trend15m,
          rsi: s.rsi,
          adx: s.adx,
          atr: s.atr,
          outcome: 'OPEN',
          pnl: 0
        });
        saveTrades();

        const emoji = s.signal === 'BUY' ? '🟢' : '🔴';
        const type = s.signal === 'BUY' ? 'COMPRA (LONG)' : 'VENDA (SHORT)';
        
        let msg = 
          `${emoji} *NOVO SINAL: ${r.symbol}*\n` +
          '━━━━━━━━━━━━━━━━━━━━\n' +
          `🎯 Tipo: *${type}*\n` +
          `💰 Preço: \`$${fmtNum(s.price, 2)}\`\n` +
          `📊 Confiança: \`${s.conf}%\` [${confidenceBar(s.conf)}]\n` +
          `🛑 SL: \`$${fmtNum(s.sl, 2)}\` (${s.slPct}%)\n`;

        if (s.useTP1) {
          const tp1Price = s.signal === 'BUY' ? s.price * (1 + s.tp1Pct/100) : s.price * (1 - s.tp1Pct/100);
          msg += `🎯 TP1 (50%): \`$${fmtNum(tp1Price, 2)}\` (${parseFloat(s.tp1Pct).toFixed(2)}%)\n`;
          msg += `🎯 TP2 (Final): \`$${fmtNum(s.tp, 2)}\` (${s.tpPct}%)\n`;
        } else {
          msg += `🎯 TP: \`$${fmtNum(s.tp, 2)}\` (${s.tpPct}%)\n`;
        }
        
        msg += 
          '━━━━━━━━━━━━━━━━━━━━\n' +
          `📈 Macro 4H: *${s.macroTrend}*\n` +
          `📉 Trend 15M: *${s.trend15m}*\n` +
          `📏 RSI: \`${s.rsi}\` | ADX: \`${s.adx}\`\n` +
          `💼 Tamanho: \`$${fmtNum(s.positionSize, 0)}\` (Risco 1%)\n\n` +
          `_Estratégia MORCA CRYPTO MASTER V1_`;

        await sendTelegram(msg);
      }
    }
  } catch (e) {
    console.error('[runBot Error]:', e.message);
  }
}

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('Server porta ' + PORT);
  const now = new Date().toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon' });
  sendTelegram(
    '🟢 *MORCA BOT CRIPTO* — Online\n' +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    `⏰ Iniciado: ${now}\n` +
    `🔄 Scan: cada 5 minutos\n` +
    `📊 Símbolos: ${SYMBOLS.join(', ')} | Risco: 1% operação\n` +
    `🎯 Estratégia *MORCA CRYPTO MASTER V1* Ativa\n\n` +
    '*Comandos disponíveis:*\n' +
    '/status — Estado detalhado do bot\n' +
    '/scan — Iniciar scan manual BTC e ETH\n' +
    '/price — Preços actuais BTC/ETH\n' +
    '/trades — Ver últimos sinais gerados\n' +
    '/stats — Estatísticas de performance\n' +
    '/capital — Ver ou alterar capital disponível\n' +
    '/backtest — Simulação histórica da estratégia\n' +
    '/help — Guia completo da estratégia\n\n' +
    `_Bot pronto para operar._`
  );
  setInterval(runBot, 5 * 60 * 1000);
  setInterval(handleTelegramCommands, 5000);
});
