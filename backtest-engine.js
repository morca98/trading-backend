const axios = require('axios');

class BacktestEngine {
  constructor(options = {}) {
    this.capital = options.initialCapital || 1000;
    this.riskPerTrade = options.riskPerTrade || 0.02;
    this.fee = options.fee || 0.001; // 0.1%
    this.slippage = options.slippage || 0.0005; // 0.05%
    this.rr = options.rr || 2.2;
    this.symbol = options.symbol || 'BTCUSDT';
    this.interval = options.interval || '30m';
    this.limit = options.limit || 1000;
    
    this.trades = [];
    this.history = [];
    this.maxCapital = this.capital;
    this.maxDD = 0;
    
    // Binance endpoints (with fallback)
    this.endpoints = [
      'https://api.binance.com',
      'https://api1.binance.com',
      'https://api2.binance.com',
      'https://api3.binance.com',
      'https://api.mexc.com'
    ];
  }

  async fetchCandles() {
    const maxPerRequest = 1000;
    const totalNeeded = this.limit;
    let allCandles = [];
    let endTime = Date.now();

    for (const base of this.endpoints) {
      try {
        allCandles = [];
        let currentEndTime = endTime;
        
        while (allCandles.length < totalNeeded) {
          const limit = Math.min(maxPerRequest, totalNeeded - allCandles.length);
          let url;
          if (base.includes('mexc')) {
            const mexcInterval = this.interval.replace('m', 'm').replace('h', 'h').replace('d', 'd');
            url = `${base}/api/v3/klines?symbol=${this.symbol}&interval=${mexcInterval}&limit=${limit}&endTime=${currentEndTime}`;
          } else {
            url = `${base}/api/v3/klines?symbol=${this.symbol}&interval=${this.interval}&limit=${limit}&endTime=${currentEndTime}`;
          }
          
          
          const r = await axios.get(url, { timeout: 5000 });
          const batch = r.data.map(k => ({
            time: +k[0],
            open: +k[1],
            high: +k[2],
            low: +k[3],
            close: +k[4],
            volume: +k[5]
          }));
          
          if (batch.length === 0) break;
          
          allCandles = [...batch, ...allCandles];
          currentEndTime = batch[0].time - 1;
          
          if (batch.length < limit) break;
        }
        
        if (allCandles.length > 0) {
          return allCandles.sort((a, b) => a.time - b.time);
        }
      } catch (e) {
        console.log(`Failed to fetch from ${base}: ${e.message}`);
      }
    }
    throw new Error('All data sources failed');
  }

  // Helper to calculate indicators on the fly
  calculateIndicators(candles) {
    const closes = candles.map(c => c.close);
    const rsi = this.calcRSI(closes);
    const ema20 = this.calcEMA(closes.slice(-20), 20);
    const ema50 = closes.length >= 50 ? this.calcEMA(closes.slice(-50), 50) : ema20;
    const atr = this.calcATR(candles, 14);
    
    // Dynamic Trend Calculation
    const macroTrend = this.calcTrend(closes, 50); // Using 50 periods as proxy for macro
    const trend15m = this.calcTrend(closes, 10); // Using 10 periods as proxy for short term
    
    return { rsi, ema20, ema50, atr, macroTrend, trend15m };
  }

  calcEMA(data, period) {
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
    
    // Fetch 4h candles for macro trend
    let candles4h = [];
    try {
      const oldInterval = this.interval;
      this.interval = '4h';
      candles4h = await this.fetchCandles();
      this.interval = oldInterval;
    } catch (e) {
      console.log("Failed to fetch 4h candles, macro trend will be less accurate");
    }

    this.history = [];
    this.trades = [];
    
    for (let i = 60; i < candles.length - 1; i++) {
      const window = candles.slice(0, i + 1);
      const currentCandle = window[window.length - 1];
      const price = currentCandle.close;
      
      // Get macro trend from 4h candles up to current time
      let macroTrend = 'NEUTRAL';
      if (candles4h.length > 0) {
        const relevant4h = candles4h.filter(c => c.time <= currentCandle.time);
        if (relevant4h.length >= 20) {
          const closes4h = relevant4h.map(c => c.close);
          macroTrend = this.calcTrend(closes4h, 20);
        }
      }
      
      const indicators = this.calculateIndicators(window);
      // Override macroTrend with the one from 4h candles
      indicators.macroTrend = macroTrend;
      
      const signalResult = generateSignalFn(window, price, indicators.macroTrend, indicators.trend15m, indicators.atr, null);
      
      // Baixar o limiar de confiança de 75 para 60 para capturar mais trades no backtest
      if (!signalResult || signalResult.conf < 60) continue;
      
      // Simulate Trade
      let outcome = null;
      let exitPrice = 0;
      let exitTime = 0;
      
      // Entry with slippage
      const entryPrice = signalResult.signal === 'BUY' ? price * (1 + this.slippage) : price * (1 - this.slippage);
      
      for (let j = i + 1; j < Math.min(i + 48, candles.length); j++) {
        const next = candles[j];
        if (signalResult.signal === 'BUY') {
          if (next.low <= signalResult.sl) { outcome = 'LOSS'; exitPrice = signalResult.sl; exitTime = next.time; break; }
          if (next.high >= signalResult.tp) { outcome = 'WIN'; exitPrice = signalResult.tp; exitTime = next.time; break; }
        } else {
          if (next.high >= signalResult.sl) { outcome = 'LOSS'; exitPrice = signalResult.sl; exitTime = next.time; break; }
          if (next.low <= signalResult.tp) { outcome = 'WIN'; exitPrice = signalResult.tp; exitTime = next.time; break; }
        }
      }
      
      if (outcome) {
        // Calculate PnL with fees
        const rawPnlPct = signalResult.signal === 'BUY' ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
        const pnlAmount = this.capital * this.riskPerTrade * (rawPnlPct / (Math.abs(entryPrice - signalResult.sl) / entryPrice));
        const feeAmount = this.capital * this.fee * 2; // Entry + Exit
        const netPnl = pnlAmount - feeAmount;
        
        this.capital += netPnl;
        this.maxCapital = Math.max(this.maxCapital, this.capital);
        this.maxDD = Math.max(this.maxDD, (this.maxCapital - this.capital) / this.maxCapital * 100);
        
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
          capital: this.capital
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
    return grossLoss === 0 ? grossProfit : grossProfit / grossLoss;
  }
}

module.exports = BacktestEngine;
