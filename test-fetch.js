const axios = require('axios');

async function test() {
  let all = [], end = Date.now(), needed = 4320;
  while (all.length < needed) {
    const r = await axios.get('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=30m&limit=1000&endTime=' + end, {timeout: 10000});
    if (!r.data || r.data.length === 0) break;
    all = [...r.data, ...all];
    end = r.data[0][0] - 1;
    console.log('Batch: ' + r.data.length + ' | Total: ' + all.length);
    if (r.data.length < 1000) break;
    if (all.length >= needed) break;
  }
  console.log('TOTAL FINAL: ' + all.length + ' velas');
  const first = new Date(all[0][0]).toISOString();
  const last = new Date(all[all.length-1][0]).toISOString();
  console.log('De: ' + first + ' Ate: ' + last);
}
test().catch(e => console.error(e.message));
