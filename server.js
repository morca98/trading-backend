const express = require('express');
const app = express();
app.get('/', function(req, res) { res.json({ status: 'ok' }); });
app.listen(process.env.PORT || 3001);
