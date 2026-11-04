// Database layer — SQLite via node:sqlite (no external DB server needed)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'erp.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  nationality TEXT,
  language TEXT DEFAULT 'en',
  passport_no TEXT,
  phone TEXT,
  email TEXT,
  complaint TEXT,
  complaint_tr TEXT,
  lead_status TEXT DEFAULT 'new',        -- new | quoted | agreed | in_operation | completed
  city TEXT DEFAULT 'Istanbul',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  channel TEXT NOT NULL,                 -- whatsapp | web | email
  subject TEXT,
  status TEXT DEFAULT 'open',            -- open | closed
  sla_deadline INTEGER,                  -- epoch ms; null when SLA satisfied/paused
  sla_responded INTEGER DEFAULT 0,
  last_message_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  direction TEXT NOT NULL,               -- in | out
  body TEXT NOT NULL,
  body_translated TEXT,
  lang TEXT DEFAULT 'tr',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS doctors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  specialty TEXT NOT NULL,
  hospital TEXT,
  city TEXT DEFAULT 'Istanbul',
  rating REAL DEFAULT 4.5,
  years_exp INTEGER DEFAULT 10
);

CREATE TABLE IF NOT EXISTS rfqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  complaint TEXT,
  status TEXT DEFAULT 'pending',         -- pending | responded | declined
  created_at TEXT DEFAULT (datetime('now')),
  responded_at TEXT
);

CREATE TABLE IF NOT EXISTS medical_opinions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rfq_id INTEGER NOT NULL REFERENCES rfqs(id),
  opinion_enc TEXT NOT NULL,             -- AES-256-GCM encrypted blob (base64 iv.tag.cipher)
  signature TEXT NOT NULL,               -- simulated e-signature hash
  signed_at TEXT,
  shared_with_patient INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS doctor_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rfq_id INTEGER NOT NULL REFERENCES rfqs(id),
  price REAL NOT NULL,
  currency TEXT DEFAULT 'EUR',
  notes TEXT,
  valid_days INTEGER DEFAULT 30
);

CREATE TABLE IF NOT EXISTS hotels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  stars INTEGER,
  district TEXT,
  price_per_night REAL,
  currency TEXT DEFAULT 'EUR'
);

CREATE TABLE IF NOT EXISTS flights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flight_no TEXT NOT NULL,
  origin TEXT, destination TEXT,
  dep_time TEXT, arr_time TEXT,
  price REAL, currency TEXT DEFAULT 'EUR'
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  kind TEXT NOT NULL,                    -- hotel | flight | transfer
  ref_label TEXT,
  details TEXT,                          -- json
  price REAL,
  status TEXT DEFAULT 'confirmed',       -- quote | confirmed | active | completed | cancelled
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'customer'           -- customer | vendor
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES accounts(id),
  patient_id INTEGER REFERENCES patients(id),
  kind TEXT NOT NULL,                    -- income | expense
  category TEXT DEFAULT 'other',         -- medical | hotel | flight | transfer | commission | other
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'EUR',
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  number TEXT UNIQUE,
  amount REAL,
  currency TEXT DEFAULT 'EUR',
  items TEXT,                            -- json [{desc, qty, unit, total}]
  status TEXT DEFAULT 'draft',           -- draft | issued | sent_ivd
  ivd_ref TEXT,
  issued_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usha_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  service_detail TEXT,
  payload TEXT,                          -- json sent to USHAŞ (simulated)
  status TEXT DEFAULT 'pending',         -- pending | sent | acknowledged
  usha_ref TEXT,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS incentive_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  docs TEXT,                             -- json checklist [{doc, present, source}]
  status TEXT DEFAULT 'collecting',      -- collecting | ready | submitted
  created_at TEXT DEFAULT (datetime('now')),
  submitted_at TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  filename TEXT,
  category TEXT DEFAULT 'other',         -- passport | radiology | report | invoice | other
  path TEXT,
  uploaded_at TEXT DEFAULT (datetime('now'))
);
`);

// ---------- seed ----------
const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

if (count('doctors') === 0) {
  const ins = db.prepare('INSERT INTO doctors (name,specialty,hospital,city,rating,years_exp) VALUES (?,?,?,?,?,?)');
  [
    ['Prof. Dr. Mehmet Kaya', 'Cardiology', 'Memorial Şişli Hospital', 'Istanbul', 4.9, 22],
    ['Doç. Dr. Elif Demirtaş', 'Cardiology', 'Acıbadem Maslak', 'Istanbul', 4.7, 15],
    ['Prof. Dr. Ahmet Yıldız', 'Orthopedics', 'Medipol Mega', 'Istanbul', 4.8, 20],
    ['Dr. Selin Arslan', 'Hair Transplant', 'Esteworld Clinic', 'Istanbul', 4.6, 12],
    ['Op. Dr. Can Öztürk', 'Plastic Surgery', 'Vera Clinic', 'Istanbul', 4.7, 14],
    ['Prof. Dr. Zeynep Aydın', 'Ophthalmology', 'Dünyagöz Hospital', 'Istanbul', 4.8, 19],
    ['Dt. Burak Şahin', 'Dentistry', 'DentGroup Maltepe', 'Istanbul', 4.5, 11],
    ['Prof. Dr. Hasan Çelik', 'Bariatric Surgery', 'Koç University Hospital', 'Istanbul', 4.9, 21],
    ['Doç. Dr. Ayşe Koç', 'IVF & Fertility', 'Bahçeci IVF Center', 'Istanbul', 4.7, 16],
    ['Dr. Emre Polat', 'General Surgery', 'Florence Nightingale', 'Istanbul', 4.4, 9],
  ].forEach(r => ins.run(...r));
}

if (count('hotels') === 0) {
  const ins = db.prepare('INSERT INTO hotels (name,stars,district,price_per_night) VALUES (?,?,?,?)');
  [
    ['Hilton Istanbul Bosphorus', 5, 'Şişli', 180],
    ['Swissôtel The Bosphorus', 5, 'Beşiktaş', 220],
    ['Ramada Plaza Tekstilkent', 4, 'Esenler', 85],
    ['Holiday Inn Şişli', 4, 'Şişli', 95],
    ['Divan Istanbul', 5, 'Taksim', 195],
    ['Point Hotel Taksim', 4, 'Taksim', 110],
    ['Nippon Hotel', 4, 'Taksim', 90],
  ].forEach(r => ins.run(...r));
}

if (count('flights') === 0) {
  const ins = db.prepare('INSERT INTO flights (flight_no,origin,destination,dep_time,arr_time,price) VALUES (?,?,?,?,?,?)');
  [
    ['TK1984', 'LHR', 'IST', '09:15', '15:05', 245],
    ['TK1772', 'CDG', 'IST', '10:40', '15:20', 230],
    ['TK1528', 'FRA', 'IST', '11:30', '15:45', 215],
    ['TK1332', 'JED', 'IST', '13:05', '16:40', 310],
    ['TK0754', 'BAH', 'IST', '14:20', '18:10', 340],
    ['TK1830', 'DXB', 'IST', '08:50', '13:00', 355],
    ['PC1091', 'AMS', 'SAW', '12:10', '16:35', 140],
  ].forEach(r => ins.run(...r));
}

if (count('accounts') === 0) {
  const ins = db.prepare('INSERT INTO accounts (name,type) VALUES (?,?)');
  [
    ['Acente Ana Kasa', 'customer'],
    ['Memorial Şişli Hospital', 'vendor'],
    ['Hilton Istanbul Bosphorus', 'vendor'],
    ['VIP Transfer Filosu', 'vendor'],
    ['THY Kurumsal', 'vendor'],
  ].forEach(r => ins.run(...r));
}

// Demo patients with a couple of conversations/messages
if (count('patients') === 0) {
  const ip = db.prepare(`INSERT INTO patients (name,nationality,language,passport_no,phone,email,complaint,complaint_tr,lead_status)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const demo = [
    ['James Whitfield', 'United Kingdom', 'en', 'UK-549201', '+44 7700 900123', 'j.whitfield@mail.com',
     'I have severe chest pain and need a cardiology consultation and possible angioplasty.',
     'Şiddetli göğüs ağrım var; kardiyoloji konsültasyonu ve olası anjiyoplasti gerekiyor.', 'new'],
    ['Fatima Al-Rashid', 'Saudi Arabia', 'ar', 'SA-881234', '+966 55 123 4567', 'fatima.ar@mail.com',
     'I would like a hair transplant procedure, about 4000 grafts.',
     'Yaklaşık 4000 greft saç ekimi işlemi istiyorum.', 'quoted'],
    ['Hans Müller', 'Germany', 'de', 'DE-C44X2A1', '+49 151 2345678', 'h.mueller@mail.com',
     'My knee cartilage is damaged; I need orthopedic surgery.',
     'Diz kıkırdağım hasarlı; ortopedik cerrahi gerekiyor.', 'agreed'],
    ['Sara Haddad', 'UAE', 'ar', 'AE-77120', '+971 50 987 6543', 'sara.h@mail.com',
     'I need IVF treatment, second attempt.',
     'Tüp bebek tedavisi gerekiyor, ikinci deneme.', 'in_operation'],
    ['Olga Petrova', 'Russia', 'ru', 'RU-65-99021', '+7 916 555 0134', 'olga.p@mail.com',
     'I want rhinoplasty and chin augmentation.',
     'Rinoplasti ve çene büyütme istiyorum.', 'completed'],
  ];
  demo.forEach(r => ip.run(...r));

  const ic = db.prepare(`INSERT INTO conversations (patient_id,channel,subject,sla_deadline,sla_responded,last_message_at)
    VALUES (?,?,?,?,?,datetime('now'))`);
  ic.run(1, 'whatsapp', 'Cardiology inquiry', Date.now() + 900000, 0);
  ic.run(2, 'web', 'Hair transplant quote', null, 1);
  ic.run(3, 'email', 'Knee surgery', null, 1);

  const im = db.prepare(`INSERT INTO messages (conversation_id,direction,body,body_translated,lang) VALUES (?,?,?,?,?)`);
  im.run(1, 'in', 'Hello, I have severe chest pain. Can you arrange a cardiology appointment in Istanbul?', 'Merhaba, şiddetli göğüs ağrım var. İstanbul\'da kardiyoloji randevusu ayarlayabilir misiniz?', 'en');
  im.run(2, 'in', 'Hello, I would like a quote for a 4000 graft hair transplant.', 'Merhaba, 4000 greft saç ekimi için fiyat teklifi almak istiyorum.', 'en');
  im.run(2, 'out', 'Merhaba, teklifimizi hazırlıyoruz. Doktorlarımızdan görüş alıyoruz.', null, 'tr');
  im.run(3, 'in', 'Guten Tag, mein Knieknorpel ist beschädigt. Ich brauche eine Operation.', 'Merhaba, diz kıkırdağım hasarlı. Ameliyat olmam gerekiyor.', 'de');
  im.run(3, 'out', 'Merhaba Hans Bey, ortopedi ekibimiz dosyanızı inceliyor.', null, 'tr');
}

// ---------- v2 schema (new business rules) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'rep',               -- rep | leader | driver | translator
  languages TEXT DEFAULT 'tr,en',        -- csv of ISO codes
  phone_masked TEXT,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT DEFAULT 'system',            -- sla_breach | info
  agent_id INTEGER,                      -- recipient (team leader for sla_breach)
  conversation_id INTEGER,
  message TEXT,
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rfq_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rfq_id INTEGER NOT NULL REFERENCES rfqs(id),
  view_password TEXT NOT NULL,           -- per-doctor data viewing password
  doctor_verified INTEGER DEFAULT 0,     -- KVK/GDPR identity verification done
  verified_at TEXT,
  credit_charged REAL DEFAULT 0          -- opinion fee paid to doctor from wallet
);

CREATE TABLE IF NOT EXISTS wallet (
  id INTEGER PRIMARY KEY CHECK (id=1),
  credits REAL DEFAULT 50000
);
INSERT OR IGNORE INTO wallet (id,credits) VALUES (1,50000);

CREATE TABLE IF NOT EXISTS wallet_txns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rfq_id INTEGER,
  amount REAL NOT NULL,                  -- negative = spend
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS postop_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT,                             -- wearable | external
  price REAL, currency TEXT DEFAULT 'EUR'
);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  items TEXT,                            -- json [{kind,desc,price}]
  postop_package_id INTEGER REFERENCES postop_packages(id),
  total REAL, currency TEXT DEFAULT 'EUR',
  status TEXT DEFAULT 'draft',           -- draft | sent | approved | paid
  e_signature TEXT,
  approved_at TEXT, paid_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  patient_id INTEGER REFERENCES patients(id),
  date TEXT NOT NULL,                    -- YYYY-MM-DD
  slot TEXT NOT NULL,                    -- e.g. '09:00-12:00'
  task TEXT,
  status TEXT DEFAULT 'scheduled',       -- scheduled | in_progress | done
  UNIQUE(agent_id, date, slot)           -- calendar conflict prevention
);

CREATE TABLE IF NOT EXISTS driver_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  booking_id INTEGER,
  patient_id INTEGER,
  label TEXT,                            -- 'Havalimanı Karşılama', 'Otel', 'Hastane'
  seq INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',         -- pending | in_progress | done
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS fx_rates (
  code TEXT PRIMARY KEY,
  rate REAL,                             -- units of foreign currency per TRY (sell)
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS commission_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  flat_pct REAL DEFAULT 3,               -- %3 flat
  threshold REAL DEFAULT 1000,           -- £/€1000+
  tiered_pct REAL DEFAULT 5              -- %5 above threshold
);

CREATE TABLE IF NOT EXISTS visa_rules (
  country TEXT PRIMARY KEY,
  rule TEXT,                             -- muafiyet | kimlik | 90gun | vize_gerekli
  note TEXT
);

CREATE TABLE IF NOT EXISTS insurance_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT, coverage TEXT, price REAL, currency TEXT DEFAULT 'EUR', policy_url TEXT
);
`);

// v2 column additions (guarded for existing db)
for (const sql of [
  "ALTER TABLE doctors ADD COLUMN title TEXT DEFAULT 'Dr.'",
  "ALTER TABLE doctors ADD COLUMN org_type TEXT DEFAULT 'hospital'",  // hospital | clinic
  "ALTER TABLE conversations ADD COLUMN assigned_agent_id INTEGER",
  "ALTER TABLE conversations ADD COLUMN masked_phone TEXT",
]) { try { db.exec(sql); } catch (_) { /* column exists */ } }

// backfill doctor titles/types
db.prepare("UPDATE doctors SET title='Prof. Dr.', org_type='hospital' WHERE name LIKE 'Prof.%' AND title='Dr.'").run();
db.prepare("UPDATE doctors SET title='Doç. Dr.' WHERE name LIKE 'Doç.%'").run();
db.prepare("UPDATE doctors SET title='Op. Dr.' WHERE name LIKE 'Op.%'").run();
db.prepare("UPDATE doctors SET org_type='clinic' WHERE hospital LIKE '%Clinic%' OR hospital LIKE '%Center%'").run();

if (count('agents') === 0) {
  const ins = db.prepare('INSERT INTO agents (name,role,languages,phone_masked) VALUES (?,?,?,?)');
  [
    ['Aylin Yurt', 'rep', 'tr,en', '+90 850 *** 1001'],
    ['Kerem Önal', 'rep', 'tr,en,de', '+90 850 *** 1002'],
    ['Leyla Haddad', 'rep', 'tr,ar,en', '+90 850 *** 1003'],
    ['Nadia Sorel', 'rep', 'tr,fr,en', '+90 850 *** 1004'],
    ['Murat Akgün', 'leader', 'tr,en', '+90 850 *** 1000'],
    ['Şoför Hasan', 'driver', 'tr,en', '+90 850 *** 2001'],
    ['Şoför İlyas', 'driver', 'tr,ar', '+90 850 *** 2002'],
    ['Tercüman Vera', 'translator', 'tr,ru,en', '+90 850 *** 3001'],
    ['Tercüman Sami', 'translator', 'tr,ar,en', '+90 850 *** 3002'],
  ].forEach(r => ins.run(...r));
  db.prepare("INSERT INTO commission_rules (agent_id,flat_pct,threshold,tiered_pct) VALUES (1,3,1000,5),(2,3,1000,5),(3,4,1000,6),(4,3,1000,5)").run();
}

if (count('postop_packages') === 0) {
  db.prepare(`INSERT INTO postop_packages (name,type,price) VALUES
    ('Giyilebilir Nabız/Oksimetre Takip Kiti','wearable',350),
    ('Harici Yara Bakım + Tele-sağlık Paketi','external',220),
    ('Giyilebilir Aktivite + Mobil Uygulama Paketi','wearable',290)`).run();
}

if (count('visa_rules') === 0) {
  const ins = db.prepare('INSERT INTO visa_rules (country,rule,note) VALUES (?,?,?)');
  [
    ['United Kingdom', '90gun', '90 gün vizesiz seyahat'],
    ['Germany', '90gun', '90 gün vizesiz seyahat'],
    ['France', '90gun', '90 gün vizesiz seyahat'],
    ['Saudi Arabia', 'muafiyet', 'Vize muafiyeti — pasaport yeterli'],
    ['UAE', 'muafiyet', 'Vize muafiyeti — pasaport yeterli'],
    ['Qatar', 'muafiyet', 'Vize muafiyeti — pasaport yeterli'],
    ['Kuwait', 'muafiyet', 'Vize muafiyeti — pasaport yeterli'],
    ['Russia', '90gun', '90 gün vizesiz seyahat'],
    ['Iran', '90gun', '90 gün vizesiz seyahat'],
    ['USA', 'vize_gerekli', 'e-Vize/vize başvurusu gerekli'],
    ['Iraq', 'vize_gerekli', 'Vize başvurusu gerekli'],
    ['Libya', 'vize_gerekli', 'Vize başvurusu gerekli'],
  ].forEach(r => ins.run(...r));
}

if (count('insurance_offers') === 0) {
  const ins = db.prepare('INSERT INTO insurance_offers (provider,coverage,price,policy_url) VALUES (?,?,?,?)');
  [
    ['Anadolu Sigorta', 'Seyahat + Sağlık (30 gün, €50k teminat)', 45, '/insurance/policy?offer=1'],
    ['Allianz Travel', 'Seyahat + Sağlık (30 gün, €100k teminat)', 80, '/insurance/policy?offer=2'],
    ['Sompo Sigorta', 'Medikal komplikasyon teminatı', 120, '/insurance/policy?offer=3'],
  ].forEach(r => ins.run(...r));
}

if (count('fx_rates') === 0) {
  const ins = db.prepare('INSERT INTO fx_rates (code,rate,updated_at) VALUES (?,?,datetime(\'now\'))');
  [['EUR', 38.20], ['USD', 35.10], ['GBP', 45.40], ['TRY', 1]].forEach(r => ins.run(...r));
}

// ---------- v3 schema (Logo ön muhasebe alanları) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS cashbanks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'kasa',              -- kasa | banka
  iban TEXT,
  currency TEXT DEFAULT 'TRY',
  branch TEXT                            -- banka şubesi
);

CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT,
  type TEXT DEFAULT 'cek',               -- cek | senet
  direction TEXT DEFAULT 'received',     -- received (müşteri çeki) | given (verilen çek)
  drawer TEXT,                           -- keşideci / borçlu
  amount REAL, currency TEXT DEFAULT 'TRY',
  issue_date TEXT, due_date TEXT,
  bank_name TEXT,
  status TEXT DEFAULT 'portfoy'          -- portfoy | tahsilde | tahsil_edildi | odendi | iade
);

CREATE TABLE IF NOT EXISTS expense_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, category TEXT DEFAULT 'genel'
);
`);

// cari hesap kartı detayları (Logo: vergi no, vergi dairesi, adres, iletişim, risk limiti, IBAN)
for (const sql of [
  "ALTER TABLE accounts ADD COLUMN vkn TEXT",
  "ALTER TABLE accounts ADD COLUMN vergi_dairesi TEXT",
  "ALTER TABLE accounts ADD COLUMN phone TEXT",
  "ALTER TABLE accounts ADD COLUMN address TEXT",
  "ALTER TABLE accounts ADD COLUMN risk_limit REAL DEFAULT 0",
  "ALTER TABLE accounts ADD COLUMN iban TEXT",
  "ALTER TABLE accounts ADD COLUMN currency TEXT DEFAULT 'EUR'",
  // fatura detay alanları (e-fatura/e-arşiv)
  "ALTER TABLE invoices ADD COLUMN direction TEXT DEFAULT 'sales'",   // sales (kesilen) | purchase (gelen)
  "ALTER TABLE invoices ADD COLUMN invoice_type TEXT DEFAULT 'SATIS'", // SATIS | IADE | TEVKIFAT | ISTISNA
  "ALTER TABLE invoices ADD COLUMN scenario TEXT DEFAULT 'TICARIFAT'", // TICARIFAT | TEMELFATURA | EARSIV | EFATURA
  "ALTER TABLE invoices ADD COLUMN vkn TEXT",
  "ALTER TABLE invoices ADD COLUMN vergi_dairesi TEXT",
  "ALTER TABLE invoices ADD COLUMN kdv_rate REAL DEFAULT 20",
  "ALTER TABLE invoices ADD COLUMN kdv_amount REAL DEFAULT 0",
  "ALTER TABLE invoices ADD COLUMN iskonto REAL DEFAULT 0",
  "ALTER TABLE invoices ADD COLUMN fx_rate REAL DEFAULT 0",
  "ALTER TABLE invoices ADD COLUMN payment_terms TEXT DEFAULT 'PESIN'", // PESIN | VADELI | TAKSITLI
  "ALTER TABLE invoices ADD COLUMN due_date TEXT",
  "ALTER TABLE invoices ADD COLUMN installments INTEGER DEFAULT 1",
  "ALTER TABLE invoices ADD COLUMN cashbank_id INTEGER",
  "ALTER TABLE bookings ADD COLUMN flight_status TEXT DEFAULT 'Scheduled'",
  // canlı uçuş takibi (AeroDataBox / FR24)
  "ALTER TABLE bookings ADD COLUMN flight_no TEXT",
  "ALTER TABLE bookings ADD COLUMN flight_date TEXT",
  "ALTER TABLE bookings ADD COLUMN flight_lat REAL",
  "ALTER TABLE bookings ADD COLUMN flight_lng REAL",
  "ALTER TABLE bookings ADD COLUMN eta TEXT",
  "ALTER TABLE bookings ADD COLUMN delay_min INTEGER DEFAULT 0",
  "ALTER TABLE bookings ADD COLUMN gate TEXT",
  "ALTER TABLE transactions ADD COLUMN cashbank_id INTEGER",
  "ALTER TABLE transactions ADD COLUMN vkn TEXT",
]) { try { db.exec(sql); } catch (_) { /* column exists */ } }

// üst yönetici (SLA eskalasyonu)
if (count('agents') > 0 && !db.prepare("SELECT id FROM agents WHERE role='exec'").get()) {
  db.prepare("INSERT INTO agents (name,role,languages,phone_masked) VALUES ('Genel Müdür (Üst Yönetici)','exec','tr,en','+90 850 *** 9000')").run();
}

if (count('cashbanks') === 0) {
  const ins = db.prepare('INSERT INTO cashbanks (name,type,iban,currency,branch) VALUES (?,?,?,?,?)');
  [
    ['Merkez Kasa', 'kasa', null, 'TRY', null],
    ['Döviz Kasası (EUR)', 'kasa', null, 'EUR', null],
    ['Ziraat Bankası TL', 'banka', 'TR33 0001 0090 0000 1234 5678 90', 'TRY', 'Şişli Şb.'],
    ['İş Bankası EUR', 'banka', 'TR98 0006 4000 0026 3000 1234 56', 'EUR', 'Maslak Şb.'],
  ].forEach(r => ins.run(...r));
}

if (count('checks') === 0) {
  const ins = db.prepare('INSERT INTO checks (doc_no,type,direction,drawer,amount,currency,issue_date,due_date,bank_name,status) VALUES (?,?,?,?,?,?,?,?,?,?)');
  [
    ['CK-1001', 'cek', 'received', 'James Whitfield', 5200, 'EUR', '2026-10-28', '2026-11-20', 'Garanti BBVA', 'portfoy'],
    ['SN-2001', 'senet', 'received', 'Fatima Al-Rashid', 3400, 'EUR', '2026-10-30', '2026-12-15', null, 'portfoy'],
    ['CK-1002', 'cek', 'given', 'Hilton Istanbul Bosphorus', 950, 'EUR', '2026-11-01', '2026-11-30', 'Yapı Kredi', 'portfoy'],
  ].forEach(r => ins.run(...r));
}

if (count('expense_cards') === 0) {
  const ins = db.prepare('INSERT INTO expense_cards (name,category) VALUES (?,?)');
  [['Reklam/Pazarlama', 'ads'], ['Ofis Giderleri', 'office'], ['Personel', 'hr'], ['Komisyon Gideri', 'commission'], ['Seyahat', 'travel']]
    .forEach(r => ins.run(...r));
}

// cari hesap kart detayları
db.prepare("UPDATE accounts SET vkn='0050012345', vergi_dairesi='Şişli V.D.', phone='+90 212 000 00 01', address='Büyükdere Cad. No:1 Şişli/İstanbul', risk_limit=50000, iban='TR33 0001 0090 0000 1234 5678 90' WHERE id=1 AND vkn IS NULL").run();
db.prepare("UPDATE accounts SET vkn='8350042310', vergi_dairesi='Beşiktaş V.D.', risk_limit=100000 WHERE id=2 AND vkn IS NULL").run();

// ---------- v4 schema (5 yeni panel) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS subagents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country TEXT,
  contact TEXT,
  commission_pct REAL DEFAULT 10,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS postop_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  day INTEGER,                          -- taburcu sonrası gün
  pain_score INTEGER,                   -- 0-10
  satisfaction INTEGER,                 -- 1-5
  note TEXT,
  photo_note TEXT,                      -- iyileşme foto sim açıklaması
  ai_flag TEXT DEFAULT 'ok',            -- ok | watch | red
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS postop_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  level TEXT DEFAULT 'red',             -- red | watch
  message TEXT,
  status TEXT DEFAULT 'open',           -- open | intervened | resolved
  action_taken TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS hospital_receivables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,          -- hastane/klinik cari
  patient_id INTEGER,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'EUR',
  due_date TEXT,
  status TEXT DEFAULT 'expected',       -- expected | overdue | collected
  collected_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kvkk_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  form_type TEXT DEFAULT 'kvkk',        -- kvkk | consent
  signer_name TEXT,
  passport_no TEXT,
  signature_hash TEXT,
  ocr_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

for (const sql of [
  "ALTER TABLE patients ADD COLUMN subagent_id INTEGER",
  "ALTER TABLE patients ADD COLUMN postop_since TEXT",
]) { try { db.exec(sql); } catch (_) { /* column exists */ } }

// --- v4 seeds ---
if (count('subagents') === 0) {
  const ins = db.prepare('INSERT INTO subagents (name,country,contact,commission_pct) VALUES (?,?,?,?)');
  [
    ['Gulf Health Partners', 'Qatar', 'Doha ofis · +974 4000 1122', 12],
    ['Balkan Med Travel', 'Germany', 'Berlin ofis · +49 30 555 010', 10],
    ['CIS Care Bridge', 'Russia', 'Moskova ofis · +7 495 100 200', 15],
  ].forEach(r => ins.run(...r));
}
// mevcut hastaları uyruğa göre alt acenteye bağla
db.prepare("UPDATE patients SET subagent_id=1 WHERE subagent_id IS NULL AND nationality IN ('Qatar','UAE','Saudi Arabia','Kuwait','Iraq','Bahrain')").run();
db.prepare("UPDATE patients SET subagent_id=2 WHERE subagent_id IS NULL AND nationality IN ('Germany','France','United Kingdom','Austria','Netherlands')").run();
db.prepare("UPDATE patients SET subagent_id=3 WHERE subagent_id IS NULL AND nationality IN ('Russia','Ukraine','Kazakhstan','Iran')").run();

// operasyonu biten hastalara post-op başlangıç tarihi ver (30/60/90 takibi için)
db.prepare("UPDATE patients SET postop_since=datetime('now','-45 days') WHERE postop_since IS NULL AND lead_status='completed' AND id%2=0").run();
db.prepare("UPDATE patients SET postop_since=datetime('now','-80 days') WHERE postop_since IS NULL AND lead_status='completed' AND id%2=1").run();
db.prepare("UPDATE patients SET postop_since=datetime('now','-10 days') WHERE postop_since IS NULL AND lead_status='in_operation'").run();

if (count('postop_checkins') === 0 && count('patients') > 0) {
  const pp = db.prepare("SELECT id FROM patients WHERE postop_since IS NOT NULL LIMIT 1").get();
  if (pp) {
    const ins = db.prepare(`INSERT INTO postop_checkins (patient_id,day,pain_score,satisfaction,note,photo_note,ai_flag,created_at)
      VALUES (?,?,?,?,?,?,?,datetime('now',?))`);
    ins.run(pp.id, 12, 3, 4, 'Hafif ağrı, ilaçlara devam.', 'Kesi bölgesi normal görünümde', 'ok', '-33 days');
    ins.run(pp.id, 15, 4, 4, 'Ağrı hafif arttı ama dayanılabilir.', 'Hafif kızarıklık mevcut', 'watch', '-30 days');
    ins.run(pp.id, 18, 7, 2, 'Kesi bölgesinde şişlik ve ateş var, endişeliyim.', 'Belirgin ödem ve kızarıklık', 'red', '-27 days');
    db.prepare(`INSERT INTO postop_alerts (patient_id,level,message,created_at) VALUES (?,?,?,datetime('now','-27 days'))`)
      .run(pp.id, 'red', 'Ağrı skoru 7/10 + memnuniyet 2/5 + şişlik/ateş şikayeti — olası enfeksiyon riski');
  }
}

if (count('hospital_receivables') === 0) {
  const ins = db.prepare(`INSERT INTO hospital_receivables (account_id,patient_id,amount,currency,due_date,status) VALUES (?,?,?,?,?,?)`);
  const jw = db.prepare("SELECT id FROM patients WHERE name='James Whitfield' LIMIT 1").get();
  const kw = db.prepare("SELECT id FROM patients WHERE name='Klaus Weber' LIMIT 1").get();
  const ar = db.prepare("SELECT id FROM patients WHERE name='Ali Rezaei' LIMIT 1").get();
  if (jw) ins.run(2, jw.id, 1040, 'EUR', '2026-11-10', 'expected');
  if (kw) ins.run(2, kw.id, 1320, 'EUR', '2026-11-25', 'expected');
  if (ar) ins.run(3, ar.id, 880, 'EUR', '2026-10-25', 'overdue');
}

// ---- v5: pazarlama & paket oluşturucu ----
db.exec(`CREATE TABLE IF NOT EXISTS ad_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,                 -- meta | google
  country TEXT NOT NULL,
  name TEXT NOT NULL,
  spend REAL DEFAULT 0,
  leads INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  revenue REAL DEFAULT 0,
  currency TEXT DEFAULT 'EUR',
  created_at TEXT DEFAULT (datetime('now'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS treatments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_en TEXT,
  base_price REAL DEFAULT 0
)`);

for (const sql of [
  "ALTER TABLE offers ADD COLUMN share_token TEXT",
  "ALTER TABLE offers ADD COLUMN lang TEXT DEFAULT 'en'",
  "ALTER TABLE offers ADD COLUMN delivered_via TEXT",
]) { try { db.exec(sql); } catch (_) { /* exists */ } }

if (count('ad_campaigns') === 0) {
  const ins = db.prepare('INSERT INTO ad_campaigns (channel,country,name,spend,leads,conversions,revenue) VALUES (?,?,?,?,?,?,?)');
  [
    ['meta',    'United Kingdom', 'UK — Saç Ekimi Lookalike',        4200, 86, 9, 31500],
    ['google',  'United Kingdom', 'UK — Hair Transplant Search',     3100, 64, 7, 24800],
    ['meta',    'Germany',        'DE — Rinoplasti Carousel',        3800, 72, 8, 35200],
    ['google',  'Germany',        'DE — Nasenkorrektur Search',      2600, 51, 4, 14100],
    ['meta',    'Qatar',          'QA — VIP Health Travel',          5200, 38, 7, 42800],
    ['meta',    'UAE',            'UAE — Luxury Aesthetics',         4700, 42, 6, 38400],
    ['google',  'Russia',         'RU — Эстетика Стамбул Search',    2900, 58, 3, 9600],
    ['meta',    'Saudi Arabia',   'KSA — Diş & Gülüş Tasarımı',      3400, 47, 5, 21300],
    ['google',  'Iran',           'IR — Istanbul Clinic Ads',        1800, 39, 2, 5400],
    ['meta',    'Kuwait',         'KW — Premium Packages',           2200, 25, 3, 14700],
    ['google',  'France',         'FR — Greffe Cheveux Search',      2100, 33, 2, 7200],
  ].forEach(r => ins.run(...r));
}

if (count('treatments') === 0) {
  const ins = db.prepare('INSERT INTO treatments (name,name_en,base_price) VALUES (?,?,?)');
  [
    ['Saç Ekimi (FUE)',        'Hair Transplant (FUE)',   2200],
    ['Rinoplasti',             'Rhinoplasty',             3500],
    ['Diş / Gülüş Tasarımı',   'Dental / Smile Design',   1800],
    ['Lazer Göz (LASIK)',      'LASIK Eye Surgery',       1500],
    ['Meme Estetiği',          'Breast Aesthetics',       4000],
    ['Tüp Bebek (IVF)',        'IVF Treatment',           3200],
    ['Ortopedi (Diz)',         'Knee Orthopedics',        6500],
    ['Check-up Premium',       'Premium Check-up',         400],
  ].forEach(r => ins.run(...r));
}

if (!db.prepare("SELECT id FROM agents WHERE role='ops'").get()) {
  db.prepare("INSERT INTO agents (name,role,languages,phone_masked) VALUES (?,?,?,?)").run('Operasyon Danışmanı Elif', 'ops', 'tr,en,de', '+90 850 *** 5001');
  db.prepare("INSERT INTO agents (name,role,languages,phone_masked) VALUES (?,?,?,?)").run('Operasyon Danışmanı Can', 'ops', 'tr,en,ar', '+90 850 *** 5002');
}
try { db.exec('ALTER TABLE patients ADD COLUMN ops_agent_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE patients ADD COLUMN sales_agent_id INTEGER'); } catch {}

db.exec(`CREATE TABLE IF NOT EXISTS escrow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  amount REAL NOT NULL,
  status TEXT DEFAULT 'blocked',        -- blocked | released
  fee_pct REAL DEFAULT 1.5,
  created_at TEXT DEFAULT (datetime('now')),
  released_at TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS escrow_splits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  escrow_id INTEGER NOT NULL REFERENCES escrow(id),
  kind TEXT NOT NULL,                   -- hospital | hotel | transfer | commission | fee
  amount REAL NOT NULL,
  note TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS local_consults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  local_doctor TEXT,
  city TEXT,
  fee REAL,
  status TEXT DEFAULT 'pending',        -- pending | approved | rejected
  created_at TEXT DEFAULT (datetime('now'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS anamnesis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  specialty TEXT,
  lang TEXT DEFAULT 'en',
  status TEXT DEFAULT 'pending',        -- pending | submitted
  answers TEXT,                          -- JSON
  created_at TEXT DEFAULT (datetime('now')),
  submitted_at TEXT
)`);

module.exports = db;

db.exec(`CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER REFERENCES patients(id),
  booking_id INTEGER, amount REAL, status TEXT DEFAULT 'open',
  reason TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS field_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER, patient_id INTEGER, task TEXT,
  location_ok INTEGER DEFAULT 0, payout REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));`)
if (!db.prepare("SELECT id FROM agents WHERE role='oncall'").get()) {
  db.prepare("INSERT INTO agents (name,role,languages,phone_masked) VALUES (?,?,?,?)").run('Nöbetçi Danışman Zeynep', 'oncall', 'tr,en,ar,ru,de', '+90 850 *** 6001');
}
try { db.exec('ALTER TABLE offers ADD COLUMN fx_locked REAL'); } catch {}
try { db.exec('ALTER TABLE patients ADD COLUMN marketing_consent INTEGER DEFAULT 0'); } catch {}

db.exec(`CREATE TABLE IF NOT EXISTS role_permissions (role TEXT, module TEXT, allowed INTEGER DEFAULT 1, UNIQUE(role,module))`);
if (count('role_permissions') === 0) {
  const mods = ['dashboard','crm','comms','rfq','ops','finance','analytics','compliance','postop','admin'];
  const defaults = {
    admin:   mods.map(() => 1),
    rep:     { dashboard:1, crm:1, comms:1, rfq:1 },
    ops:     { dashboard:1, crm:1, ops:1, postop:1 },
    finance: { dashboard:1, finance:1, compliance:1 },
    field:   { dashboard:1, ops:1 },
  };
  const ins = db.prepare('INSERT INTO role_permissions (role,module,allowed) VALUES (?,?,?)');
  for (const role of Object.keys(defaults))
    for (const m of mods) ins.run(role, m, defaults[role][m] ?? 0);
}
