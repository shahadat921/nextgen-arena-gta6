// NextGen Arena: visitor questions + weekly answers (Vercel serverless function)
// GET  /api/ask            -> public: published weekly answers
// POST /api/ask            -> public: submit a question { text, lang, website }
// POST /api/ask (admin)    -> header x-admin-key + { action: list | publish | delete | unpublish }
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;

const ADMIN_ACTIONS = ['list', 'publish', 'delete', 'unpublish'];

function sha(v) { return crypto.createHash('sha256').update(String(v)).digest(); }
function safeEq(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }
function ipHash(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  return sha(ip).toString('hex').slice(0, 20);
}
function byTsDesc(obj) {
  return Object.values(obj || {}).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!redis) return res.status(500).json({ error: 'db' });

  try {
    // ---------- public: list published answers ----------
    if (req.method === 'GET') {
      const items = byTsDesc(await redis.hgetall('ah')).slice(0, 300);
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
      return res.status(200).json({ items: items });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const ip = ipHash(req);

    // ---------- admin actions ----------
    if (ADMIN_ACTIONS.indexOf(b.action) > -1) {
      const adminKey = process.env.ADMIN_KEY;
      if (!adminKey) return res.status(500).json({ error: 'no_admin_key' });

      const badKey = 'bad:' + ip;
      const bad = Number((await redis.get(badKey)) || 0);
      if (bad >= 10) return res.status(429).json({ error: 'rate' });

      const sent = req.headers['x-admin-key'] || '';
      if (!safeEq(sent, adminKey)) {
        const n = await redis.incr(badKey);
        if (n === 1) await redis.expire(badKey, 900);
        return res.status(401).json({ error: 'auth' });
      }

      if (b.action === 'list') {
        return res.status(200).json({
          questions: byTsDesc(await redis.hgetall('qh')),
          answers: byTsDesc(await redis.hgetall('ah'))
        });
      }

      const id = String(b.id || '');
      if (!id) return res.status(400).json({ error: 'id' });

      if (b.action === 'delete') {
        await redis.hdel('qh', id);
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'unpublish') {
        await redis.hdel('ah', id);
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'publish') {
        const answer = String(b.answer || '').trim();
        if (answer.length < 2 || answer.length > 3000) return res.status(400).json({ error: 'answer' });
        const orig = await redis.hget('qh', id);
        const q = String(b.question || (orig && orig.text) || '').trim().slice(0, 400);
        if (!q) return res.status(400).json({ error: 'question' });
        await redis.hset('ah', { [id]: { id: id, q: q, a: answer, ts: Date.now() } });
        await redis.hdel('qh', id);
        return res.status(200).json({ ok: true });
      }
    }

    // ---------- public: submit a question ----------
    if (b.website) return res.status(200).json({ ok: true }); // honeypot: pretend success
    const text = String(b.text || '').trim().replace(/\s+/g, ' ');
    if (text.length < 10) return res.status(400).json({ error: 'short' });
    if (text.length > 400) return res.status(400).json({ error: 'long' });
    if (/https?:|www\./i.test(text)) return res.status(400).json({ error: 'link' });

    const rk = 'rl:' + ip;
    const n = await redis.incr(rk);
    if (n === 1) await redis.expire(rk, 3600);
    if (n > 5) return res.status(429).json({ error: 'rate' });

    if ((await redis.hlen('qh')) >= 1000) return res.status(429).json({ error: 'full' });

    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    await redis.hset('qh', { [id]: { id: id, text: text, lang: b.lang === 'en' ? 'en' : 'bn', ts: Date.now() } });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server' });
  }
};
