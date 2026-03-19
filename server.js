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

var lastSignal = { BTCUSDT: null, ETHUSDT: null };
var lastSignalTime = { BTCUSDT: 0, ETHUSDT: 0 };
var dailyResults = { BTCUSDT: [], ETHUSDT: [] };

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

app.get('/', function(req, res) { res.json({ status: 'ok' }); });

async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
      chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML'
    });
  } catch (e) { console.error('Telegram erro:', e.message); }
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

// Volume Profile com 200 velas
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
  // Nuvens de liquidez: LVN e zonas de rejeicao
  var avgVol = totalVol / bars.length;
  var lvns = bars.filter(function(b) { return b.vol < avgVol * 0.35 && b.price !== poc.price; });
  return { poc: poc.price, val: vaLow, vah: vaHigh, lvns: lvns };
}

// Stop Loss dinamico baseado em niveis reais
function calcDynamicSL(candles, signal, price) {
  var lookback = candles.slice(-20);
  var lows = lookback.map(function(c) { return c.low; });
  var highs = lookback.map(function(c) { return c.high; });
  if (signal === 'BUY') {
    // SL abaixo do minimo recente mais proximo
    var recentLow = Math.min.apply(null, lows.slice(-5));
    var sl = recentLow * 0.999;
    // Nao deixar SL mais de 3% abaixo
    return Math.max(sl, price * 0.97);
  } else {
    var recentHigh = Math.max.apply(null, highs.slice(-5));
    var sl2 = recentHigh * 1.001;
    return Math.min(sl2, price * 1.03);
  }
}

// Divergencia RSI
function calcRSIDivergence(candles, rsi) {
  var len = candles.length;
  if (len < 10) return 'NONE';
  var closes = candles.map(function(c) { return c.close; });
  var prevRsi = calcRSI(closes.slice(0, -3), 14);
  var prevPrice = closes[len - 4];
  var curPrice = closes[len - 1];
  // Bearish divergence: preco sobe mas RSI desce
  if (curPrice > prevPrice && rsi < prevRsi && rsi > 55) return 'BEARISH';
  // Bullish divergence: preco desce mas RSI sobe
  if (curPrice < prevPrice && rsi > prevRsi && rsi < 45) return 'BULLISH';
  return 'NONE';
}

// Filtro de sessao: evitar baixo volume (00h-06h UTC)
function isGoodSession() {
  var hour = new Date().getUTCHours();
  return hour >= 6 && hour <= 22;
}

// Confirmacao de candle fechada
function confirmCandle(candles, signal) {
  var prev = candles[candles.length - 2];
  if (!prev) return false;
  if (signal === 'BUY' && prev.close > prev.open) return true;
  if (signal === 'SELL' && prev.close < prev.open) return true;
  return false;
}

// Tendencia macro em 4h
async function getMacroTrend(symbol) {
  try {
    var r = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=4h&limit=50');
    var candles = r.data.map(function(k) { return { close: +k[4] }; });
    var closes = candles.map(function(c) { return c.close; });
    var ema20 = calcEMA(closes.slice(-20), 20);
    var ema50 = calcEMA(closes.slice(-50), 50);
    var lastClose = closes[closes.length - 1];
    if (lastClose > ema20 && ema20 > ema50) return 'BULL';
    if (lastClose < ema20 && ema20 < ema50) return 'BEAR';
    return 'NEUTRAL';
  } catch (e) { return 'NEUTRAL'; }
}

function generateSignal(candles, price, macroTrend) {
  var closes = candles.map(function(c) { return c.close; });
  var vp = calcVP(candles.slice(-200));
  var rsi = calcRSI(closes);
  var ema20 = calcEMA(closes.slice(-20), 20);
  var ema50 = calcEMA(closes.slice(-50), 50);
  var trend = closes[closes.length - 1] > closes[closes.length - 10] ? 'UP' : 'DOWN';
  var rv = candles.slice(-5).reduce(function(s, c) { return s + c.volume; }, 0);
  var pv = candles.slice(-10, -5).reduce(function(s, c) { return s + c.volume; }, 0);
  var inVA = price >= vp.val && price <= vp.vah;
  var abovePoc = price > vp.poc;
  var divergence = calcRSIDivergence(candles, rsi);

  var buy = 0, sell = 0;

  // Volume Profile
  if (abovePoc && inVA) buy += 2; if (!abovePoc && inVA) sell += 2;

  // RSI
  if (rsi < 35) buy += 3; else if (rsi < 45) buy += 1;
  if (rsi > 65) sell += 3; else if (rsi > 55) sell += 1;

  // EMA
  if (price > ema20 && price > ema50) buy += 2; else if (price < ema20 && price < ema50) sell += 2;
  if (ema20 > ema50) buy += 1; else sell += 1;

  // Trend
  if (trend === 'UP') buy += 1; else sell += 1;

  // Volume
  if (rv > pv * 1.1) { buy += 1; sell += 1; }

  // Macro trend bonus
  if (macroTrend === 'BULL') buy += 2;
  if (macroTrend === 'BEAR') sell += 2;

  // Divergencia RSI
  if (divergence === 'BULLISH') buy += 2;
  if (divergence === 'BEARISH') sell += 2;

  // LVN proxima (zona de aceleracao)
  var nearLVN = vp.lvns.some(function(l) { return Math.abs(l.price - price) / price < 0.01; });
  if (nearLVN) { buy += 1; sell += 1; }

  var maxScore = 14;
  var signal = null;
  if (buy >= 8 && buy > sell + 2) signal = 'BUY';
  if (sell >= 8 && sell > buy + 2) signal = 'SELL';
  if (!signal) return null;

  // Filtro macro: nao comprar em bear forte, nao vender em bull forte
  if (signal === 'BUY' && macroTrend === 'BEAR' && buy < 10) return null;
  if (signal === 'SELL' && macroTrend === 'BULL' && sell < 10) return null;

  // Confirmacao de candle
  if (!confirmCandle(candles, signal)) return null;

  var conf = Math.min(95, Math.round(Math.max(buy, sell) / maxScore * 100));
  var sl = calcDynamicSL(candles, signal, price);
  var slPct = Math.abs(price - sl) / price;
  var tp = signal === 'BUY' ? price * (1 + slPct * 2.2) : price * (1 - slPct * 2.2);

  return {
    signal: signal, conf: conf, price: price, sl: sl, tp: tp,
    rsi: rsi.toFixed(1), poc: vp.poc, val: vp.val, vah: vp.vah,
    macroTrend: macroTrend, divergence: divergence,
    slPct: (slPct * 100).toFixed(2), tpPct: (slPct * 2.2 * 100).toFixed(2)
  };
}

async function runBot() {
  console.log('Bot a analisar... ' + new Date().toISOString());

  // Filtro de sessao
  if (!isGoodSession()) {
    console.log('Fora de sessao, a aguardar...');
    return;
  }

  for (var i = 0; i < SYMBOLS.length; i++) {
    var symbol = SYMBOLS[i];
    try {
      var resp = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=30m&limit=200');
      var candles = resp.data.map(function(k) {
        return { time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
      });
      var pr = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + symbol);
      var price = parseFloat(pr.data.price);
      var macroTrend = await getMacroTrend(symbol);
      var result = generateSignal(candles, price, macroTrend);
      var pair = symbol.replace('USDT', '/USDT');

      if (!result || result.conf < 80) {
        console.log(pair + ': WAIT conf=' + (result ? result.conf : 0) + ' macro=' + macroTrend);
        continue;
      }

      // Anti-repeticao
      var now = Date.now();
      if (lastSignal[symbol] === result.signal && (now - lastSignalTime[symbol]) < SIGNAL_COOLDOWN) {
        console.log(pair + ': sinal repetido ignorado (' + result.signal + ')');
        continue;
      }

      lastSignal[symbol] = result.signal;
      lastSignalTime[symbol] = now;
      dailyResults[symbol].push({ signal: result.signal, time: new Date().toLocaleTimeString('pt-PT'), conf: result.conf });

      var divTxt = result.divergence !== 'NONE' ? '\nDivergencia RSI: ' + result.divergence : '';
      var msg = '<b>' + result.signal + ' ' + pair + '</b>\n\n'
        + 'Preco: $' + price.toFixed(2) + '\n'
        + 'Entrada: $' + price.toFixed(0) + '\n'
        + 'Stop: $' + result.sl.toFixed(0) + ' (-' + result.slPct + '%)\n'
        + 'Alvo: $' + result.tp.toFixed(0) + ' (+' + result.tpPct + '%)\n'
        + 'R/R: 1:2.2 | Conf: ' + result.conf + '%\n'
        + 'RSI: ' + result.rsi + divTxt + '\n'
        + 'Macro: ' + result.macroTrend + '\n'
        + 'POC: $' + result.poc.toFixed(0) + ' | VA: $' + result.val.toFixed(0) + '-$' + result.vah.toFixed(0) + '\n'
        + new Date().toLocaleTimeString('pt-PT');

      await sendTelegram(msg);
      console.log(pair + ': ' + result.signal + ' @ $' + price + ' conf=' + result.conf);
    } catch (e) { console.error('Erro ' + symbol + ':', e.message); }
  }
}

// Relatorio diario as 8h UTC
async function sendDailyReport() {
  var hour = new Date().getUTCHours();
  var min = new Date().getUTCMinutes();
  if (hour !== 8 || min > 5) return;

  var msg = '<b>Relatorio Diario - ' + new Date().toLocaleDateString('pt-PT') + '</b>\n\n';
  for (var i = 0; i < SYMBOLS.length; i++) {
    var symbol = SYMBOLS[i];
    var pair = symbol.replace('USDT', '/USDT');
    var results = dailyResults[symbol];
    var buys = results.filter(function(r) { return r.signal === 'BUY'; }).length;
    var sells = results.filter(function(r) { return r.signal === 'SELL'; }).length;
    msg += pair + ': ' + results.length + ' sinais (' + buys + ' BUY, ' + sells + ' SELL)\n';
    dailyResults[symbol] = [];
  }
  if (dailyResults['BTCUSDT'].length === 0 && dailyResults['ETHUSDT'].length === 0) {
    msg += 'Sem sinais hoje.';
  }
  await sendTelegram(msg);
}

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('Servidor na porta ' + PORT);
  sendTelegram('<b>Crypto AI Bot v2 iniciado!</b>\n\nMelhorias ativas:\n- Stop Loss dinamico\n- Filtro tendencia macro 4h\n- Divergencia RSI\n- Nuvens de liquidez\n- Filtro de sessao\n- Relatorio diario 8h\n- Anti-repeticao\n- Confirmacao de candle\n- Volume Profile 200 velas');
  runBot();
  setInterval(runBot, 5 * 60 * 1000);
  setInterval(sendDailyReport, 5 * 60 * 1000);
});
