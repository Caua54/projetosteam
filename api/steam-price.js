// Vercel Serverless Function — Proxy Steam Store API
// Coloque este arquivo em: api/steam-price.js
// Rota: GET /api/steam-price?appid=1174180&cc=br

const ALLOWED_CC = ['br', 'us', 'gb', 'de', 'fr', 'ar', 'mx', 'au'];

// Cache simples em memória (por instância, ~10 min de vida útil)
const cache = {};

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const appid = (req.query.appid || '').replace(/\D/g, '');
  const cc    = (req.query.cc    || 'us').toLowerCase();

  if (!appid) {
    return res.status(400).json({ error: 'appid obrigatorio' });
  }
  if (!ALLOWED_CC.includes(cc)) {
    return res.status(400).json({ error: 'cc invalido: ' + cc });
  }

  const key = appid + '_' + cc;
  const now = Date.now();

  // Cache hit (10 min)
  if (cache[key] && now - cache[key].ts < 10 * 60 * 1000) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.status(200).json(cache[key].data);
  }

  const steamUrl =
    'https://store.steampowered.com/api/appdetails' +
    '?appids=' + appid +
    '&cc=' + cc +
    '&filters=price_overview';

  try {
    const steamRes = await fetch(steamUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!steamRes.ok) {
      return res.status(502).json({ error: 'Steam retornou ' + steamRes.status });
    }

    const raw  = await steamRes.json();
    const app  = raw && raw[appid];

    if (!app || !app.success) {
      const data = { price: null };
      cache[key] = { data, ts: now };
      return res.status(200).json(data);
    }

    const po = app.data && app.data.price_overview;
    const data = po ? {
      price: {
        currency:          po.currency,
        initial:           po.initial / 100,
        final:             po.final   / 100,
        discount_percent:  po.discount_percent,
        initial_formatted: po.initial_formatted,
        final_formatted:   po.final_formatted,
      }
    } : { price: null };

    cache[key] = { data, ts: now };
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};