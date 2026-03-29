const axios = require('axios');

class BacktestEngine {
  constructor(options = {}) {
    this.capital = options.initialCapital || 1000;
    this.riskPerTrade = options.riskPerTrade || 0.01;
    this.fee = options.fee || 0.001; // 0.1%
    this.slippage = options.slippage || 0.0005; // 0.05%
    this.rr = options.rr || 2.5; // R:R 1:2.5 (Trend Master)
    this.symbol = options.symbol || 'BTCUSDT';
    this.interval = '30m'; // Fixo em 30m para sinais
    this.limit = options.limit || 1000;
    
    this.trades = [];
    this.history = [];
    this.maxCapital = this.capital;
    this.maxDD = 0;
    this.lastTradeDateBuy = '';
    this.lastTradeDateSell = '';
    
    // Endpoints por ordem de preferência
    // data-api.binance.vision é o mais estável e sem restrições geográficas
    this.endpoints = [
      { base: 'https://data-api.binance.vision', type: 'binance' },
      { base: 'https://api.binance.com', type: 'binance' },
      { base: 'https://api1.binance.com', type: 'binance' },
      { base: 'https://api2.binance.com', type: 'binance' },
      { base: 'https://api3.binance.com', type: 'binance' },
      { base: 'https://api.mexc.com', type: 'mexc' }, // Fallback: limite de 500 velas
    ];
  }

  async fetchCandlesBatch(base, type, symbol, interval, limit, endTime) {
    const maxPerRequest = type === 'mexc' ? 500 : 1000;
    const batchLimit = Math.min(maxPerRequest, limit);
    let url;
    if (type === 'mexc') {
      url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${batchLimit}&endTime=${endTime}`;
    } else {
      url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${batchLimit}&endTime=${endTime}`;
    }
    const r = await axios.get(url, { timeout: 8000 });
    return r.data.map(k => ({
      time: +k[0],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume: +k[5]
    }));
  }

  async fetchCandles() {
    const totalNeeded = this.limit;
    
    for (const ep of this.endpoints) {
      try {
        let allCandles = [];
        let currentEndTime = Date.now();
        const maxPerRequest = ep.type === 'mexc' ? 500 : 1000;
        let attempts = 0;
        const maxAttempts = Math.ceil(totalNeeded / maxPerRequest) + 2;
        
        while (allCandles.length < totalNeeded && attempts < maxAttempts) {
          attempts++;
          const remaining = totalNeeded - allCandles.length;
          const batchLimit = Math.min(maxPerRequest, remaining);
          
          const batch = await this.fetchCandlesBatch(
            ep.base, ep.type, this.symbol, this.interval, batchLimit, currentEndTime
          );
          
          if (!batch || batch.length === 0) break;
          
          // Prepend (dados mais antigos primeiro)
          allCandles = [...batch, ...allCandles];
          currentEndTime = batch[0].time - 1;
          
          // Se o batch retornou menos do que pedimos, não há mais dados
          if (batch.length < batchLimit) break;
        }
        
        if (allCandles.length > 0) {
          // Remover duplicados e ordenar
          const seen = new Set();
          const unique = allCandles.filter(c => {
            if (seen.has(c.time)) return false;
            seen.add(c.time);
            return true;
          });
          console.log(`[BacktestEngine] ${ep.type} (${ep.base}): ${unique.length} candles carregados (pedidos: ${attempts})`);
          return unique.sort((a, b) => a.time - b.time);
        }
      } catch (e) {
        console.log(`[BacktestEngine] Falhou ${ep.base}: ${e.message}`);
      }
    }
    throw new Error('Todos os endpoints falharam ao buscar dados históricos');
  }

  // Helper to calculate indicators on the fly
  calculateIndicators(candles) {
    const closes = candles.map(c => c.close);
    const rsi = this.calcRSI(closes);
    const ema9 = this.calcEMA(closes.slice(-9), 9);
    const ema21 = this.calcEMA(closes.slice(-21), 21);
    const ema50 = this.calcEMA(closes.slice(-50), 50);
    const atr = this.calcATR(candles, 14);
    const adx = this.calcADX(candles, 14);
    
    return { rsi, ema9, ema21, ema50, atr, adx };
  }

  calcADX(candles, period = 14) {
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
    return dx;
  }

  calcEMA(data, period) {
    if (!data || data.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
    return ema;
  }

  calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / period, avgLoss = losses / period;
    return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  calcATR(candles, period = 14) {
    if (candles.length < period) return 0;
    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1] || c;
      sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    return sum / period;
  }

  calcTrend(closes, period) {
    if (closes.length < period) return 'NEUTRAL';
    const current = closes[closes.length - 1];
    const prev = closes[closes.length - period];
    return current > prev ? 'BULL' : 'BEAR';
  }

  async run(generateSignalFn) {
    const candles = await this.fetchCandles();
    console.log(`[BacktestEngine] Total candles para backtest: ${candles.length}`);
    
    // Fetch 4h candles for macro trend
    let candles4h = [];
    try {
      const savedInterval = this.interval;
      const savedLimit = this.limit;
      this.interval = '4h';
      this.limit = Math.min(500, Math.ceil(this.limit / 8) + 100); // 4h = 8x menos candles, extra para EMA50
      candles4h = await this.fetchCandles();
      this.interval = savedInterval;
      this.limit = savedLimit;
      console.log(`[BacktestEngine] Candles 4h: ${candles4h.length}`);
    } catch (e) {
      console.log('[BacktestEngine] Falhou a buscar candles 4h, macro trend menos preciso');
    }

    this.history = [];
    this.trades = [];
    let lastLossCandle = -1; // Cooldown após perda
    let lastTradeDate = ''; // Limite de 1 trade por dia
    
    for (let i = 60; i < candles.length - 1; i++) {
      const window = candles.slice(0, i + 1);
      const currentCandle = window[window.length - 1];
      const price = currentCandle.close;
      
      // Get macro trend from 4h candles up to current time
      let macroTrend = 'NEUTRAL';
      let macroEma50 = 0;
      let macroEma200 = 0;
      if (candles4h.length > 0) {
        const relevant4h = candles4h.filter(c => c.time <= currentCandle.time);
        if (relevant4h.length >= 20) {
          const closes4h = relevant4h.map(c => c.close);
          // EMA50 e EMA200 dos 4h para regime mais preciso
          macroEma50 = relevant4h.length >= 50 ? this.calcEMA(closes4h.slice(-50), 50) : this.calcEMA(closes4h.slice(-20), 20);
          macroEma200 = relevant4h.length >= 200 ? this.calcEMA(closes4h.slice(-200), 200) : macroEma50;
          const lastPrice4h = closes4h[closes4h.length - 1];
          // Regime baseado em EMA50 e EMA200 dos 4h
          if (lastPrice4h > macroEma50 && macroEma50 > macroEma200) macroTrend = 'BULL';
          else if (lastPrice4h < macroEma50 && macroEma50 < macroEma200) macroTrend = 'BEAR';
          else if (lastPrice4h > macroEma200) macroTrend = 'UP';
          else macroTrend = 'DOWN';
        }
      }
      
      const ind = this.calculateIndicators(window);
      
      // Cooldown de 90min (3 velas de 30m) após QUALQUER trade
      if (lastLossCandle > 0 && i - lastLossCandle < 3) continue;
      if (this.trades.length > 0) {
        const lastTrade = this.trades[this.trades.length - 1];
        if (currentCandle.time <= lastTrade.exitTime) continue;
      }

      // Lógica TREND MASTER idêntica ao server.js
      let signal = 'WAIT', conf = 0;
      const isStrongBull = price > ind.ema9 && ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50;
      const isStrongBear = price < ind.ema9 && ind.ema9 < ind.ema21 && ind.ema21 < ind.ema50;
      
      if (isStrongBull && ind.adx > 25 && ind.rsi < 65 && (macroTrend === 'UP' || macroTrend === 'BULL')) {
        signal = 'BUY'; conf = 85;
      } else if (isStrongBear && ind.adx > 25 && ind.rsi > 35 && (macroTrend === 'DOWN' || macroTrend === 'BEAR')) {
        signal = 'SELL'; conf = 85;
      }

      if (signal === 'WAIT') continue;
      const signalResult = { signal, conf, price, atr: ind.atr };
      
      // Cooldown de 1 trade por dia removido para aumentar número de sinais
      // const currentDate = new Date(currentCandle.time).toISOString().slice(0,10);
      // if (signalResult.signal === 'BUY' && currentDate === this.lastTradeDateBuy) continue;
      // if (signalResult.signal === 'SELL' && currentDate === this.lastTradeDateSell) continue;
      
      // Simulate Trade
      let outcome = null;
      let exitPrice = 0;
      let exitTime = 0;
      
      // Entry with slippage
      const entryPrice = signalResult.signal === 'BUY' ? price * (1 + this.slippage) : price * (1 - this.slippage);
      
      // Regras de SL/TP sincronizadas com o bot real
      const lows = window.map(c => c.low);
      const highs = window.map(c => c.high);
      let sl = 0, tp = 0;
      
      if (signalResult.signal === 'BUY') {
        const lastHL = Math.min(...lows.slice(-3));
        sl = lastHL - (1.5 * ind.atr);
        const slPct = Math.abs((entryPrice - sl) / entryPrice * 100);
        tp = entryPrice * (1 + (slPct * this.rr) / 100);
      } else {
        const lastLH = Math.max(...highs.slice(-3));
        sl = lastLH + (1.5 * ind.atr);
        const slPct = Math.abs((sl - entryPrice) / entryPrice * 100);
        tp = entryPrice * (1 - (slPct * this.rr) / 100);
      }
      
      for (let j = i + 1; j < Math.min(i + 96, candles.length); j++) {
        const next = candles[j];
        if (signalResult.signal === 'BUY') {
          if (next.low <= sl) { outcome = 'LOSS'; exitPrice = sl; exitTime = next.time; break; }
          if (next.high >= tp) { outcome = 'WIN'; exitPrice = tp; exitTime = next.time; break; }
        } else {
          if (next.high >= sl) { outcome = 'LOSS'; exitPrice = sl; exitTime = next.time; break; }
          if (next.low <= tp) { outcome = 'WIN'; exitPrice = tp; exitTime = next.time; break; }
        }
      }
      
      if (outcome) {
        const slDistPct = Math.abs(entryPrice - sl) / entryPrice;
        const positionSize = (this.capital * 0.01) / slDistPct;
        const exitDistPct = Math.abs(entryPrice - exitPrice) / entryPrice;
        const grossPnl = positionSize * exitDistPct * (outcome === 'WIN' ? 1 : -1);
        const feeAmount = (positionSize * this.fee) + ((positionSize + grossPnl) * this.fee);
        const netPnl = grossPnl - feeAmount;
        
        this.capital += netPnl;
        this.maxCapital = Math.max(this.maxCapital, this.capital);
        this.maxDD = Math.max(this.maxDD, (this.maxCapital - this.capital) / this.maxCapital * 100);
        
        if (outcome === 'LOSS') lastLossCandle = i;
        const tradeDate = new Date(currentCandle.time).toISOString().slice(0,10);
        if (signalResult.signal === 'BUY') this.lastTradeDateBuy = tradeDate;
        else this.lastTradeDateSell = tradeDate;
        this.lastTradeDate = tradeDate;
        
        this.trades.push({
          time: currentCandle.time,
          exitTime: exitTime,
          symbol: this.symbol,
          signal: signalResult.signal,
          entry: entryPrice,
          exit: exitPrice,
          outcome: outcome,
          pnl: netPnl,
          pnlPct: (netPnl / (this.capital - netPnl)) * 100,
          capital: this.capital,
          conf: signalResult.conf,
          positionSize: positionSize
        });
        
        // Skip to exit time to avoid overlapping trades on same symbol
        while (i < candles.length - 1 && candles[i].time < exitTime) i++;
      }
    }
    
    return this.getResults();
  }

  getResults() {
    const wins = this.trades.filter(t => t.outcome === 'WIN').length;
    const losses = this.trades.filter(t => t.outcome === 'LOSS').length;
    const total = wins + losses;
    
    const winRate = total > 0 ? (wins / total) * 100 : 0;
    const profitFactor = this.calculateProfitFactor();
    
    return {
      symbol: this.symbol,
      totalTrades: total,
      wins,
      losses,
      winRate: winRate.toFixed(2),
      finalCapital: this.capital.toFixed(2),
      returnPct: (((this.capital - 1000) / 1000) * 100).toFixed(2),
      maxDD: this.maxDD.toFixed(2),
      profitFactor: profitFactor.toFixed(2),
      trades: this.trades
    };
  }

  calculateProfitFactor() {
    const grossProfit = this.trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(this.trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    return grossLoss === 0 ? (grossProfit > 0 ? grossProfit : 0) : grossProfit / grossLoss;
  }
}

module.exports = BacktestEngine;
