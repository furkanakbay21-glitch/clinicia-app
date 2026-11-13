// routes/gateway.js — API-First Gateway: adaptör sağlık uçları + webhook'lar
const express = require('express');
const fs = require('fs');
const path = require('path');

const adapters = {};
const dir = path.join(__dirname, '..', 'services', 'adapters');
for (const f of fs.readdirSync(dir)) {
  if (f.endsWith('Adapter.js')) adapters[f.replace('.js', '')] = require(path.join(dir, f));
}

module.exports = (ctx = {}) => {
  const { io, all, get, run, audit } = ctx;
  const r = express.Router();

  // sağlık & envanter
  r.get('/health', (req, res) => res.json({ ok: true, adapters: Object.fromEntries(Object.entries(adapters).map(([k, a]) => [k, a.health()])) }));
  r.get('/adapters', (req, res) => res.json(Object.keys(adapters)));

  // genel webhook dispatcher — dış servisler buraya POST eder
  r.post('/webhooks/:adapter', async (req, res) => {
    const a = adapters[req.params.adapter];
    if (!a) return res.status(404).json({ error: 'unknown adapter' });
    try {
      if (a.webhook) return res.json(await a.webhook(req.body, ctx));
      if (a.handleWebhook) return res.json(await a.handleWebhook(req.body, ctx));
      res.json({ ok: true, adapter: a.id, accepted: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- Kolaylık uçları (mock/canlı aynı yüz) ---
  r.post('/video/room', async (req, res) => {
    const p = get('SELECT * FROM patients WHERE id=?', req.body.patient_id);
    if (!p) return res.status(404).end();
    res.json(await adapters.videoAdapter.createRoom(p, req.body));
  });
  r.post('/ocr/mrz', async (req, res) => res.json(await adapters.ocrAdapter.readDocument(req.body.path || '', req.body.hint)));
  r.get('/flight/:no', async (req, res) => res.json(await adapters.flightAdapter.track(req.params.no, req.query.date)));
  r.get('/fx', async (req, res) => res.json(await adapters.fxAdapter.rates()));
  r.post('/fx/lock', async (req, res) => res.json(await adapters.fxAdapter.lock(req.body.pair || 'TRY', req.body.amount || 0)));
  r.post('/payment/deposit', async (req, res) => {
    const p = get('SELECT * FROM patients WHERE id=?', req.body.patient_id);
    if (!p) return res.status(404).end();
    res.json(await adapters.paymentAdapter.createDeposit(p, req.body.amount_minor || 100000, req.body.currency || 'eur'));
  });
  r.post('/signature/send', async (req, res) => {
    const p = get('SELECT * FROM patients WHERE id=?', req.body.patient_id);
    if (!p) return res.status(404).end();
    res.json(await adapters.signatureAdapter.sendForSignature(p, req.body.doc_type || 'kvkk_onam'));
  });
  r.get('/pacs/viewer/:fileId', async (req, res) => {
    const f = get('SELECT * FROM files WHERE id=?', req.params.fileId);
    if (!f) return res.status(404).end();
    res.json(await adapters.pacsAdapter.viewerUrl(f));
  });
  r.get('/geo/vehicle/:taskId', async (req, res) => res.json(await adapters.geoAdapter.vehiclePosition({ id: +req.params.taskId })));
  r.post('/geo/route', async (req, res) => res.json(await adapters.geoAdapter.routeMatrix(req.body.from || {}, req.body.to || {})));
  r.post('/mail/offer', async (req, res) => {
    const p = get('SELECT * FROM patients WHERE id=?', req.body.patient_id);
    const o = get('SELECT * FROM offers WHERE id=?', req.body.offer_id);
    if (!p || !o) return res.status(404).end();
    res.json(await adapters.mailAdapter.sendOfferMail(p, o));
  });
  r.post('/insurance/quote', async (req, res) => {
    const p = get('SELECT * FROM patients WHERE id=?', req.body.patient_id);
    if (!p) return res.status(404).end();
    res.json(await adapters.insuranceAdapter.quotePolicy(p, req.body.product));
  });
  r.get('/visa/check/:nat', async (req, res) => res.json(await adapters.visaAdapter.checkRule(req.params.nat)));
  r.post('/visa/invite', async (req, res) => {
    const p = get('SELECT * FROM patients WHERE id=?', req.body.patient_id);
    if (!p) return res.status(404).end();
    res.json(await adapters.visaAdapter.createInvitation(p));
  });
  r.post('/invoice/351', async (req, res) => {
    const inv = get('SELECT * FROM invoices WHERE id=?', req.body.invoice_id);
    const p = inv && get('SELECT * FROM patients WHERE id=?', inv.patient_id);
    if (!inv) return res.status(404).end();
    res.json(await adapters.invoiceAdapter.issue351(inv, p));
  });
  r.get('/analytics/profit-by-country', (req, res) => adapters.analyticsAdapter.profitByCountry(ctx).then(d => res.json(d)).catch(e => res.status(500).json({ error: e.message })));
  r.get('/marketing/cpa', async (req, res) => res.json(await adapters.marketingAdapter.cpaReport()));
  r.get('/hbys/calendar/:doctorId', async (req, res) => res.json(await adapters.hbysAdapter.syncDoctorCalendar({ id: +req.params.doctorId })));
  r.post('/geofence/watch', async (req, res) => res.json(await adapters.geofenceAdapter.registerArrivalWatch({ id: req.body.task_id }, req.body.airport || 'IST')));

  // sosyal DM yakalama → yeni lead/konuşma yaratır
  r.post('/dm/inbound', async (req, res) => {
    const dm = adapters.socialDmAdapter.captureDm(req.body);
    if (!dm.body) return res.json({ ok: false, reason: 'empty' });
    let p = get('SELECT * FROM patients WHERE name=?', dm.name);
    if (!p) {
      run('INSERT INTO patients (name,nationality,complaint,lead_status) VALUES (?,?,?,?)',
        dm.name, 'DM', dm.body.slice(0, 200), 'lead');
      p = get('SELECT * FROM patients ORDER BY id DESC LIMIT 1');
      run('INSERT INTO conversations (patient_id,channel,subject) VALUES (?,?,?)', p.id, 'instagram', 'DM yakalama');
    }
    const conv = get('SELECT * FROM conversations WHERE patient_id=? ORDER BY id DESC LIMIT 1', p.id);
    run('INSERT INTO messages (conversation_id,direction,body,lang) VALUES (?,?,?,?)', conv.id, 'in', dm.body, 'en');
    run("UPDATE conversations SET last_message_at=datetime('now') WHERE id=?", conv.id);
    io && io.emit('message', { conversation_id: conv.id, message: { direction: 'in', body: dm.body } });
    audit && audit(req, 'dm:capture', `Instagram DM → ${dm.name}`, p.id);
    res.json({ ok: true, patient_id: p.id, conversation_id: conv.id, dm });
  });

  // WhatsApp inbound (Twilio/Infobip formatı)
  r.post('/chat/inbound', async (req, res) => {
    const inc = adapters.chatAdapter.parseInbound(req.body);
    if (!inc.body) return res.json({ ok: false });
    const conv = get('SELECT * FROM conversations ORDER BY id DESC LIMIT 1');
    if (conv) {
      run('INSERT INTO messages (conversation_id,direction,body,lang) VALUES (?,?,?,?)', conv.id, 'in', inc.body, 'en');
      io && io.emit('message', { conversation_id: conv.id, message: { direction: 'in', body: inc.body } });
    }
    res.json({ ok: true, from: inc.from });
  });

  r.adapters = adapters;
  return r;
};
