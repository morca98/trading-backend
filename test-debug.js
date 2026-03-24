/**
 * Debug: analisar condições dos trades perdedores
 */
const BacktestEngine = require('./backtest-engine');

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
  if (!closes || closes.length === 0) return 0;
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
  var atr = trs.slice(0, period).reduce(function(s,v){return s+v;},0) / period;
  for (var j = period; j < trs.length; j++) atr = (atr * (period-1) + trs[j]) / period;
  return atr;
}

function calcADX(candles, period) {
  period = period || 14;
  if (candles.length < period * 2) return 0;
  var plusDMs = [], minusDMs = [], trs = [];
  for (var i = 1; i < candles.length; i++) {
    var h = candles[i].high, l = candles[i].low;
    var ph = candles[i-1].high, pl = candles[i-1].low, pc = candles[i-1].close;
    var plusDM = h - ph > pl - l ? Math.max(h - ph, 0) : 0;
    var minusDM = pl - l > h - ph ? Math.max(pl - l, 0) : 0;
    var tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    plusDMs.push(plusDM); minusDMs.push(minusDM); trs.push(tr);
  }
  var sPDM = plusDMs.slice(0, period).reduce(function(s,v){return s+v;},0);
  var sMDM = minusDMs.slice(0, period).reduce(function(s,v){return s+v;},0);
  var sTR = trs.slice(0, period).reduce(function(s,v){return s+v;},0);
  var dxVals = [];
  for (var j = period; j < trs.length; j++) {
    sPDM = sPDM - sPDM/period + plusDMs[j];
    sMDM = sMDM - sMDM/period + minusDMs[j];
    sTR = sTR - sTR/period + trs[j];
    var pDI = sTR > 0 ? (sPDM/sTR)*100 : 0;
    var mDI = sTR > 0 ? (sMDM/sTR)*100 : 0;
    var diSum = pDI + mDI;
    dxVals.push(diSum > 0 ? Math.abs(pDI - mDI)/diSum*100 : 0);
  }
  if (dxVals.length < period) return dxVals.length > 0 ? dxVals[dxVals.length-1] : 0;
  var adx = dxVals.slice(0, period).reduce(function(s,v){return s+v;},0) / period;
  for (var k = period; k < dxVals.length; k++) adx = (adx*(period-1) + dxVals[k]) / period;
  return adx;
}

// Versão de debug que retorna SEMPRE um sinal com informações de diagnóstico
function generateSignalDebug(candles, price, macroTrend, trend15m, atr, liqData) {
  if (candles.length < 60) return null;
  
  var closes = candles.map(function(c) { return c.close; });
  var ema20 = calcEMA(closes.slice(-20), 20);
  var ema50 = closes.length >= 50 ? calcEMA(closes.slice(-50), 50) : ema20;
  var ema200 = closes.length >= 200 ? calcEMA(closes.slice(-200), 200) : ema50;
  var adx = calcADX(candles);
  var rsi = calcRSI(closes);
  
  var priceAboveEma200 = price > ema200;
  var ema50AboveEma200 = ema50 > ema200;
  var ema20AboveEma50 = ema20 > ema50;
  
  var bullRegime = priceAboveEma200 && ema50AboveEma200;
  var bearRegime = !priceAboveEma200 && !ema50AboveEma200;
  
  return {
    signal: null, // Não gerar sinal, apenas diagnóstico
    price: price,
    ema20: ema20,
    ema50: ema50,
    ema200: ema200,
    rsi: rsi,
    adx: adx,
    macroTrend: macroTrend,
    bullRegime: bullRegime,
    bearRegime: bearRegime,
    priceAboveEma200: priceAboveEma200,
    ema50AboveEma200: ema50AboveEma200,
    ema20AboveEma50: ema20AboveEma50,
    conf: 0
  };
}

async function debug() {
  const days = 90;
  const interval = '30m';
  const limit = Math.ceil((days * 24 * 60) / 30);
  
  console.log('A buscar dados...');
  const engine = new BacktestEngine({ symbol: 'BTCUSDT', interval, limit, riskPerTrade: 0.02 });
  const candles = await engine.fetchCandles();
  
  // Analisar o regime ao longo do tempo
  console.log('\n=== ANÁLISE DE REGIME POR SEMANA ===');
  const step = 336; // ~7 dias em 30m
  for (var i = 200; i < candles.length; i += step) {
    var window = candles.slice(0, i + 1);
    var closes = window.map(function(c) { return c.close; });
    var price = closes[closes.length - 1];
    var ema20 = calcEMA(closes.slice(-20), 20);
    var ema50 = closes.length >= 50 ? calcEMA(closes.slice(-50), 50) : ema20;
    var ema200 = closes.length >= 200 ? calcEMA(closes.slice(-200), 200) : ema50;
    var adx = calcADX(window);
    var rsi = calcRSI(closes);
    
    var bullRegime = price > ema200 && ema50 > ema200;
    var bearRegime = price < ema200 && ema50 < ema200;
    var regime = bullRegime ? 'BULL' : (bearRegime ? 'BEAR' : 'NEUTRAL');
    
    var dt = new Date(candles[i].time).toISOString().slice(0,10);
    console.log(dt + ' | $' + Math.round(price) + ' | Regime: ' + regime + 
      ' | EMA200: $' + Math.round(ema200) + 
      ' | ADX: ' + adx.toFixed(1) + 
      ' | RSI: ' + rsi.toFixed(1));
  }
  
  // Analisar o que acontece nos 5 dias antes e depois dos trades perdedores
  console.log('\n=== CONTEXTO DOS TRADES PERDEDORES (BUY) ===');
  // Datas dos BUYs perdedores identificados
  var lossDates = [
    '2026-03-02', '2026-03-03', '2026-03-05', '2026-03-10', '2026-03-15', '2026-03-17'
  ];
  
  lossDates.forEach(function(dateStr) {
    var targetTime = new Date(dateStr).getTime();
    var idx = candles.findIndex(function(c) { return c.time >= targetTime; });
    if (idx < 200) return;
    
    var window = candles.slice(0, idx + 1);
    var closes = window.map(function(c) { return c.close; });
    var price = closes[closes.length - 1];
    var ema20 = calcEMA(closes.slice(-20), 20);
    var ema50 = closes.length >= 50 ? calcEMA(closes.slice(-50), 50) : ema20;
    var ema200 = closes.length >= 200 ? calcEMA(closes.slice(-200), 200) : ema50;
    var adx = calcADX(window);
    var rsi = calcRSI(closes);
    
    var bullRegime = price > ema200 && ema50 > ema200;
    var bearRegime = price < ema200 && ema50 < ema200;
    var regime = bullRegime ? 'BULL' : (bearRegime ? 'BEAR' : 'NEUTRAL');
    
    console.log(dateStr + ': $' + Math.round(price) + ' | Regime: ' + regime + 
      ' | P>EMA200: ' + (price > ema200) + 
      ' | EMA50>EMA200: ' + (ema50 > ema200) + 
      ' | EMA20>EMA50: ' + (ema20 > ema50) +
      ' | ADX: ' + adx.toFixed(1) + 
      ' | RSI: ' + rsi.toFixed(1));
  });
}

debug().catch(function(e) { console.error('ERRO:', e.message, e.stack); });
