const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const need = k => { if (!process.env[k]) { console.error('Variável de ambiente ausente: ' + k); process.exit(1); } return process.env[k]; };
const SUPABASE_URL = need('SUPABASE_URL');
// Chave secreta: existe SOMENTE aqui no servidor. O site usa apenas a chave publicável.
const sb = createClient(SUPABASE_URL, need('SUPABASE_SECRET_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const BUCKET = 'vestra-private';
const PROD = process.env.NODE_ENV === 'production';
const ROLLOVER = process.env.CREDITS_ROLLOVER === 'true';
// ---------- Virtual Try-On (FASHN) ----------
const fashn = (() => {
const BASE = 'https://api.fashn.ai/v1';
const hdr = () => ({ Authorization: 'Bearer ' + process.env.FASHN_API_KEY, 'Content-Type': 'application/json' });
const configured = () => !!process.env.FASHN_API_KEY;
const uri = (buf, mime) => `data:${mime};base64,${buf.toString('base64')}`;
const run = async (garment, model) => {
  const r = await fetch(BASE + '/run', {
    method: 'POST', headers: hdr(),
    body: JSON.stringify({ model_name: 'tryon-v1.6', inputs: { garment_image: uri(garment.buf, garment.mime), model_image: uri(model.buf, model.mime), category: 'auto', mode: 'balanced' } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error('Provedor recusou a solicitacao (' + r.status + '): ' + JSON.stringify(j.error || j).slice(0, 300));
  return j.id;
};
const status = async id => {
  const r = await fetch(BASE + '/status/' + encodeURIComponent(id), { headers: hdr() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Status HTTP ' + r.status);
  return j; // esperado: { status: starting|in_queue|processing|completed|failed, output: [url], error }
};
return { configured, run, status };
})();

const app = express();
app.set('trust proxy', 1); // Render roda atrás de proxy

app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ['https://fonts.gstatic.com'],
  imgSrc: ["'self'", 'data:', SUPABASE_URL], scriptSrc: ["'self'", "'unsafe-inline'"], connectSrc: ["'self'", SUPABASE_URL], frameAncestors: ["'none'"] } } }));
app.use((req, res, next) => { // CORS opcional (apenas se o site ficar em outro dominio)
  const o = process.env.CORS_ORIGIN;
  if (o && req.headers.origin === o) {
    res.set({ 'Access-Control-Allow-Origin': o, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '1mb' }));
// Serve somente o index.html (na raiz, ao lado deste arquivo, ou em public/). A raiz do repositório NUNCA é exposta.
const SITE = [path.join(__dirname, 'index.html'), path.join(__dirname, 'public', 'index.html')].find(p => fs.existsSync(p));
if (!SITE) console.error('ATENÇÃO: index.html não encontrado ao lado do servidor.js nem em public/.');
app.get('/healthz', (req, res) => res.send('ok'));
app.get(['/', '/index.html'], (req, res) => (SITE ? res.sendFile(SITE) : res.status(500).send('index.html ausente no servidor.')));

const sha = s => crypto.createHash('sha256').update(String(s || '')).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
const sniff = b => (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? { ext: 'jpg', mime: 'image/jpeg' }
  : b.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? { ext: 'png', mime: 'image/png' }
  : b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' ? { ext: 'webp', mime: 'image/webp' } : null);
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'Erro interno.' }); });

// Autenticação: o servidor valida o token do Supabase Auth a cada requisição
async function auth(req, res, next) {
  const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!t) return res.status(401).json({ error: 'Não autenticado.' });
  const { data, error } = await sb.auth.getUser(t);
  if (error || !data?.user) return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  req.user = data.user; next();
}

// Informa ao site o que está configurado (sem expor nenhum segredo)
app.get('/api/config', (req, res) => res.json({ payments: !!process.env.HOTMART_HOTTOK, tryon: fashn.configured() }));

// ---------- Checkout (Hotmart) ----------
app.post('/api/billing/checkout', auth, wrap(async (req, res) => {
  const { data: plan } = await sb.from('plans').select('id,checkout_url,active').eq('id', String(req.body?.plan || '')).maybeSingle();
  if (!plan || !plan.active) return res.status(400).json({ error: 'Plano inválido.' });
  if (!plan.checkout_url) return res.status(503).json({ error: 'Checkout da Hotmart ainda não configurado para este plano.' });
  const u = new URL(plan.checkout_url);
  u.searchParams.set('email', req.user.email); u.searchParams.set('sck', req.user.id);
  res.json({ checkoutUrl: u.toString() }); // créditos NÃO são liberados aqui: só pelo webhook
}));

// ---------- Webhook Hotmart ----------
app.post('/api/webhooks/hotmart', wrap(async (req, res) => {
  const tok = process.env.HOTMART_HOTTOK;
  if (!tok) return res.sendStatus(500);
  if (!safeEq(req.get('x-hotmart-hottok') || req.body?.hottok, tok)) return res.sendStatus(401);
  await handleHotmart(req.body || {});
  res.sendStatus(200);
}));
async function handleHotmart(ev) {
  const d = ev.data || {}, txn = d.purchase?.transaction, evId = String(ev.id || `${ev.event}:${txn}`);
  if ((await sb.from('webhook_events').select('id').eq('id', evId).maybeSingle()).data) return; // evento repetido
  const sub = d.subscription?.subscriber?.code;
  const record = () => sb.from('webhook_events').upsert({ id: evId, source: 'hotmart', payload: ev });
  const unmatched = async reason => { await sb.from('unmatched_payments').upsert({ transaction_id: txn, email: d.buyer?.email, reason, payload: ev }, { onConflict: 'transaction_id' }); console.error('Pagamento NÃO creditado (' + reason + '):', txn); };

  if (ev.event === 'PURCHASE_APPROVED' && txn && String(d.purchase?.status || 'APPROVED').toUpperCase() === 'APPROVED') {
    const { data: plan } = await sb.from('plans').select('id,price_cents').eq('hotmart_offer_code', String(d.purchase?.offer?.code || '')).maybeSingle();
    const email = String(d.buyer?.email || '').toLowerCase().trim(), sck = d.purchase?.origin?.sck;
    let uid = null;
    if (isUuid(sck)) uid = (await sb.from('profiles').select('id').eq('id', sck).maybeSingle()).data?.id || null;
    if (!uid && email) uid = (await sb.from('profiles').select('id').eq('email', email).maybeSingle()).data?.id || null;
    const amount = Math.round(Number(d.purchase?.price?.value || 0) * 100);
    if (!plan) await unmatched('oferta desconhecida');
    else if (!uid) await unmatched('comprador sem conta na VESTRA AI');
    else if (amount && amount < plan.price_cents) await unmatched('valor menor que o do plano');
    else {
      const { data, error } = await sb.rpc('grant_plan_credits', { p_user: uid, p_plan: plan.id, p_txn: txn, p_amount: amount || plan.price_cents, p_method: d.purchase?.payment?.type || null, p_sub: sub || null, p_rollover: ROLLOVER, p_raw: ev });
      if (error) throw error; console.log('grant_plan_credits', txn, data);
    }
  } else if (['PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK'].includes(ev.event) && txn) {
    await sb.rpc('mark_payment_refunded', { p_txn: txn });
    if (sub) await sb.rpc('set_subscription_status', { p_code: sub, p_status: 'canceled' }); // créditos já concedidos NÃO são revertidos automaticamente
  } else if (ev.event === 'SUBSCRIPTION_CANCELLATION' && sub) await sb.rpc('set_subscription_status', { p_code: sub, p_status: 'canceled' });
  else if (['PURCHASE_DELAYED', 'PURCHASE_OVERDUE'].includes(ev.event) && sub) await sb.rpc('set_subscription_status', { p_code: sub, p_status: 'past_due' });
  await record();
}

// ---------- Gerações (Virtual Try-On) ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 2 } }).fields([{ name: 'garment', maxCount: 1 }, { name: 'model', maxCount: 1 }]);
const genLimit = rateLimit({ windowMs: 60e3, limit: 10, standardHeaders: true, legacyHeaders: false });
const put = (p, buf, mime) => sb.storage.from(BUCKET).upload(p, buf, { contentType: mime, upsert: false });
app.post('/api/generations', genLimit, auth, (req, res, next) => upload(req, res, e => (e ? res.status(400).json({ error: 'Envio inválido (máx. 8 MB por imagem).' }) : next())), wrap(async (req, res) => {
  if (!fashn.configured()) return res.status(503).json({ error: 'Integração de IA ainda não configurada no servidor. Nenhum crédito foi usado.' });
  const key = String(req.get('idempotency-key') || '');
  if (!/^[\w-]{16,80}$/.test(key)) return res.status(400).json({ error: 'Idempotency-Key ausente ou inválida.' });
  if (req.body.consent !== 'true') return res.status(400).json({ error: 'Confirme a autorização para usar a imagem e a semelhança da pessoa retratada.' });
  const style = ['estudio', 'editorial'].includes(req.body.style) ? req.body.style : null;
  if (!style) return res.status(400).json({ error: 'Escolha o estilo.' });
  const gf = req.files?.garment?.[0], mf = req.files?.model?.[0], gt = gf && sniff(gf.buffer), mt = mf && sniff(mf.buffer);
  if (!gt || !mt) return res.status(400).json({ error: 'Envie as duas imagens (JPG, PNG ou WebP).' });
  const uid = req.user.id, k = crypto.randomUUID(), gp = `${uid}/${k}-garment.${gt.ext}`, mp = `${uid}/${k}-model.${mt.ext}`;
  const [a, b] = await Promise.all([put(gp, gf.buffer, gt.mime), put(mp, mf.buffer, mt.mime)]);
  if (a.error || b.error) return res.status(502).json({ error: 'Falha ao armazenar as imagens.' });
  const { data: r, error } = await sb.rpc('reserve_generation', { p_user: uid, p_idem: key, p_style: style, p_garment: gp, p_model: mp });
  if (error) { await sb.storage.from(BUCKET).remove([gp, mp]); throw error; }
  if (r.dup || r.err) await sb.storage.from(BUCKET).remove([gp, mp]);
  if (r.dup) return res.json({ id: r.id, duplicate: true });
  if (r.err) return res.status(402).json({ error: r.err });
  res.status(202).json({ id: r.id, status: 'processing' });
  try {
    const pid = await fashn.run({ buf: gf.buffer, mime: gt.mime }, { buf: mf.buffer, mime: mt.mime });
    await sb.from('generations').update({ provider_id: pid }).eq('id', r.id);
  } catch (e) { console.error('try-on submit', e.message); await sb.rpc('fail_generation', { p_gen: r.id, p_error: e.message }); }
}));
app.get('/api/generations/:id/files', auth, wrap(async (req, res) => {
  const { data: g } = await sb.from('generations').select('status,garment_path,model_path,result_path').eq('id', +req.params.id).eq('user_id', req.user.id).maybeSingle();
  if (!g) return res.status(404).json({ error: 'Não encontrada.' });
  const sign = async p => (p ? (await sb.storage.from(BUCKET).createSignedUrl(p, 120)).data?.signedUrl || null : null); // URL temporária (2 min)
  res.json({ status: g.status, garment: await sign(g.garment_path), model: await sign(g.model_path), result: await sign(g.result_path) });
}));

// Acompanha gerações em andamento no provedor (a cada 5 s)
let polling = false;
setInterval(async () => {
  if (polling) return; polling = true;
  try {
    const { data: list } = await sb.from('generations').select('id,user_id,provider_id,created_at').eq('status', 'processing').limit(50);
    for (const g of list || []) {
      const age = Date.now() - new Date(g.created_at).getTime();
      if (!g.provider_id) { if (age > 120e3) await sb.rpc('fail_generation', { p_gen: g.id, p_error: 'Falha ao enviar ao provedor.' }); continue; }
      if (age > 600e3) { await sb.rpc('fail_generation', { p_gen: g.id, p_error: 'Tempo limite excedido.' }); continue; }
      try {
        const s = await fashn.status(g.provider_id);
        if (s.status === 'completed' && s.output?.[0]) {
          const url = String(s.output[0]); if (!url.startsWith('https://')) { await sb.rpc('fail_generation', { p_gen: g.id, p_error: 'URL de resultado inválida.' }); continue; }
          const r = await fetch(url); if (!r.ok) throw new Error('download ' + r.status);
          const buf = Buffer.from(await r.arrayBuffer()), t = sniff(buf);
          if (!t) { await sb.rpc('fail_generation', { p_gen: g.id, p_error: 'Resposta do provedor não é uma imagem válida.' }); continue; }
          const rp = `${g.user_id}/${g.id}-result.${t.ext}`, up = await sb.storage.from(BUCKET).upload(rp, buf, { contentType: t.mime, upsert: true });
          if (up.error) throw up.error;                         // tenta de novo no próximo ciclo; crédito só é cobrado após salvar
          await sb.rpc('complete_generation', { p_gen: g.id, p_result: rp });
        } else if (s.status === 'failed') await sb.rpc('fail_generation', { p_gen: g.id, p_error: 'O provedor não gerou a imagem: ' + JSON.stringify(s.error || '').slice(0, 300) });
      } catch (e) { console.error('poll', g.id, e.message); }
    }
  } catch (e) { console.error('poll geral', e.message); } finally { polling = false; }
}, 5000);

app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('VESTRA AI backend na porta', PORT, '| site:', SITE || 'AUSENTE'));
