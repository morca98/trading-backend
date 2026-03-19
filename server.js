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
const MIN_SCORE = 10; // Score minimo subido para 10/16

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

// ATR - Average True Range para medir volatilidade
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
  for (var j = period; j < trs.length; j++) {
    atr = (atr * (period - 1) + trs[j]) / period;
  }
  return atr;
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
  var avgVol = totalVol / bars.length;
  var lvns = bars.filter(function(b) { return b.vol < avgVol * 0.35; });
  return { poc: poc.price, val: vaLow, vah: vaHigh, lvns: lvns };
}

// Stop Loss dinamico baseado em ATR
function calcDynamicSL(candles, signal, price, atr) {
  var slDistance = atr * 1.5; // 1.5x ATR
  var lookback = candles.slice(-10);
  var lows = lookback.map(function(c) { return c.low; });
  var highs = lookback.map(function(c) { return c.high; });
  if (signal === 'BUY') {
    var recentLow = Math.min.apply(null, lows.slice(-5));
    var slAtr = price - slDistance;
    var sl = Math.min(recentLow * 0.999, slAtr);
    return Math.max(sl, price * 0.97);
  } else {
    var recentHigh = Math.max.apply(null, highs.slice(-5));
    var slAtr2 = price + slDistance;
    var sl2 = Math.max(recentHigh * 1.001, slAtr2);
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
  if (curPrice > prevPrice && rsi < prevRsi && rsi > 55) return 'BEARISH';
  if (curPrice < prevPrice && rsi > prevRsi && rsi < 45) return 'BULLISH';
  return 'NONE';
}

// Padroes de velas
function detectCandlePattern(candles) {
  var len = candles.length;
  if (len < 3) return 'NONE';
  var c = candles[len - 2]; // vela fechada
  var prev = candles[len - 3];
  var body = Math.abs(c.close - c.open);
  var range = c.high - c.low;
  var upperWick = c.high - Math.max(c.open, c.close);
  var lowerWick = Math.min(c.open, c.close) - c.low;

  // Bullish Engulfing
  if (prev.close < prev.open && c.close > c.open && c.open < prev.close && c.close > prev.open) return 'BULLISH_ENGULFING';
  // Bearish Engulfing
  if (prev.close > prev.open && c.close < c.open && c.open > prev.close && c.close < prev.open) return 'BEARISH_ENGULFING';
  // Hammer (bullish)
  if (lowerWick > body * 2 && upperWick < body * 0.5 && c.close > c.open) return 'HAMMER';
  // Shooting Star (bearish)
  if (upperWick > body * 2 && lowerWick < body * 0.5 && c.close < c.open) return 'SHOOTING_STAR';
  // Pin Bar bullish
  if (lowerWick > range * 0.6 && body < range * 0.3) return 'PIN_BAR_BULL';
  // Pin Bar bearish
  if (upperWick > range * 0.6 && body < range * 0.3) return 'PIN_BAR_BEAR';
  // Doji
  if (body < range * 0.1) return 'DOJI';
  return 'NONE';
}

// Filtro de sessao
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

// Tendencia em 15min para confirmacao adicional
async function get15mTrend(symbol) {
  try {
    var r = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=15m&limit=30');
    var candles = r.data.map(function(k) { return { close: +k[4] }; });
    var closes = candles.map(function(c) { return c.close; });
    var ema20 = calcEMA(closes.slice(-20), 20);
    var lastClose = closes[closes.length - 1];
    if (lastClose > ema20) return 'UP';
    if (lastClose < ema20) return 'DOWN';
    return 'NEUTRAL';
  } catch (e) { return 'NEUTRAL'; }
}

function generateSignal(candles, price, macroTrend, trend15m, atr) {
  var closes = candles.map(function(c) { return c.close; });
  var vp = calcVP(candles.slice(-200));
  var rsi = calcRSI(closes);
  var ema20 = calcEMA(closes.slice(-20), 20);
  var ema50 = calcEMA(closes.slice(-50), 50);
  var trend30m = closes[closes.length - 1] > closes[closes.length - 10] ? 'UP' : 'DOWN';
  var rv = candles.slice(-5).reduce(function(s, c) { return s + c.volume; }, 0);
  var pv = candles.slice(-10, -5).reduce(function(s, c) { return s + c.volume; }, 0);
  var inVA = price >= vp.val && price <= vp.vah;
  var abovePoc = price > vp.poc;
  var divergence = calcRSIDivergence(candles, rsi);
  var pattern = detectCandlePattern(candles);
  var nearLVN = vp.lvns.some(function(l) { return Math.abs(l.price - price) / price < 0.01; });

  var buy = 0, sell = 0;

  // Volume Profile (2pts)
  if (abovePoc && inVA) buy += 2; if (!abovePoc && inVA) sell += 2;

  // RSI (3pts)
  if (rsi < 35) buy += 3; else if (rsi < 45) buy += 1;
  if (rsi > 65) sell += 3; else if (rsi > 55) sell += 1;

  // EMA 30m (2pts)
  if (price > ema20 && price > ema50) buy += 2; else if (price < ema20 && price < ema50) sell += 2;
  if (ema20 > ema50) buy += 1; else sell += 1;

  // Trend 30m (1pt)
  if (trend30m === 'UP') buy += 1; else sell += 1;

  // Volume momentum (1pt)
  if (rv > pv * 1.1) { buy += 1; sell += 1; }

  // Macro trend 4h (2pts)
  if (macroTrend === 'BULL') buy += 2;
  if (macroTrend === 'BEAR') sell += 2;

  // Trend 15m (1pt) - multiplos timeframes
  if (trend15m === 'UP') buy += 1;
  if (trend15m === 'DOWN') sell += 1;

  // Divergencia RSI (2pts)
  if (divergence === 'BULLISH') buy += 2;
  if (divergence === 'BEARISH') sell += 2;

  // Padroes de velas (2pts)
  if (pattern === 'BULLISH_ENGULFING' || pattern === 'HAMMER' || pattern === 'PIN_BAR_BULL') buy += 2;
  if (pattern === 'BEARISH_ENGULFING' || pattern === 'SHOOTING_STAR' || pattern === 'PIN_BAR_BEAR') sell += 2;
  if (pattern === 'DOJI') { buy += 0; sell += 0; } // Doji = indecisao, ignorar

  // LVN proxima (1pt)
  if (nearLVN) { buy += 1; sell += 1; }

  var maxScore = 16;
  var signal = null;
  if (buy >= MIN_SCORE && buy > sell + 2) signal = 'BUY';
  if (sell >= MIN_SCORE && sell > buy + 2) signal = 'SELL';
  if (!signal) return null;

  // Filtro macro: nao comprar em bear forte, nao vender em bull forte
  if (signal === 'BUY' && macroTrend === 'BEAR' && buy < 12) return null;
  if (signal === 'SELL' && macroTrend === 'BULL' && sell < 12) return null;

  // Multiplos timeframes: 30m e 15m tem de concordar
  if (signal === 'BUY' && trend15m === 'DOWN' && macroTrend !== 'BULL') return null;
  if (signal === 'SELL' && trend15m === 'UP' && macroTrend !== 'BEAR') return null;

  // Confirmacao de candle
  if (!confirmCandle(candles, signal)) return null;

  var conf = Math.min(95, Math.round(Math.max(buy, sell) / maxScore * 100));
  var sl = calcDynamicSL(candles, signal, price, atr);
  var slPct = Math.abs(price - sl) / price;
  var tp = signal === 'BUY' ? price * (1 + slPct * 2.2) : price * (1 - slPct * 2.2);

  return {
    signal: signal, conf: conf, price: price, sl: sl, tp: tp,
    rsi: rsi.toFixed(1), poc: vp.poc, val: vp.val, vah: vp.vah,
    macroTrend: macroTrend, trend15m: trend15m, divergence: divergence,
    pattern: pattern, atr: atr.toFixed(2),
    slPct: (slPct * 100).toFixed(2), tpPct: (slPct * 2.2 * 100).toFixed(2),
    buyScore: buy, sellScore: sell
  };
}

async function runBot() {
  console.log('Bot a analisar... ' + new Date().toISOString());
  if (!isGoodSession()) { console.log('Fora de sessao'); return; }

  for (var i = 0; i < SYMBOLS.length; i++) {
    var symbol = SYMBOLS[i];
    try {
      var resp = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=30m&limit=200');
      var candles = resp.data.map(function(k) {
        return { time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
      });
      var pr = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + symbol);
      var price = parseFloat(pr.data.price);
      var atr = calcATR(candles, 14);
      var macroTrend = await getMacroTrend(symbol);
      var trend15m = await get15mTrend(symbol);
      var result = generateSignal(candles, price, macroTrend, trend15m, atr);
      var pair = symbol.replace('USDT', '/USDT');

      if (!result || result.conf < 80) {
        console.log(pair + ': WAIT conf=' + (result ? result.conf : 0) + ' macro=' + macroTrend + ' 15m=' + trend15m);
        continue;
      }

      var now = Date.now();
      if (lastSignal[symbol] === result.signal && (now - lastSignalTime[symbol]) < SIGNAL_COOLDOWN) {
        console.log(pair + ': sinal repetido ignorado');
        continue;
      }

      lastSignal[symbol] = result.signal;
      lastSignalTime[symbol] = now;
      dailyResults[symbol].push({ signal: result.signal, time: new Date().toLocaleTimeString('pt-PT'), conf: result.conf });

      var patternTxt = result.pattern !== 'NONE' ? '\nPadrao: ' + result.pattern : '';
      var divTxt = result.divergence !== 'NONE' ? '\nDiv RSI: ' + result.divergence : '';

      var msg = '<b>' + result.signal + ' ' + pair + '</b>\n\n'
        + 'Preco: $' + price.toFixed(2) + '\n'
        + 'Entrada: $' + price.toFixed(0) + '\n'
        + 'Stop: $' + result.sl.toFixed(0) + ' (-' + result.slPct + '%)\n'
        + 'Alvo: $' + result.tp.toFixed(0) + ' (+' + result.tpPct + '%)\n'
        + 'R/R: 1:2.2 | Conf: ' + result.conf + '%\n'
        + 'Score: ' + Math.max(result.buyScore, result.sellScore) + '/16\n'
        + 'RSI: ' + result.rsi + divTxt + patternTxt + '\n'
        + 'ATR: $' + result.atr + '\n'
        + 'Macro 4h: ' + result.macroTrend + ' | 15m: ' + result.trend15m + '\n'
        + 'POC: $' + result.poc.toFixed(0) + ' | VA: $' + result.val.toFixed(0) + '-$' + result.vah.toFixed(0) + '\n'
        + new Date().toLocaleTimeString('pt-PT');

      await sendTelegram(msg);
      console.log(pair + ': ' + result.signal + ' @ $' + price + ' conf=' + result.conf + ' score=' + Math.max(result.buyScore, result.sellScore));
    } catch (e) { console.error('Erro ' + symbol + ':', e.message); }
  }
}

async function sendDailyReport() {
  var hour = new Date().getUTCHours();
  var min = new Date().getUTCMinutes();
  if (hour !== 8 || min > 5) return;
  var msg = '<b>Relatorio Diario - ' + new Date().toLocaleDateString('pt-PT') + '</b>\n\n';
  var total = 0;
  for (var i = 0; i < SYMBOLS.length; i++) {
    var symbol = SYMBOLS[i];
    var pair = symbol.replace('USDT', '/USDT');
    var results = dailyResults[symbol];
    var buys = results.filter(function(r) { return r.signal === 'BUY'; }).length;
    var sells = results.filter(function(r) { return r.signal === 'SELL'; }).length;
    total += results.length;
    if (results.length > 0) {
      msg += pair + ': ' + results.length + ' sinais (' + buys + ' BUY, ' + sells + ' SELL)\n';
    }
    dailyResults[symbol] = [];
  }
  if (total === 0) msg += 'Sem sinais ontem.';
  await sendTelegram(msg);
}

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('Servidor na porta ' + PORT);
  sendTelegram('<b>Crypto AI Bot v3 iniciado!</b>\n\nMelhorias:\n- ATR dinamico\n- Multiplos timeframes (4h+30m+15m)\n- Padroes de velas\n- Score minimo 10/16\n- Todos os filtros anteriores ativos');
  runBot();
  setInterval(runBot, 5 * 60 * 1000);
  setInterval(sendDailyReport, 5 * 60 * 1000);
});
