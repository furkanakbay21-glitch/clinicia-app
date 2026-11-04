// Health Tourism Agency ERP & CRM — Phase 1 backend
// Express + Socket.io + SQLite (node:sqlite). Single-panel agency console.
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const archiver = require('archiver');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const PORT = process.env.PORT || 8080;
const AGENCY_CITY = 'Istanbul';
const SLA_MS = 15 * 60 * 1000; // 15-minute response SLA

// ---------- encryption for medical opinions ----------
const KEY_PATH = path.join(__dirname, 'data', 'opinion.key');
if (!fs.existsSync(KEY_PATH)) fs.writeFileSync(KEY_PATH, crypto.randomBytes(32).toString('hex'));
const OPINION_KEY = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'hex');

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', OPINION_KEY, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob) {
  const b = Buffer.from(blob, 'base64');
  const iv = b.subarray(0, 12), tag = b.subarray(12, 28), data = b.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', OPINION_KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
function esign(doctorName, text) {
  return 'ESIGN-' + crypto.createHash('sha256').update(doctorName + '|' + text + '|' + Date.now()).digest('hex').slice(0, 24).toUpperCase();
}

// ---------- translation (MyMemory free API + offline fallback) ----------
const FALLBACK_TR = {
  'I have severe chest pain and need a cardiology consultation and possible angioplasty.':
    'Şiddetli göğüs ağrım var; kardiyoloji konsültasyonu ve olası anjiyoplasti gerekiyor.',
  'I would like a hair transplant procedure, about 4000 grafts.': 'Yaklaşık 4000 greft saç ekimi işlemi istiyorum.',
  'My knee cartilage is damaged; I need orthopedic surgery.': 'Diz kıkırdağım hasarlı; ortopedik cerrahi gerekiyor.',
  'I need IVF treatment, second attempt.': 'Tüp bebek tedavisi gerekiyor, ikinci deneme.',
  'I want rhinoplasty and chin augmentation.': 'Rinoplasti ve çene büyütme istiyorum.',
  'Hello, I have tooth pain and want dental implants.': 'Merhaba, diş ağrım var ve diş implantı istiyorum.',
  'I am interested in gastric sleeve surgery for weight loss.': 'Kilo vermek için tüp mide ameliyatı ile ilgileniyorum.',
  'I want LASIK eye surgery, both eyes.': 'Her iki göze LASIK ameliyatı istiyorum.',
  'I would like a quote for a full health check-up package.': 'Tam kapsamlı check-up paketi için fiyat teklifi istiyorum.',
};
async function translateToTR(text, srcLang = 'auto') {
  if (!text) return null;
  try {
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text.slice(0, 500)) +
      '&langpair=' + (srcLang === 'auto' ? 'Autodetect' : srcLang) + '|tr';
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 6000);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    const j = await res.json();
    const out = j?.responseData?.translatedText;
    if (out && !/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) return out;
  } catch (_) { /* offline / rate limit -> fallback */ }
  return FALLBACK_TR[text] || ('[Çeviri] ' + text);
}

// ---------- AI doctor matching ----------
const SPECIALTY_MAP = [
  { keys: ['chest', 'heart', 'cardiac', 'angioplast', 'kalp', 'göğüs', 'cardio', 'بصدر', 'قلب'], specialty: 'Cardiology' },
  { keys: ['hair', 'transplant', 'graft', 'saç', 'ekim', 'شعر'], specialty: 'Hair Transplant' },
  { keys: ['knee', 'orthopedic', 'cartilage', 'hip', 'diz', 'ortopedi', 'knie', 'ركبة'], specialty: 'Orthopedics' },
  { keys: ['rhinoplasty', 'nose', 'chin', 'plastic', 'aesthetic', 'burun', 'estetik', 'تجميل'], specialty: 'Plastic Surgery' },
  { keys: ['eye', 'lasik', 'vision', 'cataract', 'göz', 'lazer', 'auge', 'عين'], specialty: 'Ophthalmology' },
  { keys: ['tooth', 'teeth', 'dental', 'implant', 'diş', 'zahn', 'أسنان'], specialty: 'Dentistry' },
  { keys: ['gastric', 'sleeve', 'bariatric', 'weight', 'obez', 'mide', 'تكميم'], specialty: 'Bariatric Surgery' },
  { keys: ['ivf', 'fertility', 'tüp bebek', 'embryo', 'أطفال الأنابيب'], specialty: 'IVF & Fertility' },
  { keys: ['check-up', 'checkup', 'screening'], specialty: 'General Surgery' },
];
function detectSpecialties(text) {
  const t = (text || '').toLowerCase();
  const tokens = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // Katı eşleşme: kelime başlangıcıyla eşleşen anahtarlar ("hip" → "worship" yanlış pozitifini engeller)
  // Çok kelimeli anahtarlar ('tüp bebek', 'check-up') doğrudan substring aranır
  const hit = k => /[\s-]/.test(k) ? t.includes(k) : tokens.some(tok => tok === k || tok.startsWith(k));
  return SPECIALTY_MAP.filter(s => s.keys.some(hit)).map(s => s.specialty);
}
function patientSpecialties(p) {
  const specs = detectSpecialties((p.complaint || '') + ' ' + (p.complaint_tr || ''));
  const anamSpecs = db.prepare("SELECT DISTINCT specialty FROM anamnesis WHERE patient_id=? AND specialty IS NOT NULL AND specialty<>''")
    .all(p.id).map(r => r.specialty);
  for (const s of anamSpecs) if (!specs.includes(s)) specs.push(s);
  return specs;
}
function aiMatchDoctors(complaint, patientId) {
  const specs = patientId
    ? patientSpecialties(db.prepare('SELECT * FROM patients WHERE id=?').get(patientId) || { id: patientId, complaint })
    : detectSpecialties(complaint);
  // STRICT BRANCH FILTER: branş tespit edilemediyse hiç hekim önerilmez — alakasız branş asla listelenmez
  if (!specs.length) return { specialties: [], doctors: [] };
  const docs = db.prepare('SELECT * FROM doctors WHERE city = ? ORDER BY rating DESC').all(AGENCY_CITY);
  // Kural: sadece eşleşen uzmanlık branşı — yan branşlar kesinlikle elenir
  const ranked = docs
    .filter(d => specs.includes(d.specialty))
    .map(d => ({ ...d, score: 100 + d.rating * 2 + d.years_exp * 0.3 }))
    .sort((a, b) => b.score - a.score);
  return { specialties: specs, doctors: ranked.slice(0, 5) };
}

// ---------- helpers ----------
const all = (q, ...p) => db.prepare(q).all(...p);
const get = (q, ...p) => db.prepare(q).get(...p);
const run = (q, ...p) => db.prepare(q).run(...p);
const uid = (p) => p + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

// =====================================================================
// REST API
// =====================================================================

// --- Dashboard KPIs ---
// --- RBAC: rol-modül yetki kontrolü ---
const ROLE_MODULES = {
  crm:        ['/api/patients'],
  comms:      ['/api/conversations', '/api/messages', '/api/anamnesis'],
  rfq:        ['/api/rfqs', '/api/doctors', '/api/treatments', '/api/packages/build'],
  ops:        ['/api/bookings', '/api/flight', '/api/field-tasks', '/api/kiosk', '/api/driver', '/api/translators', '/api/claims', '/api/simulate'],
  finance:    ['/api/transactions', '/api/invoices', '/api/fx', '/api/profit', '/api/rep-performance', '/api/escrow'],
  analytics:  ['/api/marketing', '/api/campaigns', '/api/mkt'],
  compliance: ['/api/usha', '/api/checklist', '/api/zip', '/api/ivd'],
  postop:     ['/api/postop', '/api/bpo'],
  admin:      ['/api/role-permissions'],
};
function can(role, module) {
  if (role === 'admin') return true;
  const row = get('SELECT allowed FROM role_permissions WHERE role=? AND module=?', role, module);
  return row ? !!row.allowed : false;
}
app.use('/api', (req, res, next) => {
  const role = req.get('x-user-role') || 'admin';
  const path = '/api' + req.path;
  for (const [mod, prefixes] of Object.entries(ROLE_MODULES)) {
    if (prefixes.some(p => path.startsWith(p))) {
      if (!can(role, mod)) return res.status(403).json({ error: 'Bu modüle erişim yetkiniz yok', module: mod, role });
      return next();
    }
  }
  next();
});
app.get('/api/role-permissions', (req, res) => {
  res.json({ roles: all('SELECT DISTINCT role FROM role_permissions ORDER BY role'),
    permissions: all('SELECT * FROM role_permissions ORDER BY role,module') });
});
app.post('/api/role-permissions', (req, res) => {
  const { role, module, allowed } = req.body || {};
  run('INSERT INTO role_permissions (role,module,allowed) VALUES (?,?,?) ON CONFLICT(role,module) DO UPDATE SET allowed=excluded.allowed',
    role, module, allowed ? 1 : 0);
  res.json({ ok: true });
});

app.get('/api/kpis', (req, res) => {
  res.json({
    patients: get('SELECT COUNT(*) c FROM patients').c,
    openLeads: get("SELECT COUNT(*) c FROM patients WHERE lead_status != 'completed'").c,
    slaBreaching: get("SELECT COUNT(*) c FROM conversations WHERE sla_responded=0 AND sla_deadline IS NOT NULL AND sla_deadline < ?", Date.now()).c,
    pendingRfqs: get("SELECT COUNT(*) c FROM rfqs WHERE status='pending'").c,
    revenue: get("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE kind='income'").s,
    expense: get("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE kind='expense'").s,
    pendingUsha: get("SELECT COUNT(*) c FROM usha_notifications WHERE status='pending'").c,
  });
});

// --- Patients / CRM ---
app.get('/api/patients', (req, res) => {
  res.json(all(`SELECT p.*,
    (SELECT COALESCE(SUM(CASE WHEN t.kind='income' THEN t.amount ELSE -t.amount END),0)
       FROM transactions t WHERE t.patient_id=p.id) balance
    FROM patients p ORDER BY p.created_at DESC`));
});
app.post('/api/patients', (req, res) => {
  const { name, nationality, language, passport_no, phone, email, complaint } = req.body;
  const r = run(`INSERT INTO patients (name,nationality,language,passport_no,phone,email,complaint) VALUES (?,?,?,?,?,?,?)`,
    name, nationality, language || 'en', passport_no || null, phone || null, email || null, complaint || '');
  res.json(get('SELECT * FROM patients WHERE id=?', r.lastInsertRowid));
});
app.patch('/api/patients/:id', (req, res) => {
  const f = req.body;
  const cur = get('SELECT * FROM patients WHERE id=?', req.params.id);
  if (!cur) return res.status(404).end();
  run(`UPDATE patients SET name=?,nationality=?,language=?,passport_no=?,phone=?,email=?,complaint=?,lead_status=?,subagent_id=?,postop_since=? WHERE id=?`,
    f.name ?? cur.name, f.nationality ?? cur.nationality, f.language ?? cur.language,
    f.passport_no ?? cur.passport_no, f.phone ?? cur.phone, f.email ?? cur.email,
    f.complaint ?? cur.complaint, f.lead_status ?? cur.lead_status,
    f.subagent_id !== undefined ? f.subagent_id : cur.subagent_id,
    f.postop_since !== undefined ? f.postop_since : cur.postop_since, req.params.id);
  const p = get(`SELECT p.*, sa.name sales_agent_name, oa.name ops_agent_name FROM patients p LEFT JOIN agents sa ON sa.id=p.sales_agent_id LEFT JOIN agents oa ON oa.id=p.ops_agent_id WHERE p.id=?`, req.params.id);
  io.emit('patient_update', p);
  res.json(p);
});
app.get('/api/patients/:id/dossier', (req, res) => {
  const pid = req.params.id;
  res.json({
    patient: get(`SELECT p.*, sa.name sales_agent_name, oa.name ops_agent_name FROM patients p LEFT JOIN agents sa ON sa.id=p.sales_agent_id LEFT JOIN agents oa ON oa.id=p.ops_agent_id WHERE p.id=?`, pid),
    conversations: all('SELECT * FROM conversations WHERE patient_id=? ORDER BY id DESC', pid),
    rfqs: all(`SELECT r.*, d.name doctor_name, d.specialty, d.hospital FROM rfqs r JOIN doctors d ON d.id=r.doctor_id WHERE r.patient_id=?`, pid),
    bookings: all('SELECT * FROM bookings WHERE patient_id=?', pid),
    transactions: all('SELECT t.*, a.name account_name FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id WHERE t.patient_id=?', pid),
    invoices: all('SELECT * FROM invoices WHERE patient_id=?', pid),
    usha: all('SELECT * FROM usha_notifications WHERE patient_id=?', pid),
    incentive: all('SELECT * FROM incentive_packages WHERE patient_id=?', pid),
    files: all('SELECT * FROM files WHERE patient_id=?', pid),
    offers: all('SELECT * FROM offers WHERE patient_id=? ORDER BY id DESC', pid),
    driver_tasks: all(`SELECT t.*, a.name agent_name, b.ref_label FROM driver_tasks t
      LEFT JOIN agents a ON a.id=t.agent_id LEFT JOIN bookings b ON b.id=t.booking_id
      WHERE t.patient_id=? ORDER BY t.seq`, pid),
    checklist: patientChecklist(pid),
    anamnesis: all('SELECT * FROM anamnesis WHERE patient_id=? ORDER BY id DESC', pid),
    visa_rule: (() => { const p = get('SELECT nationality FROM patients WHERE id=?', pid);
      return p ? get('SELECT * FROM visa_rules WHERE country=?', p.nationality) : null; })(),
  });
});

// --- File archive ---
const upload = multer({ dest: path.join(__dirname, 'uploads') });
app.post('/api/patients/:id/files', upload.single('file'), (req, res) => {
  const cat = req.body.category || 'other';
  const fname = req.file ? (req.file.originalname || req.file.filename) : (req.body.filename || 'document.txt');
  const p = req.file ? '/uploads/' + req.file.filename : null;
  const r = run('INSERT INTO files (patient_id,filename,category,path) VALUES (?,?,?,?)', req.params.id, fname, cat, p);
  res.json(get('SELECT * FROM files WHERE id=?', r.lastInsertRowid));
});

// --- Omnichannel inbox ---
app.get('/api/files', (req, res) => {
  res.json(all(`SELECT f.*, p.name patient_name FROM files f JOIN patients p ON p.id=f.patient_id ORDER BY f.id DESC LIMIT 30`));
});
app.get('/api/conversations', (req, res) => {
  res.json(all(`SELECT c.*, p.name patient_name, p.nationality, p.language, ag.name agent_name,
    (SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) last_body
    FROM conversations c JOIN patients p ON p.id=c.patient_id
    LEFT JOIN agents ag ON ag.id=c.assigned_agent_id
    ORDER BY c.last_message_at DESC`));
});
app.get('/api/conversations/:id/messages', (req, res) => {
  res.json(all('SELECT * FROM messages WHERE conversation_id=? ORDER BY id', req.params.id));
});
app.post('/api/conversations/:id/reply', async (req, res) => {
  const conv = get('SELECT * FROM conversations WHERE id=?', req.params.id);
  if (!conv) return res.status(404).end();
  const r = run('INSERT INTO messages (conversation_id,direction,body,lang) VALUES (?,?,?,?)',
    conv.id, 'out', req.body.body, 'tr');
  run(`UPDATE conversations SET sla_responded=1, sla_deadline=NULL, last_message_at=datetime('now') WHERE id=?`, conv.id);
  const msg = get('SELECT * FROM messages WHERE id=?', r.lastInsertRowid);
  io.emit('message', { conversation_id: conv.id, message: msg });
  io.emit('sla', { conversation_id: conv.id, sla_responded: 1 });
  res.json(msg);
});

// Simulate a new inbound message on an existing conversation (patient replies)
app.post('/api/conversations/:id/inbound', async (req, res) => {
  const conv = get('SELECT c.*, p.language FROM conversations c JOIN patients p ON p.id=c.patient_id WHERE c.id=?', req.params.id);
  if (!conv) return res.status(404).end();
  const replies = {
    en: 'Thank you! Could you also tell me about the hotel options?', tr: 'Teşekkürler! Otel seçeneklerini de paylaşır mısınız?',
    ar: 'شكراً! هل يمكنك إخباري عن خيارات الفندق أيضاً؟', de: 'Danke! Können Sie mir auch die Hoteloptionen nennen?',
    fr: 'Merci ! Pouvez-vous aussi me parler des options d\u2019hôtel ?', ru: 'Спасибо! Расскажите также о вариантах отеля?',
    fa: 'ممنون! درباره گزینه‌های هتل هم بگویید؟', es: '¡Gracias! ¿Puede contarme también las opciones de hotel?' };
  const body = replies[conv.language] || replies.en;
  const tr = conv.language === 'tr' ? null : (await translateToTR(body, conv.language) || 'Teşekkürler! Otel seçeneklerini de paylaşır mısınız?');
  const r = run('INSERT INTO messages (conversation_id,direction,body,body_translated,lang) VALUES (?,?,?,?,?)',
    conv.id, 'in', body, tr, conv.language);
  run(`UPDATE conversations SET sla_responded=0, sla_deadline=? , last_message_at=datetime('now') WHERE id=?`,
    Date.now() + 900000, conv.id);
  const msg = get('SELECT * FROM messages WHERE id=?', r.lastInsertRowid);
  io.emit('message', { conversation_id: conv.id, message: msg });
  io.emit('sla', { conversation_id: conv.id });
  res.json(msg);
});

// Inbound channel simulator (WhatsApp / Web form / Mail webhooks)
const INBOUND_SAMPLES = [
  { name: 'Ahmed Al-Sayed', nat: 'Kuwait', lang: 'ar', ch: 'whatsapp',
    body: 'I am interested in gastric sleeve surgery for weight loss.', pass: 'KW-33421' },
  { name: 'Marie Dupont', nat: 'France', lang: 'fr', ch: 'web',
    body: 'I want LASIK eye surgery, both eyes.', pass: 'FR-99281' },
  { name: 'Ali Rezaei', nat: 'Iran', lang: 'fa', ch: 'email',
    body: 'Hello, I have tooth pain and want dental implants.', pass: 'IR-55823' },
  { name: 'Nadia Karim', nat: 'Qatar', lang: 'ar', ch: 'whatsapp',
    body: 'I need IVF treatment, second attempt.', pass: 'QA-11890' },
  { name: 'John Smith', nat: 'USA', lang: 'en', ch: 'web',
    body: 'I would like a quote for a full health check-up package.', pass: 'US-77456' },
  { name: 'Lena Fischer', nat: 'Germany', lang: 'de', ch: 'instagram',
    body: 'Guten Tag, ich interessiere mich für eine Nasenoperation.', pass: 'DE-99XA2' },
  { name: 'Omar Khalil', nat: 'Iraq', lang: 'ar', ch: 'whatsapp',
    body: 'مرحبا، أحتاج إلى زراعة شعر في إسطنبول.', pass: 'IQ-44781' },
];
// ---------- language detection + round-robin assignment ----------
function detectLang(text) {
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';
  if (/[\u0400-\u04FF]/.test(text)) return 'ru';
  if (/\b(guten|ich|und|ist|danke|bitte|mein)\b/i.test(text)) return 'de';
  if (/\b(bonjour|je|suis|merci|voudrais)\b/i.test(text)) return 'fr';
  return 'en';
}
const rrCounters = {};
function assignRep(lang) {
  const reps = all(`SELECT * FROM agents WHERE role='rep' AND active=1 AND (','||languages||',') LIKE '%,'||?||',%'`, lang);
  const pool = reps.length ? reps : all(`SELECT * FROM agents WHERE role='rep' AND active=1 AND (','||languages||',') LIKE '%,en,%'`);
  if (!pool.length) return null;
  const key = reps.length ? lang : 'en';
  rrCounters[key] = (rrCounters[key] || 0) + 1;
  return pool[(rrCounters[key] - 1) % pool.length];
}
let opsCounter = 0;
function assignOps() {
  const pool = all("SELECT * FROM agents WHERE role='ops' AND active=1 ORDER BY id");
  if (!pool.length) return null;
  opsCounter++;
  return pool[(opsCounter - 1) % pool.length];
}
function maskPhone() { return '+90 850 4' + String(Math.floor(100 + Math.random() * 900)) + ' XX XX'; }

const CRISIS_RE = /(ağrı|agri|pain|enfeksiyon|infection|şikayet|sikayet|complaint|iptal|cancel|kanama|bleeding|fever|ateş|ates)/i;
function maybeCrisis(patientId, body) {
  if (!CRISIS_RE.test(body || '')) return;
  const p = get('SELECT * FROM patients WHERE id=?', patientId);
  const oc = get("SELECT * FROM agents WHERE role='oncall' AND active=1 LIMIT 1");
  notify(`KRİZ ALARMI — ${p ? p.name : '?'}: riskli ifade tespit edildi (${body.slice(0,60)})`, 'crisis');
  if (oc) notify(`Nöbetçi medikal danışman ${oc.name} bilgilendirildi`, 'crisis');
  run('INSERT INTO claims (patient_id,amount,reason,status) VALUES (?,?,?,?)',
    patientId, 0, 'Otomatik kriz taslağı — ' + body.slice(0, 120), 'draft');
  io.emit('crisis', { patient_id: patientId });
}

app.post('/api/simulate/inbound', async (req, res) => {
  const b = req.body || {};
  const s = b.sample ? b : INBOUND_SAMPLES[Math.floor(Math.random() * INBOUND_SAMPLES.length)];
  const lang = detectLang(s.body) !== 'en' ? detectLang(s.body) : s.lang;
  const tr = await translateToTR(s.body, 'auto');
  const pr = run(`INSERT INTO patients (name,nationality,language,passport_no,complaint,complaint_tr,lead_status)
    VALUES (?,?,?,?,?,?, 'new')`, s.name, s.nat, lang, s.pass, s.body, tr);
  const rep = assignRep(lang);
  const cr = run(`INSERT INTO conversations (patient_id,channel,subject,sla_deadline,sla_responded,last_message_at,assigned_agent_id,masked_phone)
    VALUES (?,?,?,?,0,datetime('now'),?,?)`, pr.lastInsertRowid, s.ch, 'Yeni hasta talebi', Date.now() + SLA_MS, rep ? rep.id : null, maskPhone());
  if (rep) { try { run('UPDATE patients SET sales_agent_id=? WHERE id=?', rep.id, pr.lastInsertRowid); } catch {} }
  const h = new Date().getHours();
  if (h < 9 || h >= 19) {
    const oc = get("SELECT * FROM agents WHERE role='oncall' AND active=1 ORDER BY id LIMIT 1");
    if (oc) run('UPDATE conversations SET assigned_agent_id=? WHERE id=?', oc.id, cr.lastInsertRowid);
  }
  const mr = run('INSERT INTO messages (conversation_id,direction,body,body_translated,lang) VALUES (?,?,?,?,?)',
    cr.lastInsertRowid, 'in', s.body, tr, lang);
  maybeCrisis(pr.lastInsertRowid, s.body);
  const payload = {
    patient: get('SELECT * FROM patients WHERE id=?', pr.lastInsertRowid),
    conversation: get('SELECT * FROM conversations WHERE id=?', cr.lastInsertRowid),
    message: get('SELECT * FROM messages WHERE id=?', mr.lastInsertRowid),
    sla_deadline: Date.now() + SLA_MS,
  };
  io.emit('inbound', payload);
  res.json(payload);
});

// --- Doctors & RFQ ---
app.get('/api/doctors', (req, res) => {
  const { specialty, title, city, hospital, org_type } = req.query;
  let q = 'SELECT * FROM doctors WHERE 1=1'; const p = [];
  if (specialty) { q += ' AND specialty LIKE ?'; p.push('%' + specialty + '%'); }
  if (title) { q += ' AND title=?'; p.push(title); }
  if (city) { q += ' AND city LIKE ?'; p.push('%' + city + '%'); }
  if (hospital) { q += ' AND hospital LIKE ?'; p.push('%' + hospital + '%'); }
  if (org_type) { q += ' AND org_type=?'; p.push(org_type); }
  q += ' ORDER BY rating DESC';
  res.json(all(q, ...p));
});
app.get('/api/ai/match', (req, res) => {
  const p = get('SELECT * FROM patients WHERE id=?', req.query.patient_id);
  if (!p) return res.status(404).end();
  res.json(aiMatchDoctors(null, p.id));
});
const OPINION_FEE_CREDITS = 150; // per-doctor opinion fee, paid from agency wallet regardless of deal
try { db.exec('ALTER TABLE rfqs ADD COLUMN attachments TEXT'); } catch(e) {}
app.post('/api/rfq', (req, res) => {
  const { patient_id, doctor_ids } = req.body;
  const p = get('SELECT * FROM patients WHERE id=?', patient_id);
  if (!p) return res.status(404).json({ error: 'patient not found' });
  const w = get('SELECT credits FROM wallet WHERE id=1');
  if (w.credits < OPINION_FEE_CREDITS * doctor_ids.length)
    return res.status(402).json({ error: 'Yetersiz sistem kredisi', credits: w.credits });
  const created = [];
  const attFiles = all('SELECT filename,category FROM files WHERE patient_id=?', patient_id);
  const attachments = JSON.stringify({
    complaint: p.complaint, passport: p.passport_no, nationality: p.nationality,
    files: attFiles.map(f => f.filename) });
  for (const did of doctor_ids) {
    const r = run('INSERT INTO rfqs (patient_id,doctor_id,complaint,attachments) VALUES (?,?,?,?)', patient_id, did, p.complaint, attachments);
    const rfq = get('SELECT * FROM rfqs WHERE id=?', r.lastInsertRowid);
    const pwd = String(crypto.randomInt(100000, 999999));
    run('INSERT INTO rfq_access (rfq_id,view_password,credit_charged) VALUES (?,?,?)', rfq.id, pwd, OPINION_FEE_CREDITS);
    run('UPDATE wallet SET credits=credits-? WHERE id=1', OPINION_FEE_CREDITS);
    run('INSERT INTO wallet_txns (rfq_id,amount,description) VALUES (?,?,?)', rfq.id, -OPINION_FEE_CREDITS,
      'Görüş ücreti — doktor #' + did);
    created.push({ ...rfq, view_password: pwd, credit_charged: OPINION_FEE_CREDITS });
    simulateDoctorResponse(rfq);
  }
  io.emit('wallet', get('SELECT credits FROM wallet WHERE id=1'));
  res.json(created);
});
// Doctor portal simulation: identity verification (KVK/GDPR) before seeing the data password
app.post('/api/rfq/:id/verify-identity', (req, res) => {
  const { password, id_number } = req.body || {};
  const acc = get('SELECT * FROM rfq_access WHERE rfq_id=?', req.params.id);
  if (!acc) return res.status(404).json({ error: 'RFQ bulunamadı' });
  if (acc.view_password !== password) return res.status(403).json({ error: 'Geçersiz görüntüleme şifresi' });
  if (!id_number || String(id_number).length < 5) return res.status(400).json({ error: 'KVK/GDPR kimlik doğrulaması gerekli' });
  run("UPDATE rfq_access SET doctor_verified=1, verified_at=datetime('now') WHERE rfq_id=?", req.params.id);
  res.json({ ok: true });
});
app.get('/api/rfq/:id/secure-view', (req, res) => {
  const acc = get('SELECT * FROM rfq_access WHERE rfq_id=?', req.params.id);
  if (!acc || acc.view_password !== req.query.password) return res.status(403).json({ error: 'Yetkisiz' });
  if (!acc.doctor_verified) return res.status(403).json({ error: 'Önce KVK/GDPR kimlik doğrulaması gerekli' });
  const r = get(`SELECT r.*, p.name patient_name, p.nationality, p.complaint, p.complaint_tr FROM rfqs r
    JOIN patients p ON p.id=r.patient_id WHERE r.id=?`, req.params.id);
  const anam = get("SELECT answers,submitted_at FROM anamnesis WHERE patient_id=? AND status='submitted' ORDER BY id DESC LIMIT 1", r.patient_id);
  const medFiles = all("SELECT filename,category,uploaded_at FROM files WHERE patient_id=? AND category IN ('anamnesis','radiology','report') ORDER BY id DESC", r.patient_id);
  res.json({ rfq_id: r.id, patient_initials: r.patient_name.split(' ').map(w => w[0]).join('.') + '.',
    nationality: r.nationality, complaint: r.complaint, complaint_tr: r.complaint_tr,
    anamnesis: anam ? { answers: JSON.parse(anam.answers), submitted_at: anam.submitted_at } : null,
    medical_files: medFiles });
});
// Manual doctor response (doctor portal)
app.post('/api/rfq/:id/respond', (req, res) => {
  const { opinion, price } = req.body || {};
  const acc = get('SELECT * FROM rfq_access WHERE rfq_id=?', req.params.id);
  if (!acc || !acc.doctor_verified) return res.status(403).json({ error: 'Kimlik doğrulanmadı' });
  const r = get('SELECT r.*, d.name dname FROM rfqs r JOIN doctors d ON d.id=r.doctor_id WHERE r.id=?', req.params.id);
  if (!r || r.status !== 'pending') return res.status(400).json({ error: 'RFQ kapalı' });
  const sig = esign(r.dname, opinion);
  run('INSERT INTO medical_opinions (rfq_id,opinion_enc,signature,signed_at) VALUES (?,?,?,datetime(\'now\'))', r.id, encrypt(opinion), sig);
  run('INSERT INTO doctor_quotes (rfq_id,price,currency,notes) VALUES (?,?,?,?)', r.id, price, 'EUR', 'Hekim manuel teklif');
  run("UPDATE rfqs SET status='responded', responded_at=datetime('now') WHERE id=?", r.id);
  io.emit('rfq_update', { rfq_id: r.id });
  res.json({ ok: true });
});
app.get('/api/wallet', (req, res) => {
  res.json({ credits: get('SELECT credits FROM wallet WHERE id=1').credits,
    txns: all('SELECT * FROM wallet_txns ORDER BY id DESC LIMIT 30') });
});
app.post('/api/wallet/topup', (req, res) => {
  const amt = +(req.body.amount || 10000);
  run('UPDATE wallet SET credits=credits+? WHERE id=1', amt);
  run('INSERT INTO wallet_txns (rfq_id,amount,description) VALUES (NULL,?,?)', amt, 'Kredi yükleme');
  res.json(get('SELECT credits FROM wallet WHERE id=1'));
});
app.get('/api/rfq', (req, res) => {
  res.json(all(`SELECT r.*, p.name patient_name, d.name doctor_name, d.specialty, d.hospital,
    (SELECT id FROM medical_opinions o WHERE o.rfq_id=r.id) opinion_id,
    (SELECT price FROM doctor_quotes q WHERE q.rfq_id=r.id) quote_price,
    (SELECT currency FROM doctor_quotes q WHERE q.rfq_id=r.id) quote_currency,
    (SELECT view_password FROM rfq_access a WHERE a.rfq_id=r.id) view_password,
    (SELECT doctor_verified FROM rfq_access a WHERE a.rfq_id=r.id) doctor_verified
    FROM rfqs r JOIN patients p ON p.id=r.patient_id JOIN doctors d ON d.id=r.doctor_id
    ORDER BY r.id DESC`));
});
// medical opinion (decrypted for forwarding to patient — quote NEVER included)
app.get('/api/rfq/:id/opinion', (req, res) => {
  const o = get('SELECT * FROM medical_opinions WHERE rfq_id=?', req.params.id);
  if (!o) return res.status(404).end();
  res.json({ ...o, opinion_text: decrypt(o.opinion_enc),
    ministry_notice: 'Bu belge Sağlık Bakanlığı onaylı hekim tarafından e-imzalanmıştır. Hasta, pasaport/kimlik doğrulaması ile erişir.' });
});
app.post('/api/rfq/:id/share-opinion', (req, res) => {
  run('UPDATE medical_opinions SET shared_with_patient=1 WHERE rfq_id=?', req.params.id);
  io.emit('rfq_update', {});
  res.json({ ok: true });
});
const OPINION_TEMPLATES = [
  'Klinik değerlendirme sonucunda hastanın şikâyetleri uygun endikasyon göstermektedir. Ön tetkiklerin (kan tahlili, görüntüleme) hastanemizde tekrarlanması önerilir. İşlem süresi ortalama {d} gün, yatış 1-2 gece planlanmıştır. Komplikasyon riski düşüktür.',
  'Hasta dosyası incelenmiştir. Mevcut bulgular cerrahi girişim için uygundur. Operasyon öncesi anestezi konsültasyonu gereklidir. Toplam tedavi süreci {d} gün öngörülmektedir.',
  'Tıbbi geçmiş ve şikâyet değerlendirildi. Minimal invaziv yaklaşım önerilmektedir. Hastanın {d} gün İstanbul\'da kalması yeterlidir. Detaylı plan ilk muayenede netleşecektir.',
];
function simulateDoctorResponse(rfq) {
  const doc = get('SELECT * FROM doctors WHERE id=?', rfq.doctor_id);
  const delay = 6000 + Math.random() * 12000;
  setTimeout(() => {
    const declined = Math.random() < 0.08;
    if (declined) {
      run("UPDATE rfqs SET status='declined', responded_at=datetime('now') WHERE id=?", rfq.id);
    } else {
      const days = 3 + Math.floor(Math.random() * 8);
      const text = OPINION_TEMPLATES[Math.floor(Math.random() * OPINION_TEMPLATES.length)].replace('{d}', days);
      const sig = esign(doc.name, text);
      run('INSERT INTO medical_opinions (rfq_id,opinion_enc,signature,signed_at) VALUES (?,?,?,datetime(\'now\'))',
        rfq.id, encrypt(text), sig);
      const price = Math.round((1500 + Math.random() * 8000) / 50) * 50;
      run('INSERT INTO doctor_quotes (rfq_id,price,currency,notes) VALUES (?,?,?,?)',
        rfq.id, price, 'EUR', 'Hastane + cerrahi ücreti dahil; konaklama hariç.');
      run("UPDATE rfqs SET status='responded', responded_at=datetime('now') WHERE id=?", rfq.id);
    }
    io.emit('rfq_update', { rfq_id: rfq.id });
  }, delay);
}

// --- Logistics: hotels / flights / transfers / bookings ---
app.get('/api/hotels', (req, res) => res.json(all('SELECT * FROM hotels ORDER BY price_per_night')));
app.get('/api/flights', (req, res) => res.json(all('SELECT * FROM flights ORDER BY dep_time')));
app.get('/api/transfer-quote', (req, res) => {
  const km = 15 + Math.random() * 30;
  res.json({ quotes: [
    { type: 'VIP Mercedes Vito', price: Math.round(km * 3.5), currency: 'EUR', eta_min: 20 },
    { type: 'VIP Sprinter (grup)', price: Math.round(km * 4.5), currency: 'EUR', eta_min: 25 },
    { type: 'Standart Sedan', price: Math.round(km * 2), currency: 'EUR', eta_min: 15 },
  ]});
});
app.post('/api/bookings', (req, res) => {
  const { patient_id, kind, ref_label, details, price } = req.body;
  const r = run('INSERT INTO bookings (patient_id,kind,ref_label,details,price,status,flight_no,flight_date) VALUES (?,?,?,?,?,?,?,?)',
    patient_id, kind, ref_label, JSON.stringify(details || {}), price,
    kind === 'transfer' ? 'active' : 'confirmed',
    kind === 'flight' ? ((details || {}).flight_no || null) : null,
    kind === 'flight' ? ((details || {}).flight_date || null) : null);
  const b = get('SELECT * FROM bookings WHERE id=?', r.lastInsertRowid);
  if (kind === 'hotel' || kind === 'flight' || kind === 'transfer' || kind === 'insurance' || kind === 'tour') {
    run('INSERT INTO transactions (account_id,patient_id,kind,category,amount,description) VALUES (?,?,?,?,?,?)',
      1, patient_id, 'expense', kind, price, ref_label + ' rezervasyonu');
  }
  if (kind === 'flight') startFlightTracking(b.id);
  if (kind === 'transfer') {
    if (!b.details || !JSON.parse(b.details).plate) {
      const dd = JSON.parse(b.details || '{}');
      const drvA = all("SELECT * FROM agents WHERE role='driver' AND active=1 ORDER BY id");
      dd.plate = '34 CLN ' + String(100 + (b.id % 900));
      dd.driver_name = drvA.length ? drvA[b.id % drvA.length].name : 'VIP Şoför';
      dd.driver_phone = '+90 532 ' + String(1000000 + b.id).slice(0,7);
      dd.vehicle = dd.vehicle || 'VIP Mercedes Vito';
      run('UPDATE bookings SET details=? WHERE id=?', JSON.stringify(dd), b.id);
      b.details = JSON.stringify(dd);
    }
    startGpsTracking(b.id);
    // create driver task chain (airport pickup -> hotel -> hospital)
    const drv = all("SELECT * FROM agents WHERE role='driver' AND active=1 ORDER BY id");
    if (drv.length) {
      const d = drv[b.id % drv.length];
      ['Havalimanı Karşılama', 'Otel Transferi', 'Hastane Transferi'].forEach((t, i) =>
        run('INSERT INTO driver_tasks (agent_id,booking_id,patient_id,label,seq) VALUES (?,?,?,?,?)',
          d.id, b.id, patient_id, t, i + 1));
    }
  }
  io.emit('booking', b);
  res.json(b);
});
app.get('/api/bookings', (req, res) => {
  const q = req.query.patient_id ? 'WHERE b.patient_id=' + Number(req.query.patient_id) : '';
  res.json(all(`SELECT b.*, p.name patient_name FROM bookings b JOIN patients p ON p.id=b.patient_id ${q} ORDER BY b.id DESC`));
});

// --- Live flight tracking: AeroDataBox (RapidAPI) / Flightradar24 + simulated fallback ---
const ADB_KEY = process.env.AERODATABOX_KEY || '';          // RapidAPI key → gerçek veri
const FLIGHT_STAGES = ['Scheduled', 'Boarding', 'Departed', 'En Route', 'Approaching', 'Landed'];
const AIRPORTS = {
  IST: [41.275, 28.752], SAW: [40.898, 29.309], AYT: [36.898, 30.801],
  LHR: [51.477, -0.461], CDG: [49.010, 2.548], FRA: [50.037, 8.562], MUC: [48.353, 11.786],
  DXB: [25.253, 55.365], DOH: [25.273, 51.608], JFK: [40.641, -73.778], KWI: [29.226, 47.980],
  RUH: [24.958, 46.698], BAH: [26.270, 50.633], SVO: [55.972, 37.413], TBS: [41.669, 44.955],
};
const flightTrackers = new Map();
const delayNotified = new Set();
function parseFlightNo(ref) { const m = (ref || '').match(/[A-Za-z]{2}\s?\d{1,4}/); return m ? m[0].replace(/\s/g, '').toUpperCase() : null; }
function parseRoute(ref) { const m = (ref || '').match(/([A-Z]{3})\s*[-–>→]\s*([A-Z]{3})/); return m ? [m[1], m[2]] : null; }
async function fetchAeroDataBox(fno, date) {
  const url = `https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(fno)}/${date}`;
  const r = await fetch(url, { headers: { 'x-rapidapi-key': ADB_KEY, 'x-rapidapi-host': 'aerodatabox.p.rapidapi.com' } });
  if (!r.ok) throw new Error('AeroDataBox HTTP ' + r.status);
  const arr = await r.json();
  return Array.isArray(arr) ? (arr[0] || null) : null;
}
function notifyFlightDelay(b, delayMin) {
  if (delayNotified.has(b.id)) return;
  delayNotified.add(b.id);
  const p = get('SELECT name, agent_id FROM patients WHERE id=?', b.patient_id) || {};
  const msg = `UÇUŞ RÖTARLI ✈ ${b.ref_label} — ${p.name || 'Hasta'} (${delayMin} dk gecikme). VIP şoför bilgilendirildi.`;
  run('INSERT INTO notifications (kind,agent_id,conversation_id,message) VALUES (?,?,?,?)', 'flight_delay', p.agent_id || null, null, msg);
  const drv = get('SELECT agent_id FROM driver_tasks WHERE patient_id=? LIMIT 1', b.patient_id);
  if (drv) run('INSERT INTO notifications (kind,agent_id,conversation_id,message) VALUES (?,?,?,?)', 'flight_delay', drv.agent_id, null, msg);
  notify(msg, 'flight_delay');
  io.emit('flight_delay', { booking_id: b.id, patient_id: b.patient_id, delay_min: delayMin, message: msg });
}
function emitFlight(b, payload) {
  io.emit('flight_status', Object.assign({ booking_id: b.id, patient_id: b.patient_id, source: ADB_KEY ? 'aerodatabox' : 'sim' }, payload));
}
async function trackFlightReal(b) {
  const fno = b.flight_no;
  const date = b.flight_date || new Date().toISOString().slice(0, 10);
  try {
    const f = await fetchAeroDataBox(fno, date);
    if (!f) { console.log('[flight] AeroDataBox: sonuç yok', fno); return false; }
    const status = f.status || 'Scheduled';
    const loc = f.location || (f.aircraft && f.aircraft.location) || null;
    const dep = f.departure || {}, arr = f.arrival || {};
    const delayMin = Math.round(arr.delay || dep.delay || 0);
    const eta = (arr.predictedTime && arr.predictedTime.local) || (arr.scheduledTime && arr.scheduledTime.local) || null;
    const gate = dep.gate || arr.gate || null;
    run('UPDATE bookings SET flight_status=?, flight_lat=?, flight_lng=?, eta=?, delay_min=?, gate=? WHERE id=?',
      status, loc ? loc.latitude : null, loc ? loc.longitude : null, eta, delayMin, gate, b.id);
    if (delayMin > 10 || /delay/i.test(status)) notifyFlightDelay(b, delayMin || 30);
    emitFlight(b, { status, lat: loc ? loc.latitude : null, lng: loc ? loc.longitude : null,
      eta, delay_min: delayMin, gate, progress: status === 'Landed' ? 1 : (/en route|airborne/i.test(status) ? .5 : .1) });
    return status !== 'Landed';
  } catch (e) { console.log('[flight] API hatası:', e.message); return false; }
}
function trackFlightSim(b) {
  const route = parseRoute(b.ref_label) || ['LHR', 'IST'];
  const org = AIRPORTS[route[0]] || [51.5, 0], dst = AIRPORTS[route[1]] || [41.2, 28.8];
  const simDelay = Math.random() < 0.3 ? 15 + Math.round(Math.random() * 45) : 0;
  const gate = 'A' + (b.id % 9 + 1);
  const depAt = Date.now();
  let stage = 0;
  const timer = setInterval(() => {
    stage++;
    if (stage >= FLIGHT_STAGES.length) { clearInterval(timer); flightTrackers.delete(b.id); return; }
    const prog = stage / (FLIGHT_STAGES.length - 1);
    const lat = org[0] + (dst[0] - org[0]) * prog, lng = org[1] + (dst[1] - org[1]) * prog;
    const delayed = simDelay > 0 && stage >= 2 && stage < FLIGHT_STAGES.length - 1;
    const status = delayed ? 'Delayed' : FLIGHT_STAGES[stage];
    const eta = new Date(depAt + 48000 + simDelay * 60000).toISOString();
    run('UPDATE bookings SET flight_status=?, flight_lat=?, flight_lng=?, eta=?, delay_min=?, gate=? WHERE id=?',
      status, lat, lng, eta, delayed ? simDelay : 0, gate, b.id);
    if (delayed) notifyFlightDelay(b, simDelay);
    emitFlight(b, { status, lat, lng, eta, delay_min: delayed ? simDelay : 0, gate, progress: prog });
  }, 8000);
  flightTrackers.set(b.id, timer);
  emitFlight(b, { status: 'Scheduled', lat: org[0], lng: org[1], gate, delay_min: 0, progress: 0 });
}
async function startFlightTracking(bookingId) {
  if (flightTrackers.has(bookingId)) return;
  const b = get('SELECT * FROM bookings WHERE id=?', bookingId);
  if (!b) return;
  const det = JSON.parse(b.details || '{}');
  const fno = b.flight_no || det.flight_no || parseFlightNo(b.ref_label);
  const fdate = b.flight_date || det.flight_date || new Date().toISOString().slice(0, 10);
  run('UPDATE bookings SET flight_no=?, flight_date=? WHERE id=?', fno, fdate, b.id);
  b.flight_no = fno; b.flight_date = fdate;
  if (ADB_KEY && fno) {
    const cont = await trackFlightReal(b);
    if (cont === false) { trackFlightSim(b); return; }   // API bulamadı → sim fallback
    const t = setInterval(() => trackFlightReal(b), 60000);
    flightTrackers.set(b.id, t);
    return;
  }
  trackFlightSim(b);
}
app.post('/api/bookings/:id/track-flight', (req, res) => { startFlightTracking(Number(req.params.id)); res.json({ ok: true }); });

// VIP transfer live GPS simulation (stylized Istanbul route)
const gpsTrackers = new Map();
function startGpsTracking(bookingId) {
  if (gpsTrackers.has(bookingId)) return;
  const route = [];
  const [x0, y0, x1, y1] = [8, 62, 88, 30]; // airport (bottom-left) -> hospital (top-right) on 100x100 map
  const steps = 60;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    route.push({ x: x0 + (x1 - x0) * t + Math.sin(t * Math.PI * 3) * 6, y: y0 + (y1 - y0) * t - Math.sin(t * Math.PI * 2) * 5 });
  }
  let i = 0;
  const timer = setInterval(() => {
    i++;
    if (i >= route.length) {
      io.emit('gps', { booking_id: bookingId, done: true });
      clearInterval(timer); gpsTrackers.delete(bookingId);
      run("UPDATE bookings SET status='completed' WHERE id=?", bookingId);
      return;
    }
    io.emit('gps', { booking_id: bookingId, pos: route[i], progress: i / steps, done: false });
  }, 1000);
  gpsTrackers.set(bookingId, timer);
}
app.post('/api/bookings/:id/track-transfer', (req, res) => { startGpsTracking(Number(req.params.id)); res.json({ ok: true }); });
app.get('/api/bookings/:id/route', (req, res) => res.json({ note: 'simulated route pushed via socket gps events' }));

// --- Accounting / invoices / İVD ---
app.get('/api/accounts', (req, res) => {
  res.json(all(`SELECT a.*,
    COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.account_id=a.id AND t.kind='income'),0) -
    COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.account_id=a.id AND t.kind='expense'),0) balance
    FROM accounts a`));
});
app.get('/api/transactions', (req, res) => {
  res.json(all(`SELECT t.*, a.name account_name, p.name patient_name FROM transactions t
    LEFT JOIN accounts a ON a.id=t.account_id LEFT JOIN patients p ON p.id=t.patient_id ORDER BY t.id DESC`));
});
app.post('/api/transactions', (req, res) => {
  const { account_id, patient_id, kind, category, amount, description } = req.body;
  const r = run('INSERT INTO transactions (account_id,patient_id,kind,category,amount,description) VALUES (?,?,?,?,?,?)',
    account_id, patient_id, kind, category, amount, description);
  io.emit('kpi', {});
  res.json(get('SELECT * FROM transactions WHERE id=?', r.lastInsertRowid));
});
// package margin view: sell price vs costs per patient
app.get('/api/margins', (req, res) => {
  res.json(all(`SELECT p.id patient_id, p.name,
    COALESCE((SELECT SUM(amount) FROM transactions WHERE patient_id=p.id AND kind='income'),0) revenue,
    COALESCE((SELECT SUM(amount) FROM transactions WHERE patient_id=p.id AND kind='expense'),0) cost,
    COALESCE((SELECT SUM(amount) FROM transactions WHERE patient_id=p.id AND kind='income'),0) -
    COALESCE((SELECT SUM(amount) FROM transactions WHERE patient_id=p.id AND kind='expense'),0) margin
    FROM patients p`));
});
let invSeq = (get("SELECT MAX(CAST(substr(number,-4) AS INT)) m FROM invoices WHERE number GLOB '*[0-9]'") || {}).m || 1000;
app.get('/api/invoices', (req, res) => {
  res.json(all(`SELECT i.*, p.name patient_name FROM invoices i JOIN patients p ON p.id=i.patient_id ORDER BY i.id DESC`));
});
app.get('/api/patients/:id/latest-quote', (req, res) => {
  const r = get(`SELECT q.price quote_price, q.currency, d.specialty, d.name doctor_name FROM rfqs r
    JOIN doctors d ON d.id=r.doctor_id
    JOIN doctor_quotes q ON q.rfq_id=r.id
    WHERE r.patient_id=? AND r.status='responded' ORDER BY r.id DESC LIMIT 1`, req.params.id);
  res.json(r || {});
});

app.post('/api/invoices', (req, res) => {
  const b = req.body || {};
  const { patient_id, items } = b;
  const net = (items || []).reduce((s, i) => s + (i.qty * i.unit), 0);
  const isk = +(b.iskonto || 0);
  const base = net - isk;
  const kdvRate = +(b.kdv_rate ?? 20);
  const kdv = Math.round(base * kdvRate) / 100;
  const amount = Math.round((base + kdv) * 100) / 100;
  const number = 'HTA' + new Date().getFullYear() + (++invSeq);
  const r = run(`INSERT INTO invoices (patient_id,number,amount,items,status,issued_at,
      direction,invoice_type,scenario,vkn,vergi_dairesi,kdv_rate,kdv_amount,iskonto,currency,fx_rate,payment_terms,due_date,installments,cashbank_id)
    VALUES (?,?,?,?,?,datetime('now'),?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    patient_id, number, amount, JSON.stringify(items || []), 'issued',
    'sales', b.invoice_type || 'SATIS', b.scenario || 'TICARIFAT',
    b.vkn || null, b.vergi_dairesi || null, kdvRate, kdv, isk,
    b.currency || 'EUR', +(b.fx_rate || 0), b.payment_terms || 'PESIN',
    b.due_date || null, +(b.installments || 1), b.cashbank_id || null);
  run('INSERT INTO transactions (account_id,patient_id,kind,category,amount,currency,description,cashbank_id,vkn) VALUES (?,?,?,?,?,?,?,?,?)',
    1, patient_id, 'income', 'medical', amount, b.currency || 'EUR', 'Fatura ' + number + ' · DAB-' + new Date().getFullYear() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase(), b.cashbank_id || null, b.vkn || null);
  io.emit('kpi', {});
  res.json(get('SELECT * FROM invoices WHERE id=?', r.lastInsertRowid));
});
// çözüm ortağı / tedarikçi faturalarını içe almak (purchase invoice)
app.post('/api/invoices/inbound', (req, res) => {
  const b = req.body || {};
  const kdvRate = +(b.kdv_rate ?? 20);
  const base = +(b.amount || 0);
  const kdv = Math.round(base * kdvRate) / 100;
  const total = base + kdv;
  const number = 'IN' + new Date().getFullYear() + (++invSeq);
  const r = run(`INSERT INTO invoices (patient_id,number,amount,items,status,issued_at,
      direction,invoice_type,scenario,vkn,kdv_rate,kdv_amount,currency,payment_terms,due_date)
    VALUES (?,?,?,?,?,datetime('now'),'purchase',?,?,?,?,?,?,?,?)`,
    b.patient_id || 1, number, total, JSON.stringify([{ desc: b.desc || 'Çözüm ortağı faturası', qty: 1, unit: base }]), 'issued',
    b.invoice_type || 'SATIS', b.scenario || 'EFATURA', b.vkn || null, kdvRate, kdv,
    b.currency || 'EUR', b.payment_terms || 'VADELI', b.due_date || null);
  run('INSERT INTO transactions (account_id,patient_id,kind,category,amount,currency,description,vkn) VALUES (?,?,?,?,?,?,?,?)',
    b.account_id || 2, b.patient_id || null, 'expense', b.category || 'medical', total, b.currency || 'EUR',
    'Gelen fatura ' + number + (b.vendor ? ' — ' + b.vendor : ''), b.vkn || null);
  io.emit('kpi', {});
  res.json(get('SELECT * FROM invoices WHERE id=?', r.lastInsertRowid));
});
// --- Logo ön muhasebe: kasa/banka, çek-senet, gider kartları, ekstre, KDV raporu ---
app.get('/api/cashbanks', (req, res) => {
  res.json(all(`SELECT c.*,
    COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.cashbank_id=c.id AND t.kind='income'),0) -
    COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.cashbank_id=c.id AND t.kind='expense'),0) balance
    FROM cashbanks c`));
});
app.get('/api/checks', (req, res) => res.json(all('SELECT * FROM checks ORDER BY due_date')));
app.post('/api/checks', (req, res) => {
  const b = req.body || {};
  const r = run('INSERT INTO checks (doc_no,type,direction,drawer,amount,currency,issue_date,due_date,bank_name,status) VALUES (?,?,?,?,?,?,?,?,?,?)',
    b.doc_no, b.type || 'cek', b.direction || 'received', b.drawer, b.amount, b.currency || 'EUR',
    b.issue_date, b.due_date, b.bank_name, 'portfoy');
  res.json(get('SELECT * FROM checks WHERE id=?', r.lastInsertRowid));
});
app.post('/api/checks/:id/status', (req, res) => {
  run('UPDATE checks SET status=? WHERE id=?', req.body.status, req.params.id);
  res.json(get('SELECT * FROM checks WHERE id=?', req.params.id));
});
app.get('/api/expense-cards', (req, res) => res.json(all('SELECT * FROM expense_cards')));
// cari ekstre / mutabakat
app.get('/api/accounts/:id/statement', (req, res) => {
  const a = get('SELECT * FROM accounts WHERE id=?', req.params.id);
  if (!a) return res.status(404).end();
  const txns = all('SELECT * FROM transactions WHERE account_id=? ORDER BY id', a.id);
  res.json({ account: a, transactions: txns,
    balance: txns.reduce((s, t) => s + (t.kind === 'income' ? t.amount : -t.amount), 0) });
});
// KDV raporu (sales vs purchase)
app.get('/api/kdv-report', (req, res) => {
  const sales = get("SELECT COALESCE(SUM(kdv_amount),0) kdv, COALESCE(SUM(amount-kdv_amount),0) base FROM invoices WHERE direction='sales'");
  const purchase = get("SELECT COALESCE(SUM(kdv_amount),0) kdv, COALESCE(SUM(amount-kdv_amount),0) base FROM invoices WHERE direction='purchase'");
  res.json({ sales_kdv: sales.kdv, sales_base: sales.base, purchase_kdv: purchase.kdv,
    purchase_base: purchase.base, payable: Math.round((sales.kdv - purchase.kdv) * 100) / 100 });
});
// İVD (İnteraktif Vergi Dairesi) e-invoice transmission simulation
app.post('/api/invoices/:id/send-ivd', (req, res) => {
  const inv = get('SELECT * FROM invoices WHERE id=?', req.params.id);
  if (!inv) return res.status(404).end();
  setTimeout(() => {
    const ref = 'IVD-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    run("UPDATE invoices SET status='sent_ivd', ivd_ref=? WHERE id=?", ref, inv.id);
    io.emit('ivd', { invoice_id: inv.id, ivd_ref: ref });
  }, 1500);
  res.json({ ok: true, note: 'İVD aktarım kuyruğuna alındı' });
});

// --- USHAŞ notification ---
app.post('/api/usha/send', (req, res) => {
  const p = get('SELECT * FROM patients WHERE id=?', req.body.patient_id);
  if (!p) return res.status(404).end();
  // 5448/USHAŞ zorunlu alan kontrolü
  const flight = get("SELECT * FROM bookings WHERE patient_id=? AND kind='flight' ORDER BY id DESC", p.id);
  const rfq = get("SELECT r.*, d.name dname, d.hospital FROM rfqs r JOIN doctors d ON d.id=r.doctor_id WHERE r.patient_id=? AND r.status='responded' ORDER BY r.id DESC", p.id);
  const missing = [];
  if (!p.name) missing.push('Ad-Soyad');
  if (!p.passport_no) missing.push('Pasaport/Kimlik No');
  if (!p.nationality) missing.push('Uyruk');
  if (!rfq && !p.complaint_tr && !p.complaint) missing.push('Tedavi Branşı');
  if (!rfq) missing.push('Anlaşmalı Hastane/Klinik');
  if (missing.length) return res.status(409).json({ error: 'USHAŞ zorunlu alanları eksik', missing });
  const detail = req.body.service_detail || (p.complaint_tr || p.complaint || 'Sağlık turizmi hizmeti');
  const payload = {
    portal: 'USHAŞ (simülasyon)', schema: 'healthtourism-v2',
    patient: {
      name: p.name, nationality: p.nationality, passport_no: p.passport_no,
      entry_date: flight?.flight_date || flight?.created_at || p.created_at,
      treatment_branch: detail,
      hospital_name: rfq ? rfq.hospital : null,
    },
    service: detail, agency: 'HTA Demo Acente', city: AGENCY_CITY, notified_at: new Date().toISOString(),
  };
  setTimeout(() => {
    const ref = 'USH-' + new Date().getFullYear() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    run(`INSERT INTO usha_notifications (patient_id,service_detail,payload,status,usha_ref,sent_at)
         VALUES (?,?,?,?,?,datetime('now'))`,
      p.id, detail, JSON.stringify(payload), 'acknowledged', ref);
    io.emit('usha', { patient_id: p.id, usha_ref: ref });
  }, 1200);
  run(`INSERT INTO usha_notifications (patient_id,service_detail,payload,status) VALUES (?,?,?,'pending')`,
    p.id, detail, JSON.stringify(payload));
  res.json({ ok: true });
});
app.get('/api/usha', (req, res) => {
  res.json(all(`SELECT u.*, p.name patient_name FROM usha_notifications u JOIN patients p ON p.id=u.patient_id ORDER BY u.id DESC`));
});

// --- Incentive (Teşvik) package builder ---
const INCENTIVE_DOCS = [
  ['Uçak bileti faturası', 'flight'],
  ['Otel konaklama faturası', 'hotel'],
  ['Hastane tedavi faturası', 'medical'],
  ['VIP transfer belgesi', 'transfer'],
  ['Hasta pasaport fotokopisi', 'passport'],
  ['USHAŞ bildirim referansı', 'usha'],
];
app.get('/api/incentive/checklist/:patientId', (req, res) => {
  const pid = req.params.patientId;
  const p = get('SELECT * FROM patients WHERE id=?', pid);
  if (!p) return res.status(404).end();
  const bookings = all('SELECT * FROM bookings WHERE patient_id=?', pid);
  const invoices = all('SELECT * FROM invoices WHERE patient_id=?', pid);
  const files = all('SELECT * FROM files WHERE patient_id=?', pid);
  const usha = all('SELECT * FROM usha_notifications WHERE patient_id=? AND status=\'acknowledged\'', pid);
  const docs = INCENTIVE_DOCS.map(([doc, key]) => {
    let present = false, source = '';
    if (key === 'flight') { present = bookings.some(b => b.kind === 'flight'); source = 'Rezervasyon kaydı'; }
    if (key === 'hotel') { present = bookings.some(b => b.kind === 'hotel'); source = 'Rezervasyon kaydı'; }
    if (key === 'transfer') { present = bookings.some(b => b.kind === 'transfer'); source = 'Rezervasyon kaydı'; }
    if (key === 'medical') { present = invoices.length > 0; source = invoices.length ? 'Fatura ' + invoices[0].number : ''; }
    if (key === 'passport') { present = !!p.passport_no || files.some(f => f.category === 'passport'); source = p.passport_no ? 'Pasaport no: ' + p.passport_no : ''; }
    if (key === 'usha') { present = usha.length > 0; source = usha.length ? usha[0].usha_ref : ''; }
    return { doc, key, present, source };
  });
  res.json({ patient: p, docs, ready: docs.every(d => d.present) });
});
app.post('/api/incentive/package/:patientId', (req, res) => {
  const pid = req.params.patientId;
  const r = patientChecklist(pid);
  if (!r.patient) return res.status(404).end();
  const missing = r.docs.filter(d => !d.present).map(d => d.doc);
  if (missing.length) return res.status(409).json({ error: 'Eksik evrak — teşvik havuzuna aktarılamaz', missing });
  const rr = run('INSERT INTO incentive_packages (patient_id,docs,status,submitted_at) VALUES (?,?,?,datetime(\'now\'))',
    pid, JSON.stringify(r.docs), 'submitted');
  io.emit('incentive', { patient_id: Number(pid) });
  res.json(get('SELECT * FROM incentive_packages WHERE id=?', rr.lastInsertRowid));
});
app.get('/api/incentive', (req, res) => {
  res.json(all(`SELECT i.*, p.name patient_name FROM incentive_packages i JOIN patients p ON p.id=i.patient_id ORDER BY i.id DESC`));
});

// auto-inbound toggle
let autoTimer = null;
app.post('/api/simulate/auto', (req, res) => {
  if (req.body.on && !autoTimer) {
    autoTimer = setInterval(async () => {
      try { await fetch(`http://localhost:${PORT}/api/simulate/inbound`, { method: 'POST' }); } catch (_) {}
    }, 45000);
  } else if (!req.body.on && autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  res.json({ auto: !!autoTimer });
});

// =====================================================================
// v2 — SLA breach -> team leader, agents, offers, driver app, visa/insurance,
//      FX/TCMB, profit calculator, incentive checklist & zip export
// =====================================================================

// --- SLA breach monitor: notify team leader ---
setInterval(() => {
  const breached = all(`SELECT c.*, p.name pname FROM conversations c JOIN patients p ON p.id=c.patient_id
    WHERE c.sla_responded=0 AND c.sla_deadline IS NOT NULL AND c.sla_deadline < ?`, Date.now());
  for (const c of breached) {
    const exists = get("SELECT id FROM notifications WHERE kind='sla_breach' AND conversation_id=?", c.id);
    if (exists) continue;
    const leader = get("SELECT * FROM agents WHERE role='leader' LIMIT 1");
    run('INSERT INTO notifications (kind,agent_id,conversation_id,message) VALUES (?,?,?,?)',
      'sla_breach', leader ? leader.id : null, c.id,
      `SLA AŞIMI: ${c.pname} (#${c.patient_id}) 15 dk içinde yanıtlanmadı — ${c.channel}`);
    io.emit('notify', { kind: 'sla_breach', conversation_id: c.id, patient: c.pname });
    // eskalasyon: 5 dk hâlâ yanıtlanmadıysa üst yöneticiye bildir
  }
  const escalated = all(`SELECT c.*, p.name pname FROM conversations c JOIN patients p ON p.id=c.patient_id
    WHERE c.sla_responded=0 AND c.sla_deadline IS NOT NULL AND c.sla_deadline < ?`, Date.now() - 5 * 60000);
  for (const c of escalated) {
    const exists = get("SELECT id FROM notifications WHERE kind='sla_exec' AND conversation_id=?", c.id);
    if (exists) continue;
    const exec = get("SELECT * FROM agents WHERE role='exec' LIMIT 1");
    run('INSERT INTO notifications (kind,agent_id,conversation_id,message) VALUES (?,?,?,?)',
      'sla_exec', exec ? exec.id : null, c.id,
      `ÜST YÖNETİCİ ESKALASYONU: ${c.pname} (#${c.patient_id}) 15 dk SLA + 5 dk eskalasyon süresi aşıldı, hâlâ yanıtsız — ${c.channel}`);
    io.emit('notify', { kind: 'sla_exec', conversation_id: c.id, patient: c.pname });
  }
}, 10000);

// --- agents ---
app.get('/api/agents', (req, res) => {
  const role = req.query.role;
  res.json(all(`SELECT * FROM agents WHERE active=1 ${role ? 'AND role=?' : ''} ORDER BY role,id`, ...(role ? [role] : [])));
});
app.post('/api/conversations/:id/assign', (req, res) => {
  run('UPDATE conversations SET assigned_agent_id=? WHERE id=?', req.body.agent_id, req.params.id);
  io.emit('sla', {});
  res.json({ ok: true });
});
app.get('/api/notifications', (req, res) => {
  res.json(all(`SELECT n.*, a.name recipient FROM notifications n LEFT JOIN agents a ON a.id=n.agent_id
    ORDER BY n.id DESC LIMIT 50`));
});
app.post('/api/notifications/read-all', (req, res) => { run('UPDATE notifications SET read=1'); res.json({ ok: true }); });

// --- offers / teklif mektubu + post-op package + e-sign/payment ---
app.get('/api/postop-packages', (req, res) => res.json(all('SELECT * FROM postop_packages')));
app.post('/api/offers', (req, res) => {
  const { patient_id, items, postop_package_id } = req.body || {};
  if (!postop_package_id) return res.status(400).json({ error: 'Post-op takip paketi zorunludur' });
  const pkg = get('SELECT * FROM postop_packages WHERE id=?', postop_package_id);
  const total = (items || []).reduce((s, i) => s + (+i.price || 0), 0) + (pkg ? pkg.price : 0);
  const token = crypto.randomBytes(10).toString('hex');
  const r = run('INSERT INTO offers (patient_id,items,postop_package_id,total,status,share_token,lang) VALUES (?,?,?,?,?,?,?)',
    patient_id, JSON.stringify(items || []), postop_package_id, total, 'draft', token, req.body.lang || 'en');
  res.json({ ...get('SELECT * FROM offers WHERE id=?', r.lastInsertRowid), url: '/o/' + token });
});
app.get('/api/offers', (req, res) => {
  res.json(all(`SELECT o.*, p.name patient_name, pp.name postop_name FROM offers o
    JOIN patients p ON p.id=o.patient_id LEFT JOIN postop_packages pp ON pp.id=o.postop_package_id
    ORDER BY o.id DESC`));
});
app.post('/api/offers/:id/send', (req, res) => {
  run("UPDATE offers SET status='sent' WHERE id=?", req.params.id);
  res.json(get('SELECT * FROM offers WHERE id=?', req.params.id));
});
// patient-side mobile approval (e-sign) then payment
app.post('/api/offers/:id/approve', (req, res) => {
  const o = get('SELECT * FROM offers WHERE id=?', req.params.id);
  if (!o) return res.status(404).end();
  const sig = 'MOBILE-ESIGN-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  run("UPDATE offers SET status='approved', e_signature=?, approved_at=datetime('now') WHERE id=?", sig, o.id);
  run("UPDATE patients SET lead_status='agreed' WHERE id=?", o.patient_id);
  io.emit('offer', { id: o.id, status: 'approved' });
  res.json({ ok: true, e_signature: sig });
});
app.post('/api/offers/:id/pay', (req, res) => {
  const o = get('SELECT * FROM offers WHERE id=?', req.params.id);
  if (!o || o.status !== 'approved') return res.status(400).json({ error: 'Önce mobil onay gerekli' });
  run("UPDATE offers SET status='paid', paid_at=datetime('now') WHERE id=?", o.id);
  const p = get('SELECT * FROM patients WHERE id=?', o.patient_id);
  const dep = +((req.body || {}).amount) || o.total;
  run('INSERT INTO transactions (account_id,patient_id,kind,category,amount,currency,description) VALUES (?,?,?,?,?,?,?)',
    1, o.patient_id, 'income', 'medical', dep, o.currency, `Teklif ödemesi #${o.id}${dep < o.total ? ' (kapora)' : ''}`);
  if (p) run('INSERT INTO files (patient_id,filename,category) VALUES (?,?,?)',
    p.id, `Mesafeli_Satis_Sozlesmesi_${p.name.replace(/\s+/g, '_')}_Imzali.esign`, 'contract');
  const ops = assignOps();
  if (ops && p) {
    try { run('UPDATE patients SET ops_agent_id=? WHERE id=?', ops.id, p.id); } catch {}
    run('UPDATE conversations SET assigned_agent_id=? WHERE patient_id=?', ops.id, p.id);
    notify(`${p.name}: satış tamamlandı — dosya ${ops.name} (Operasyon Danışmanı) yetkisine devredildi`, 'handoff');
    const conv = get('SELECT * FROM conversations WHERE patient_id=? ORDER BY id DESC LIMIT 1', p.id);
    if (conv) run('INSERT INTO messages (conversation_id,direction,body,lang) VALUES (?,?,?,?)',
      conv.id, 'out', `Dosyanız saha operasyon ekibimize devredildi. Yeni koordinatörünüz: ${ops.name}`, 'tr');
  }
  io.emit('kpi', {});
  io.emit('handoff', { patient_id: o.patient_id });
  res.json({ ok: true, ops_agent: ops ? ops.name : null });
});

// --- assignments: calendar conflict prevention (UNIQUE agent+date+slot) ---
app.get('/api/assignments', (req, res) => {
  res.json(all(`SELECT a.*, g.name agent_name, g.role, p.name patient_name FROM assignments a
    JOIN agents g ON g.id=a.agent_id LEFT JOIN patients p ON p.id=a.patient_id ORDER BY a.date,a.slot`));
});
app.post('/api/assignments', (req, res) => {
  const { agent_id, patient_id, date, slot, task } = req.body || {};
  try {
    run('INSERT INTO assignments (agent_id,patient_id,date,slot,task) VALUES (?,?,?,?,?)',
      agent_id, patient_id, date, slot, task);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: 'Çakışma: bu personel/araç aynı tarih ve saat dilimine zaten atanmış' });
  }
});

// --- driver / translator mobile app ---
app.get('/api/driver/tasks', (req, res) => {
  res.json(all(`SELECT t.*, p.name patient_name, b.ref_label FROM driver_tasks t
    LEFT JOIN patients p ON p.id=t.patient_id LEFT JOIN bookings b ON b.id=t.booking_id
    ${req.query.agent_id ? 'WHERE t.agent_id=' + Number(req.query.agent_id) : ''}
    ORDER BY t.agent_id, t.booking_id, t.seq`));
});
app.post('/api/driver/tasks/:id/:action', (req, res) => {
  const st = req.params.action === 'start' ? 'in_progress' : 'done';
  run("UPDATE driver_tasks SET status=?, updated_at=datetime('now') WHERE id=?", st, req.params.id);
  const t = get('SELECT * FROM driver_tasks WHERE id=?', req.params.id);
  io.emit('driver_task', t);
  if (t && t.booking_id && req.params.action === 'start') startGpsTracking(t.booking_id);
  res.json(t);
});

// --- visa & insurance ---
app.get('/api/visa', (req, res) => res.json(all('SELECT * FROM visa_rules ORDER BY country')));
app.get('/api/visa/lookup', (req, res) => {
  const v = get('SELECT * FROM visa_rules WHERE country=?', req.query.country);
  res.json(v || { country: req.query.country, rule: 'vize_gerekli', note: 'Kural bulunamadı — vize başvurusu gerekli' });
});
app.get('/api/insurance', (req, res) => res.json(all('SELECT * FROM insurance_offers')));
// Hasta merkezli sigorta poliçesi kesimi → dosya çekmecesi + cari gider + evrak
app.post('/api/insurance/issue', (req, res) => {
  const { patient_id, offer_id } = req.body || {};
  const p = get('SELECT * FROM patients WHERE id=?', patient_id);
  const off = get('SELECT * FROM insurance_offers WHERE id=?', offer_id);
  if (!p || !off) return res.status(400).json({ error: 'Hasta ve sigorta teklifi zorunlu' });
  const label = `${off.provider} Poliçesi — ${p.name}`;
  const r = run('INSERT INTO bookings (patient_id,kind,ref_label,details,price,status) VALUES (?,?,?,?,?,?)',
    patient_id, 'insurance', label, JSON.stringify({ policy_url: off.policy_url, coverage: off.coverage }), off.price, 'confirmed');
  run('INSERT INTO transactions (account_id,patient_id,kind,category,amount,description) VALUES (?,?,?,?,?,?)',
    1, patient_id, 'expense', 'insurance', off.price, label + ' poliçesi');
  const fname = `Police_${off.provider.replace(/\s+/g, '_')}_${p.name.replace(/\s+/g, '_')}.pdf`;
  run('INSERT INTO files (patient_id,filename,path,category,uploaded_at) VALUES (?,?,?,?,datetime(\'now\'))',
    patient_id, fname, off.policy_url || '/uploads/' + fname, 'insurance');
  io.emit('booking', { id: r.lastInsertRowid });
  io.emit('files', { patient_id });
  res.json({ ok: true, booking_id: r.lastInsertRowid, file: fname });
});
// --- İki dilli sağlık turizmi sözleşmesi + kapora kaydı (Adım 3) ---
app.post('/api/contract', (req, res) => {
  const { patient_id, deposit } = req.body || {};
  const p = get('SELECT * FROM patients WHERE id=?', patient_id);
  if (!p) return res.status(400).json({ error: 'Hasta bulunamadı' });
  const fname = `Sozlesme_TR-EN_${p.name.replace(/\s+/g, '_')}.pdf`;
  run('INSERT INTO files (patient_id,filename,category) VALUES (?,?,?)', p.id, fname, 'contract');
  let dep = 0;
  if (+deposit) {
    dep = +deposit;
    run('INSERT INTO transactions (account_id,patient_id,kind,category,amount,description) VALUES (?,?,?,?,?,?)',
      1, p.id, 'income', 'deposit', dep, `Ön ödeme / kapora — ${fname}`);
  }
  notify(`${p.name}: İki dilli hizmet sözleşmesi oluşturuldu${dep ? ' + ' + dep + '€ kapora' : ''}`, 'contract');
  io.emit('files', { patient_id: p.id });
  res.json({ ok: true, file: fname, deposit: dep });
});

// --- Escrow güvenli ödeme & hakediş dağıtımı (PDF strateji: depozito bloke + split + %1.5 fee) ---
app.get('/api/escrow', (req, res) => res.json(all(`SELECT e.*, p.name patient_name FROM escrow e JOIN patients p ON p.id=e.patient_id ORDER BY e.id DESC`)));
app.post('/api/escrow', (req, res) => {
  const { patient_id, amount } = req.body || {};
  if (!patient_id || !+amount) return res.status(400).json({ error: 'Hasta ve tutar zorunlu' });
  const r = run('INSERT INTO escrow (patient_id,amount) VALUES (?,?)', patient_id, +amount);
  io.emit('escrow', { id: r.lastInsertRowid });
  res.json(get('SELECT * FROM escrow WHERE id=?', r.lastInsertRowid));
});
app.post('/api/escrow/:id/release', (req, res) => {
  const e = get('SELECT * FROM escrow WHERE id=?', req.params.id);
  if (!e) return res.status(404).end();
  if (e.status === 'released') return res.status(409).json({ error: 'Zaten dağıtıldı' });
  const fee = +(e.amount * (e.fee_pct || 1.5) / 100).toFixed(2);
  const net = e.amount - fee;
  const splits = [
    ['hospital', +(net * 0.65).toFixed(2), 'Hastane hakedişi'],
    ['hotel',    +(net * 0.15).toFixed(2), 'Otel hakedişi'],
    ['transfer', +(net * 0.05).toFixed(2), 'VIP transfer hakedişi'],
    ['commission', +(net * 0.15).toFixed(2), 'Temsilci/alt acente komisyonu'],
    ['fee', fee, 'Escrow işlem ücreti %1.5'],
  ];
  splits.forEach(([k, a, n]) => run('INSERT INTO escrow_splits (escrow_id,kind,amount,note) VALUES (?,?,?,?)', e.id, k, a, n));
  splits.filter(s => s[0] !== 'fee').forEach(([k, a, n]) =>
    run('INSERT INTO transactions (account_id,patient_id,kind,category,amount,description) VALUES (?,?,?,?,?,?)',
      1, e.patient_id, 'expense', k, a, 'Escrow ' + n));
  run('INSERT INTO transactions (account_id,patient_id,kind,category,amount,description) VALUES (?,?,?,?,?,?)',
    1, e.patient_id, 'income', 'escrow', e.amount, 'Escrow depozito tahsilatı');
  run("UPDATE escrow SET status='released', released_at=datetime('now') WHERE id=?", e.id);
  io.emit('escrow', { id: e.id });
  res.json({ ok: true, splits: all('SELECT * FROM escrow_splits WHERE escrow_id=?', e.id) });
});
app.get('/api/escrow/:id/splits', (req, res) => res.json(all('SELECT * FROM escrow_splits WHERE escrow_id=?', req.params.id)));

// --- B2C platform trafik havuzu (sıfır CAC lead'ler + $300 prim + %8-12 komisyon) ---
app.get('/api/b2c', (req, res) => {
  const ps = all(`SELECT p.*, (SELECT MAX(total) FROM offers o WHERE o.patient_id=p.id) offer_total FROM patients p ORDER BY p.id DESC LIMIT 12`);
  const rows = ps.slice(0, 8).map((p, i) => ({
    patient_id: p.id, name: p.name, nationality: p.nationality,
    channel: ['HealthTürkiye B2C', 'Partner Portal', 'Sigorta Yönlendirme', 'SGK Anlaşmalı'][i % 4],
    cac: 0, bonus_usd: 300,
    commission_pct: 8 + (i % 5),                       // %8-%12
    offer_total: p.offer_total || 0,
    commission: +(((p.offer_total || 0) * (8 + (i % 5)) / 100)).toFixed(0),
    status: p.lead_status,
  }));
  res.json({
    rows,
    totals: {
      leads: rows.length, zero_cac: rows.length,
      bonus_usd: rows.length * 300,
      commission_eur: rows.reduce((s, r) => s + r.commission, 0),
    },
  });
});

// --- Yerel doktor konsültasyon onayları ($100-250 ek hizmet modeli) ---
app.get('/api/local-consults', (req, res) => res.json(all(`SELECT c.*, p.name patient_name FROM local_consults c JOIN patients p ON p.id=c.patient_id ORDER BY c.id DESC`)));
app.post('/api/local-consults', (req, res) => {
  const { patient_id, local_doctor, city, fee } = req.body || {};
  if (!patient_id) return res.status(400).json({ error: 'Hasta zorunlu' });
  const r = run('INSERT INTO local_consults (patient_id,local_doctor,city,fee) VALUES (?,?,?,?)',
    patient_id, local_doctor || 'Dr. Local', city || 'London', +fee || 150);
  res.json(get('SELECT * FROM local_consults WHERE id=?', r.lastInsertRowid));
});
app.post('/api/local-consults/:id/approve', (req, res) => {
  const c = get('SELECT * FROM local_consults WHERE id=?', req.params.id);
  if (!c) return res.status(404).end();
  run("UPDATE local_consults SET status='approved' WHERE id=?", c.id);
  run('INSERT INTO transactions (account_id,patient_id,kind,category,amount,description) VALUES (?,?,?,?,?,?)',
    1, c.patient_id, 'income', 'medical', c.fee, 'Yerel doktor konsültasyon ücreti');
  io.emit('postop', {});
  res.json({ ok: true });
});

app.get('/insurance/policy', (req, res) => {
  const o = get('SELECT * FROM insurance_offers WHERE id=?', req.query.offer || 0);
  res.send(`<html><head><meta charset="utf-8"><title>Poliçe — ${o ? o.provider : ''}</title>
    <style>body{font-family:sans-serif;background:#0f1420;color:#e8ecf6;display:grid;place-items:center;min-height:100vh}
    .card{background:#161d2e;border:1px solid #263154;border-radius:14px;padding:40px;max-width:520px}</style></head>
    <body><div class="card"><h1>${o ? o.provider : 'Poliçe'}</h1>
    <p>${o ? o.coverage : ''}</p><p><b>Prim: €${o ? o.price : ''}</b></p>
    <p style="color:#8b96b8">Bu bir simülasyon poliçe sayfasıdır. Poliçe kesme entegrasyonu buraya bağlanır.</p>
    <a href="/" style="color:#4f7cff">← Panele dön</a></div></body></html>`);
});

// --- FX: TCMB daily rates (fetch best-effort, keep mock fallback) ---
async function refreshFx() {
  try {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 6000);
    const r = await fetch('https://www.tcmb.gov.tr/kurlar/today.xml', { signal: ac.signal });
    const xml = await r.text();
    for (const code of ['USD', 'EUR', 'GBP']) {
      const m = xml.match(new RegExp(`<Currency[^>]*CurrencyCode="${code}"[\\s\\S]*?<ForexSelling>([\\d.,]+)</ForexSelling>`));
      if (m) run('UPDATE fx_rates SET rate=?, updated_at=datetime(\'now\') WHERE code=?', parseFloat(m[1].replace(',', '.')), code);
    }
  } catch (_) { /* keep seeded rates */ }
}
refreshFx();
app.get('/api/fx', (req, res) => res.json(all('SELECT * FROM fx_rates')));

// --- net profit calculator & commission rules ---
app.get('/api/profit/:patientId', (req, res) => {
  const pid = req.params.patientId;
  const p = get('SELECT * FROM patients WHERE id=?', pid);
  if (!p) return res.status(404).end();
  const t = all('SELECT kind,category,SUM(amount) s FROM transactions WHERE patient_id=? GROUP BY kind,category', pid);
  const income = t.filter(x => x.kind === 'income').reduce((s, x) => s + x.s, 0);
  const cats = { hospital: 0, hotel: 0, transfer: 0, commission: 0, ads: 0, flight: 0, medical: 0, other: 0 };
  for (const x of t.filter(y => y.kind === 'expense')) cats[x.category] = (cats[x.category] || 0) + x.s;
  const net = income - Object.values(cats).reduce((a, b) => a + b, 0);
  res.json({ patient: p.name, income, costs: cats, net_profit: net });
});
app.get('/api/commissions', (req, res) => {
  const rules = all(`SELECT cr.*, a.name agent_name FROM commission_rules cr JOIN agents a ON a.id=cr.agent_id`);
  const out = rules.map(r => {
    // rep's handled patients via assigned conversations
    const income = get(`SELECT COALESCE(SUM(t.amount),0) s FROM transactions t
      JOIN conversations c ON c.patient_id=t.patient_id
      WHERE t.kind='income' AND c.assigned_agent_id=?`, r.agent_id).s;
    const comm = income <= r.threshold ? income * r.flat_pct / 100
      : r.threshold * r.flat_pct / 100 + (income - r.threshold) * r.tiered_pct / 100;
    return { agent: r.agent_name, rule: `%${r.flat_pct} flat / ${r.threshold}€ üzeri %${r.tiered_pct}`, income, commission: Math.round(comm * 100) / 100 };
  });
  res.json(out);
});

// --- incentive checklist v2 + pool + zip export ---
const REQUIRED_DOCS = [
  ['boarding_pass', 'Boarding Pass (uçuş kartı)'],
  ['passport', 'Pasaport fotokopisi'],
  ['hospital_invoice', 'Hastane faturası'],
  ['service_contract', 'Hizmet sözleşmesi / onaylı teklif'],
];
function patientChecklist(pid) {
  const p = get('SELECT * FROM patients WHERE id=?', pid);
  const files = all('SELECT * FROM files WHERE patient_id=?', pid);
  const flights = all("SELECT * FROM bookings WHERE patient_id=? AND kind='flight'", pid);
  const invs = all('SELECT * FROM invoices WHERE patient_id=?', pid);
  const offers = all("SELECT * FROM offers WHERE patient_id=? AND status IN ('approved','paid')", pid);
  const ins = all("SELECT * FROM bookings WHERE patient_id=? AND kind='insurance'", pid);
  return {
    patient: p,
    // 5. destekleyici belge — zorunlu değil, havuz aktarımını engellemez
    supporting: [{ key: 'insurance', doc: 'Sigorta poliçesi (destekleyici belge)',
      present: ins.length > 0 || files.some(f => f.category === 'insurance') }],
    docs: REQUIRED_DOCS.map(([key, doc]) => {
      let present = false;
      if (key === 'boarding_pass') present = flights.length > 0 || files.some(f => f.category === 'boarding_pass');
      if (key === 'passport') present = !!p.passport_no || files.some(f => f.category === 'passport');
      if (key === 'hospital_invoice') present = invs.length > 0 || files.some(f => f.category === 'invoice');
      if (key === 'service_contract') present = offers.length > 0 || files.some(f => f.category === 'contract');
      return { key, doc, present };
    }),
  };
}
app.get('/api/checklist/:patientId', (req, res) => {
  const r = patientChecklist(req.params.patientId);
  if (!r.patient) return res.status(404).end();
  res.json({ ...r, complete: r.docs.every(d => d.present) });
});
app.post('/api/incentive/pool/:patientId', (req, res) => {
  const r = patientChecklist(req.params.patientId);
  if (!r.patient) return res.status(404).end();
  const missing = r.docs.filter(d => !d.present).map(d => d.doc);
  if (missing.length) return res.status(409).json({ error: 'Eksik evrak — teşvik havuzuna aktarılamaz', missing });
  const rr = run('INSERT INTO incentive_packages (patient_id,docs,status,submitted_at) VALUES (?,?,?,datetime(\'now\'))',
    r.patient.id, JSON.stringify(r.docs), 'submitted');
  io.emit('incentive', {});
  res.json(get('SELECT * FROM incentive_packages WHERE id=?', rr.lastInsertRowid));
});
// one-click zip export with regulation-compliant filenames
app.get('/api/incentive/export/:patientId', (req, res) => {
  const pid = req.params.patientId;
  const p = get('SELECT * FROM patients WHERE id=?', pid);
  if (!p) return res.status(404).end();
  const chk = patientChecklist(pid);
  const slugify = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i').replace(/İ/g, 'I').replace(/ş/g, 's').replace(/Ş/g, 'S')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'G').replace(/ü/g, 'u').replace(/Ü/g, 'U')
    .replace(/ö/g, 'o').replace(/Ö/g, 'O').replace(/ç/g, 'c').replace(/Ç/g, 'C')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const safe = slugify(p.name);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="TESVIK_${safe}_${pid}.zip"`);
  const zip = new archiver.ZipArchive();
  zip.pipe(res);
  zip.append(JSON.stringify({ patient: p, docs: chk.docs, exported_at: new Date().toISOString() }, null, 2),
    { name: `00_Manifest_${safe}.json` });
  const label = { boarding_pass: '01_BoardingPass', passport: '02_Pasaport', hospital_invoice: '03_HastaneFaturasi', service_contract: '04_HizmetSozlesmesi' };
  for (const d of chk.docs) {
    const files = all("SELECT * FROM files WHERE patient_id=? AND category=?", pid, d.key === 'hospital_invoice' ? 'invoice' : d.key === 'boarding_pass' ? 'boarding_pass' : d.key);
    if (files.length && files[0].path) {
      const fp = path.join(__dirname, files[0].path.replace('/uploads/', 'uploads/'));
      if (fs.existsSync(fp)) zip.file(fp, { name: `${label[d.key]}_${safe}${path.extname(files[0].filename)}` });
    } else {
      zip.append(`BELGE: ${d.doc}\nHASTA: ${p.name} (${p.passport_no || 'pasaport yok'})\nDURUM: ${d.present ? 'Sistemde mevcut (otomatik üretildi)' : 'EKSİK'}\n`, { name: `${label[d.key]}_${safe}.txt` });
    }
  }
  zip.append(all('SELECT * FROM invoices WHERE patient_id=?', pid).map(i => `FATURA ${i.number} | ${i.amount} ${i.currency} | ${i.status} | İVD:${i.ivd_ref || '-'}`).join('\n'),
    { name: `05_Faturalar_${safe}.txt` });
  zip.finalize();
});

// --- patient cari (hasta carisi) ---
app.get('/api/patients/:id/cari', (req, res) => {
  const t = all('SELECT * FROM transactions WHERE patient_id=? ORDER BY id', req.params.id);
  const bal = t.reduce((s, x) => s + (x.kind === 'income' ? x.amount : -x.amount), 0);
  res.json({ transactions: t, balance: bal });
});

// --- Hipokrat AI asistan: yardımcı sohbet ---
function hipokratReply(msgRaw) {
  const msg = (msgRaw || '').toLowerCase();
  const say = (reply) => ({ reply });
  if (/\b(merhaba|selam|hello|hi|hey)\b/.test(msg) && msg.length < 20)
    return say('Merhaba! Ben Hipokrat, acentenizin AI asistanıyım. "durum özeti", "sla durumu", "gelir durumu", "teşvik eksik evrak", "yeni hasta simüle et" gibi komutları deneyebilirsiniz.');
  if (/sla/.test(msg)) {
    const k = get("SELECT COUNT(*) c FROM conversations WHERE sla_responded=0 AND sla_deadline IS NOT NULL AND sla_deadline < ?", Date.now());
    const open = get("SELECT COUNT(*) c FROM conversations WHERE sla_responded=0 AND sla_deadline IS NOT NULL").c;
    return say(`SLA durumu: ${open} açık SLA sayacı, ${k.c} aşım. Aşım varsa takım lideri ve 5 dk sonrasında üst yönetici otomatik bilgilendirilir.`);
  }
  if (/durum|özet|summary|kpi/.test(msg)) {
    const k = get(`SELECT (SELECT COUNT(*) FROM patients) p,
      (SELECT COUNT(*) FROM patients WHERE lead_status!='completed') l,
      (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE kind='income') rev,
      (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE kind='expense') exp,
      (SELECT COUNT(*) FROM rfqs WHERE status='pending') rfq`);
    return say(`Özet: ${k.p} hasta (${k.l} açık lead), gelir €${k.rev.toLocaleString('tr-TR')}, gider €${k.exp.toLocaleString('tr-TR')}, net €${(k.rev - k.exp).toLocaleString('tr-TR')}, ${k.rfq} bekleyen RFQ.`);
  }
  if (/gelir|kâr|kar|muhasebe|finans/.test(msg)) {
    const p = get(`SELECT COALESCE(SUM(CASE WHEN kind='income' THEN amount END),0) i,
      COALESCE(SUM(CASE WHEN kind='expense' THEN amount END),0) e FROM transactions`);
    const kdv = get("SELECT COALESCE(SUM(CASE WHEN direction='sales' THEN kdv_amount END),0) - COALESCE(SUM(CASE WHEN direction='purchase' THEN kdv_amount END),0) p FROM invoices");
    return say(`Finans: gelir €${p.i.toLocaleString('tr-TR')}, gider €${p.e.toLocaleString('tr-TR')}, net kâr €${(p.i - p.e).toLocaleString('tr-TR')}. Ödenecek KDV tahmini: €${(kdv.p || 0).toLocaleString('tr-TR')}.`);
  }
  if (/rfq|doktor|hekim|görüş|teklif/.test(msg) && !/teklif mektubu|teklif oluştur/.test(msg)) {
    const r = all(`SELECT r.id, d.name dn, d.specialty, p.name pn FROM rfqs r JOIN doctors d ON d.id=r.doctor_id
      JOIN patients p ON p.id=r.patient_id WHERE r.status='pending' LIMIT 5`);
    return r.length ? say(`Bekleyen RFQ'lar: ${r.map(x => `#${x.id} ${x.dn} (${x.specialty}) ← ${x.pn}`).join('; ')}`)
      : say('Şu anda bekleyen RFQ yok. AI eşleştirme veya manuel filtreyle hekimlere RFQ gönderebilirsiniz.');
  }
  if (/uçu|flight|uçak/.test(msg)) {
    const f = all("SELECT b.*, p.name pn FROM bookings b JOIN patients p ON p.id=b.patient_id WHERE b.kind='flight' ORDER BY b.id DESC LIMIT 5");
    return f.length ? say('Uçuşlar: ' + f.map(x => `${x.ref_label} (${x.pn}) — ${x.flight_status || 'Scheduled'}`).join('; '))
      : say('Kayıtlı uçuş rezervasyonu yok. Lojistik sekmesinden uçuş rezervasyonu oluşturabilirsiniz.');
  }
  if (/transfer|şoför|soför|araç|arac/.test(msg)) {
    const t = get("SELECT COUNT(*) c FROM driver_tasks WHERE status='in_progress'").c;
    const p = get("SELECT COUNT(*) c FROM driver_tasks WHERE status='pending'").c;
    return say(`Transfer durumu: ${t} aktif görev, ${p} bekleyen görev. Canlı harita Lojistik sekmesinde.`);
  }
  if (/teşvik|tesvik|evrak|ushaş|ushas/.test(msg)) {
    const inc = get('SELECT COUNT(*) c FROM incentive_packages').c;
    const us = get("SELECT COUNT(*) c FROM usha_notifications WHERE status='acknowledged'").c;
    return say(`Teşvik: ${inc} paket oluşturuldu, ${us} onaylı USHAŞ bildirimi var. Eksik evraklı hasta havuza aktarılamaz — checklist'i Uyum sekmesinden kontrol edin.`);
  }
  if (/kur|döviz|doviz|euro|dolar|tl|tlmb|tcmb/.test(msg)) {
    const fx = all('SELECT * FROM fx_rates');
    return say('TCMB güncel kurlar: ' + fx.map(f => `${f.code} = ₺${f.rate}`).join(', ') + '.');
  }
  if (/temsilci|takım|ekip|agent|kim/.test(msg)) {
    const a = all("SELECT name,role,languages FROM agents WHERE role IN ('rep','leader','exec') AND active=1");
    return say('Ekip: ' + a.map(x => `${x.name} (${x.role}, ${x.languages})`).join('; '));
  }
  if (/hasta|patient|lead/.test(msg) && /kaç|kac|sayı|count|listele/.test(msg)) {
    const c = get('SELECT COUNT(*) c FROM patients').c;
    const l = all('SELECT lead_status s, COUNT(*) c FROM patients GROUP BY lead_status');
    return say(`${c} hasta kayıtlı: ${l.map(x => `${leadName(x.s)} ${x.c}`).join(', ')}.`);
  }
  if (/simüle|simule|yeni mesaj|gelen mesaj/.test(msg)) {
    return say('Yeni hasta mesajı simüle etmek için Gelen Kutusu\'ndaki "+ Gelen mesaj simüle et" butonunu veya "Otomatik sim" anahtarını kullanabilirsiniz.');
  }
  return say('Bunu tam anlayamadım. Deneyebilecekleriniz: "durum özeti", "sla durumu", "gelir", "bekleyen rfq", "uçuşlar", "transfer durumu", "teşvik", "kurlar", "ekip", "kaç hasta var".');
}
const LEAD_NAMES = { new: 'Yeni', quoted: 'Teklif Verildi', agreed: 'Anlaşıldı', in_operation: 'Operasyonda', completed: 'Tamamlandı' };
function leadName(s) { return LEAD_NAMES[s] || s; }
app.post('/api/hipokrat', (req, res) => res.json(hipokratReply(req.body.message)));

io.on('connection', (s) => { s.emit('hello', { ts: Date.now() }); });

// ================= PANEL 1: Post-Op AI & Erken Uyarı =================
function notify(message, kind) {
  run('INSERT INTO notifications (kind,agent_id,conversation_id,message) VALUES (?,?,?,?)', kind || 'info', null, null, message);
  io.emit('notify', { kind: kind || 'info', message });
}
const RED_WORDS = /kanama|ateş|ates|fever|bleeding|enfeksiyon|infection|şişlik|sislik|ödem|odem|nefes|kusma|bulantı|ırıltı|irin|pus|swelling/i;
function analyzeCheckin(c) {
  if (c.pain_score >= 7 || (c.satisfaction != null && c.satisfaction <= 2) || (c.note && RED_WORDS.test(c.note)) || (c.photo_note && RED_WORDS.test(c.photo_note)))
    return { flag: 'red', msg: `Yüksek risk: ağrı ${c.pain_score}/10, memnuniyet ${c.satisfaction}/5 — komplikasyon/olumsuz deneyim riski` };
  if (c.pain_score >= 5 || c.satisfaction === 3)
    return { flag: 'watch', msg: `İzlem gerekli: ağrı ${c.pain_score}/10` };
  return { flag: 'ok' };
}
function openPostopAlert(pid, level, message) {
  const r = run('INSERT INTO postop_alerts (patient_id,level,message) VALUES (?,?,?)', pid, level, message);
  const p = get('SELECT name FROM patients WHERE id=?', pid);
  const alert = get('SELECT * FROM postop_alerts WHERE id=?', r.lastInsertRowid);
  notify(`🔴 POST-OP KIRMIZI ALARM — ${p ? p.name : ''}: ${message}`, 'alert');
  io.emit('postop_alert', { ...alert, patient_name: p ? p.name : '' });
  return alert;
}
const postopDay = since => Math.max(0, Math.floor(get("SELECT julianday('now') - julianday(?) d", since).d));

app.get('/api/postop', (req, res) => {
  const rows = all(`SELECT p.id, p.name, p.nationality, p.lead_status, p.postop_since,
      (SELECT COUNT(*) FROM postop_checkins c WHERE c.patient_id=p.id) checkins,
      (SELECT COUNT(*) FROM postop_alerts a WHERE a.patient_id=p.id AND a.status='open') open_alerts,
      (SELECT ai_flag FROM postop_checkins c WHERE c.patient_id=p.id ORDER BY id DESC LIMIT 1) last_flag,
      (SELECT pain_score FROM postop_checkins c WHERE c.patient_id=p.id ORDER BY id DESC LIMIT 1) last_pain
    FROM patients p WHERE p.postop_since IS NOT NULL ORDER BY open_alerts DESC, p.postop_since`);
  res.json(rows.map(r => ({ ...r, day: postopDay(r.postop_since) })));
});
app.get('/api/postop/:pid', (req, res) => {
  const pid = req.params.pid;
  res.json({
    patient: get('SELECT * FROM patients WHERE id=?', pid),
    day: postopDay(get('SELECT postop_since s FROM patients WHERE id=?', pid)?.s || 'now'),
    checkins: all('SELECT * FROM postop_checkins WHERE patient_id=? ORDER BY day DESC, id DESC', pid),
    alerts: all('SELECT * FROM postop_alerts WHERE patient_id=? ORDER BY id DESC', pid),
  });
});
app.post('/api/postop/:pid/checkin', (req, res) => {
  const pid = req.params.pid;
  const c = req.body;
  const a = analyzeCheckin(c);
  const r = run('INSERT INTO postop_checkins (patient_id,day,pain_score,satisfaction,note,photo_note,ai_flag) VALUES (?,?,?,?,?,?,?)',
    pid, c.day || null, c.pain_score ?? 0, c.satisfaction ?? null, c.note || null, c.photo_note || null, a.flag);
  if (a.flag === 'red') openPostopAlert(pid, 'red', a.msg);
  else if (a.flag === 'watch') io.emit('postop_watch', { patient_id: pid, message: a.msg });
  res.json({ ...get('SELECT * FROM postop_checkins WHERE id=?', r.lastInsertRowid), analysis: a });
});
app.post('/api/postop/:pid/simulate', (req, res) => {
  const pid = req.params.pid;
  const day = postopDay(get('SELECT postop_since s FROM patients WHERE id=?', pid)?.s || 'now');
  const risk = req.body.risk;
  const ok = [
    { pain_score: 2, satisfaction: 5, note: 'İyileşme iyi gidiyor, moraller yüksek.', photo_note: 'Kesi bölgesi temiz' },
    { pain_score: 3, satisfaction: 4, note: 'Hafif ağrı var, normal seyrinde.', photo_note: 'Normal iyileşme görünümü' },
    { pain_score: 1, satisfaction: 5, note: 'Ağrı yok denecek kadar az.', photo_note: 'Dikişler kapanıyor' },
  ];
  const bad = [
    { pain_score: 8, satisfaction: 2, note: 'Kesi bölgesinde şişlik ve ateş var.', photo_note: 'Belirgin ödem ve kızarıklık' },
    { pain_score: 7, satisfaction: 2, note: 'Gece kanama oldu, çok endişeliyim.', photo_note: 'Kesi hattında akıntı' },
    { pain_score: 6, satisfaction: 2, note: 'Bulantı ve sürekli ağrı var.', photo_note: 'Bölgede morarma arttı' },
  ];
  const c = { ...(risk === 'red' ? bad : ok)[Math.floor(Math.random() * 3)], day };
  const a = analyzeCheckin(c);
  const r = run('INSERT INTO postop_checkins (patient_id,day,pain_score,satisfaction,note,photo_note,ai_flag) VALUES (?,?,?,?,?,?,?)',
    pid, c.day, c.pain_score, c.satisfaction, c.note, c.photo_note, a.flag);
  if (a.flag === 'red') openPostopAlert(pid, 'red', a.msg);
  res.json({ ...get('SELECT * FROM postop_checkins WHERE id=?', r.lastInsertRowid), analysis: a });
});
app.post('/api/postop/alerts/:id/intervene', (req, res) => {
  const { action } = req.body;
  const al = get('SELECT * FROM postop_alerts WHERE id=?', req.params.id);
  if (!al) return res.status(404).end();
  const label = { video_consult: 'Görüntülü doktor görüşmesi teklif edildi', call: 'Hasta telefonla arandı', dismiss: 'Alarm kapatıldı' }[action] || action;
  run('UPDATE postop_alerts SET status=?, action_taken=?, resolved_at=datetime(\'now\') WHERE id=?',
    action === 'dismiss' ? 'resolved' : 'intervened', label, al.id);
  const p = get('SELECT name FROM patients WHERE id=?', al.patient_id);
  notify(`Post-op müdahale (${p ? p.name : ''}): ${label}`, 'postop');
  res.json(get('SELECT * FROM postop_alerts WHERE id=?', al.id));
});

// ================= PANEL 2: Dinamik Bütçe & Maliyet Sapma =================
app.get('/api/variance', (req, res) => {
  const CATMAP = { medical: ['hospital', 'medical'], hotel: ['hotel'], transport: ['transfer', 'transport'], ads: ['ads'], commission: ['commission'] };
  const patientsWithOffers = all(`SELECT DISTINCT p.id, p.name, p.nationality, p.lead_status FROM patients p
    JOIN offers o ON o.patient_id = p.id ORDER BY p.name`);
  const rows = patientsWithOffers.map(p => {
    const offers = all(`SELECT * FROM offers WHERE patient_id=? AND status IN ('sent','approved','paid')`, p.id);
    const est = { medical: 0, hotel: 0, transport: 0, other: 0 };
    let estTotal = 0;
    offers.forEach(o => JSON.parse(o.items || '[]').forEach(i => {
      const k = CATMAP[i.kind] ? i.kind : 'other';
      est[k] = (est[k] || 0) + (i.price || 0); estTotal += i.price || 0;
    }));
    const txns = all(`SELECT category, SUM(amount) s FROM transactions WHERE patient_id=? AND kind='expense' GROUP BY category`, p.id);
    const act = { medical: 0, hotel: 0, transport: 0, other: 0 };
    let actTotal = 0;
    txns.forEach(t => {
      let k = 'other';
      for (const [key, cats] of Object.entries(CATMAP)) if (cats.includes(t.category)) k = key;
      act[k] += t.s; actTotal += t.s;
    });
    const income = get(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE patient_id=? AND kind='income'`, p.id).s;
    const variance = actTotal - estTotal;
    const variancePct = estTotal ? Math.round(variance / estTotal * 1000) / 10 : 0;
    return { patient_id: p.id, name: p.name, nationality: p.nationality, lead_status: p.lead_status,
      estimated: est, est_total: Math.round(estTotal), actual: act, act_total: Math.round(actTotal),
      income, variance: Math.round(variance), variance_pct: variancePct,
      net: Math.round(income - actTotal), flag: variancePct > 10 ? 'red' : variancePct > 0 ? 'warn' : 'ok' };
  });
  res.json({
    patients: rows,
    totals: {
      est: Math.round(rows.reduce((s, r) => s + r.est_total, 0)),
      act: Math.round(rows.reduce((s, r) => s + r.act_total, 0)),
      income: Math.round(rows.reduce((s, r) => s + r.income, 0)),
      overruns: rows.filter(r => r.flag !== 'ok').length,
    },
  });
});

// ================= PANEL 3: B2B Sub-Agent Portalı =================
app.get('/api/subagents', (req, res) => {
  res.json(all('SELECT * FROM subagents ORDER BY name').map(s => {
    const ps = all('SELECT id,name,lead_status FROM patients WHERE subagent_id=?', s.id);
    const earned = get(`SELECT COALESCE(SUM(i.amount),0) t FROM invoices i
      JOIN patients p ON p.id=i.patient_id WHERE p.subagent_id=? AND i.direction='sales'`, s.id).t;
    return { ...s, patient_count: ps.length, stages: ps, commission_earned: Math.round(earned * s.commission_pct / 100), invoice_base: Math.round(earned) };
  }));
});
app.get('/api/subagents/:id', (req, res) => {
  const s = get('SELECT * FROM subagents WHERE id=?', req.params.id);
  if (!s) return res.status(404).end();
  const patients = all(`SELECT p.id,p.name,p.nationality,p.lead_status,p.created_at,
      (SELECT COALESCE(SUM(amount),0) FROM invoices i WHERE i.patient_id=p.id AND i.direction='sales') invoice_total
    FROM patients p WHERE p.subagent_id=? ORDER BY p.created_at DESC`, s.id);
  res.json({ ...s, patients: patients.map(p => ({ ...p, commission: Math.round(p.invoice_total * s.commission_pct / 100 * 100) / 100 })) });
});
app.post('/api/subagents', (req, res) => {
  const { name, country, contact, commission_pct } = req.body;
  const r = run('INSERT INTO subagents (name,country,contact,commission_pct) VALUES (?,?,?,?)', name, country, contact || null, commission_pct || 10);
  res.json(get('SELECT * FROM subagents WHERE id=?', r.lastInsertRowid));
});

// ================= PANEL 4: Klinik & Hastane Cari Takip =================
app.get('/api/receivables', (req, res) => {
  run(`UPDATE hospital_receivables SET status='overdue' WHERE status='expected' AND due_date < date('now')`);
  res.json(all(`SELECT r.*, a.name hospital_name, p.name patient_name FROM hospital_receivables r
    LEFT JOIN accounts a ON a.id=r.account_id LEFT JOIN patients p ON p.id=r.patient_id
    ORDER BY CASE r.status WHEN 'overdue' THEN 0 WHEN 'expected' THEN 1 ELSE 2 END, r.due_date`));
});
app.post('/api/receivables', (req, res) => {
  const { account_id, patient_id, amount, due_date } = req.body;
  const r = run('INSERT INTO hospital_receivables (account_id,patient_id,amount,due_date) VALUES (?,?,?,?)',
    account_id, patient_id || null, amount, due_date);
  res.json(get('SELECT * FROM hospital_receivables WHERE id=?', r.lastInsertRowid));
});
app.post('/api/receivables/:id/collect', (req, res) => {
  const r0 = get('SELECT * FROM hospital_receivables WHERE id=?', req.params.id);
  if (!r0) return res.status(404).end();
  run(`UPDATE hospital_receivables SET status='collected', collected_at=datetime('now') WHERE id=?`, r0.id);
  const acc = get('SELECT name FROM accounts WHERE id=?', r0.account_id);
  run(`INSERT INTO transactions (patient_id,account_id,kind,category,amount,currency,description) VALUES (?,?,?,?,?,?,?)`,
    r0.patient_id, 1, 'income', 'commission', r0.amount, r0.currency,
    `Hastane komisyon tahsilatı — ${acc ? acc.name : 'klinik'}`);
  notify(`Komisyon tahsil edildi: ${acc ? acc.name : ''} ${r0.amount} ${r0.currency}`, 'accounting');
  io.emit('receivable_collected', get('SELECT * FROM hospital_receivables WHERE id=?', r0.id));
  res.json(get('SELECT * FROM hospital_receivables WHERE id=?', r0.id));
});

// ================= PANEL 5: Saha Kiosk (OCR + KVKK e-imza) =================
const OCR_POOL = [
  { name: 'Yusuf Al-Mansouri', passport_no: 'QA-881234', nationality: 'Qatar', dob: '1988-04-12' },
  { name: 'Elena Petrova', passport_no: 'RU-440921', nationality: 'Russia', dob: '1991-09-03' },
  { name: 'Markus Steiner', passport_no: 'DE-773812', nationality: 'Germany', dob: '1979-12-30' },
  { name: 'Amir Hosseini', passport_no: 'IR-229087', nationality: 'Iran', dob: '1995-06-18' },
];
app.post('/api/field/ocr', (req, res) => {
  const pid = req.body.patient_id;
  const p = pid ? get('SELECT name,passport_no,nationality FROM patients WHERE id=?', pid) : null;
  const data = p && p.passport_no
    ? { name: p.name, passport_no: p.passport_no, nationality: p.nationality, dob: '—' }
    : OCR_POOL[Math.floor(Math.random() * OCR_POOL.length)];
  res.json({ ok: true, engine: 'HTA-OCR-sim v1.2', confidence: 0.97, data });
});
app.get('/api/field/arrivals', (req, res) => {
  res.json(all(`SELECT b.id booking_id, b.ref_label, b.flight_status, p.id patient_id, p.name patient_name, p.nationality, p.passport_no
    FROM bookings b JOIN patients p ON p.id=b.patient_id WHERE b.kind='flight' ORDER BY b.id DESC LIMIT 12`));
});
app.get('/api/kvkk/:pid', (req, res) => {
  res.json(all('SELECT * FROM kvkk_forms WHERE patient_id=? ORDER BY id DESC', req.params.pid));
});
app.post('/api/kvkk', (req, res) => {
  const { patient_id, form_type, signer_name, passport_no, signature, ocr } = req.body;
  const p = get('SELECT * FROM patients WHERE id=?', patient_id);
  if (!p) return res.status(404).json({ error: 'Hasta bulunamadı' });
  const hash = 'ESIGN-' + crypto.createHash('sha256').update((signature || 'sig') + '|' + patient_id + '|' + form_type + '|' + Date.now()).digest('hex').toUpperCase();
  const r = run('INSERT INTO kvkk_forms (patient_id,form_type,signer_name,passport_no,signature_hash,ocr_json) VALUES (?,?,?,?,?,?)',
    patient_id, form_type || 'kvkk', signer_name || p.name, passport_no || p.passport_no, hash, JSON.stringify(ocr || {}));
  const fname = `${form_type === 'consent' ? 'Tibbi_Onay' : 'KVKK_Onay'}_${(signer_name || p.name).replace(/\s+/g, '_')}_${hash.slice(-6)}`;
  run('INSERT INTO files (patient_id,filename,category) VALUES (?,?,?)', patient_id, fname + '.esign', 'contract');
  notify(`${p.name}: ${form_type === 'consent' ? 'Tıbbi onay' : 'KVKK'} formu dijital imzalandı ✓ (${hash})`, 'kvkk');
  io.emit('kvkk_signed', { patient_id: +patient_id, form_type, hash });
  res.json({ ...get('SELECT * FROM kvkk_forms WHERE id=?', r.lastInsertRowid) });
});

// ================= v5: Pazarlama (CAC/ROAS) + Paket Oluşturucu =================
app.get('/api/marketing', (req, res) => {
  const camps = all('SELECT * FROM ad_campaigns ORDER BY spend DESC');
  const byCountry = {};
  for (const c of camps) {
    const k = c.country;
    const o = byCountry[k] = byCountry[k] || { country: k, spend: 0, leads: 0, conversions: 0, revenue: 0 };
    o.spend += c.spend; o.leads += c.leads; o.conversions += c.conversions; o.revenue += c.revenue;
  }
  const countries = Object.values(byCountry).map(o => ({ ...o,
    cac: o.leads ? Math.round(o.spend / o.leads) : 0,
    roas: o.spend ? +(o.revenue / o.spend).toFixed(2) : 0,
    conv_rate: o.leads ? +(100 * o.conversions / o.leads).toFixed(1) : 0,
  })).sort((a, b) => b.revenue - a.revenue);
  const tot = camps.reduce((s, c) => ({ spend: s.spend + c.spend, leads: s.leads + c.leads,
    conv: s.conv + c.conversions, rev: s.rev + c.revenue }), { spend: 0, leads: 0, conv: 0, rev: 0 });
  res.json({
    campaigns: camps.map(c => ({ ...c, cac: c.leads ? Math.round(c.spend / c.leads) : 0,
      roas: c.spend ? +(c.revenue / c.spend).toFixed(2) : 0 })),
    countries,
    totals: { ...tot, cac: tot.leads ? Math.round(tot.spend / tot.leads) : 0,
      roas: tot.spend ? +(tot.rev / tot.spend).toFixed(2) : 0 },
    connected: { meta: true, google: true },
  });
});
app.post('/api/marketing/campaigns', (req, res) => {
  const { channel, country, name, spend } = req.body || {};
  if (!channel || !country || !name) return res.status(400).json({ error: 'channel, country, name zorunlu' });
  const r = run('INSERT INTO ad_campaigns (channel,country,name,spend) VALUES (?,?,?,?)', channel, country, name, +spend || 0);
  res.json(get('SELECT * FROM ad_campaigns WHERE id=?', r.lastInsertRowid));
});
app.post('/api/marketing/sync', (req, res) => {          // Meta/Google entegrasyon simülasyonu: günlük veri çek
  const camps = all('SELECT * FROM ad_campaigns');
  camps.forEach(c => {
    const dS = Math.round(50 + Math.random() * 150), dL = Math.round(Math.random() * 8);
    const dC = Math.random() < 0.35 ? 1 : 0, dR = dC ? 2200 + Math.round(Math.random() * 4000) : 0;
    run('UPDATE ad_campaigns SET spend=spend+?, leads=leads+?, conversions=conversions+?, revenue=revenue+? WHERE id=?',
      dS, dL, dC, dR, c.id);
  });
  notify('Meta & Google Ads senkronize edildi — günlük kampanya verileri güncellendi', 'marketing');
  res.json({ ok: true });
});

// --- Paket Oluşturucu ---
app.get('/api/treatments', (req, res) => res.json(all('SELECT * FROM treatments ORDER BY name')));
const HOTEL_PRICES = { 3: 90, 4: 130, 5: 190 };
const TRANSFER_PRICES = { sedan: 40, vito: 60, sprinter: 80 };
app.post('/api/packages/build', (req, res) => {
  const { patient_id, treatment_id, stars, nights, transfer, postop_package_id, lang } = req.body || {};
  const t = get('SELECT * FROM treatments WHERE id=?', treatment_id);
  const pkg = (postop_package_id ? get('SELECT * FROM postop_packages WHERE id=?', +postop_package_id) : null)
           || get('SELECT * FROM postop_packages ORDER BY price LIMIT 1');
  if (!patient_id || !t || !pkg) return res.status(400).json({ error: 'Hasta, tedavi ve post-op paket zorunlu' });
  const n = Math.max(1, +nights || 3), st = HOTEL_PRICES[+stars] || HOTEL_PRICES[4], tr = TRANSFER_PRICES[transfer] || TRANSFER_PRICES.vito;
  const { rfq_id, extras } = req.body || {};
  const rfq = rfq_id ? get('SELECT r.*, d.name dname, (SELECT price FROM doctor_quotes q WHERE q.rfq_id=r.id) quote_price FROM rfqs r JOIN doctors d ON d.id=r.doctor_id WHERE r.id=?', rfq_id) : null;
  const items = [
    rfq && rfq.quote_price
      ? { kind: 'medical', desc: `${t.name} — Dr. ${rfq.dname} (RFQ #${rfq.id})`, price: rfq.quote_price }
      : { kind: 'medical', desc: t.name + ' (' + t.name_en + ')', price: t.base_price },
    { kind: 'hotel',   desc: `${stars}★ Otel — ${n} gece`,   price: st * n },
    { kind: 'transfer', desc: 'VIP Transfer — ' + transfer,   price: tr },
  ].concat((extras || []).map(e => ({ kind: 'custom', desc: String(e.desc || 'Ek kalem').slice(0, 80), price: +e.price || 0 })).filter(e => e.price > 0));
  const total = items.reduce((s, i) => s + i.price, 0) + pkg.price;
  const token = crypto.randomBytes(10).toString('hex');
  const eur = get("SELECT rate FROM fx_rates WHERE code='EUR'"); 
  const r = run('INSERT INTO offers (patient_id,items,postop_package_id,total,status,share_token,lang,fx_locked) VALUES (?,?,?,?,?,?,?,?)',
    patient_id, JSON.stringify(items), pkg.id, total, 'draft', token, lang || 'en', eur ? eur.rate : null);
  const o = get('SELECT * FROM offers WHERE id=?', r.lastInsertRowid);
  res.json({ ...o, url: '/o/' + token });
});
const OFFER_LANGS = {
  en: { title: 'Treatment Offer Letter', dear: 'Dear', includes: 'Your package includes', postop: 'Post-Op Care Package', total: 'Total', approve: 'Approve (E-Sign)', pay: 'Pay Securely', valid: 'This offer is valid for 7 days. Prices are fixed — no hidden costs.', thx: 'HTA Health Tourism — Istanbul, Türkiye', dir: 'ltr' },
  tr: { title: 'Tedavi Teklif Mektubu', dear: 'Sayın', includes: 'Paketiniz şunları içerir', postop: 'Post-Op Takip Paketi', total: 'Toplam', approve: 'Onayla (E-İmza)', pay: 'Güvenli Öde', valid: 'Bu teklif 7 gün geçerlidir. Fiyatlar sabittir — gizli maliyet yoktur.', thx: 'HTA Sağlık Turizmi — İstanbul, Türkiye', dir: 'ltr' },
  ar: { title: 'خطاب عرض العلاج', dear: 'عزيزي', includes: 'تشمل باقتك', postop: 'حزمة الرعاية بعد العملية', total: 'الإجمالي', approve: 'موافقة (توقيع إلكتروني)', pay: 'دفع آمن', valid: 'هذا العرض صالح لمدة 7 أيام. الأسعار ثابتة — لا تكاليف خفية.', thx: 'HTA للسياحة العلاجية — إسطنبول، تركيا', dir: 'rtl' },
  de: { title: 'Behandlungsangebot', dear: 'Sehr geehrte/r', includes: 'Ihr Paket umfasst', postop: 'Post-Op Nachsorgepaket', total: 'Gesamt', approve: 'Genehmigen (E-Signatur)', pay: 'Sicher bezahlen', valid: 'Dieses Angebot ist 7 Tage gültig. Festpreise — keine versteckten Kosten.', thx: 'HTA Gesundheitstourismus — Istanbul, Türkei', dir: 'ltr' },
  ru: { title: 'Предложение на лечение', dear: 'Уважаемый(ая)', includes: 'Ваш пакет включает', postop: 'Пакет послеоперационного наблюдения', total: 'Итого', approve: 'Одобрить (Э-подпись)', pay: 'Оплатить', valid: 'Предложение действует 7 дней. Фиксированные цены — без скрытых расходов.', thx: 'HTA Медицинский туризм — Стамбул, Турция', dir: 'ltr' },
};
app.get('/o/:token', (req, res) => {
  const o = get('SELECT o.*, p.name pname, pp.name postop_name FROM offers o JOIN patients p ON p.id=o.patient_id LEFT JOIN postop_packages pp ON pp.id=o.postop_package_id WHERE o.share_token=?', req.params.token);
  if (!o) return res.status(404).send('Offer not found');
  const L = OFFER_LANGS[o.lang] || OFFER_LANGS.en;
  const items = JSON.parse(o.items || '[]');
  const row = i => `<tr><td>${i.desc}</td><td style="text-align:right">€${i.price.toLocaleString('en')}</td></tr>`;
  res.send(`<!doctype html><html dir="${L.dir}"><head><meta charset="utf-8"><title>${L.title}</title>
<style>body{font-family:-apple-system,'SF Pro',Segoe UI,Arial;background:#f4f5f7;margin:0;padding:24px}
.c{max-width:560px;margin:auto;background:#fff;border-radius:20px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
h1{font-size:20px}table{width:100%;border-collapse:collapse;margin:12px 0}td{padding:8px 4px;border-bottom:1px solid #eee}
.t{font-size:22px;font-weight:700}.b{display:block;width:100%;padding:14px;margin:10px 0;border:0;border-radius:12px;font-size:16px;cursor:pointer}
.a{background:#0a84ff;color:#fff}.p{background:#34c759;color:#fff}.mut{color:#888;font-size:13px}
.s{display:inline-block;padding:4px 10px;border-radius:8px;background:#eef;font-size:12px}</style></head>
<body><div class="c"><h1>✚ ${L.title}</h1><p class="mut">${L.thx}</p>
<p>${L.dear} <b>${o.pname}</b>,</p><p>${L.includes}:</p>
<table>${items.map(row).join('')}<tr><td>${L.postop}: ${o.postop_name || ''}</td><td style="text-align:right">€${(o.total - items.reduce((s, i) => s + i.price, 0)).toLocaleString('en')}</td></tr></table>
<p class="t">${L.total}: €${o.total.toLocaleString('en')}</p>
<p class="mut">${L.valid}</p><p>Status: <span class="s">${o.status}</span></p>
${o.status === 'sent' || o.status === 'draft' ? `
<div style="background:#f7f8fa;border-radius:12px;padding:14px;margin:12px 0;font-size:12px;color:#555;max-height:140px;overflow:auto">
<b>${o.lang === 'tr' ? 'UZAKTAN/MESAFELİ SAĞLIK TURİZMİ SATIŞ SÖZLEŞMESİ' : 'DISTANCE HEALTH TOURISM SALES AGREEMENT'}</b><br>
${o.lang === 'tr'
 ? 'Taraflar: HTA Sağlık Turizmi (hizmet sağlayıcı/acente) ve hasta. Konu: yukarıda listelenen tedavi, konaklama, transfer ve post-op takip hizmetlerinin sağlanması. Fiyatlar sabittir; belirtilen tutar kapora/toplam ödeme sanal POS üzerinden tahsil edilir. Hasta 14 gün içinde cayma hakkına sahiptir (mevzuat gereği).'
 : 'Parties: HTA Health Tourism (service provider/agency) and the patient. Subject: provision of the medical treatment, accommodation, transfer and post-op care services listed above. Prices are fixed; the stated deposit/total is collected via virtual POS. The patient has a 14-day right of withdrawal under applicable law.'}
</div>
<label style="display:flex;gap:8px;font-size:13px;margin:8px 0;align-items:flex-start"><input type="checkbox" id="ok" required style="margin-top:2px">
<span>${o.lang === 'tr'
 ? 'Sözleşmeyi ve KVKK/GDPR açık rıza metnini okudum, dijital imza ile kabul ediyorum.'
 : 'I have read and accept the agreement and the KVKK/GDPR explicit consent text via digital signature.'}</span></label>
<button class="b a" onclick="act('approve')">${L.approve}</button>` : ''}
${o.status === 'approved' ? `
<label class="mut">${o.lang === 'tr' ? 'Ödenecek tutar (kapora/toplam):' : 'Amount to pay (deposit/total):'}</label>
<input id="amt" type="number" value="${o.total}" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:12px;margin:6px 0">
<button class="b p" onclick="act('pay')">${L.pay}</button>` : ''}
<script>async function act(a){
 if(a==='approve' && !document.getElementById('ok').checked){alert('Please accept the agreement first.');return;}
 const body = a==='pay' ? JSON.stringify({amount:+document.getElementById('amt').value||undefined}) : '{}';
 const r=await fetch('/api/offers/${o.id}/'+a,{method:'POST',headers:{'Content-Type':'application/json'},body});
 if(r.ok)location.reload();}</script>
</div></body></html>`);
});
app.post('/api/offers/:id/deliver', (req, res) => {
  const o = get('SELECT * FROM offers WHERE id=?', req.params.id);
  if (!o) return res.status(404).end();
  const channel = (req.body || {}).channel === 'mail' ? 'email' : 'whatsapp';
  const conv = get('SELECT * FROM conversations WHERE patient_id=? ORDER BY id DESC LIMIT 1', o.patient_id)
    || { id: run('INSERT INTO conversations (patient_id,channel,subject) VALUES (?,?,?)', o.patient_id, channel, 'Teklif').lastInsertRowid };
  const link = '/o/' + o.share_token;
  run('INSERT INTO messages (conversation_id,direction,body,lang) VALUES (?,?,?,?)', conv.id, 'out',
    `Teklif mektubunuz hazır: ${link} — Toplam €${o.total.toLocaleString('en')} (${o.lang || 'en'})`, o.lang || 'en');
  run("UPDATE offers SET status='sent', delivered_via=? WHERE id=?", channel, o.id);
  notify(`Teklif ${channel === 'whatsapp' ? 'WhatsApp' : 'e-posta'} ile gönderildi (€${o.total.toLocaleString('en')})`, 'offer');
  io.emit('inbox', {});
  res.json({ ok: true, url: link });
});

// ---------- Dijital Anamnez (Dynamic Medical Data Collection) ----------
// Branşa özel soru setleri — type: slider | num | yn | text | file
const ANAMNESIS_SETS = {
  'Orthopedics': [
    { key: 'vas_pain', type: 'slider', min: 1, max: 10, tr: 'Ağrı Skoru (VAS) — 1 hafif, 10 dayanılmaz', en: 'Pain Score (VAS) — 1 mild, 10 unbearable' },
    { key: 'pain_duration', type: 'select', opts: ['<1 ay', '1-3 ay', '3-12 ay', '>1 yıl'], opts_en: ['<1 month', '1-3 months', '3-12 months', '>1 year'], tr: 'Ağrı süresi', en: 'Pain duration' },
    { key: 'walking_limit', type: 'yn', tr: 'Yürüme güçlüğünüz var mı?', en: 'Do you have difficulty walking?' },
    { key: 'mri_ct', type: 'file', tr: 'MR / BT filmleri (DICOM, PDF, JPG, MP4)', en: 'MRI / CT scans (DICOM, PDF, JPG, MP4)' },
  ],
  'Hair Transplant': [
    { key: 'photos', type: 'file', tr: 'Ön / yan / tepe saç fotoğrafları (JPG, PNG)', en: 'Front / side / top hair photos (JPG, PNG)' },
    { key: 'donor_area', type: 'select', opts: ['Güçlü', 'Orta', 'Zayıf', 'Bilmiyorum'], opts_en: ['Strong', 'Medium', 'Weak', 'Not sure'], tr: 'Donör (ense) alanı durumu', en: 'Donor (back of head) area condition' },
    { key: 'systemic_disease', type: 'text', tr: 'Sistemik hastalıklar (diyabet, tansiyon vb.)', en: 'Systemic diseases (diabetes, hypertension etc.)' },
    { key: 'smoking', type: 'yn', tr: 'Sigara kullanıyor musunuz?', en: 'Do you smoke?' },
  ],
  'Plastic Surgery': [
    { key: 'photos', type: 'file', tr: 'İlgili bölge fotoğrafları (JPG, PNG)', en: 'Photos of the relevant area (JPG, PNG)' },
    { key: 'prev_ops', type: 'text', tr: 'Daha önce geçirilen estetik operasyonlar', en: 'Previous aesthetic operations' },
    { key: 'expectation', type: 'text', tr: 'Beklentinizi kısaca anlatın', en: 'Briefly describe your expectation' },
  ],
  'Cardiology': [
    { key: 'chest_pain', type: 'select', opts: ['Baskı/yanma', 'Bıçak gibi', 'Künt', 'Nefesle artan'], opts_en: ['Pressure/burning', 'Stabbing', 'Dull', 'Worse with breathing'], tr: 'Ağrının karakteri', en: 'Character of chest pain' },
    { key: 'exertion', type: 'yn', tr: 'Ağrı eforla artıyor mu?', en: 'Does pain increase with exertion?' },
    { key: 'ht_dm', type: 'yn', tr: 'Hipertansiyon veya diyabet var mı?', en: 'Hypertension or diabetes?' },
    { key: 'ecg_echo', type: 'file', tr: 'EKG / EKO raporları (PDF, JPG)', en: 'ECG / ECHO reports (PDF, JPG)' },
  ],
  'Ophthalmology': [
    { key: 'glasses_no', type: 'text', tr: 'Gözlük/lens numaraları (varsa)', en: 'Glasses/lens prescription (if any)' },
    { key: 'eye_pressure', type: 'yn', tr: 'Göz tansiyonu tanısı aldınız mı?', en: 'Diagnosed with eye pressure (glaucoma)?' },
    { key: 'oct_fundus', type: 'file', tr: 'OCT / fundus görüntüleri (JPG, PDF)', en: 'OCT / fundus images (JPG, PDF)' },
  ],
  'Dentistry': [
    { key: 'missing_teeth', type: 'num', tr: 'Eksik diş sayısı', en: 'Number of missing teeth' },
    { key: 'opg', type: 'file', tr: 'Panoramik röntgen / OPG (JPG, PDF, DICOM)', en: 'Panoramic X-ray / OPG (JPG, PDF, DICOM)' },
  ],
  'Bariatric Surgery': [
    { key: 'comorbid', type: 'text', tr: 'Eşlik eden hastalıklar (uyku apnesi, diyabet vb.)', en: 'Comorbidities (sleep apnea, diabetes etc.)' },
    { key: 'endoscopy', type: 'file', tr: 'Endoskopi / kan tahlilleri (PDF, JPG)', en: 'Endoscopy / blood tests (PDF, JPG)' },
  ],
  'IVF & Fertility': [
    { key: 'amh', type: 'num', tr: 'AMH değeri (biliniyorsa)', en: 'AMH value (if known)' },
    { key: 'prev_attempts', type: 'num', tr: 'Daha önceki deneme sayısı', en: 'Number of previous attempts' },
    { key: 'hormone_tests', type: 'file', tr: 'Hormon testleri / ultrason raporları', en: 'Hormone tests / ultrasound reports' },
  ],
  'General Surgery': [
    { key: 'symptoms', type: 'text', tr: 'Şikâyetlerinizi kısaca anlatın', en: 'Briefly describe your symptoms' },
    { key: 'reports', type: 'file', tr: 'Varsa tahlil / rapor dosyaları', en: 'Lab results / reports if any' },
  ],
};
const ANAMNESIS_GENERAL = [
  { key: 'height', type: 'num', tr: 'Boy (cm)', en: 'Height (cm)' },
  { key: 'weight', type: 'num', tr: 'Kilo (kg)', en: 'Weight (kg)' },
  { key: 'blood', type: 'select', opts: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', '0+', '0-'], tr: 'Kan grubu', en: 'Blood type' },
  { key: 'allergies', type: 'text', tr: 'Alerjiler', en: 'Allergies' },
  { key: 'chronic_meds', type: 'text', tr: 'Sürekli kullandığınız ilaçlar', en: 'Chronic medications' },
  { key: 'past_surgeries', type: 'text', tr: 'Geçirilmiş ameliyatlar', en: 'Past surgeries' },
];
const ANAMNESIS_L = {
  en: { kvkk: 'I consent to processing of my personal & health data for treatment coordination under GDPR/KVKK explicit consent.', title: 'Medical Questionnaire', hi: 'Dear', intro: 'Please answer the questions so our doctors can evaluate your case.', upload: 'Upload files', submit: 'Submit', done: 'Thank you! Your information has been sent to your medical coordinator.', all: 'All file types accepted (DICOM, PDF, JPG, PNG, MP4, DOCX)', yes: 'Yes', no: 'No', send: 'Send files' },
  tr: { kvkk: 'Kişisel ve sağlık verilerimin tedavi koordinasyonu amacıyla KVKK/GDPR açık rızasıyla işlenmesine onay veriyorum.', title: 'Tıbbi Bilgi Formu', hi: 'Sayın', intro: 'Doktorlarımızın değerlendirebilmesi için lütfen soruları yanıtlayın.', upload: 'Dosya yükle', submit: 'Gönder', done: 'Teşekkürler! Bilgileriniz tıbbi koordinatörünüze iletildi.', all: 'Tüm dosya türleri kabul edilir (DICOM, PDF, JPG, PNG, MP4, DOCX)', yes: 'Evet', no: 'Hayır', send: 'Dosyaları gönder' },
  ar: { kvkk: 'أوافق على معالجة بياناتي الشخصية والصحية لتنسيق العلاج وفق موافقة GDPR/KVKK الصريحة.', title: 'الاستبيان الطبي', hi: 'عزيزي', intro: 'يرجى الإجابة على الأسئلة ليتمكن أطباؤنا من تقييم حالتك.', upload: 'رفع الملفات', submit: 'إرسال', done: 'شكراً لك! تم إرسال معلوماتك إلى منسقك الطبي.', all: 'جميع أنواع الملفات مقبولة (DICOM, PDF, JPG, PNG, MP4, DOCX)', yes: 'نعم', no: 'لا', send: 'إرسال الملفات' },
  de: { kvkk: 'Ich stimme der Verarbeitung meiner persönlichen und Gesundheitsdaten zur Behandlungskoordination gemäß DSGVO/KVKK ausdrücklich zu.', title: 'Medizinischer Fragebogen', hi: 'Sehr geehrte/r', intro: 'Bitte beantworten Sie die Fragen, damit unsere Ärzte Ihren Fall bewerten können.', upload: 'Dateien hochladen', submit: 'Absenden', done: 'Danke! Ihre Informationen wurden an Ihren medizinischen Koordinator gesendet.', all: 'Alle Dateitypen akzeptiert (DICOM, PDF, JPG, PNG, MP4, DOCX)', yes: 'Ja', no: 'Nein', send: 'Dateien senden' },
  ru: { kvkk: 'Я даю согласие на обработку моих персональных и медицинских данных для координации лечения по GDPR/KVKK.', title: 'Медицинская анкета', hi: 'Уважаемый(ая)', intro: 'Пожалуйста, ответьте на вопросы, чтобы наши врачи могли оценить ваш случай.', upload: 'Загрузить файлы', submit: 'Отправить', done: 'Спасибо! Ваши данные отправлены медицинскому координатору.', all: 'Принимаются все типы файлов (DICOM, PDF, JPG, PNG, MP4, DOCX)', yes: 'Да', no: 'Нет', send: 'Отправить файлы' },
};

app.get('/api/anamnesis', (req, res) => {
  res.json(all(`SELECT a.id,a.token,a.specialty,a.lang,a.status,a.created_at,a.submitted_at,p.name patient_name
    FROM anamnesis a JOIN patients p ON p.id=a.patient_id ORDER BY a.id DESC LIMIT 50`));
});
app.post('/api/anamnesis', (req, res) => {
  const p = get('SELECT * FROM patients WHERE id=?', req.body.patient_id);
  if (!p) return res.status(404).json({ error: 'patient not found' });
  const specs = detectSpecialties((p.complaint || '') + ' ' + (p.complaint_tr || ''));
  const token = crypto.randomBytes(10).toString('hex');
  const lang = ['tr', 'ar', 'de', 'ru'].includes(p.language) ? p.language : 'en';
  const r = run('INSERT INTO anamnesis (token,patient_id,specialty,lang) VALUES (?,?,?,?)', token, p.id, specs[0] || null, lang);
  const link = '/a/' + token;
  const conv = get('SELECT * FROM conversations WHERE patient_id=? ORDER BY id DESC LIMIT 1', p.id)
    || { id: run('INSERT INTO conversations (patient_id,channel,subject) VALUES (?,?,?)', p.id, 'whatsapp', 'Anamnez').lastInsertRowid };
  const L = ANAMNESIS_L[lang];
  const body = lang === 'tr'
    ? `📋 Sayın ${p.name}, tıbbi bilgi formunuz hazır: ${link} — Doktorlarımızın değerlendirmesi için lütfen doldurun.`
    : `📋 ${L.hi} ${p.name}, your medical form is ready: ${link} — please fill it in so our doctors can evaluate your case.`;
  run('INSERT INTO messages (conversation_id,direction,body,lang) VALUES (?,?,?,?)', conv.id, 'out', body, lang);
  io.emit('message', { conversation_id: conv.id, message: { direction: 'out', body } });
  res.json({ id: r.lastInsertRowid, url: link, specialties: specs });
});

app.get('/api/anamnesis/:token', (req, res) => {
  const a = get('SELECT a.*, p.name pname, p.language FROM anamnesis a JOIN patients p ON p.id=a.patient_id WHERE a.token=?', req.params.token);
  if (!a) return res.status(404).json({ error: 'not found' });
  const questions = [...(ANAMNESIS_SETS[a.specialty] || ANAMNESIS_SETS['General Surgery']), ...ANAMNESIS_GENERAL];
  const files = all("SELECT filename,uploaded_at FROM files WHERE patient_id=? AND category='anamnesis'", a.patient_id);
  res.json({ patient_name: a.pname, specialty: a.specialty, lang: a.lang, status: a.status, questions, answers: a.answers ? JSON.parse(a.answers) : null, uploaded: files, L: ANAMNESIS_L[a.lang] });
});

const anamnesisUpload = multer({ dest: path.join(__dirname, 'uploads') });
app.post('/api/anamnesis/:token/upload', anamnesisUpload.array('files', 10), (req, res) => {
  const a = get('SELECT * FROM anamnesis WHERE token=?', req.params.token);
  if (!a) return res.status(404).json({ error: 'not found' });
  const saved = (req.files || []).map(f => {
    run("INSERT INTO files (patient_id,filename,category,path) VALUES (?,?,?,?)", a.patient_id, f.originalname, 'anamnesis', '/uploads/' + f.filename);
    return f.originalname;
  });
  res.json({ ok: true, saved });
});

app.post('/api/anamnesis/:token/submit', (req, res) => {
  const a = get('SELECT a.*, p.name pname FROM anamnesis a JOIN patients p ON p.id=a.patient_id WHERE a.token=?', req.params.token);
  if (!a) return res.status(404).json({ error: 'not found' });
  run("UPDATE anamnesis SET answers=?, status='submitted', submitted_at=datetime('now') WHERE id=?", JSON.stringify(req.body.answers || {}), a.id);
  const conv = get('SELECT * FROM conversations WHERE patient_id=? ORDER BY id DESC LIMIT 1', a.patient_id);
  if (conv) {
    run('INSERT INTO messages (conversation_id,direction,body,lang) VALUES (?,?,?,?)', conv.id, 'in',
      `✅ Tıbbi bilgi formu dolduruldu (anamnez #${a.id})`, 'tr');
    io.emit('message', { conversation_id: conv.id, message: { direction: 'in', body: 'Anamnez formu dolduruldu' } });
  }
  if ((req.body.answers || {}).kvkk_consent) {
    const hash = 'KVKK-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    run('INSERT INTO kvkk_forms (patient_id,form_type,signer_name,passport_no,signature_hash,ocr_json) VALUES (?,?,?,?,?,?)',
      a.patient_id, 'consent', a.pname, null, hash, '{}');
    run('INSERT INTO files (patient_id,filename,category) VALUES (?,?,?)',
      a.patient_id, `KVKK_Onay_${a.pname.replace(/\s+/g, '_')}_${hash.slice(-6)}.esign`, 'contract');
  }
  notify(`📋 ${a.pname} tıbbi verilerini yükledi (anamnez)`, 'anamnesis');
  io.emit('anamnesis', { patient_id: a.patient_id, name: a.pname });
  res.json({ ok: true });
});

app.get('/a/:token', (req, res) => {
  const a = get('SELECT * FROM anamnesis WHERE token=?', req.params.token);
  if (!a) return res.status(404).send('Form not found');
  res.send(`<!doctype html><html lang="${a.lang}" dir="${a.lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HTA — Medical Form</title><style>
body{font-family:-apple-system,'SF Pro',Segoe UI,Arial;background:#f4f5f7;margin:0;padding:16px}
.c{max-width:520px;margin:auto}
.card{background:#fff;border-radius:18px;padding:20px;margin-bottom:14px;box-shadow:0 4px 20px rgba(0,0,0,.06)}
h1{font-size:19px;margin:0 0 4px}.mut{color:#888;font-size:13px}
.q{margin:14px 0}.q label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
input[type=text],input[type=number],select,textarea{width:100%;padding:12px;border:1px solid #ddd;border-radius:12px;font-size:15px;box-sizing:border-box}
input[type=range]{width:100%}
.v{font-weight:700;color:#0a84ff}
.b{display:block;width:100%;padding:14px;border:0;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer;background:#0a84ff;color:#fff;margin-top:14px}
.up{border:2px dashed #bbb;border-radius:14px;padding:16px;text-align:center;color:#777;font-size:14px}
.up.done{border-color:#34c759;color:#34c759}
.chip{display:inline-block;background:#eef4ff;color:#0a84ff;border-radius:8px;padding:3px 10px;font-size:12px;margin:2px}
.done-all{text-align:center;padding:60px 20px;font-size:17px}
</style></head><body><div class="c" id="app"></div>
<script>
const T='${a.token}';let D=null;
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function boot(){
  D=await(await fetch('/api/anamnesis/'+T)).json();const L=D.L;
  if(D.status==='submitted'){app.innerHTML='<div class="card done-all">✅ '+esc(L.done)+'</div>';return;}
  const qlab=q=>D.lang==='tr'?q.tr:(q.en||q.tr);
  app.innerHTML='<div class="card"><h1>✚ '+esc(L.title)+'</h1><p class="mut">'+esc(L.hi)+' <b>'+esc(D.patient_name)+'</b>, '+esc(L.intro)+'</p><span class="chip">'+esc(D.specialty)+'</span></div>'
  +'<form id="f"><div class="card">'+D.questions.map((q,i)=>{
    const id='q'+i;
    if(q.type==='slider')return '<div class="q"><label>'+esc(qlab(q))+'</label><input type="range" id="'+id+'" min="'+q.min+'" max="'+q.max+'" value="'+q.min+'" oninput="document.getElementById(\\''+id+'v\\').textContent=this.value"><div class="v" id="'+id+'v">'+q.min+'</div></div>';
    if(q.type==='num')return '<div class="q"><label>'+esc(qlab(q))+'</label><input type="number" id="'+id+'" inputmode="decimal"></div>';
    if(q.type==='select'){const o=D.lang==='tr'?(q.opts||[]):(q.opts_en||q.opts||[]);return '<div class="q"><label>'+esc(qlab(q))+'</label><select id="'+id+'">'+o.map(x=>'<option>'+esc(x)+'</option>').join('')+'</select></div>';}
    if(q.type==='yn')return '<div class="q"><label>'+esc(qlab(q))+'</label><select id="'+id+'"><option value="">—</option><option value="yes">'+esc(L.yes)+'</option><option value="no">'+esc(L.no)+'</option></select></div>';
    if(q.type==='file')return '<div class="q"><label>'+esc(qlab(q))+'</label><div class="up" id="'+id+'">'+esc(L.upload)+'<input type="file" multiple style="margin-top:8px;width:100%" onchange="uploadFiles(this,\\''+id+'\\')"></div></div>';
    return '<div class="q"><label>'+esc(qlab(q))+'</label><input type="text" id="'+id+'"></div>';
  }).join('')+'<p class="mut">'+esc(L.all)+'</p><button class="b" type="submit">'+esc(L.submit)+' ➤</button></div></form>';
  document.getElementById('f').onsubmit=async e=>{e.preventDefault();
    const ans={};D.questions.forEach((q,i)=>{const el=document.getElementById('q'+i);if(el&&q.type!=='file')ans[q.key]=el.value;});
    const r=await fetch('/api/anamnesis/'+T+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answers:{...ans,kvkk_consent:document.getElementById('kvkk_ok').checked?'KVKK/GDPR açık rıza onaylandı':'—'}})});
    if(r.ok)app.innerHTML='<div class="card done-all">✅ '+esc(L.done)+'</div>';};
}
async function uploadFiles(inp,box){const fd=new FormData();[...inp.files].forEach(f=>fd.append('files',f));const el=document.getElementById(box);
  el.innerHTML='⏳ '+inp.files.length+' file(s)…';const r=await fetch('/api/anamnesis/'+T+'/upload',{method:'POST',body:fd});
  const j=await r.json();el.classList.add('done');el.innerHTML='✅ '+j.saved.map(esc).join(', ');}
boot();
</script></body></html>`);
});


// --- Komplikasyon sigortasi & claim ---
app.post('/api/claims', (req, res) => {
  const b = req.body || {};
  const r = run('INSERT INTO claims (patient_id,booking_id,amount,reason) VALUES (?,?,?,?)',
    b.patient_id || null, b.booking_id || null, +b.amount || 0, b.reason || '');
  if (b.patient_id) {
    const p = get('SELECT * FROM patients WHERE id=?', b.patient_id);
    run('INSERT INTO files (patient_id,filename,category) VALUES (?,?,?)',
      b.patient_id, `HasarDosyasi_${r.lastInsertRowid}_${(p ? p.name : 'hasta').replace(/\s+/g, '_')}.claim`, 'contract');
  }
  notify('Komplikasyon sigorta hasar dosyasi acildi #' + r.lastInsertRowid, 'claim');
  res.json({ id: r.lastInsertRowid });
});
app.get('/api/claims', (req, res) => res.json(all('SELECT c.*, p.name patient_name FROM claims c LEFT JOIN patients p ON p.id=c.patient_id ORDER BY c.id DESC')));
app.post('/api/claims/:id/status', (req, res) => {
  run('UPDATE claims SET status=? WHERE id=?', (req.body || {}).status || 'open', req.params.id);
  res.json({ ok: true });
});

// --- Saha tercuman & gorevli hakedis ---
app.post('/api/field-tasks', (req, res) => {
  const b = req.body || {};
  const r = run('INSERT INTO field_tasks (agent_id,patient_id,task,payout) VALUES (?,?,?,?)',
    b.agent_id || null, b.patient_id || null, b.task || '', +b.payout || 0);
  res.json({ id: r.lastInsertRowid });
});
app.get('/api/field-tasks', (req, res) => res.json(all(`SELECT t.*, a.name agent_name, p.name patient_name FROM field_tasks t
  LEFT JOIN agents a ON a.id=t.agent_id LEFT JOIN patients p ON p.id=t.patient_id ORDER BY t.id DESC`)));
app.post('/api/field-tasks/:id/confirm', (req, res) => {
  run('UPDATE field_tasks SET location_ok=1 WHERE id=?', req.params.id);
  const t = get('SELECT * FROM field_tasks WHERE id=?', req.params.id);
  if (t && t.payout) run('INSERT INTO transactions (account_id,patient_id,kind,category,amount,currency,description) VALUES (?,?,?,?,?,?,?)',
    1, t.patient_id, 'expense', 'commission', t.payout, 'EUR', 'Saha gorevli hakedis #' + t.id);
  res.json({ ok: true });
});

// --- Pazarlama gorsel izin (KVKK) ---
app.post('/api/patients/:id/marketing-consent', (req, res) => {
  run('UPDATE patients SET marketing_consent=1 WHERE id=?', req.params.id);
  const p = get('SELECT * FROM patients WHERE id=?', req.params.id);
  const hash = crypto.createHash('sha1').update(p.name + 'mk').digest('hex');
  run("INSERT INTO files (patient_id,filename,category) VALUES (?,?,?)",
    p.id, `Pazarlama_Izin_Onay_${p.name.replace(/\s+/g, '_')}_${hash.slice(-6)}.esign`, 'contract');
  run("INSERT INTO kvkk_forms (patient_id,form_type,signer_name,signature_hash,ocr_json) VALUES (?,?,?,?,?)",
    p.id, 'marketing', p.name, hash, '{}');
  res.json({ ok: true });
});

// --- Temsilci prim hesaplayici ---
app.get('/api/rep-performance', (req, res) => {
  const reps = all("SELECT * FROM agents WHERE role='rep' AND active=1");
  res.json(reps.map(r => {
    const pts = all('SELECT id FROM patients WHERE sales_agent_id=?', r.id).map(x => x.id);
    const inc = pts.length ? all(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE kind='income' AND patient_id IN (${pts.join(',')})`)[0].s : 0;
    const exp = pts.length ? all(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE kind='expense' AND patient_id IN (${pts.join(',')})`)[0].s : 0;
    const cr2 = get('SELECT * FROM commission_rules WHERE agent_id=?', r.id) || { flat_pct: 3 };
    const net = inc - exp, premium = net * (cr2.flat_pct || 3) / 100;
    return { id: r.id, name: r.name, patients: pts.length, revenue: inc, net_profit: net, premium };
  }));
});
app.get('/api/translators', (req, res) => res.json(all("SELECT * FROM agents WHERE role IN ('translator','ops') AND active=1")));


// --- AI Smart Upsell: tedavi+ülkeye göre öneri ---
const UPSELL = {
  'Hair Transplant': { cross: 'Diş Emax Kaplama + Medikal Estetik (Yüz Dolgusu)', conv: 78, tip: 'Saç ekimi hastaları %64 oranında diş paketi ekliyor' },
  'Plastic Surgery': { cross: 'Post-Op Premium İyileşme + Ortodonti', conv: 71, tip: 'Estetik paketine iyileşme eklentisi dönüşümü artırıyor' },
  'Orthopedics': { cross: 'Fizik Tedavi Paketi + Premium VIP İyileşme', conv: 66, tip: 'Ortopedi hastaları uzun süreli rehabilitasyon tercih ediyor' },
  'Cardiology': { cross: '12 Ay Kardiyak İzleme + Komplikasyon Sigortası', conv: 74, tip: 'Kardiyak hastalar sigorta eklentisini %81 oranında alıyor' },
};
app.get('/api/upsell/:patientId', (req, res) => {
  const p = get('SELECT * FROM patients WHERE id=?', req.params.patientId);
  if (!p) return res.status(404).end();
  const match = Object.keys(UPSELL).find(k => (p.complaint || p.complaint_tr || '').toLowerCase().includes(k.toLowerCase().split(' ')[0]));
  const u = UPSELL[match] || { cross: '12 Ay Post-Op Tele-Sağlık Paketi', conv: 62, tip: 'Genel iyileşme takibi dönüşümü yükseltir' };
  const gulf = ['Qatar','UAE','Saudi Arabia','Kuwait','Iraq'].includes(p.nationality);
  res.json({ cross_sell: u.cross, conv_pct: Math.min(95, u.conv + (gulf ? 9 : 0)), tip: u.tip,
    recommended: gulf ? 'Paket C — Premium VIP İyileşme' : 'Paket B — 12 Ay Medikal İzleme' });
});

// --- Medikal vize davetiyesi ---
app.post('/api/patients/:id/visa-letter', (req, res) => {
  const p = get('SELECT * FROM patients WHERE id=?', req.params.id);
  if (!p) return res.status(404).end();
  const fname = `Medikal_Davetiyesi_${p.name.replace(/\s+/g, '_')}.pdf`;
  run('INSERT INTO files (patient_id,filename,category) VALUES (?,?,?)', p.id, fname, 'letter');
  notify(`Medikal vize davetiyesi üretildi — ${p.name} (${p.passport_no || 'pasaport yok'})`, 'visa');
  res.json({ ok: true, file: fname, ref: 'UST-YT-2024-0017' });
});

// --- B2B alt-acenta paneli ---
app.get('/api/affiliates', (req, res) => {
  const sas = all('SELECT * FROM subagents ORDER BY id');
  res.json(sas.map(sa => {
    const pts = all('SELECT id, name, lead_status FROM patients WHERE subagent_id=?', sa.id);
    const ids = pts.map(x => x.id);
    const rev = ids.length ? get(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE kind='income' AND patient_id IN (${ids.join(',')})`).s : 0;
    return { ...sa, patients: pts, revenue: rev, commission: rev * (sa.commission_pct || 0) / 100 };
  }));
});


// --- Patient Digital Pass: hasta takip linki + mobil görünüm ---
app.post('/api/patients/:id/pass', (req, res) => {
  const p = get('SELECT * FROM patients WHERE id=?', req.params.id);
  if (!p) return res.status(404).end();
  const token = crypto.createHash('sha256').update('pass-' + p.id + '-' + p.passport_no).digest('hex').slice(0, 12);
  try { run('ALTER TABLE patients ADD COLUMN pass_token TEXT'); } catch {}
  run('UPDATE patients SET pass_token=? WHERE id=?', token, p.id);
  res.json({ url: '/p/' + token });
});
app.get('/p/:token', (req, res) => {
  const p = get('SELECT * FROM patients WHERE pass_token=?', req.params.token);
  if (!p) return res.status(404).send('Invalid link');
  const bs = all('SELECT * FROM bookings WHERE patient_id=?', p.id);
  const rfqs = all('SELECT r.*, d.name dname, d.hospital FROM rfqs r JOIN doctors d ON d.id=r.doctor_id WHERE r.patient_id=?', p.id);
  const flight = bs.find(b => b.kind === 'flight'), hotel = bs.find(b => b.kind === 'hotel'), tr = bs.find(b => b.kind === 'transfer');
  const steps = ['Talep','Tıbbi değerlendirme','Teklif & sözleşme','Lojistik','Hastane','Post-Op'];
  const stage = p.lead_status === 'completed' ? 6 : p.lead_status === 'in_operation' ? 5 : bs.length ? 4 : rfqs.length ? 2 : 1;
  const en = p.language !== 'tr';
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clinicia — ${en ? 'My Journey' : 'Yolculuğum'}</title>
<style>body{font-family:-apple-system,'SF Pro',Segoe UI,Arial;background:#f4f5f7;margin:0;padding:20px}
.c{max-width:420px;margin:auto}.card{background:#fff;border-radius:18px;padding:18px;margin-bottom:12px;box-shadow:0 6px 20px rgba(0,0,0,.06)}
h1{font-size:18px}.mut{color:#888;font-size:12.5px}.step{display:flex;align-items:center;gap:10px;padding:7px 0;font-size:14px}
.dot{width:20px;height:20px;border-radius:50%;background:#e5e5ea;color:#999;display:grid;place-items:center;font-size:11px;flex-shrink:0}
.done .dot{background:#34c759;color:#fff}.act .dot{background:#0071e3;color:#fff}
.live{color:#0071e3;font-weight:600}</style></head><body><div class="c">
<div class="card"><h1><svg width="26" height="26" viewBox="0 0 32 32" fill="none" style="vertical-align:-4px;margin-right:6px"><path d="M22 10C20.2 7.5 17.3 6 14 6C8.5 6 4 10.5 4 16C4 21.5 8.5 26 14 26C17.3 26 20.2 24.5 22 22" stroke="#00C7BE" stroke-width="4" stroke-linecap="round"/></svg>Clinicia</h1><div class="mut">${en ? 'Dear' : 'Sayın'} ${p.name} · ${p.nationality}</div></div>
<div class="card">${steps.map((t,i)=>`<div class="step ${i+1<stage?'done':i+1===stage?'act':''}"><span class="dot">${i+1<stage?'✓':i+1}</span>${t}</div>`).join('')}</div>
${flight ? `<div class="card"><b>✈ ${flight.ref_label||'Uçuş'}</b><div class="mut">${en?'Flight status':'Uçuş durumu'}: <span class="live">${flight.flight_status||'Scheduled'}</span></div></div>` : ''}
${tr ? `<div class="card"><b> VIP Transfer</b><div class="mut">${(() => { const d = JSON.parse(tr.details||'{}');
      return `${d.vehicle||'VIP Mercedes Vito'} · ${d.plate||''} ${en?'· Driver':'· Şoför'}: ${d.driver_name||''} ${d.driver_phone||''}<br>${en?'Live tracking active':'Canlı takip aktif'}`; })()}</div></div>` : ''}
${hotel ? `<div class="card"><b> ${hotel.ref_label||'Otel'}</b><div class="mut">${(() => { const d = JSON.parse(hotel.details||'{}');
      return `${d.checkin||''} ${d.checkin?'·':''} ${d.nights?d.nights+' '+ (en?'nights':'gece'):''} · ${en?'Confirmation':'Konfirme'} #HTL-${hotel.id} · €${hotel.price||''}`; })()}</div></div>` : ''}
<div class="card mut" style="text-align:center">Clinicia Health Tourism · 7/24 ${en?'support':'destek'}: +90 850 *** 0000</div>
<div id="pushbox"></div>
<script>
const TOKEN=${JSON.stringify(req.params.token)};
(async()=>{try{
 const r=await fetch('/api/pass/push/'+TOKEN);const ns=await r.json();
 if(ns&&ns.length){document.getElementById('pushbox').innerHTML=ns.map(n=>'<div class="card" style="border-left:4px solid #00C7BE"><b> '+ (n.body||'') +'</b><div class="mut">'+n.sent_at+' · push</div></div>').join('');}
}catch(e){}
// PWA-lite: 30sn'de bir yeni bildirim kontrolü
setInterval(async()=>{try{const r=await fetch('/api/pass/push/'+TOKEN);const ns=await r.json();
 if(ns&&ns.length)document.getElementById('pushbox').innerHTML=ns.map(n=>'<div class="card" style="border-left:4px solid #00C7BE"><b> '+ (n.body||'') +'</b><div class="mut">'+n.sent_at+' · push</div></div>').join('');}catch(e){}},30000);
})();
</script>
</div></body></html>`);
});


// --- v2.0: AI Lead Scoring ---
const BUDGET = { 'Hair Transplant': [3000, 5500], 'Plastic Surgery': [4000, 8000], 'Orthopedics': [5000, 9000], 'Cardiology': [8000, 15000], 'Dental': [1500, 4500], 'Obesity': [4500, 7500] };
app.get('/api/lead-score/:patientId', (req, res) => {
  const p = get('SELECT * FROM patients WHERE id=?', req.params.patientId);
  if (!p) return res.status(404).end();
  const txt = ((p.complaint || '') + ' ' + (p.complaint_tr || '')).toLowerCase();
  const gulf = ['Qatar','UAE','Saudi Arabia','Kuwait','Iraq','Bahrain'].includes(p.nationality);
  const eu = ['United Kingdom','Germany','France','Netherlands','Austria'].includes(p.nationality);
  const spec = Object.keys(BUDGET).find(k => txt.includes(k.toLowerCase().split(' ')[0]) || txt.includes('saç') && k === 'Hair Transplant' || txt.includes('diş') && k === 'Dental');
  const base = spec ? 55 : 40;
  const pct = Math.min(96, base + (gulf ? 25 : eu ? 15 : 8) + (/ağrı|pain|urgent|acil/i.test(txt) ? 10 : 0));
  const [lo, hi] = BUDGET[spec] || [2500, 6000];
  const rep = assignRep(p.language || 'en');
  res.json({ pct, segment: pct >= 75 ? 'Yüksek' : pct >= 50 ? 'Orta' : 'Düşük',
    budget: `€${lo.toLocaleString('en')} – €${hi.toLocaleString('en')}`,
    rep: rep ? rep.name : null, spec });
});

// --- v2.0: Vision AI pre-diagnostic ---
app.get('/api/ai-analysis/:patientId', (req, res) => {
  const p = get('SELECT * FROM patients WHERE id=?', req.params.patientId);
  if (!p) return res.status(404).end();
  const txt = ((p.complaint || '') + (p.complaint_tr || '')).toLowerCase();
  const files = all("SELECT * FROM files WHERE patient_id=? AND (category IN ('radiology','other') OR filename LIKE '%jpg%' OR filename LIKE '%png%' OR filename LIKE '%dcm%')", p.id);
  let analysis = null;
  if (/saç|hair|ekim/i.test(txt)) analysis = { type: 'hair', estimate: '3.800 – 4.200 greft', conf: 82, note: 'Donör alanı orta-güçlü; FUE tekniği önerilir' };
  else if (/diş|dental|zirkon|implant/i.test(txt)) analysis = { type: 'dental', estimate: '6 – 8 zirkonyum / 2 implant', conf: 78, note: 'Panoramik değerlendirme taslağı' };
  else if (/diz|knee|ortho|eklem/i.test(txt)) analysis = { type: 'ortho', estimate: 'Total diz protezi adayı — MR doğrulaması gerekli', conf: 71, note: 'VAS yüksek, konservatif seçenekler değerlendirildi' };
  res.json({ files_analyzed: files.length, analysis, draft_offer: analysis ? `${analysis.estimate} (${analysis.note})` : 'Yeterli görsel veri yok — anamnez dosyaları bekleniyor' });
});

// --- v2.0: franchise şube görünümü ---
app.get('/api/franchise', (req, res) => {
  const BRANCHES = { london: ['United Kingdom'], berlin: ['Germany', 'Austria', 'Netherlands'], gulf: ['Qatar', 'UAE', 'Saudi Arabia', 'Kuwait', 'Iraq', 'Bahrain'] };
  const sas = all('SELECT * FROM subagents ORDER BY id');
  const out = {};
  for (const [k, countries] of Object.entries(BRANCHES)) {
    const branchSas = sas.filter(sa => countries.includes(sa.country));
    const ids = all(`SELECT id FROM patients WHERE subagent_id IN (${branchSas.map(x => x.id).join(',') || '0'}) OR (subagent_id IS NULL AND nationality IN (${countries.map(c => `'${c}'`).join(',') || "''"}))`).map(x => x.id);
    const rev = ids.length ? get(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE kind='income' AND patient_id IN (${ids.join(',')})`).s : 0;
    out[k] = { name: { london: 'London Office (UK)', berlin: 'Berlin Branch (DE)', gulf: 'Körfez Temsilciliği' }[k],
      patients: ids.length, agents: branchSas.map(x => x.name), revenue: rev,
      hakedis: rev * 0.12 };
  }
  res.json(out);
});


try { db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')), role TEXT, user_label TEXT, patient_id INTEGER, patient_name TEXT,
  action TEXT, entity TEXT, entity_id INTEGER, detail TEXT)`); } catch(e){}
try { db.exec(`CREATE TABLE IF NOT EXISTS call_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER, type TEXT, note TEXT, callback_at TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')))`); } catch(e){}
try { db.exec(`CREATE TABLE IF NOT EXISTS op_calendar (id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER, kind TEXT, label TEXT, scheduled_at TEXT, status TEXT DEFAULT 'scheduled', room TEXT)`); } catch(e){}

const audit = (req, action, detail, pid) => {
  try {
    const role = req.headers['x-user-role'] || 'admin';
    const p = pid ? get('SELECT id,name FROM patients WHERE id=?', +pid) : null;
    run('INSERT INTO audit_logs (role,user_label,patient_id,patient_name,action,entity,detail) VALUES (?,?,?,?,?,?,?)',
      role, {admin:'Acente Sahibi',rep:'Satış Danışmanı',ops:'Operasyon Danışmanı',finance:'Muhasebeci',field:'Saha Görevlisi'}[role] || role,
      p ? p.id : null, p ? p.name : null, action, req.path, (detail||'').slice(0,300));
  } catch(e){}
};
// mutasyon kaydı: hassas endpoint'lerde otomatik audit
const AUDIT_PATHS = /\/api\/(patients|bookings|invoices|offers|rfq|files|anamnesis|calls|role-permissions|usha|incentive)/;
app.use('/api', (req,res,next) => {
  if (['POST','PUT','PATCH','DELETE'].includes(req.method) && AUDIT_PATHS.test(req.path))
    res.on('finish', () => { if (res.statusCode < 400) audit(req, req.method+' '+req.path,
      JSON.stringify(req.body||{}).slice(0,200), (req.body||{}).patient_id || req.params.id || req.params.patientId || req.params.token); });
  next();
});

app.get('/api/audit', (req, res) => {
  const pid = req.query.patient_id;
  res.json(all(`SELECT * FROM audit_logs ${pid?'WHERE patient_id='+Number(pid):''} ORDER BY id DESC LIMIT 200`));
});

app.post('/api/calls', (req, res) => {
  const b = req.body || {};
  const p = get('SELECT * FROM patients WHERE id=?', b.patient_id);
  if (!p) return res.status(404).json({ error: 'patient not found' });
  const r = run('INSERT INTO call_logs (patient_id,type,note,callback_at,created_by) VALUES (?,?,?,?,?)',
    p.id, b.type || 'call', b.note || null, b.callback_at || null, req.headers['x-user-role'] || 'admin');
  const link = b.type === 'video' ? '/v/' + crypto.randomBytes(8).toString('hex') : null;
  audit(req, 'call:' + (b.type || 'call'), b.note || link || '', p.id);
  io.emit('call', { patient_id: p.id, type: b.type });
  res.json({ ok: true, id: r.lastInsertRowid, room: link });
});
app.get('/api/calls', (req, res) => {
  const pid = req.query.patient_id;
  res.json(all(`SELECT c.*, p.name patient_name FROM call_logs c JOIN patients p ON p.id=c.patient_id
    ${pid?'WHERE c.patient_id='+Number(pid):''} ORDER BY c.id DESC LIMIT 100`));
});
// şifreli görüntülü görüşme odası (simüle)
app.get('/v/:room', (req, res) => res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Clinicia Tele-Sağlık</title>
<style>body{font-family:-apple-system,Arial;background:#090D16;color:#F8FAFC;display:grid;place-items:center;height:100vh;margin:0}
.c{text-align:center}.room{background:#111726;border:1px solid #1E293B;border-radius:20px;padding:40px 60px}
h1{color:#00C7BE}</style></head><body><div class="c"><div class="room"><h1>Clinicia Tele-Sağlık Odası</h1>
<p>Şifreli görüntülü konsültasyon · Oda: <b>${req.params.room.slice(0,8)}</b></p>
<p style="color:#94A3B8">Hekim bağlantısı bekleniyor…</p></div></div></body></html>`));

// HSYS / Bakanlık bildirim listesi
app.get('/api/hsys/report', (req, res) => {
  res.json(all(`SELECT p.id, p.name, p.passport_no, p.nationality, p.complaint, p.lead_status,
    p.created_at, (SELECT COUNT(*) FROM kvkk_forms k WHERE k.patient_id=p.id) kvkk_count,
    (SELECT MAX(i.number) FROM invoices i WHERE i.patient_id=p.id) last_invoice
    FROM patients p ORDER BY p.id DESC`));
});

// Ameliyathane + post-op takvim
app.get('/api/calendar/ops', (req, res) => {
  const ops = all(`SELECT o.*, p.name patient_name FROM op_calendar o JOIN patients p ON p.id=o.patient_id ORDER BY o.scheduled_at`);
  const postops = all(`SELECT p.id, p.name, p.postop_since, p.lead_status FROM patients p WHERE p.postop_since IS NOT NULL OR p.lead_status='completed'`).map(p => {
    const base = new Date(p.postop_since || p.created_at || Date.now());
    return { patient_id: p.id, name: p.name, since: p.postop_since,
      checkpoints: [30,90,180,365].map(d => { const t = new Date(base); t.setDate(t.getDate()+d);
        return { day: d, date: t.toISOString().slice(0,10), done: t < new Date() }; }) };
  });
  res.json({ ops, postops });
});
app.post('/api/calendar/ops', (req, res) => {
  const b = req.body || {};
  const r = run('INSERT INTO op_calendar (patient_id,kind,label,scheduled_at,room) VALUES (?,?,?,?,?)',
    b.patient_id, b.kind || 'surgery', b.label || 'Operasyon', b.scheduled_at, b.room || 'Ameliyathane-1');
  audit(req, 'calendar:create', b.label, b.patient_id);
  res.json(get('SELECT * FROM op_calendar WHERE id=?', r.lastInsertRowid));
});


// --- C-Level Executive Dashboard ---
app.get('/api/executive', (req, res) => {
  const rev = get("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE kind='income'").s;
  const receivables = get("SELECT COALESCE(SUM(amount),0) s FROM invoices WHERE COALESCE(status,'draft')!='paid'").s;
  const rfqTotal = get('SELECT COUNT(*) c FROM rfqs').c, rfqAnswered = get("SELECT COUNT(*) c FROM rfqs WHERE responded_at IS NOT NULL").c;
  const reps = all(`SELECT a.name, COUNT(p.id) assigned, SUM(CASE WHEN p.lead_status IN ('agreed','in_operation','completed') THEN 1 ELSE 0 END) won
    FROM agents a LEFT JOIN patients p ON p.sales_agent_id=a.id WHERE a.role='rep' GROUP BY a.id ORDER BY won DESC LIMIT 5`);
  const incentive = get("SELECT COUNT(*) c FROM patients WHERE lead_status IN ('in_operation','completed')").c * 780; // teşvik hasta başı ~€780
  res.json({ revenue: rev, receivables, incentive_receivable: incentive,
    rfq_accept_pct: rfqTotal ? Math.round(rfqAnswered / rfqTotal * 100) : 0,
    rfq_total: rfqTotal, rfq_answered: rfqAnswered, reps });
});

// --- AI Translation layer (simulated) ---
const TR_DICT = { en: { 'hello': 'merhaba', 'pain': 'ağrı', 'price': 'fiyat', 'flight': 'uçuş', 'hotel': 'otel', 'surgery': 'ameliyat', 'transfer': 'transfer', 'thank': 'teşekkür', 'need': 'ihtiyacım var', 'appointment': 'randevu', 'doctor': 'doktor', 'tomorrow': 'yarın' },
  de: { 'hallo': 'merhaba', 'schmerz': 'ağrı', 'preis': 'fiyat', 'flug': 'uçuş', 'hotel': 'otel', 'operation': 'ameliyat', 'danke': 'teşekkür' },
  ar: { 'مرحبا': 'merhaba', 'ألم': 'ağrı', 'سعر': 'fiyat', 'طيران': 'uçuş', 'فندق': 'otel', 'عملية': 'ameliyat', 'شكرا': 'teşekkür' },
  ru: { 'привет': 'merhaba', 'боль': 'ağrı', 'цена': 'fiyat', 'отель': 'otel', 'операция': 'ameliyat', 'спасибо': 'teşekkür' } };
const OUT_TPL = { en: t => `[EN] Dear patient, ${t}`, de: t => `[DE] Sehr geehrter Patient, ${t}`, fr: t => `[FR] Cher patient, ${t}`,
  ar: t => `[AR] المريض العزيز، ${t}`, ru: t => `[RU] Уважаемый пациент, ${t}` };
app.post('/api/ai/translate', (req, res) => {
  const { text = '', direction = 'in', lang = 'en' } = req.body || {};
  if (direction === 'in') {
    const dict = TR_DICT[lang] || {};
    let tr = text.toLowerCase();
    for (const [k, v] of Object.entries(dict)) tr = tr.split(k).join(v);
    res.json({ translated: `[AI→TR] ${tr}`, lang, direction });
  } else {
    res.json({ translated: (OUT_TPL[lang] || OUT_TPL.en)(text), lang, direction });
  }
});

// --- Night Shift AI Lead Agent ---
app.post('/api/night-agent', (req, res) => {
  const { patient_id } = req.body || {};
  const p = get('SELECT * FROM patients WHERE id=?', patient_id);
  if (!p) return res.status(404).end();
  const conv = get('SELECT * FROM conversations WHERE patient_id=? ORDER BY id DESC LIMIT 1', p.id)
    || { id: run('INSERT INTO conversations (patient_id,channel,subject) VALUES (?,?,?)', p.id, 'whatsapp', 'Gece AI').lastInsertRowid };
  const body = ` [AI Gece Asistanı] Sayın ${p.name}, mesajınız mesai dışında alındı — sizi karşıladım. Değerlendirme için lütfen rahatsızlık bölgenizin FOTOĞRAF ve/veya RÖNTGEN görüntüsünü bu sohbete yükleyin. Sabah 09:00'da danışmanınız sizinle iletişime geçecek. / [Night AI] Your message was received after hours — please upload photos/x-rays; your consultant will contact you at 09:00.`;
  run('INSERT INTO messages (conversation_id,direction,body,lang) VALUES (?,?,?,?)', conv.id, 'out', body, 'auto');
  run("INSERT INTO call_logs (patient_id,type,note,created_by) VALUES (?,?,?,'ai-night')", p.id, 'call', 'Gece vardiyası AI: fotoğraf/röntgen talep edildi, sabah vakası olarak işaretlendi');
  io.emit('message', { conversation_id: conv.id, message: { direction: 'out', body } });
  audit(req, 'night-agent', 'AI gece karşılama + medya talebi', p.id);
  res.json({ ok: true, queued_for: '09:00' });
});

// --- Push notification simulator for /p/:token ---
try { db.exec('CREATE TABLE IF NOT EXISTS push_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER, body TEXT, sent_at TEXT DEFAULT CURRENT_TIMESTAMP)'); } catch(e) {}
app.post('/api/pass/push', (req, res) => {
  const { patient_id, body } = req.body || {};
  const p = get('SELECT * FROM patients WHERE id=?', patient_id);
  if (!p) return res.status(404).end();
  run('INSERT INTO push_notes (patient_id,body) VALUES (?,?)', p.id, body || 'Transfer aracınız kapıda');
  audit(req, 'push:send', body || '', p.id);
  res.json({ ok: true });
});
app.get('/api/pass/push/:token', (req, res) => {
  const p = get('SELECT * FROM patients WHERE pass_token=?', req.params.token);
  if (!p) return res.status(404).json([]);
  res.json(all('SELECT * FROM push_notes WHERE patient_id=? ORDER BY id DESC LIMIT 5', p.id));
});

server.listen(PORT, () => console.log('HTA ERP listening on http://localhost:' + PORT));
