const BacktestEngine = require('./backtest-engine');

// Funções auxiliares (copiadas de test-v3.js para consistência)
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / avgLoss);
}

function calcEMA(closes, period) {
  if (!closes || closes.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcEMALine(closes, period) {
  if (!closes || closes.length < period) return [];
  const k = 2 / (period + 1);
  const result = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    result.push(closes[i] * k + result[result.length - 1] * (1 - k));
  }
  return result;
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2) return 0;
  const plusDMs = [], minusDMs = [], trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low;
    const ph = candles[i - 1].high, pl = candles[i - 1].low, pc = candles[i - 1].close;
    const plusDM = h - ph > pl - l ? Math.max(h - ph, 0) : 0;
    const minusDM = pl - l > h - ph ? Math.max(pl - l, 0) : 0;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    plusDMs.push(plusDM); minusDMs.push(minusDM); trs.push(tr);
  }
  let sPDM = plusDMs.slice(0, period).reduce((s, v) => s + v, 0);
  let sMDM = minusDMs.slice(0, period).reduce((s, v) => s + v, 0);
  let sTR = trs.slice(0, period).reduce((s, v) => s + v, 0);
  const dxVals = [];
  for (let j = period; j < trs.length; j++) {
    sPDM = sPDM - sPDM / period + plusDMs[j];
    sMDM = sMDM - sMDM / period + minusDMs[j];
    sTR = sTR - sTR / period + trs[j];
    const pDI = sTR > 0 ? (sPDM / sTR) * 100 : 0;
    const mDI = sTR > 0 ? (sMDM / sTR) * 100 : 0;
    const diSum = pDI + mDI;
    dxVals.push(diSum > 0 ? Math.abs(pDI - mDI) / diSum * 100 : 0);
  }
  if (dxVals.length < period) return dxVals.length > 0 ? dxVals[dxVals.length - 1] : 0;
  let adx = dxVals.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let k = period; k < dxVals.length; k++) adx = (adx * (period - 1) + dxVals[k]) / period;
  return adx;
}

// Estratégia v3 com opção de filtro EMA Diário
function generateSignal(candles, price, macroTrend, trend15m, atr, liqData, symbol, useDailyFilter = false, dailyCandles = []) {
  if (candles.length < 60) return null;

  // --- FILTRO EMA DIÁRIO ---
  let dailyTrend = 'NEUTRAL';
  if (useDailyFilter && dailyCandles.length > 0) {
    const currentCandleTime = candles[candles.length - 1].time;
    const relevantDaily = dailyCandles.filter(c => c.time <= currentCandleTime);
    if (relevantDaily.length >= 50) {
      const dailyCloses = relevantDaily.map(c => c.close);
      const ema20 = calcEMA(dailyCloses.slice(-20), 20);
      const ema50 = calcEMA(dailyCloses.slice(-50), 50);
      dailyTrend = ema20 > ema50 ? 'BULL' : 'BEAR';
    }
  }

  const closes = candles.map(c => c.close);
  const rsi = calcRSI(closes);
  const adx = calcADX(candles);

  const ema9Line = calcEMALine(closes, 9);
  const ema21Line = calcEMALine(closes, 21);
  const ema50Line = calcEMALine(closes, 50);

  const len = ema9Line.length;
  if (len < 3) return null;

  const ema9 = ema9Line[len - 1];
  const ema21 = ema21Line[len - 1];
  const ema50 = ema50Line.length > 0 ? ema50Line[len - 1] : ema21;
  const ema200 = closes.length >= 200 ? calcEMA(closes.slice(-200), 200) : ema50;

  const ema9PrevAbove = ema9Line[len - 2] > ema21Line[len - 2];
  const ema9CurrAbove = ema9 > ema21;
  const crossedUp = !ema9PrevAbove && ema9CurrAbove;
  const crossedDown = ema9PrevAbove && !ema9CurrAbove;

  const trendingUp = ema9 > ema21 && ema21 > ema50;
  const trendingDown = ema9 < ema21 && ema21 < ema50;

  const rv = candles.slice(-3).reduce((s, c) => s + c.volume, 0) / 3;
  const pv = candles.slice(-15, -3).reduce((s, c) => s + c.volume, 0) / 12;
  const volHigh = pv > 0 && rv > pv * 1.2;

  if (adx < 20) return null;

  let signal = null;
  let reason = '';

  // BUY logic
  if (crossedUp && ema21 > ema50 && macroTrend !== 'BEAR') {
    signal = 'BUY';
    reason = 'CROSSOVER_UP';
  } else if (trendingUp && macroTrend === 'BULL' && rsi > 45 && rsi < 65 && volHigh) {
    const nearEma21 = Math.abs(price - ema21) / price < 0.008;
    if (nearEma21) {
      signal = 'BUY';
      reason = 'PULLBACK_BUY';
    }
  }

  // SELL logic
  if (crossedDown && ema21 < ema50 && macroTrend !== 'BULL') {
    signal = 'SELL';
    reason = 'CROSSOVER_DOWN';
  } else if (trendingDown && macroTrend === 'BEAR' && rsi > 35 && rsi < 55 && volHigh) {
    const nearEma21Sell = Math.abs(price - ema21) / price < 0.008;
    if (nearEma21Sell) {
      signal = 'SELL';
      reason = 'PULLBACK_SELL';
    }
  }

  if (!signal) return null;

  // --- APLICAR FILTRO DIÁRIO ---
  if (useDailyFilter && dailyTrend !== 'NEUTRAL') {
    if (signal === 'BUY' && dailyTrend !== 'BULL') return null;
    if (signal === 'SELL' && dailyTrend !== 'BEAR') return null;
  }

  // Filtros de qualidade
  if (signal === 'BUY') {
    if (rsi > 70) return null;
    if (price < ema200 && macroTrend !== 'BULL') return null;
    const ema9DistFromEma21 = (ema9 - ema21) / ema21 * 100;
    if (ema9DistFromEma21 > 1.5) return null;
  }

  if (signal === 'SELL') {
    if (rsi < 30) return null;
    if (price > ema200 && macroTrend !== 'BEAR') return null;
    const ema9DistFromEma21Sell = (ema21 - ema9) / ema21 * 100;
    if (ema9DistFromEma21Sell > 1.5) return null;
  }

  const prevCandle = candles[candles.length - 2];
  if (signal === 'BUY' && prevCandle.close < prevCandle.open) return null;
  if (signal === 'SELL' && prevCandle.close > prevCandle.open) return null;
  if (!volHigh) return null;

  const atrBuffer = adx > 30 ? 1.5 : (adx > 25 ? 1.25 : 1.0);
  let sl, slDist;
  if (signal === 'BUY') {
    const recentLow = Math.min(...candles.slice(-3).map(c => c.low));
    sl = recentLow - atr * atrBuffer;
    slDist = price - sl;
  } else {
    const recentHigh = Math.max(...candles.slice(-3).map(c => c.high));
    sl = recentHigh + atr * atrBuffer;
    slDist = sl - price;
  }

  slDist = Math.max(price * 0.005, Math.min(price * 0.03, slDist));
  sl = signal === 'BUY' ? price - slDist : price + slDist;
  const slPct = slDist / price;
  const rr = adx > 30 ? 3.0 : (adx > 25 ? 2.5 : 2.0);
  const tp = signal === 'BUY' ? price + slDist * rr : price - slDist * rr;

  return {
    signal, price, sl, tp, slPct: (slPct * 100).toFixed(2), tpPct: (slPct * rr * 100).toFixed(2)
  };
}

async function runComparison() {
  const days = 365;
  const interval = '30m';
  const limit = Math.ceil((days * 24 * 60) / 30);
  const symbol = 'BTCUSDT';

  console.log(`=== INICIANDO BACKTEST COMPARATIVO (${days} DIAS) ===`);
  
  const engine = new BacktestEngine({ symbol, interval, limit, riskPerTrade: 0.02 });
  
  // Buscar candles diários para o filtro
  console.log('[Info] Buscando candles diários...');
  const savedInterval = engine.interval;
  const savedLimit = engine.limit;
  engine.interval = '1d';
  engine.limit = days + 100; // Extra para EMAs
  const dailyCandles = await engine.fetchCandles();
  engine.interval = savedInterval;
  engine.limit = savedLimit;
  console.log(`[Info] ${dailyCandles.length} candles diários carregados.`);

  // 1. Backtest SEM filtro
  console.log('\n--- Executando Backtest SEM Filtro EMA Diário ---');
  const resultsNoFilter = await engine.run((c, p, mt, t15, atr) => 
    generateSignal(c, p, mt, t15, atr, null, symbol, false)
  );

  // 2. Backtest COM filtro
  console.log('\n--- Executando Backtest COM Filtro EMA Diário ---');
  // Reset engine state for second run
  engine.capital = 1000;
  engine.trades = [];
  engine.history = [];
  const resultsWithFilter = await engine.run((c, p, mt, t15, atr) => 
    generateSignal(c, p, mt, t15, atr, null, symbol, true, dailyCandles)
  );

  // Comparação
  console.log('\n' + '='.repeat(50));
  console.log('RESULTADOS COMPARATIVOS (365 DIAS)');
  console.log('='.repeat(50));
  
  const table = [
    ['Métrica', 'Sem Filtro', 'Com Filtro EMA20/50'],
    ['Total Trades', resultsNoFilter.totalTrades, resultsWithFilter.totalTrades],
    ['Win Rate', resultsNoFilter.winRate + '%', resultsWithFilter.winRate + '%'],
    ['Retorno Total', resultsNoFilter.returnPct + '%', resultsWithFilter.returnPct + '%'],
    ['Capital Final', '$' + resultsNoFilter.finalCapital, '$' + resultsWithFilter.finalCapital],
    ['Max Drawdown', resultsNoFilter.maxDD + '%', resultsWithFilter.maxDD + '%'],
    ['Profit Factor', resultsNoFilter.profitFactor, resultsWithFilter.profitFactor]
  ];

  table.forEach(row => {
    console.log(`${row[0].padEnd(20)} | ${row[1].toString().padEnd(15)} | ${row[2]}`);
  });
  console.log('='.repeat(50));
}

runComparison().catch(console.error);
