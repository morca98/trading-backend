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
var lastUpdateId = 0;

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
function calcTrend(closes) {
  var ema9 = calcEMA(closes.slice(-9), 9), ema21 = calcEMA(closes.slice(-21), 21);
  return ema9 > ema21 ? 'UP' : 'DOWN';
}

function generateSignal(candles, price, macroTrend, trend15m, atr, liqData) {
  var closes = candles.map(function(c) { return c.close; });
  var ema9 = calcEMA(closes.slice(-9), 9), ema21 = calcEMA(closes.slice(-21), 21), ema50 = calcEMA(closes.slice(-50), 50);
  
  var signal = 'WAIT', conf = 0;
  if (price > ema9 && ema9 > ema21 && ema21 > ema50 && macroTrend.includes('BULL') && trend15m === 'UP') {
    signal = 'BUY'; conf = 65;
  } else if (price < ema9 && ema9 < ema21 && ema21 < ema50 && macroTrend.includes('BEAR') && trend15m === 'DOWN') {
    signal = 'SELL'; conf = 65;
  }

  var slPct = 1.5, tpPct = 3.0;
  var sl = signal === 'BUY' ? price * (1 - slPct/100) : price * (1 + slPct/100);
  var tp = signal === 'BUY' ? price * (1 + tpPct/100) : price * (1 - tpPct/100);

  return { 
    signal: signal, conf: conf, price: price, sl: sl, tp: tp, slPct: slPct, tpPct: tpPct, 
    ema9: ema9.toFixed(2), ema21: ema21.toFixed(2), ema50: ema50.toFixed(2), 
    macroTrend: macroTrend, trend15m: trend15m, atr: atr.toFixed(2),
    rsi: 50, adx: 25 // Fallback values
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
    var BINANCE_FUTURES = 'https://fapi.binance.com';
    var results = await Promise.all([
      axios.get(BINANCE_FUTURES + '/fapi/v1/ticker/24hr?symbol=' + symbol),
      axios.get(BINANCE_FUTURES + '/fapi/v1/premiumIndex?symbol=' + symbol),
      axios.get(BINANCE_FUTURES + '/fapi/v1/openInterest?symbol=' + symbol)
    ]);
    res.json({ success: true, symbol: symbol, currentPrice: parseFloat(results[0].data.lastPrice), fundingRate: parseFloat(results[1].data.lastFundingRate), openInterest: parseFloat(results[2].data.openInterest), levels: [] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/stats', function(req, res) { res.json({ success: true, wins: winCount, losses: lossCount, totalPnl: totalPnl }); });

app.get('/api/backtest', async function(req, res) {
  try {
    const symbol = req.query.symbol || 'BTCUSDT';
    const days = parseInt(req.query.days) || 90;
    const engine = new BacktestEngine({ symbol: symbol, interval: '30m', limit: Math.ceil((days * 24 * 60) / 30) });
    const results = await engine.run(generateSignal);
    res.json({ success: true, results: results });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.use(express.static(path.join(__dirname, '/')));

// ── TELEGRAM ──
async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try { await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' }); } catch (e) { console.error('Telegram Error:', e.message); }
}

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
        } else if (text === '/backtest') {
          runBacktest('BTCUSDT');
        } else if (text === '/status') {
          await sendTelegram('<b>Estado:</b> Ativo\nSinais: BTC/ETH\nTimeframe: 30M');
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

async function checkActiveTrades() {
  for (var sym in activeTrades) {
    var t = activeTrades[sym];
    try {
      var r = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + sym);
      var p = parseFloat(r.data.price);
      var win = (t.signal === 'BUY' && p >= t.tp) || (t.signal === 'SELL' && p <= t.tp);
      var loss = (t.signal === 'BUY' && p <= t.sl) || (t.signal === 'SELL' && p >= t.sl);
      if (win || loss) {
        var pnl = win ? Math.abs(t.tp - t.entry) / t.entry * 100 : -Math.abs(t.sl - t.entry) / t.entry * 100;
        if (win) winCount++; else lossCount++;
        totalPnl += pnl;
        saveStats(winCount, lossCount, totalPnl);
        await sendTelegram(`<b>Trade Concluido!</b>\n${t.pair}: ${win ? 'WIN' : 'LOSS'}\nP&L: ${pnl.toFixed(2)}%`);
        delete activeTrades[sym];
      }
    } catch (e) {}
  }
}

async function runBot() {
  await checkActiveTrades();
  for (var i = 0; i < SYMBOLS.length; i++) {
    var symbol = SYMBOLS[i];
    if (activeTrades[symbol]) continue;
    try {
      var r = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=30m&limit=200');
      var candles = r.data.map(function(k) { return { time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }; });
      var p = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + symbol);
      var price = parseFloat(p.data.price);
      var atr = calcATR(candles, 14);
      var result = generateSignal(candles, price, 'BULL', 'UP', atr, null);
      if (result.signal !== 'WAIT') {
        // Lógica de envio de sinal aqui...
      }
    } catch (e) {}
  }
}

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('Server porta ' + PORT);
  sendTelegram('<b>Bot Ativo!</b>\nSite e Comandos interativos disponiveis.');
  setInterval(runBot, 5 * 60 * 1000);
  setInterval(handleTelegramCommands, 5000);
});
