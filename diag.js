const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BINANCE_FUTURES = 'https://fapi.binance.com';
const DATA_DIR = path.join(__dirname, 'data');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');

async function getCurrentPrice(symbol) {
  try {
    const res = await axios.get(`${BINANCE_FUTURES}/ticker/price?symbol=${symbol}`);
    return parseFloat(res.data.price);
  } catch (e) {
    console.error(`[Price Fetch Error ${symbol}]:`, e.message);
    return null;
  }
}

async function test() {
  console.log('--- DIAGNÓSTICO DE FECHO DE TRADES ---');
  
  if (!fs.existsSync(TRADES_FILE)) {
    console.error('Ficheiro trades.json não encontrado!');
    return;
  }

  const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  const openTrades = trades.filter(t => t.outcome === 'OPEN');
  
  console.log(`Trades abertos encontrados: ${openTrades.length}`);
  
  for (const trade of openTrades) {
    const price = await getCurrentPrice(trade.symbol);
    console.log(`\nVerificando ${trade.symbol}:`);
    console.log(`- Preço Atual: $${price}`);
    console.log(`- Entrada: $${trade.entry}`);
    console.log(`- SL: $${trade.sl}`);
    console.log(`- TP: $${trade.tp}`);
    console.log(`- Sinal: ${trade.signal}`);

    const tp = parseFloat(trade.tp);
    const sl = parseFloat(trade.sl);
    const isBuy = trade.signal === 'BUY';
    
    let shouldClose = false;
    let closeReason = null;

    if (isBuy) {
      if (price <= sl) { shouldClose = true; closeReason = 'SL'; }
      else if (price >= tp) { shouldClose = true; closeReason = 'TP'; }
    } else {
      if (price >= sl) { shouldClose = true; closeReason = 'SL'; }
      else if (price <= tp) { shouldClose = true; closeReason = 'TP'; }
    }

    if (shouldClose) {
      console.log(`>>> RESULTADO: DEVERIA FECHAR POR ${closeReason}!`);
    } else {
      console.log(`>>> RESULTADO: Ainda em aberto.`);
    }
  }
}

test();
