/**
 * Análise detalhada dos trades - ver quanto o mercado se moveu antes de atingir SL/TP
 */
const axios = require('axios');

async function analyze() {
  // Buscar dados de 30m para o período problemático
  const r = await axios.get('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=30m&limit=1000&endTime=' + new Date('2026-03-25').getTime(), {timeout: 15000});
  const candles = r.data.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  
  // Trades perdedores identificados
  const lossTrades = [
    { date: '2026-02-02', signal: 'SELL', entry: 76444, sl: 77629, tp: 73000 },
    { date: '2026-02-23', signal: 'SELL', entry: 65644, sl: 66173, tp: 63500 },
    { date: '2026-02-24', signal: 'SELL', entry: 63195, sl: 63738, tp: 61000 },
    { date: '2026-02-24', signal: 'SELL', entry: 64188, sl: 64859, tp: 62000 },
    { date: '2026-02-28', signal: 'SELL', entry: 63968, sl: 64884, tp: 62000 },
    { date: '2026-03-08', signal: 'SELL', entry: 67186, sl: 67561, tp: 65500 },
    { date: '2026-03-08', signal: 'SELL', entry: 67232, sl: 68268, tp: 65500 },
    { date: '2026-03-15', signal: 'BUY', entry: 71743, sl: 71340, tp: 73500 },
    { date: '2026-03-17', signal: 'BUY', entry: 74544, sl: 73781, tp: 76500 },
  ];
  
  console.log('=== ANÁLISE DE TRADES PERDEDORES ===\n');
  
  lossTrades.forEach(trade => {
    const entryTime = new Date(trade.date).getTime();
    const entryIdx = candles.findIndex(c => c.time >= entryTime);
    if (entryIdx < 0) return;
    
    const slDist = Math.abs(trade.entry - trade.sl) / trade.entry * 100;
    const tpDist = Math.abs(trade.entry - trade.tp) / trade.entry * 100;
    
    // Ver os próximos 96 candles (48h)
    let maxFav = 0, maxAdv = 0, hitSL = false, hitTP = false, hitAt = 0;
    for (let j = entryIdx + 1; j < Math.min(entryIdx + 96, candles.length); j++) {
      const c = candles[j];
      if (trade.signal === 'SELL') {
        const fav = (trade.entry - c.low) / trade.entry * 100; // Movimento favorável
        const adv = (c.high - trade.entry) / trade.entry * 100; // Movimento adverso
        maxFav = Math.max(maxFav, fav);
        maxAdv = Math.max(maxAdv, adv);
        if (!hitSL && c.high >= trade.sl) { hitSL = true; hitAt = j - entryIdx; }
        if (!hitTP && c.low <= trade.tp) { hitTP = true; hitAt = j - entryIdx; }
      } else {
        const fav = (c.high - trade.entry) / trade.entry * 100;
        const adv = (trade.entry - c.low) / trade.entry * 100;
        maxFav = Math.max(maxFav, fav);
        maxAdv = Math.max(maxAdv, adv);
        if (!hitSL && c.low <= trade.sl) { hitSL = true; hitAt = j - entryIdx; }
        if (!hitTP && c.high >= trade.tp) { hitTP = true; hitAt = j - entryIdx; }
      }
    }
    
    const result = hitSL ? 'SL (' + hitAt + ' velas)' : (hitTP ? 'TP (' + hitAt + ' velas)' : 'EXPIROU');
    console.log(trade.date + ' | ' + trade.signal + ' @ $' + trade.entry);
    console.log('  SL: ' + slDist.toFixed(2) + '% | TP: ' + tpDist.toFixed(2) + '%');
    console.log('  Max Fav: +' + maxFav.toFixed(2) + '% | Max Adv: -' + maxAdv.toFixed(2) + '%');
    console.log('  Resultado: ' + result);
    console.log('');
  });
  
  // Analisar o comportamento do mercado em fevereiro
  console.log('\n=== VOLATILIDADE MÉDIA POR VELA (30m) ===');
  const months = { '2026-01': [], '2026-02': [], '2026-03': [] };
  candles.forEach(c => {
    const m = new Date(c.time).toISOString().slice(0,7);
    if (months[m]) months[m].push((c.high - c.low) / c.close * 100);
  });
  Object.keys(months).forEach(m => {
    const arr = months[m];
    if (arr.length === 0) return;
    const avg = arr.reduce((s,v) => s+v, 0) / arr.length;
    const max = Math.max(...arr);
    console.log(m + ': Volatilidade média: ' + avg.toFixed(3) + '% | Máx: ' + max.toFixed(3) + '%');
  });
}

analyze().catch(e => console.error(e.message));
