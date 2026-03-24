/**
 * Teste da estratégia v2 - Trend-Following com filtro de regime
 * Objetivo: PF > 1.3 e retorno positivo em 90 dias
 */
const BacktestEngine = require('./backtest-engine');

// ── Indicadores ──────────────────────────────────────────────────────────────
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
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    ));
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

function calcBB(closes, period, mult) {
  period = period || 20; mult = mult || 2;
  if (closes.length < period) return { upper: closes[closes.length-1]*1.02, lower: closes[closes.length-1]*0.98, mid: closes[closes.length-1], pos: 0.5 };
  var slice = closes.slice(-period);
  var mean = slice.reduce(function(s,v){return s+v;},0) / period;
  var std = Math.sqrt(slice.reduce(function(s,v){return s+Math.pow(v-mean,2);},0) / period);
  var upper = mean + std*mult, lower = mean - std*mult;
  var pos = (upper - lower) > 0 ? (closes[closes.length-1] - lower) / (upper - lower) : 0.5;
  return { upper: upper, lower: lower, mid: mean, pos: pos, std: std };
}

function calcMACD(closes) {
  if (closes.length < 26) return { macd: 0, signal: 0, hist: 0 };
  var ema12 = calcEMA(closes.slice(-12), 12);
  var ema26 = calcEMA(closes.slice(-26), 26);
  var macd = ema12 - ema26;
  // Signal line (9-period EMA of MACD) - simplified
  var macdLine = [];
  for (var i = 26; i <= closes.length; i++) {
    var e12 = calcEMA(closes.slice(i-12, i), 12);
    var e26 = calcEMA(closes.slice(i-26, i), 26);
    macdLine.push(e12 - e26);
  }
  var signalLine = macdLine.length >= 9 ? calcEMA(macdLine.slice(-9), 9) : macdLine[macdLine.length-1] || 0;
  return { macd: macd, signal: signalLine, hist: macd - signalLine };
}

function detectPattern(candles) {
  var len = candles.length;
  if (len < 3) return 'NONE';
  var c = candles[len-2], prev = candles[len-3];
  var body = Math.abs(c.close - c.open), range = c.high - c.low || 0.001;
  var uw = c.high - Math.max(c.open, c.close), lw = Math.min(c.open, c.close) - c.low;
  if (prev.close < prev.open && c.close > c.open && c.open < prev.close && c.close > prev.open) return 'BULL_ENGULF';
  if (prev.close > prev.open && c.close < c.open && c.open > prev.close && c.close < prev.open) return 'BEAR_ENGULF';
  if (lw > body * 2 && uw < body * 0.5 && c.close > c.open) return 'HAMMER';
  if (uw > body * 2 && lw < body * 0.5 && c.close < c.open) return 'SHOOT_STAR';
  return 'NONE';
}

// ── Estratégia v2: Trend-Following com Regime Filter ─────────────────────────
const MIN_SCORE = 10;
const MAX_SCORE = 28;

function generateSignal(candles, price, macroTrend, trend15m, atr, liqData) {
  if (candles.length < 60) return null;
  
  var closes = candles.map(function(c) { return c.close; });
  var rsi = calcRSI(closes);
  var ema20 = calcEMA(closes.slice(-20), 20);
  var ema50 = closes.length >= 50 ? calcEMA(closes.slice(-50), 50) : ema20;
  var ema200 = closes.length >= 200 ? calcEMA(closes.slice(-200), 200) : ema50;
  var adx = calcADX(candles);
  var bb = calcBB(closes);
  var macd = calcMACD(closes);
  var pattern = detectPattern(candles);
  
  // Volume momentum
  var rv = candles.slice(-3).reduce(function(s,c){return s+c.volume;},0) / 3;
  var pv = candles.slice(-10,-3).reduce(function(s,c){return s+c.volume;},0) / 7;
  var volRatio = pv > 0 ? rv / pv : 1;
  
  // Estrutura de tendência
  var priceAboveEma200 = price > ema200;
  var priceAboveEma50 = price > ema50;
  var priceAboveEma20 = price > ema20;
  var ema20AboveEma50 = ema20 > ema50;
  var ema50AboveEma200 = ema50 > ema200;
  
  // ── FILTRO DE REGIME ──────────────────────────────────────────────────────
  // Regime baseado em EMA200 dos 30m (estrutura local)
  var bullRegime = priceAboveEma200 && ema50AboveEma200;
  var bearRegime = !priceAboveEma200 && !ema50AboveEma200;
  var neutralRegime = !bullRegime && !bearRegime;
  
  // Regime macro baseado no macroTrend (4h)
  var macroBull = macroTrend === 'BULL';
  var macroBear = macroTrend === 'BEAR';
  
  // Filtro ADX: mercado sem tendência = sem operações
  if (adx < 18) return null;
  
  // Filtro de conflito: apenas bloquear quando AMBOS os regimes divergem fortemente
  // Usar macroTrend como filtro principal nos filtros de qualidade abaixo
  
  // ── SCORING ───────────────────────────────────────────────────────────────
  var buy = 0, sell = 0;
  
  // 1. Regime de mercado (peso máximo - define a direção base)
  if (bullRegime) { buy += 5; }
  else if (bearRegime) { sell += 5; }
  else {
    // Regime neutro: pequeno bónus para a direção da EMA200
    if (priceAboveEma200) buy += 2; else sell += 2;
  }
  
  // 2. Macro Trend (4h)
  if (macroTrend === 'BULL') buy += 3; 
  if (macroTrend === 'BEAR') sell += 3;
  
  // 3. Alinhamento de EMAs (tendência de curto prazo)
  if (ema20AboveEma50 && priceAboveEma20) buy += 3;
  else if (!ema20AboveEma50 && !priceAboveEma20) sell += 3;
  
  // 4. RSI - Momentum
  if (rsi < 35) buy += 3; else if (rsi < 45) buy += 1;
  if (rsi > 65) sell += 3; else if (rsi > 55) sell += 1;
  
  // 5. MACD - Confirmação de momentum
  if (macd.hist > 0 && macd.macd > macd.signal) buy += 2;
  if (macd.hist < 0 && macd.macd < macd.signal) sell += 2;
  
  // 6. Bollinger Bands - Posição relativa
  if (bb.pos < 0.25) buy += 2;  // Próximo do fundo
  if (bb.pos > 0.75) sell += 2; // Próximo do topo
  
  // 7. Volume confirmando
  if (volRatio > 1.4) {
    var trend3 = closes[closes.length-1] > closes[closes.length-4] ? 'UP' : 'DOWN';
    if (trend3 === 'UP') buy += 2; else sell += 2;
  }
  
  // 8. Padrões de candles (apenas os mais fiáveis)
  if (pattern === 'BULL_ENGULF') buy += 3;
  if (pattern === 'BEAR_ENGULF') sell += 3;
  if (pattern === 'HAMMER') buy += 2;
  if (pattern === 'SHOOT_STAR') sell += 2;
  
  // 9. ADX forte = tendência forte
  if (adx > 30) {
    if (macroTrend === 'BULL') buy += 2;
    if (macroTrend === 'BEAR') sell += 2;
  }
  
  // 10. Trend15m
  if (trend15m === 'UP') buy += 1;
  if (trend15m === 'DOWN') sell += 1;
  
  // ── GERAÇÃO DO SINAL ──────────────────────────────────────────────────────
  var signal = null;
  var score = Math.max(buy, sell);
  var conf = Math.min(99, Math.round((score / MAX_SCORE) * 100));
  
  // Diferencial mínimo de 3 pontos
  if (buy >= MIN_SCORE && buy > sell + 3) signal = 'BUY';
  if (sell >= MIN_SCORE && sell > buy + 3) signal = 'SELL';
  
  if (!signal) return null;
  
  // ── FILTROS DE QUALIDADE ──────────────────────────────────────────────────
  
  // Filtro de momentum imediato: não entrar contra o movimento das últimas 3 velas
  var last3Closes = closes.slice(-4);
  var recentMove = (last3Closes[3] - last3Closes[0]) / last3Closes[0] * 100;
  
  // Regra principal: BUY apenas com alinhamento completo
  if (signal === 'BUY') {
    // Regime bearish = sem BUY
    if (bearRegime) return null;
    // Macro bearish = sem BUY
    if (macroBear) return null;
    // Não comprar em overbought
    if (rsi > 68) return null;
    // Não comprar no topo da banda de Bollinger
    if (bb.pos > 0.80) return null;
    // EMA20 deve estar acima da EMA50 (tendência de curto prazo confirmada)
    if (!ema20AboveEma50) return null;
    // Não comprar quando o mercado acabou de cair mais de 0.8% nas últimas 3 velas
    if (recentMove < -0.8) return null;
  }
  
  // Regra principal: SELL apenas com alinhamento completo
  if (signal === 'SELL') {
    // Regime bullish = sem SELL
    if (bullRegime) return null;
    // Macro bullish = sem SELL
    if (macroBull) return null;
    // Não vender em oversold
    if (rsi < 32) return null;
    // Não vender no fundo da banda de Bollinger
    if (bb.pos < 0.20) return null;
    // EMA20 deve estar abaixo da EMA50 (tendência de curto prazo confirmada)
    if (ema20AboveEma50) return null;
    // Não vender quando o mercado acabou de subir mais de 0.8% nas últimas 3 velas (bounce)
    if (recentMove > 0.8) return null;
  }
  
  // ── CÁLCULO DE SL/TP ─────────────────────────────────────────────────────
  var slPct;
  
  // SL baseado em ATR (mais preciso)
  var atrPct = atr / price;
  slPct = Math.max(0.004, Math.min(0.015, atrPct * 1.5));
  
  // Ajustar SL para suporte/resistência recente
  var recentLows = candles.slice(-10).map(function(c){return c.low;});
  var recentHighs = candles.slice(-10).map(function(c){return c.high;});
  var nearestLow = Math.min.apply(null, recentLows);
  var nearestHigh = Math.max.apply(null, recentHighs);
  
  var sl, tp;
  if (signal === 'BUY') {
    var slFromLow = (price - nearestLow * 0.999) / price;
    slPct = Math.max(slPct, Math.min(slFromLow, 0.015));
    sl = price * (1 - slPct);
  } else {
    var slFromHigh = (nearestHigh * 1.001 - price) / price;
    slPct = Math.max(slPct, Math.min(slFromHigh, 0.015));
    sl = price * (1 + slPct);
  }
  
  // R:R dinâmico baseado em regime e ADX
  var rr = 2.0;
  if (adx > 30 && ((signal === 'BUY' && bullRegime) || (signal === 'SELL' && bearRegime))) rr = 3.0;
  else if (adx > 25) rr = 2.5;
  
  tp = signal === 'BUY' ? price * (1 + slPct * rr) : price * (1 - slPct * rr);
  
  return {
    signal: signal, conf: conf, price: price, sl: sl, tp: tp,
    rsi: rsi.toFixed(1), ema20: ema20.toFixed(2), ema50: ema50.toFixed(2),
    macroTrend: macroTrend, trend15m: trend15m, pattern: pattern,
    atr: atr.toFixed(2), slPct: (slPct*100).toFixed(2), tpPct: (slPct*rr*100).toFixed(2),
    buyScore: buy, sellScore: sell, adx: adx.toFixed(1),
    regime: bullRegime ? 'BULL' : (bearRegime ? 'BEAR' : 'NEUTRAL'),
    bbPos: bb.pos.toFixed(2), macdHist: macd.hist.toFixed(2)
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────
async function main() {
  const days = 90;
  const interval = '30m';
  const limit = Math.ceil((days * 24 * 60) / 30);
  
  console.log('=== BACKTEST v2 - 90 DIAS - BTCUSDT ===');
  console.log('Intervalo: ' + interval + ' | Velas: ' + limit);
  console.log('A buscar dados...');
  
  const engine = new BacktestEngine({ symbol: 'BTCUSDT', interval, limit, riskPerTrade: 0.02 });
  const results = await engine.run(generateSignal);
  
  const trades = results.trades;
  const buys = trades.filter(function(t){return t.signal==='BUY';});
  const sells = trades.filter(function(t){return t.signal==='SELL';});
  const buyWins = buys.filter(function(t){return t.outcome==='WIN';}).length;
  const sellWins = sells.filter(function(t){return t.outcome==='WIN';}).length;
  
  console.log('\n=== RESULTADOS ===');
  console.log('Total Trades: ' + results.totalTrades);
  console.log('Wins: ' + results.wins + ' | Losses: ' + results.losses);
  console.log('Win Rate: ' + results.winRate + '%');
  console.log('Retorno: ' + results.returnPct + '%');
  console.log('Capital Final: $' + results.finalCapital);
  console.log('Max Drawdown: ' + results.maxDD + '%');
  console.log('Profit Factor: ' + results.profitFactor);
  
  console.log('\n=== POR DIREÇÃO ===');
  console.log('BUY: ' + buys.length + ' trades | WR: ' + (buys.length > 0 ? (buyWins/buys.length*100).toFixed(1) : 0) + '%');
  console.log('SELL: ' + sells.length + ' trades | WR: ' + (sells.length > 0 ? (sellWins/sells.length*100).toFixed(1) : 0) + '%');
  
  console.log('\n=== RESULTADOS POR MÊS ===');
  var byMonth = {};
  trades.forEach(function(t) {
    var m = new Date(t.time).toISOString().slice(0,7);
    if (!byMonth[m]) byMonth[m] = { wins: 0, losses: 0, pnl: 0 };
    if (t.outcome === 'WIN') byMonth[m].wins++; else byMonth[m].losses++;
    byMonth[m].pnl += t.pnl;
  });
  Object.keys(byMonth).sort().forEach(function(m) {
    var bm = byMonth[m];
    var total = bm.wins + bm.losses;
    console.log(m + ': ' + total + ' trades | WR: ' + (bm.wins/total*100).toFixed(1) + '% | P&L: $' + bm.pnl.toFixed(2));
  });
  
  console.log('\n=== ÚLTIMOS 10 TRADES ===');
  trades.slice(-10).forEach(function(t) {
    var dt = new Date(t.time).toISOString().slice(0,16).replace('T',' ');
    console.log(dt + ' | ' + t.signal + ' | Entry: $' + Math.round(t.entry) + ' | Exit: $' + Math.round(t.exit) + ' | ' + t.outcome + ' | PnL: $' + t.pnl.toFixed(2) + ' | Conf: ' + t.conf + '%');
  });
}

main().catch(function(e) { console.error('ERRO:', e.message); });
