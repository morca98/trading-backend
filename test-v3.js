/**
 * Estratégia v3 - Trend Following Puro
 * Baseada em: EMA crossover + RSI momentum + Volume confirmation
 * Objetivo: Seguir a tendência, não prever reversões
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

function calcEMALine(closes, period) {
  if (!closes || closes.length < period) return [];
  var k = 2 / (period + 1);
  var result = [closes[0]];
  for (var i = 1; i < closes.length; i++) {
    result.push(closes[i] * k + result[result.length-1] * (1 - k));
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

/**
 * Estratégia v3: EMA Crossover com confirmação de momentum
 * 
 * SINAL BUY: EMA9 cruza acima da EMA21 + EMA21 acima EMA50 + RSI > 50 + Volume alto
 * SINAL SELL: EMA9 cruza abaixo da EMA21 + EMA21 abaixo EMA50 + RSI < 50 + Volume alto
 * 
 * Filtros:
 * - macroTrend deve confirmar a direção
 * - ADX > 20 (tendência presente)
 * - Não entrar em extremos de RSI
 */
function generateSignal(candles, price, macroTrend, trend15m, atr, liqData) {
  if (candles.length < 60) return null;
  
  var closes = candles.map(function(c) { return c.close; });
  var rsi = calcRSI(closes);
  var adx = calcADX(candles);
  
  // Calcular linhas EMA completas para detetar crossover
  var ema9Line = calcEMALine(closes, 9);
  var ema21Line = calcEMALine(closes, 21);
  var ema50Line = calcEMALine(closes, 50);
  
  var len = ema9Line.length;
  if (len < 3) return null;
  
  var ema9 = ema9Line[len-1];
  var ema21 = ema21Line[len-1];
  var ema50 = ema50Line.length > 0 ? ema50Line[len-1] : ema21;
  var ema200 = closes.length >= 200 ? calcEMA(closes.slice(-200), 200) : ema50;
  
  // Crossover: EMA9 cruzou EMA21 na última vela
  var ema9PrevAbove = ema9Line[len-2] > ema21Line[len-2];
  var ema9CurrAbove = ema9 > ema21;
  var crossedUp = !ema9PrevAbove && ema9CurrAbove;   // Cruzou para cima
  var crossedDown = ema9PrevAbove && !ema9CurrAbove; // Cruzou para baixo
  
  // Também aceitar quando EMA9 está acima/abaixo e tendência está estabelecida
  var trendingUp = ema9 > ema21 && ema21 > ema50;
  var trendingDown = ema9 < ema21 && ema21 < ema50;
  
  // Volume
  var rv = candles.slice(-3).reduce(function(s,c){return s+c.volume;},0) / 3;
  var pv = candles.slice(-15,-3).reduce(function(s,c){return s+c.volume;},0) / 12;
  var volHigh = pv > 0 && rv > pv * 1.2;
  
  // Filtro ADX
  if (adx < 20) return null;
  
  // ── GERAÇÃO DE SINAL ─────────────────────────────────────────────────────
  var signal = null;
  var reason = '';
  
  // BUY: crossover para cima OU tendência de alta estabelecida com pullback
  if (crossedUp && ema21 > ema50 && macroTrend !== 'BEAR') {
    signal = 'BUY';
    reason = 'CROSSOVER_UP';
  } else if (trendingUp && macroTrend === 'BULL' && rsi > 45 && rsi < 65 && volHigh) {
    // Continuação de tendência de alta com pullback para EMA21
    var nearEma21 = Math.abs(price - ema21) / price < 0.008;
    if (nearEma21) {
      signal = 'BUY';
      reason = 'PULLBACK_BUY';
    }
  }
  
  // SELL: crossover para baixo OU tendência de baixa estabelecida com pullback
  if (crossedDown && ema21 < ema50 && macroTrend !== 'BULL') {
    signal = 'SELL';
    reason = 'CROSSOVER_DOWN';
  } else if (trendingDown && macroTrend === 'BEAR' && rsi > 35 && rsi < 55 && volHigh) {
    var nearEma21Sell = Math.abs(price - ema21) / price < 0.008;
    if (nearEma21Sell) {
      signal = 'SELL';
      reason = 'PULLBACK_SELL';
    }
  }
  
  if (!signal) return null;
  
  // ── FILTROS DE QUALIDADE ─────────────────────────────────────────────────────────
  if (signal === 'BUY') {
    if (rsi > 70) return null;  // Overbought
    if (price < ema200 && macroTrend !== 'BULL') return null; // Abaixo da EMA200 sem macro bull
    // Não comprar quando EMA9 está muito acima da EMA21 (entrada tardia)
    var ema9DistFromEma21 = (ema9 - ema21) / ema21 * 100;
    if (ema9DistFromEma21 > 1.5) return null;
  }
  
  if (signal === 'SELL') {
    if (rsi < 30) return null;  // Oversold
    if (price > ema200 && macroTrend !== 'BEAR') return null; // Acima da EMA200 sem macro bear
    // Não vender quando EMA9 está muito abaixo da EMA21 (entrada tardia)
    var ema9DistFromEma21Sell = (ema21 - ema9) / ema21 * 100;
    if (ema9DistFromEma21Sell > 1.5) return null;
  }
  
  // Confirmação de vela
  var prevCandle = candles[candles.length - 2];
  if (signal === 'BUY' && prevCandle.close < prevCandle.open) return null;
  if (signal === 'SELL' && prevCandle.close > prevCandle.open) return null;
  
  // Filtro de volume: exigir volume acima da média para todos os sinais
  if (!volHigh) return null;
  
  // ── CÁLCULO DE SL/TP ───────────────────────────────────────
  // SL baseado no HL (mínimo/máximo) do candle de 30m com buffer de 1.0–1.5 ATR
  // O buffer escala com a volatilidade: ADX alto → 1.5 ATR, ADX baixo → 1.0 ATR
  var atrBuffer = adx > 30 ? 1.5 : (adx > 25 ? 1.25 : 1.0);
  
  var sl, slDist;
  if (signal === 'BUY') {
    // SL abaixo do mínimo (low) da vela de 30m mais recente
    var recentLow = Math.min.apply(null, candles.slice(-3).map(function(c) { return c.low; }));
    sl = recentLow - atr * atrBuffer;
    slDist = price - sl;
  } else {
    // SL acima do máximo (high) da vela de 30m mais recente
    var recentHigh = Math.max.apply(null, candles.slice(-3).map(function(c) { return c.high; }));
    sl = recentHigh + atr * atrBuffer;
    slDist = sl - price;
  }
  
  // Garantir distância mínima de 0.5% e máxima de 3% do preço
  slDist = Math.max(price * 0.005, Math.min(price * 0.03, slDist));
  sl = signal === 'BUY' ? price - slDist : price + slDist;
  
  var slPct = slDist / price;
  
  // R:R baseado em ADX
  var rr = adx > 30 ? 3.0 : (adx > 25 ? 2.5 : 2.0);
  var tp = signal === 'BUY' ? price + slDist * rr : price - slDist * rr;
  
  var conf = Math.min(99, Math.round(55 + (adx - 20) * 1.5 + (volHigh ? 5 : 0)));
  
  return {
    signal: signal, conf: conf, price: price, sl: sl, tp: tp,
    rsi: rsi.toFixed(1), ema9: ema9.toFixed(2), ema21: ema21.toFixed(2), ema50: ema50.toFixed(2),
    macroTrend: macroTrend, adx: adx.toFixed(1), reason: reason, atrBuffer: atrBuffer.toFixed(2),
    slPct: (slPct*100).toFixed(2), tpPct: (slPct*rr*100).toFixed(2)
  };
}

async function main() {
  const days = 90;
  const interval = '30m';
  const limit = Math.ceil((days * 24 * 60) / 30);
  
  console.log('=== BACKTEST v3 (Trend Following) - 90 DIAS - BTCUSDT ===');
  console.log('Intervalo: ' + interval + ' | Velas: ' + limit);
  
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
  
  console.log('\n=== TODOS OS TRADES ===');
  trades.forEach(function(t) {
    var dt = new Date(t.time).toISOString().slice(0,16).replace('T',' ');
    console.log(dt + ' | ' + t.signal + ' | Entry: $' + Math.round(t.entry) + ' | Exit: $' + Math.round(t.exit) + ' | ' + t.outcome + ' | PnL: $' + t.pnl.toFixed(2) + ' | Conf: ' + t.conf + '%');
  });
}

main().catch(function(e) { console.error('ERRO:', e.message); });
