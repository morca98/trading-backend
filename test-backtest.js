const BacktestEngine = require('./backtest-engine');

// Importar as funções do server.js que precisamos
const axios = require('axios');

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
  var N = 40, step = (max - min) / N;
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
  var hvns = bars.filter(function(b) { return b.vol > avgVol * 1.5 && Math.abs(b.price - poc.price) / poc.price > 0.01; });
  return { poc: poc.price, val: vaLow, vah: vaHigh, lvns: bars.filter(function(b) { return b.vol < avgVol * 0.35; }), hvns: hvns, bars: bars, maxVol: Math.max.apply(null, bars.map(function(b) { return b.vol; })) };
}

function calcKeyLevels(candles, vp) {
  var levels = [];
  var currentPrice = candles[candles.length - 1].close;
  levels.push({ price: vp.poc, type: 'POC', strength: 100 });
  levels.push({ price: vp.vah, type: 'VAH', strength: 80 });
  levels.push({ price: vp.val, type: 'VAL', strength: 80 });
  vp.hvns.forEach(function(h) { levels.push({ price: h.price, type: 'HVN', strength: 60 }); });
  for (var i = 5; i < candles.length - 5; i++) {
    var isHigh = true, isLow = true;
    for (var j = 1; j <= 5; j++) {
      if (candles[i].high < candles[i-j].high || candles[i].high < candles[i+j].high) isHigh = false;
      if (candles[i].low > candles[i-j].low || candles[i].low > candles[i+j].low) isLow = false;
    }
    if (isHigh) levels.push({ price: candles[i].high, type: 'RES', strength: 50 });
    if (isLow) levels.push({ price: candles[i].low, type: 'SUP', strength: 50 });
  }
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
      } else { grouped.push(current); current = levels[k]; }
    }
    grouped.push(current);
  }
  return grouped.filter(function(l) { return Math.abs(l.price - currentPrice) / currentPrice < 0.05; })
    .sort(function(a, b) { return Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice); }).slice(0, 8);
}

function calcADX(candles, period) {
  period = period || 14;
  if (candles.length < period * 2) return 0;
  var plusDMs = [], minusDMs = [], trs = [];
  for (var i = 1; i < candles.length; i++) {
    var high = candles[i].high, low = candles[i].low;
    var prevHigh = candles[i-1].high, prevLow = candles[i-1].low, prevClose = candles[i-1].close;
    var plusDM = high - prevHigh > prevLow - low ? Math.max(high - prevHigh, 0) : 0;
    var minusDM = prevLow - low > high - prevHigh ? Math.max(prevLow - low, 0) : 0;
    var tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    plusDMs.push(plusDM); minusDMs.push(minusDM); trs.push(tr);
  }
  var smoothPlusDM = plusDMs.slice(0, period).reduce(function(s,v){return s+v;}, 0);
  var smoothMinusDM = minusDMs.slice(0, period).reduce(function(s,v){return s+v;}, 0);
  var smoothTR = trs.slice(0, period).reduce(function(s,v){return s+v;}, 0);
  var dxValues = [];
  for (var j = period; j < trs.length; j++) {
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDMs[j];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMs[j];
    smoothTR = smoothTR - smoothTR / period + trs[j];
    var plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    var minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    var diSum = plusDI + minusDI;
    var dx = diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0;
    dxValues.push(dx);
  }
  if (dxValues.length < period) return dxValues.length > 0 ? dxValues[dxValues.length - 1] : 0;
  var adx = dxValues.slice(0, period).reduce(function(s,v){return s+v;}, 0) / period;
  for (var k = period; k < dxValues.length; k++) adx = (adx * (period - 1) + dxValues[k]) / period;
  return adx;
}

function calcDynamicSL(candles, signal, price, atr) {
  var slDist = atr * 1.2;
  var lows = candles.slice(-8).map(function(c) { return c.low; });
  var highs = candles.slice(-8).map(function(c) { return c.high; });
  if (signal === 'BUY') return Math.max(Math.min(Math.min.apply(null, lows) * 0.999, price - slDist), price * 0.98);
  return Math.min(Math.max(Math.max.apply(null, highs) * 1.001, price + slDist), price * 1.02);
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

function confirmCandle(candles, signal) {
  var prev = candles[candles.length - 2];
  if (!prev) return false;
  return signal === 'BUY' ? prev.close > prev.open : prev.close < prev.open;
}

const MIN_SCORE = 9;
const MAX_SCORE = 25;

function generateSignal(candles, price, macroTrend, trend15m, atr, liqData) {
  var closes = candles.map(function(c) { return c.close; });
  var vp = calcVP(candles.slice(-200));
  var keyLevels = calcKeyLevels(candles, vp);
  var rsi = calcRSI(closes);
  var ema20 = calcEMA(closes.slice(-20), 20);
  var ema50 = closes.length >= 50 ? calcEMA(closes.slice(-50), 50) : ema20;
  var ema200 = closes.length >= 200 ? calcEMA(closes.slice(-200), 200) : ema50;
  var trend30m = closes[closes.length - 1] > closes[closes.length - 10] ? 'UP' : 'DOWN';
  var rv = candles.slice(-5).reduce(function(s, c) { return s + c.volume; }, 0);
  var pv = candles.slice(-10, -5).reduce(function(s, c) { return s + c.volume; }, 0);
  var inVA = price >= vp.val && price <= vp.vah, abovePoc = price > vp.poc;
  var divergence = calcRSIDivergence(candles, rsi);
  var pattern = detectPattern(candles);
  var adx = calcADX(candles);
  
  if (adx < 18) return null;
  
  var nearSupport = keyLevels.filter(function(l) { return (l.type === 'SUP' || l.type === 'VAL' || l.type === 'POC') && price > l.price && (price - l.price) / price < 0.008; });
  var nearResistance = keyLevels.filter(function(l) { return (l.type === 'RES' || l.type === 'VAH' || l.type === 'POC') && price < l.price && (l.price - price) / price < 0.008; });

  var buy = 0, sell = 0; 
  
  if (price > ema200) buy += 3;
  if (price < ema200) sell += 3;
  
  if (abovePoc && inVA) buy += 2; if (!abovePoc && inVA) sell += 2;
  if (price > vp.vah) buy += 1; 
  if (price < vp.val) sell += 1;
  
  if (rsi < 30) buy += 4; else if (rsi < 40) buy += 2;
  if (rsi > 70) sell += 4; else if (rsi > 60) sell += 2;
  if (divergence === 'BULLISH') buy += 3; if (divergence === 'BEARISH') sell += 3;
  
  if (price > ema20 && ema20 > ema50) buy += 3;
  else if (price < ema20 && ema20 < ema50) sell += 3;
  else if (price > ema20 && price > ema50) buy += 1;
  else if (price < ema20 && price < ema50) sell += 1;
  
  if (macroTrend === 'BULL') buy += 3; if (macroTrend === 'BEAR') sell += 3;
  if (trend15m === 'UP') buy += 1; if (trend15m === 'DOWN') sell += 1;
  
  if (rv > pv * 1.3) { if (trend30m === 'UP') buy += 2; else sell += 2; }
  
  if (pattern === 'BULL_ENGULF' || pattern === 'HAMMER') buy += 3;
  if (pattern === 'BEAR_ENGULF' || pattern === 'SHOOT_STAR') sell += 3;
  if (pattern === 'PIN_BULL') buy += 1;
  if (pattern === 'PIN_BEAR') sell += 1;
  
  if (nearSupport.length > 0) buy += 3;
  if (nearResistance.length > 0) sell += 3;
  
  if (adx > 30) { if (macroTrend === 'BULL') buy += 2; if (macroTrend === 'BEAR') sell += 2; }
  
  if (liqData) {
    if (liqData.lsRatio < 0.45) buy += 2;
    if (liqData.lsRatio > 0.55) sell += 2;
  }

  var signal = null;
  var score = Math.max(buy, sell);
  var effectiveMax = liqData ? 27 : MAX_SCORE;
  var conf = Math.min(99, Math.round((score / effectiveMax) * 100)); 

  if (buy >= MIN_SCORE && buy > sell + 3) signal = 'BUY';
  if (sell >= MIN_SCORE && sell > buy + 3) signal = 'SELL';
  
  if (!signal) return null;
  
  if (signal === 'BUY' && macroTrend === 'BEAR') {
    if (divergence !== 'BULLISH' && pattern !== 'BULL_ENGULF' && pattern !== 'HAMMER') return null;
    if (buy < 14) return null;
  }
  if (signal === 'SELL' && macroTrend === 'BULL') {
    if (divergence !== 'BEARISH' && pattern !== 'BEAR_ENGULF' && pattern !== 'SHOOT_STAR') return null;
    if (sell < 14) return null;
  }
  
  if (signal === 'BUY' && price < ema200 && buy < 16) return null;
  if (signal === 'SELL' && price > ema200 && sell < 16) return null;
  
  if (signal === 'BUY' && rsi > 68) return null;
  if (signal === 'SELL' && rsi < 32) return null;
  
  if (score < 14 && !confirmCandle(candles, signal)) return null;

  var sl = calcDynamicSL(candles, signal, price, atr);
  
  if (signal === 'BUY' && nearSupport.length > 0) {
    var bestSup = nearSupport[0].price * 0.998;
    if (bestSup < price && bestSup > sl) sl = bestSup;
  } else if (signal === 'SELL' && nearResistance.length > 0) {
    var bestRes = nearResistance[0].price * 1.002;
    if (bestRes > price && bestRes < sl) sl = bestRes;
  }

  var slPct = Math.abs(price - sl) / price;
  
  if (slPct > 0.02) {
    sl = signal === 'BUY' ? price * 0.98 : price * 1.02;
    slPct = 0.02;
  }
  
  var rrMultiplier = adx > 25 ? 2.5 : 2.0;
  var tp = signal === 'BUY' ? price * (1 + slPct * rrMultiplier) : price * (1 - slPct * rrMultiplier);

  return { signal: signal, conf: conf, price: price, sl: sl, tp: tp, rsi: rsi.toFixed(1), ema20: ema20.toFixed(2), ema50: ema50.toFixed(2), poc: vp.poc, val: vp.val, vah: vp.vah, macroTrend: macroTrend, trend15m: trend15m, trend30m: trend30m, divergence: divergence, pattern: pattern, atr: atr.toFixed(2), slPct: (slPct * 100).toFixed(2), tpPct: (slPct * rrMultiplier * 100).toFixed(2), buyScore: buy, sellScore: sell, adx: adx.toFixed(1) };
}

// ── Executar Backtest ─────────────────────────────────────────────────────────
async function main() {
  console.log('=== BACKTEST 90 DIAS - BTCUSDT ===\n');
  
  const days = 90;
  const interval = '30m';
  const limit = Math.ceil((days * 24 * 60) / 30);
  
  console.log(`Periodo: ${days} dias | Intervalo: ${interval} | Velas: ${limit}`);
  console.log('A buscar dados...\n');
  
  const engine = new BacktestEngine({
    symbol: 'BTCUSDT',
    interval: interval,
    limit: limit,
    riskPerTrade: 0.02
  });
  
  try {
    const results = await engine.run(generateSignal);
    
    console.log('=== RESULTADOS ===');
    console.log(`Total Trades: ${results.totalTrades}`);
    console.log(`Wins: ${results.wins} | Losses: ${results.losses}`);
    console.log(`Win Rate: ${results.winRate}%`);
    console.log(`Retorno: ${results.returnPct}%`);
    console.log(`Capital Final: $${results.finalCapital}`);
    console.log(`Max Drawdown: ${results.maxDD}%`);
    console.log(`Profit Factor: ${results.profitFactor}`);
    
    if (results.trades.length > 0) {
      console.log('\n=== ULTIMOS 10 TRADES ===');
      results.trades.slice(-10).forEach(function(t) {
        var date = new Date(t.time).toISOString().slice(0, 16);
        console.log(`${date} | ${t.signal} | Entry: $${t.entry.toFixed(0)} | Exit: $${t.exit.toFixed(0)} | ${t.outcome} | PnL: $${t.pnl.toFixed(2)} | Conf: ${t.conf}%`);
      });
    }
    
  } catch (e) {
    console.error('Erro:', e.message);
  }
}

main();
