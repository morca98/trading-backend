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

// Anti-repeticao: guarda ultimo sinal enviado por par
var lastSignal = { BTCUSDT: null, ETHUSDT: null };
var lastSignalTime = { BTCUSDT: 0, ETHUSDT: 0 };
var SIGNAL_COOLDOWN = 60 * 60 * 1000; // 1 hora entre sinais iguais

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
  return { poc: poc.price, val: vaLow, vah: vaHigh };
}

// Confirmacao de candle: vela anterior fechou na direcao do sinal
function confirmCandle(candles, signal) {
  var prev = candles[candles.length - 2]; // vela ja fechada
  if (!prev) return false;
  if (signal === 'BUY' && prev.close > prev.open) return true;  // vela verde fechada
  if (signal === 'SELL' && prev.close < prev.open) return true; // vela vermelha fechada
  return false;
}

function generateSignal(candles, price) {
  var closes = candles.map(function(c) { return c.close; });
  // VP com ultimas 200 velas
  var vpCandles = candles.slice(-200);
  var vp = calcVP(vpCandles);
  var rsi = calcRSI(closes);
  var ema20 = calcEMA(closes.slice(-20), 20);
  var ema50 = calcEMA(closes.slice(-50), 50);
  var trend = closes[closes.length - 1] > closes[closes.length - 10] ? 'UP' : 'DOWN';
  var rv = candles.slice(-5).reduce(function(s, c) { return s + c.volume; }, 0);
  var pv = candles.slice(-10, -5).reduce(function(s, c) { return s + c.volume; }, 0);
  var inVA = price >= vp.val && price <= vp.vah;
  var abovePoc = price > vp.poc;
  var buy = 0, sell = 0;
  if (abovePoc && inVA) buy += 2; if (!abovePoc && inVA) sell += 2;
  if (rsi < 35) buy += 3; else if (rsi < 45) buy += 1;
  if (rsi > 65) sell += 3; else if (rsi > 55) sell += 1;
  if (price > ema20 && price > ema50) buy += 2; else if (price < ema20 && price < ema50) sell += 2;
  if (ema20 > ema50) buy += 1; else sell += 1;
  if (trend === 'UP') buy += 1; else sell += 1;
  if (rv > pv * 1.1) { buy += 1; sell += 1; }

  var signal = null;
  if (buy >= 7 && buy > sell + 2) signal = 'BUY';
  if (sell >= 7 && sell > buy + 2) signal = 'SELL';
  if (!signal) return null;

  // Confirmacao de candle
  if (!confirmCandle(candles, signal)) {
    console.log('Sinal ' + signal + ' sem confirmacao de candle');
    return null;
  }

  var conf = Math.min(95, Math.round(Math.max(buy, sell) / 12 * 100));
  var sl = signal === 'BUY' ? price * 0.988 : price * 1.012;
  var tp = signal === 'BUY' ? price * 1.0264 : price * 0.9736;
  return { signal: signal, conf: conf, price: price, sl: sl, tp: tp, rsi: rsi.toFixed(1), poc: vp.poc, val: vp.val, vah: vp.vah };
}

async function runBot() {
  console.log('Bot a analisar... ' + new Date().toISOString());
  for (var i = 0; i < SYMBOLS.length; i++) {
    var symbol = SYMBOLS[i];
    try {
      // Buscar 200 velas para Volume Profile
      var resp = await axios.get(BINANCE + '/api/v3/klines?symbol=' + symbol + '&interval=30m&limit=200');
      var candles = resp.data.map(function(k) {
        return { time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
      });
      var pr = await axios.get(BINANCE + '/api/v3/ticker/price?symbol=' + symbol);
      var price = parseFloat(pr.data.price);
      var result = generateSignal(candles, price);
      var pair = symbol.replace('USDT', '/USDT');

      // Filtro confianca
      if (!result || result.conf < 80) {
        console.log(pair + ': WAIT conf=' + (result ? result.conf : 0));
        continue;
      }

      // Anti-repeticao: nao envia o mesmo sinal dentro de 1 hora
      var now = Date.now();
      if (lastSignal[symbol] === result.signal && (now - lastSignalTime[symbol]) < SIGNAL_COOLDOWN) {
        console.log(pair + ': sinal repetido ignorado (' + result.signal + ')');
        continue;
      }

      // Guardar ultimo sinal
      lastSignal[symbol] = result.signal;
      lastSignalTime[symbol] = now;

      var msg = '<b>' + result.signal + ' ' + pair + '</b>\n\n'
        + 'Preco: $' + price.toFixed(2) + '\n'
        + 'Entrada: $' + price.toFixed(0) + '\n'
        + 'Stop: $' + result.sl.toFixed(0) + '\n'
        + 'Alvo: $' + result.tp.toFixed(0) + '\n'
        + 'R/R: 1:2.2 | Conf: ' + result.conf + '%\n'
        + 'RSI: ' + result.rsi + '\n'
        + 'POC: $' + result.poc.toFixed(0) + ' | VAH: $' + result.vah.toFixed(0) + ' | VAL: $' + result.val.toFixed(0) + '\n'
        + new Date().toLocaleTimeString('pt-PT');

      await sendTelegram(msg);
      console.log(pair + ': ' + result.signal + ' @ $' + price + ' conf=' + result.conf);
    } catch (e) { console.error('Erro ' + symbol + ':', e.message); }
  }
}

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('Servidor na porta ' + PORT);
  sendTelegram('<b>Crypto AI Bot atualizado!</b>\n\nMelhorias:\n- Anti-repeticao de sinais\n- Confirmacao de candle\n- Volume Profile 200 velas\n- Verificacao a cada 5min\n- Confianca minima 80%');
  runBot();
  setInterval(runBot, 1 * 60 * 1000);
});
