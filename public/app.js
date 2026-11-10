/* HTA ERP & CRM — Phase 1 frontend */
const socket = io();
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (u, m = 'GET', b) => {
 const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json', 'x-user-role': ROLE }, body: b ? JSON.stringify(b) : undefined });
 return r.json();
};
let ROLE = localStorage.getItem('clinica-role') || 'admin';
const fmt = n => '€' + Number(n || 0).toLocaleString('tr-TR');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toast = t => { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; $('#toast').appendChild(d); setTimeout(() => d.remove(), 3500); };

let patients = [], conversations = [], activeConv = null, activity = [];

const LEADS = [
 ['new', 'Yeni'], ['quoted', 'Teklif Verildi'], ['agreed', 'Anlaşıldı'],
 ['in_operation', 'Operasyonda'], ['completed', 'Tamamlandı'],
];
const leadName = s => (LEADS.find(l => l[0] === s) || [s, s])[1];

// ---------- tabs (akordiyon menü) ----------
$$('#nav .nav-head').forEach(h => h.onclick = () => h.parentElement.classList.toggle('open'));
$('#logo-home').onclick = () => goTab('dashboard');
$$('#nav .nav-sub').forEach(b => b.onclick = () => { goTab(b.dataset.tab); if (b.dataset.hint) toast(b.dataset.hint); });
const switchTab = t => goTab(t);
// tema + menü daraltma
const htmlEl = document.documentElement;
htmlEl.dataset.theme = localStorage.getItem('hta-theme') || 'dark';
$('#theme-toggle').onclick = () => {
 htmlEl.dataset.theme = htmlEl.dataset.theme === 'dark' ? 'light' : 'dark';
 localStorage.setItem('hta-theme', htmlEl.dataset.theme);
};
$('#nav-collapse').onclick = () => $('#sidebar').classList.toggle('collapsed');

socket.on('connect', () => { $('#ws-status').textContent = '● canlı'; $('#ws-status').className = 'ws online'; });
socket.on('disconnect', () => { $('#ws-status').textContent = '● çevrimdışı'; $('#ws-status').className = 'ws offline'; });
function logActivity(t) { activity.unshift(new Date().toLocaleTimeString('tr-TR') + ' — ' + t); activity = activity.slice(0, 20); renderActivity(); }
function renderActivity() { $('#activity').innerHTML = activity.map(a => `<div>${esc(a)}</div>`).join('') || '<div class="mut">Henüz aktivite yok</div>'; }

// ---------- KPIs ----------
async function loadKpis() {
 const k = await api('/api/kpis');
 $('#kpis').innerHTML = [
 [k.patients, 'Toplam Hasta', ''], [k.openLeads, 'Açık Lead', ''],
 [k.slaBreaching, 'SLA Aşımı', 'alert'], [k.pendingRfqs, 'Bekleyen RFQ', ''],
 [fmt(k.revenue), 'Gelir', ''], [fmt(k.expense), 'Gider', ''],
 [fmt(k.revenue - k.expense), 'Net Marj', ''],
 ].map(([v, l, c]) => `<div class="kpi ${c}"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
 $('#sla-badge').textContent = k.slaBreaching;
 $('#sla-badge').classList.toggle('hidden', !k.slaBreaching);
 renderFunnel(); renderRecent(); loadExecutive();
}
function renderFunnel() {
 const counts = LEADS.map(([s, n]) => [n, patients.filter(p => p.lead_status === s).length]);
 const max = Math.max(1, ...counts.map(c => c[1]));
 $('#funnel').innerHTML = counts.map(([n, c]) =>
 `<div class="funnel-row"><div style="width:110px">${n}</div><div class="funnel-bar" style="width:${c / max * 100}%">${c}</div></div>`).join('');
}

// ---------- Inbox ----------
const CH_ICON = { whatsapp: ' WhatsApp', web: ' Web', email: ' Mail', instagram: ' Instagram' };
async function loadConvs() {
 conversations = await api('/api/conversations');
 $('#conv-list').innerHTML = conversations.map(c => `
 <div class="conv-item ${activeConv === c.id ? 'active' : ''}" onclick="openConv(${c.id})">
 <div class="top"><span class="name plink" data-pid="${c.patient_id}">${esc(c.patient_name)}</span><span class="ch">${CH_ICON[c.channel] || c.channel}</span></div>
 <div class="top"><span class="prev">${esc(c.last_body || '')}</span>
 <span class="sla" data-deadline="${c.sla_deadline || ''}" data-responded="${c.sla_responded}"></span></div>
 <div class="prev">${c.agent_name ? ' ' + esc(c.agent_name) : 'atanmadı'} · ${c.masked_phone ? ' ' + esc(c.masked_phone) : ''} · ${FLAG[c.language] || ''} ${esc(c.language || '')}</div>
 </div>`).join('') || '<div class="empty">Görüşme yok</div>';
}
function tickSla() {
 $$('.sla').forEach(el => {
 if (el.dataset.responded === '1' || !el.dataset.deadline) { el.textContent = '✓ yanıtlandı'; el.className = 'sla ok'; return; }
 const left = Math.floor((+el.dataset.deadline - Date.now()) / 1000);
 if (left <= 0) { el.textContent = 'SLA AŞTI'; el.className = 'sla bad'; return; }
 el.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
 el.className = 'sla ' + (left < 300 ? 'bad' : 'warn');
 });
}
setInterval(tickSla, 1000);
window.openConv = async id => {
 activeConv = id; await loadConvs();
 const c = conversations.find(x => x.id === id);
 if (!c) return;
 const msgs = await api(`/api/conversations/${id}/messages`);
 $('#chat-pane').innerHTML = `
 <div class="chat-head"><span><b class="plink" data-pid="${c.patient_id}">${esc(c.patient_name)}</b>
 <span class="mut" style="font-size:12px"> · ${esc(c.masked_phone || 'maskeli hat')} · ${esc(c.agent_name || 'atanmadı')} · ${FLAG[c.language] || ''} ${esc(c.language || '')}</span></span>
 <span class="ch">${CH_ICON[c.channel]}</span></div>
 <div class="chat-body">${msgs.map(m => `
 <div class="msg ${m.direction}">${esc(m.body)}
 ${m.direction === 'in' && m.body_translated ? `<div class="tr"> ${esc(m.body_translated)}</div>` : ''}
 </div>`).join('')}</div>
 <div class="chat-input"><button class="btn ghost" style="width:auto" title="Hastadan gelen mesaj simüle et" onclick="simIn(${id})">← Hasta yanıtı</button><button class="btn ghost" style="width:auto" title="Şikayete özel tıbbi bilgi formu linki gönder" onclick="sendAnamnesis(${c.patient_id},${id})"> Anamnez</button><input id="reply" class="input" placeholder="Türkçe yanıt yazın…">
 <select id="tpl-pick" class="input" style="width:auto" title="Hazır şablon (hastanın dilinde)">
 <option value="">Şablon…</option>
 <option value="flight">✈ Uçuş Öncesi Bilgilendirme</option>
 <option value="transfer"> Transfer Karşılama Detayı</option>
 <option value="discharge"> Taburcu Sonrası Rehber</option></select><button class="btn primary" onclick="sendReply(${id})">Gönder</button></div>`;
 $('.chat-body').scrollTop = 1e9;
 $('#reply').focus();
 $('#tpl-pick').onchange = async e => { if (!e.target.value) return; await api(`/api/conversations/${id}/reply`, 'POST', { body: TPL[c.language] && TPL[c.language][e.target.value] ? TPL[c.language][e.target.value] : TPL.en[e.target.value] }); e.target.value=''; };
 // sağ özet paneli
 const side = $('#conv-side');
 if (side) {
 const p = patients.find(x => x.id === c.patient_id) || {};
 const [lbl] = stageOf(p);
 side.innerHTML = `<h3 style="margin:0 0 10px">Hasta Özeti</h3>
 <div class="srow"><span>Ad</span><b>${esc(c.patient_name)}</b></div>
 <div class="srow"><span>Ülke</span><b>${CFLAG[p.nationality] || ''} ${esc(p.nationality || '—')}</b></div>
 <div class="srow"><span>Dil</span><b>${FLAG[c.language] || ''} ${esc(c.language || '—')}</b></div>
 <div class="srow"><span>SLA</span><b><span class="sla" data-deadline="${c.sla_deadline || ''}" data-responded="${c.sla_responded}"></span></b></div>
 <div class="srow"><span>Temsilci</span><b>${esc(c.agent_name || 'atanmadı')}</b></div>
 <div class="srow"><span>Hat</span><b>${esc(c.masked_phone || 'maskeli')}</b></div>
 <div class="srow"><span>Aşama</span><b>${lbl || '—'}</b></div>
 <button class="btn ghost mini" style="margin-top:12px;width:100%" onclick="openDrawer(${c.patient_id})"> Dosyayı aç</button>`;
 }
};
window.simIn = async id => { await api(`/api/conversations/${id}/inbound`, 'POST'); };
window.sendAnamnesis = async (pid, cid) => {
 const r = await api('/api/anamnesis', 'POST', { patient_id: pid });
 toast(` Anamnez linki gönderildi (${r.specialties.join(', ')})`);
 loadAnamnesis();
 if (cid) openConv(cid);
};
async function loadAnamnesis() {
 const el = $('#anam-list'); if (!el) return;
 const list = await api('/api/anamnesis');
 el.innerHTML = list.map(a => `<div class="li"><span><b class="plink" data-pid="${a.patient_id}">${esc(a.patient_name)}</b>
 <div class="mut">${esc(a.specialty)} · ${a.lang} · <a href="/a/${a.token}" target="_blank">/a/${a.token}</a></div></span>
 <span class="tag ${a.status === 'submitted' ? 'green' : 'yellow'}">${a.status === 'submitted' ? ' dolduruldu' : ' bekliyor'}</span></div>`).join('')
 || '<div class="mut">Henüz link üretilmedi</div>';
}
if ($('#anam-create')) $('#anam-create').onclick = async () => {
 const pid = +$('#anam-patient').value; if (!pid) return toast('Hasta seçin');
 await sendAnamnesis(pid);
};
async function loadRecentFiles() {
 const el = $('#files-recent'); if (!el) return;
 const files = await api('/api/files');
 el.innerHTML = files.map(f => `<div class="li"><span> ${esc(f.filename)}
 <div class="mut"><span class="plink" data-pid="${f.patient_id}">${esc(f.patient_name)}</span> · ${esc(f.category)} · ${esc(f.uploaded_at || '')}</div></span>
 ${f.path ? `<a class="btn ghost mini" href="${f.path}" target="_blank">Aç</a>` : ''}</div>`).join('')
 || '<div class="mut">Dosya yok</div>';
}
if ($('#files-open')) $('#files-open').onclick = () => { const pid = +$('#files-patient').value; if (pid) openDrawer(pid); };
window.sendReply = async id => {
 const v = $('#reply').value.trim(); if (!v) return;
 await api(`/api/conversations/${id}/reply`, 'POST', { body: v });
 openConv(id); loadKpis();
};
$('#sim-inbound').onclick = async () => { await api('/api/simulate/inbound', 'POST'); };
let autoOn = false;
$('#auto-toggle').onclick = async () => {
 autoOn = !autoOn;
 await api('/api/simulate/auto', 'POST', { on: autoOn });
 $('#auto-toggle').textContent = 'Otomatik sim: ' + (autoOn ? 'açık' : 'kapalı');
};
socket.on('inbound', d => { toast(` Yeni ${d.conversation.channel} mesajı: ${d.patient.name}`); logActivity(`Yeni mesaj — ${d.patient.name} (${d.conversation.channel})`); loadConvs(); loadPatients(); loadKpis(); applyRole(); });
socket.on('message', d => {
 if (activeConv) openConv(activeConv);
 // Otomatik yanıt: gelen hasta mesajına seçili şablonla cevap
 if (tplAuto.on && d && d.message && d.message.direction === 'in') {
 const tpl = tpls()[tplAuto.pick] || tpls()[0];
 if (tpl) setTimeout(() => api(`/api/conversations/${d.conversation_id}/reply`, 'POST', { body: tpl.body })
 .then(() => { toast(' Otomatik yanıt gönderildi: ' + tpl.name); logActivity('Otomatik yanıt — ' + tpl.name); }), 800);
 }
});
socket.on('sla', () => { loadConvs(); loadKpis(); });
socket.on('anamnesis', d => { toast(` ${d.name} tıbbi verilerini yükledi`); logActivity(`Anamnez formu dolduruldu — ${d.name}`); loadPatients(); });

// ---------- Şablonlar & Otomatik Yanıtlar ----------
const TPL_DEFAULTS = [
 { name: 'Karşılama', body: 'Merhaba! HTA Sağlık Turizmi\'ne hoş geldiniz. Size nasıl yardımcı olabilirim?' },
 { name: 'Fiyat bilgisi', body: 'Teşekkürler! Tedaviniz için size özel bir teklif hazırlıyorum; kısa süre içinde link ileteceğim.' },
 { name: 'Pasaport talebi', body: 'Teklifinizi hazırlayabilmemiz için pasaportunuzun fotoğrafını paylaşabilir misiniz?' },
 { name: 'Teşekkür', body: 'Bilgiler için teşekkürler! Ekibimiz en kısa sürede size dönüş yapacaktır.' },
];
function tpls() { try { return JSON.parse(localStorage.getItem('hta-tpls')) || TPL_DEFAULTS; } catch { return TPL_DEFAULTS; } }
const tplAuto = { pick: +(localStorage.getItem('hta-tpl-pick') || 0), on: localStorage.getItem('hta-tpl-auto') === '1' };
function loadTemplates() {
 const list = tpls();
 $('#tpl-list').innerHTML = list.map((t, i) => `
 <div class="tpl-item"><b>${esc(t.name)}</b>
 <textarea id="tpl-txt-${i}" class="input" rows="3">${esc(t.body)}</textarea>
 <button class="btn ghost mini" onclick="saveTpl(${i})">Kaydet</button></div>`).join('');
 $('#tpl-auto-pick').innerHTML = list.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('');
 $('#tpl-auto-pick').value = tplAuto.pick;
 $('#tpl-auto-on').checked = tplAuto.on;
 $('#tpl-status').textContent = tplAuto.on ? `Aktif — gelen mesajlara "${list[tplAuto.pick].name}" şablonu ile yanıt verilir.` : 'Kapalı';
}
window.saveTpl = i => { const l = tpls(); l[i].body = $('#tpl-txt-' + i).value; localStorage.setItem('hta-tpls', JSON.stringify(l)); toast('Şablon kaydedildi'); };
if ($('#tpl-list')) {
 $('#tpl-auto-pick').onchange = e => { tplAuto.pick = +e.target.value; localStorage.setItem('hta-tpl-pick', tplAuto.pick); loadTemplates(); };
 $('#tpl-auto-on').onchange = e => { tplAuto.on = e.target.checked; localStorage.setItem('hta-tpl-auto', tplAuto.on ? '1' : '0'); loadTemplates(); };
}

// ---------- CRM ----------
async function loadPatients() {
 patients = await api('/api/patients');
 renderKanban(); renderFunnel(); renderPatients();
 const opts = patients.map(p => `<option value="${p.id}">${esc(p.name)} — ${esc(p.nationality)}</option>`).join('');
 ['#ai-patient', '#usha-patient', '#inc-patient', '#zx-patient', '#anam-patient', '#files-patient', '#oc-patient', '#as-patient'].forEach(s => { const el = $(s); if (el) el.innerHTML = opts; });
 const ivp = $('#inv-patient'); if (ivp && !ivp.value) ivp.innerHTML = '<option value=""> Hasta seçin (fatura için zorunlu)…</option>' + opts;
 // Hasta-ilk (patient-first) kilitli işlem seçicileri: hasta seçilmeden butonlar pasif
 const BK_SEL = { '#bk-patient': 'flight', '#hotel-patient': 'hotel', '#tr-patient': 'transfer', '#ins-patient': 'ins', '#tour-patient': 'tour' };
 Object.entries(BK_SEL).forEach(([s, k]) => {
 const el = $(s); if (!el) return;
 const prev = el.value;
 el.innerHTML = '<option value=""> Hasta seçin…</option>' + opts;
 if (prev && patients.some(p => String(p.id) === prev)) el.value = prev;
 el.onchange = () => { document.querySelectorAll(`.bkbtn[data-k="${k}"]`).forEach(b => b.disabled = !el.value); };
 el.onchange();
 });
}
function renderKanban() {
 $('#kanban').innerHTML = LEADS.map(([s, n]) => `
 <div class="kcol"><h3>${n} (${patients.filter(p => p.lead_status === s).length})</h3>
 ${patients.filter(p => p.lead_status === s).map(p => `
 <div class="kcard" onclick="openDrawer(${p.id})"><b>${esc(p.name)}</b>
 <div class="mut">${esc(p.nationality)} · ${esc(p.complaint_tr || p.complaint || '').slice(0, 60)}</div></div>`).join('')}
 </div>`).join('');
}
// ---------- Hastalarım (sade liste) ----------
const STAGE_LABEL = { new: ['Yeni Lead', 1], offer_sent: ['Teklif Bekliyor', 2], agreed: ['Uçuş/Transfer', 3], in_operation: ['Hastanede', 4], completed: ['Taburcu / Tamam', 5] };
function stageOf(p) { const s = STAGE_LABEL[p.lead_status] || STAGE_LABEL.new; return p.postop_since && p.lead_status === 'completed' ? ['Taburcu · Post-Op', 5] : s; }
function renderPatients() {
 const cel = $('#pat-country');
 if (cel && cel.options.length <= 1) cel.innerHTML = '<option value="">Tüm ülkeler</option>' + [...new Set(patients.map(p => p.nationality))].filter(Boolean).sort().map(n => `<option>${esc(n)}</option>`).join('');
 const q = ($('#pat-search')?.value || '').toLowerCase(), co = $('#pat-country')?.value || '', st = $('#pat-stage')?.value || '', tr = ($('#pat-treat')?.value || '').toLowerCase();
 const rows = patients.filter(p =>
 (!q || (p.name + ' ' + (p.passport_no || '')).toLowerCase().includes(q)) &&
 (!co || p.nationality === co) && (!st || p.lead_status === st) &&
 (!tr || (p.complaint_tr || p.complaint || '').toLowerCase().includes(tr)));
 const el = $('#patients-list'); if (!el) return;
 el.innerHTML = rows.map(p => { const [lbl, n] = stageOf(p); return `
 <div class="pat-row">
 <div><div class="nm">${esc(p.name)}</div><div class="mut" style="font-size:12px">${esc(p.passport_no || '')} · ${esc(p.complaint_tr || p.complaint || '').slice(0, 45)}</div></div>
 <div>${CFLAG[p.nationality] || ''} ${esc(p.nationality)}</div>
 <div><span class="stage-chip s${n}">${lbl}</span></div>
 <div class="pat-bal ${p.balance >= 0 ? 'pos' : 'neg'}">${fmt(p.balance || 0)}</div>
 <div><button class="btn primary mini" onclick="openDrawer(${p.id})"> Dosya</button></div>
 </div>`; }).join('') || '<div class="empty">Sonuç yok</div>';
}
['pat-search', 'pat-country', 'pat-stage', 'pat-treat'].forEach(id => { const e = document.getElementById(id); if (e) { e.oninput = renderPatients; e.onchange = renderPatients; } });
$('#new-patient-btn').onclick = async () => {
 const name = prompt('Hasta adı:'); if (!name) return;
 const nationality = prompt('Uyruk:', 'UK') || '';
 const complaint = prompt('Şikâyet / talep:', '') || '';
 await api('/api/patients', 'POST', { name, nationality, complaint });
 loadPatients(); loadKpis(); applyRole();
};
window.closeWs = () => $('#workspace').classList.remove('open');
const goTab = t => {
$$('#nav .nav-sub').forEach(x => x.classList.remove('active'));
 $$('#nav .nav-head').forEach(x => x.classList.remove('active'));
 $$('.tab').forEach(x => x.classList.remove('active'));
 const sub = $(`#nav .nav-sub[data-tab="${t}"]`);
 if (sub) { const g = sub.closest('.nav-group'); g.classList.add('open'); g.querySelector('.nav-head').classList.add('active'); sub.classList.add('active'); }
 $('#tab-' + t)?.classList.add('active');
 ({ anamnesis: loadAnamnesis, files: loadRecentFiles, tour: loadTour, hsys: loadHsys, auditlog: loadAuditLog, opcal: loadOpcal }[t] || (() => {}))();
};
window.goTab = goTab;
const FLAG = { en: '', de: '', fr: '', ar: '', ru: '', tr: '', fa: '', es: '' };
const CFLAG = { 'United Kingdom': '', 'Germany': '', 'France': '', 'Russia': '', 'Turkey': '', 'Iran': '', 'Qatar': '', 'UAE': '', 'Saudi Arabia': '', 'Kuwait': '', 'Iraq': '', 'USA': '', 'Spain': '' };

// ---------- Unified Patient Master File: global context + 4-sekmeli drawer ----------
document.addEventListener('click', e => {
 const el = e.target.closest('.plink[data-pid]');
 if (el) { e.preventDefault(); openDrawer(+el.dataset.pid); }
});

window.GP = null; // Global Patient ID — paneller arası bağ
window.setGlobalPatient = pid => { GP = pid;
 // Hastayı içeren tüm select'leri global hastaya sabitle (sıfır tekrar giriş)
 $$('select').forEach(s => { if (s.id === 'ws-lead') return;
  if ([...s.options].some(o => +o.value === pid)) { if (+s.value !== pid) { s.value = pid; s.dispatchEvent(new Event('change')); } } });
};
window.openDrawer = async id => { WS_PID = id; setGlobalPatient(id);
 const d = await api(`/api/patients/${id}/dossier`);
 const p = d.patient;
 const flights = d.bookings.filter(b => b.kind === 'flight');
 const hotels = d.bookings.filter(b => b.kind === 'hotel');
 const transfers = d.bookings.filter(b => b.kind === 'transfer');
 const conv = d.conversations[0];
 const latestOffer = d.offers[0];
 const stage = p.lead_status === 'completed' || p.postop_since ? 5
 : p.lead_status === 'in_operation' ? 4
 : p.lead_status === 'agreed' || d.bookings.length ? 3
 : d.rfqs.length || d.offers.length ? 2 : 1;
 const cari = await api(`/api/patients/${id}/cari`);
 $('#ws-avatar').textContent = p.name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
 $('#ws-name').textContent = p.name;
 $('#ws-meta').innerHTML = `${CFLAG[p.nationality] || ''} ${esc(p.nationality)} · Pasaport ${esc(p.passport_no || '—')} · ${esc(p.complaint_tr || p.complaint || '')}${p.ops_agent_name ? ' · Operasyon: <b>' + esc(p.ops_agent_name) + '</b>' : p.sales_agent_name ? ' · Danışman: ' + esc(p.sales_agent_name) : ''} · Cari: <b style="color:${cari.balance >= 0 ? 'var(--ok)' : '#d9392b'}">${fmt(cari.balance)}</b>`;
 $('#ws-lead').innerHTML = LEADS.map(([s, n]) => `<option value="${s}" ${p.lead_status === s ? 'selected' : ''}>${n}</option>`).join('');
 $('#ws-lead').onchange = e => setLead(p.id, e.target.value);
 // 7 adımlı durum çubuğu + renk kodlu durum kartları
 $('#ws-steps').innerHTML = `
 <div class="steps5">${['Lead', 'KVKK & Anamnez', 'Medikal / RFQ', 'Sözleşme', 'Lojistik', 'Hastane & Fatura', 'Teşvik & Post-Op'].map((t, i) => `
 <div class="st ${i + 1 < stage ? 'done' : i + 1 === stage ? 'active' : ''}">
 <span class="dot">${i + 1 < stage ? '✓' : i + 1}</span><div class="lbl">${t}</div></div>`).join('')}</div>
 <div class="scard-row">
 <div class="scard ${d.files.some(f => f.filename.startsWith('KVKK_Onay')) ? 'ok' : 'warn'}"><div class="sc-l">KVKK & Anamnez</div><div class="sc-v">${d.files.some(f => f.filename.startsWith('KVKK_Onay')) ? 'Onaylı ✓' : 'Bekliyor'}</div><div class="mut">${(d.anamnesis || []).filter(a => a.status === 'submitted').length} anamnez</div></div>
 <div class="scard ${d.rfqs.some(r => r.status === 'responded') ? 'ok' : d.rfqs.length ? 'warn' : ''}"><div class="sc-l">Medikal / RFQ</div><div class="sc-v">${d.rfqs.filter(r => r.status === 'responded').length}/${d.rfqs.length} yanıt</div><div class="mut">${esc(d.rfqs[0]?.specialty || '')}</div></div>
 <div class="scard ${latestOffer && latestOffer.status === 'paid' ? 'ok' : latestOffer ? 'warn' : ''}"><div class="sc-l">Sözleşme & Ödeme</div><div class="sc-v">${latestOffer ? fmt(latestOffer.total) + ' · ' + latestOffer.status : 'Teklif yok'}</div><div class="mut">${latestOffer && latestOffer.e_signature ? esc(latestOffer.e_signature) : ''}</div></div>
 <div class="scard ${flights.length ? 'ok' : ''}"><div class="sc-l">Lojistik</div><div class="sc-v">${flights.length ? '✈ ' + esc(flights[0].ref_label || 'Kayıtlı') : 'Rezervasyon yok'}</div><div class="mut">${hotels.length ? ' ' + esc(hotels[0].ref_label || '') : ''}${d.driver_tasks.length ? ' · ' + d.driver_tasks.filter(t => t.status === 'done').length + '/' + d.driver_tasks.length + ' transfer' : ''}</div></div>
 <div class="scard ${d.checklist.complete ? 'ok' : 'warn'}"><div class="sc-l">Finans & Teşvik</div><div class="sc-v">Cari: ${fmt(cari.balance)}</div><div class="mut">${d.checklist.docs.filter(x => !x.present).length ? d.checklist.docs.filter(x => !x.present).length + ' eksik evrak' : 'Evraklar tam ✓'}</div></div>
 </div>
 <div class="ws-actions" style="margin:10px 0 0">
 <button class="btn primary mini" onclick="startCall(${p.id},'call')"> Çağrı</button>
 <button class="btn ghost mini" onclick="startCall(${p.id},'video')"> Görüntülü</button>
 <button class="btn ghost mini" onclick="startCall(${p.id},'callback')">⏰ Geri Arama</button>
 <button class="btn ghost mini" onclick="aiTranslate(${p.id})"> AI Çeviri</button>
 <button class="btn ghost mini" onclick="nightAgent(${p.id})"> Gece AI</button>
 <button class="btn ghost mini" onclick="sendPush(${p.id})"> Push</button>
 <button class="btn ghost mini" onclick="leadScore(${p.id})">AI Skor</button>
 <button class="btn ghost mini" onclick="aiAnalysis(${p.id})">AI Ön Analiz</button>
 ${latestOffer && latestOffer.status === 'sent' ? `<button class="btn ghost mini" onclick="offerAction(${latestOffer.id},'approve');setTimeout(()=>openDrawer(${p.id}),400)"> Mobil onay</button>` : ''}
 ${latestOffer && latestOffer.status === 'approved' ? `<button class="btn primary mini" onclick="offerAction(${latestOffer.id},'pay');setTimeout(()=>openDrawer(${p.id}),400)"> Ödeme al</button>` : ''}
 </div>`;
 $('#workspace').classList.add('open');
 // ilk sekmeyi yükle
 $$('.wstab').forEach(x => x.classList.toggle('on', x.dataset.ws === 'timeline'));
 ['timeline','medical','travel','finance'].forEach(t => $('#ws-' + t).classList.toggle('hidden', t !== 'timeline'));
 loadWsPane('timeline', p.id, d);
};
window.setLead = async (id, s) => { await api('/api/patients/' + id, 'PATCH', { lead_status: s }); loadPatients(); loadKpis(); applyRole(); };
window.uploadFile = async (pid, form) => {
 const fd = new FormData(form);
 await fetch(`/api/patients/${pid}/files`, { method: 'POST', body: fd });
 toast('Dosya arşivlendi'); openDrawer(pid); return false;
};

// ---------- Medical / RFQ ----------
// Hasta seçildiğinde hekim havuzu filtresi hastanın branşına kilitlenir
$('#ai-patient').onchange = async () => {
 const pid = $('#ai-patient').value; if (!pid) return;
 const r = await api('/api/ai/match?patient_id=' + pid);
 if (r.specialties && r.specialties.length) {
 $('#f-specialty').value = r.specialties[0];
 toast('Branş filtresi kilitlendi: ' + r.specialties.join(', '));
 $('#f-search').click();
 } else toast('Branş tespit edilemedi — anamnez veya şikayet bekleniyor');
};
$('#ai-match-btn').onclick = async () => {
 const pid = $('#ai-patient').value; if (!pid) return;
 const r = await api('/api/ai/match?patient_id=' + pid);
 if (!r.doctors || !r.doctors.length) {
 $('#ai-result').innerHTML = '<div class="mut" style="margin:10px 0">Branş tespit edilemedi — hastanın anamnez/şikayet verisi eksik.</div>'; return;
 }
 $('#ai-result').innerHTML = `
 <div style="margin:10px 0">Tespit edilen uzmanlık: <b>${r.specialties.join(', ')}</b> — sadece bu branş hekimleri listelendi</div>
 ${r.doctors.map((d, i) => `<div class="li">
 <span><b>${i + 1}. ${esc(d.name)}</b><div class="mut">${esc(d.specialty)} · ${esc(d.hospital)} · ★${d.rating}</div></span>
 <label class="mut"><input type="checkbox" class="doc-check" value="${d.id}" ${i < 2 ? 'checked' : ''}> RFQ</label></div>`).join('')}
 <button class="btn primary" style="margin-top:10px" onclick="sendRfq(${pid})">Seçili doktorlardan görüş/fiyat iste</button>`;
};
window.sendRfq = async pid => {
 const ids = $$('.doc-check').filter(c => c.checked).map(c => +c.value);
 if (!ids.length) return toast('Doktor seçilmedi');
 await api('/api/rfq', 'POST', { patient_id: +pid, doctor_ids: ids });
 toast('RFQ gönderildi — doktor yanıtları bekleniyor'); logActivity(`RFQ gönderildi (hasta #${pid})`);
};
async function loadRfqs() {
 const rfqs = await api('/api/rfq');
 $('#rfq-list').innerHTML = rfqs.map(r => `
 <div class="li li-col">
 <div style="display:flex;justify-content:space-between;align-items:center">
 <span><b>${esc(r.doctor_name)}</b> · ${esc(r.specialty)}<div class="mut"><span class="plink" data-pid="${r.patient_id}">${esc(r.patient_name)}</span> → ${esc(r.hospital)}</div></span>
 <span class="tag ${r.status === 'responded' ? 'green' : r.status === 'declined' ? 'red' : 'yellow'}">
 ${r.status === 'pending' ? ' bekliyor' : r.status === 'responded' ? '✓ yanıtlandı' : '✕ reddetti'}</span></div>
 ${r.view_password ? `<div class="mut" style="font-size:11px;margin-top:4px"> Görüntüleme şifresi: <b>${r.view_password}</b>
 · ${r.doctor_verified ? '<span class="tag green">KVK doğrulandı</span>' : '<span class="tag yellow">doğrulama bekliyor</span>'} · 150 kredi ödendi</div>` : ''}
 ${r.status === 'responded' ? `
 <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
 <button class="btn ghost mini" onclick="viewOpinion(${r.id})">E-imzalı görüşü aç</button>
 <button class="btn ghost mini" onclick="shareOpinion(${r.id})">Hastaya ilet</button>
 <span class="tag blue"> Acente fiyatı: ${fmt(r.quote_price)}</span>

 </div>
 <div id="op-${r.id}"></div>` : ''}
 </div>`).join('') || '<div class="mut">Henüz RFQ yok</div>';
}
window.viewOpinion = async id => {
 const o = await api(`/api/rfq/${id}/opinion`);
 $('#op-' + id).innerHTML = `<div class="opinion-box">${esc(o.opinion_text)}
 <div class="sig"> ${o.signature} · ${esc(o.signed_at)} · Şifreli saklanıyor (AES-256-GCM)</div>
 <div class="sig"> ${esc(o.ministry_notice || '')}</div></div>`;
};
window.shareOpinion = async id => { await api(`/api/rfq/${id}/share-opinion`, 'POST'); toast('Tıbbi görüş hastaya iletildi (fiyat gizli)'); };
socket.on('rfq_update', () => { loadRfqs(); loadKpis(); logActivity('Doktor RFQ yanıtı geldi'); });

// ---------- Logistics ----------
function patientSel() { return `<select class="input pat-sel">${patients.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>`; }
async function loadLogistics() {
 const hotels = await api('/api/hotels');
 $('#hotel-list').innerHTML = hotels.map(h => `
 <div class="li"><span>${'★'.repeat(h.stars)} ${esc(h.name)}<div class="mut">${esc(h.district)}</div></span>
 <span><b>${fmt(h.price_per_night)}</b><span class="mut">/gece</span>
 <button class="btn ghost mini bkbtn" data-k="hotel" disabled onclick="book('hotel','${esc(h.name)}',${h.price_per_night})">Rez.</button></span></div>`).join('');
 const flights = await api('/api/flights');
 $('#flight-list').innerHTML = flights.map(f => `
 <div class="li"><span><b>${f.flight_no}</b> ${f.origin}→${f.destination}<div class="mut">${f.dep_time}–${f.arr_time}</div></span>
 <span><b>${fmt(f.price)}</b> <button class="btn ghost mini bkbtn" data-k="flight" disabled onclick="book('flight','${f.flight_no} ${f.origin}-${f.destination}',${f.price})">Rez.</button></span></div>`).join('');
 loadBookings();
}
const BOOK_SEL = { hotel: '#hotel-patient', flight: '#bk-patient', transfer: '#tr-patient' };
window.book = async (kind, label, price) => {
 const pid = +($(BOOK_SEL[kind] || '#bk-patient')?.value || 0);
 if (!pid) return toast('Önce hasta seçin — işlem hasta dosyasına işlenir');
 const details = kind === 'flight' ? { flight_date: $('#flight-date')?.value || undefined } : undefined;
 await api('/api/bookings', 'POST', { patient_id: pid, kind, ref_label: label, price, details });
 toast(`Rezervasyon: ${label}`); logActivity(`${kind} rezervasyonu — ${label}`);
 loadBookings();
};
async function loadBookings() {
 const bs = await api('/api/bookings');
 $('#booking-list').innerHTML = bs.map(b => `
 <div class="li"><span>${{ hotel: '', flight: '✈', transfer: '' }[b.kind] || ''} <span class="plink" data-pid="${b.patient_id}">${esc(b.patient_name)}</span> — ${esc(b.ref_label || b.kind)}
 <div class="mut">${fmt(b.price)}</div>
 ${b.kind === 'flight' ? `<div class="flight-prog"><div id="fp-${b.id}" style="width:0%"></div></div><div class="mut" id="fs-${b.id}"></div>` : ''}
 ${b.kind === 'transfer' ? `<button class="btn ghost mini" onclick="trackTransfer(${b.id})">Haritada izle</button>` : ''}</span>
 <span class="tag ${b.status === 'completed' ? 'green' : 'blue'}">${b.status}</span></div>`).join('') || '<div class="mut">Rezervasyon yok</div>';
}
$('#transfer-quote-btn').onclick = async () => {
 const q = await api('/api/transfer-quote');
 $('#transfer-quotes').innerHTML = q.quotes.map(x => `
 <div class="li"><span>${esc(x.type)}<div class="mut">ETA ${x.eta_min} dk</div></span>
 <span><b>${fmt(x.price)}</b> <button class="btn ghost mini bkbtn" data-k="transfer" disabled onclick="book('transfer','${esc(x.type)}',${x.price})">Rez.</button></span></div>`).join('');
};
window.trackTransfer = id => startMapAnim(id);
window.issueInsurance = async offerId => {
 const pid = +($('#ins-patient')?.value || 0);
 if (!pid) return toast('Önce hasta seçin');
 const r = await api('/api/insurance/issue', 'POST', { patient_id: pid, offer_id: offerId });
 if (r.error) return toast(r.error);
 toast(' Poliçe kesildi → hasta dosyasına işlendi');
 logActivity(`Sigorta poliçesi — ${r.file}`);
 loadBookings();
};
// Hasta detayından tek tık aksiyon: ilgili ekrana git + hastayı ön-seç
window.qa = (t, sel, pid) => {
 closeWs(); goTab(t);
 setTimeout(() => { const e = $(sel); if (e) { e.value = String(pid); e.dispatchEvent(new Event('change')); } }, 150);
};
// map
let car;
function buildMap() {
 const m = $('#map');
 m.innerHTML = `
 <rect width="100" height="100" fill="#0a0f1c"/>
 <path d="M70 0 Q60 25 72 50 Q84 75 68 100 L100 100 L100 0 Z" fill="#12395e" opacity=".8"/>
 <text x="80" y="55" fill="#3f6f9e" font-size="4" transform="rotate(75 82 52)">BOSPHORUS</text>
 ${[15, 30, 45, 60].map(y => `<line x1="0" y1="${y}" x2="70" y2="${y + 4}" stroke="#1b2a4a" stroke-width=".6"/>`).join('')}
 ${[15, 30, 45, 60].map(x => `<line x1="${x}" y1="0" x2="${x - 5}" y2="100" stroke="#1b2a4a" stroke-width=".6"/>`).join('')}
 <path id="route" d="" fill="none" stroke="#4f7cff" stroke-width=".8" stroke-dasharray="2 1.5" opacity=".7"/>
 <circle cx="8" cy="62" r="2.5" fill="#f5b942"/><text x="11" y="63" font-size="4" fill="#f5b942">IST ✈</text>
 <circle cx="88" cy="30" r="2.5" fill="#ef5a6f"/><text x="74" y="26" font-size="4" fill="#ef5a6f">HASTANE +</text>
 <path id="froute" d="" fill="none" stroke="#f5a524" stroke-width=".6" stroke-dasharray="2 2" opacity=".8"/>
 <g id="plane" display="none"><circle r="3" fill="#f5a524" opacity=".35"/><text font-size="6" y="2.2" text-anchor="middle">✈</text></g>
 <g id="car"><circle r="2.6" fill="#22c9a5"/><circle r="1.1" fill="#fff"/></g>`;
 car = $('#car');
}
function planeXY(lat, lng) { // dünya → 100x100 harita projeksiyonu (lng -15..65, lat 15..60)
 return [Math.max(2, Math.min(98, (lng + 15) / 80 * 100)), Math.max(2, Math.min(98, (60 - lat) / 45 * 100))];
}
function startMapAnim(bookingId) { window._mapBooking = bookingId; $('#gps-status').textContent = 'Transfer ' + bookingId + ' izleniyor…'; }
socket.on('gps', d => {
 if (d.booking_id !== window._mapBooking) return;
 if (!car) buildMap();
 if (d.pos) {
 car.setAttribute('transform', `translate(${d.pos.x},${d.pos.y})`);
 const r = $('#route'); const cur = r.getAttribute('d');
 r.setAttribute('d', cur ? cur + ` L${d.pos.x},${d.pos.y}` : `M${d.pos.x},${d.pos.y}`);
 $('#gps-status').textContent = `Araç yolda — %${Math.round(d.progress * 100)}`;
 }
 if (d.done) { $('#gps-status').textContent = 'Transfer tamamlandı ✓'; loadBookings(); }
});
socket.on('flight_status', d => {
 const bar = $('#fp-' + d.booking_id), lbl = $('#fs-' + d.booking_id);
 if (bar) bar.style.width = (d.progress * 100) + '%';
 if (lbl) lbl.textContent = '✈ ' + d.status;
 const dfs = $('#dfs-' + d.booking_id); // hasta dosyası canlı uçuş durumu
 if (dfs) dfs.textContent = '✈ ' + d.status + (d.delay_min ? ` (+${d.delay_min}dk)` : '');
 // haritada canlı uçak konumu + uçuş bilgi kartı
 if (d.lat != null && d.lng != null) {
 if (!$('#plane')) buildMap();
 const [x, y] = planeXY(d.lat, d.lng);
 const pl = $('#plane');
 pl.setAttribute('display', 'block');
 pl.setAttribute('transform', `translate(${x},${y})`);
 const fr = $('#froute'); const cur = fr.getAttribute('d');
 fr.setAttribute('d', cur ? cur + ` L${x},${y}` : `M${x},${y}`);
 const fi = $('#flight-info');
 if (fi) fi.innerHTML = `✈ <b>${esc(d.status)}</b>${d.gate ? ' · Kapı ' + esc(d.gate) : ''}` +
 (d.eta ? ` · ETA ${new Date(d.eta).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}` : '') +
 (d.delay_min ? ` · <span style="color:var(--red,#ef5a6f)">Rötar ${d.delay_min} dk</span>` : '') +
 ` <span class="mut">(${d.source === 'aerodatabox' ? 'AeroDataBox canlı' : 'simülasyon'} · ${d.lat.toFixed(2)},${d.lng.toFixed(2)})</span>`;
 }
 if (d.delay_min) toast(`Uçuş rötarlı: +${d.delay_min} dk`, 'warn');
 logActivity(`Uçuş #${d.booking_id}: ${d.status}`);
});
socket.on('flight_delay', d => toast(d.message || 'Uçuş rötarlı', 'warn'));
socket.on('booking', () => { loadBookings(); loadKpis(); });

// ---------- Accounting ----------
async function loadAccounting() {
 const [accs, txns, margins, invs, cashbanks, checks, kdv] = await Promise.all([
 api('/api/accounts'), api('/api/transactions'), api('/api/margins'), api('/api/invoices'),
 api('/api/cashbanks'), api('/api/checks'), api('/api/kdv-report')]);
 // Logo tarzı cari kart: VKN, vergi dairesi, IBAN, risk limiti + ekstre
 $('#account-list').innerHTML = accs.map(a => `
 <div class="li"><span>${esc(a.name)}
 <div class="mut">${a.type}${a.vkn ? ' · VKN ' + esc(a.vkn) : ''}${a.vergi_dairesi ? ' / ' + esc(a.vergi_dairesi) : ''}</div>
 ${a.iban ? `<div class="mut" style="font-size:11px">IBAN: ${esc(a.iban)}</div>` : ''}
 ${a.risk_limit ? `<div class="mut" style="font-size:11px">Risk limiti: ${fmt(a.risk_limit)}</div>` : ''}</span>
 <span style="text-align:right"><b style="color:${a.balance >= 0 ? 'var(--ok)' : 'var(--bad)'}">${fmt(a.balance)}</b><br>
 <button class="btn ghost mini" onclick="showStatement(${a.id})">Ekstre</button></span></div>`).join('');
 $('#statement-box').innerHTML = '';
 $('#cashbank-list').innerHTML = cashbanks.map(c => `
 <div class="li"><span>${c.type === 'banka' ? '' : ''} ${esc(c.name)}
 <div class="mut">${c.type}${c.branch ? ' · ' + esc(c.branch) : ''}${c.iban ? ' · ' + esc(c.iban) : ''}</div></span>
 <b style="color:${(c.balance || 0) >= 0 ? 'var(--ok)' : 'var(--bad)'}">${c.currency} ${fmt(c.balance || 0)}</b></div>`).join('') || '<div class="mut">—</div>';
 if (!$('#inv-cashbank').options.length)
 $('#inv-cashbank').innerHTML = '<option value="">Kasa/Banka seç</option>' +
 cashbanks.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
 $('#check-list').innerHTML = checks.map(c => `
 <div class="li"><span>${c.type === 'senet' ? '' : ''} ${esc(c.doc_no || '')} — ${esc(c.drawer || '')}
 <div class="mut">${c.direction === 'received' ? 'Alınan' : 'Verilen'} · vade ${esc(c.due_date || '—')}${c.bank_name ? ' · ' + esc(c.bank_name) : ''}</div></span>
 <span style="text-align:right"><b>${fmt(c.amount)}</b><br><span class="tag ${c.status === 'portfoy' ? 'yellow' : 'green'}">${c.status}</span></span></div>`).join('') || '<div class="mut">—</div>';
 $('#kdv-report').innerHTML = `
 <div class="li"><span>Satış KDV</span><b>${fmt(kdv.sales_kdv)}</b></div>
 <div class="li"><span>Alış (indirilecek) KDV</span><b>${fmt(kdv.purchase_kdv)}</b></div>
 <div class="li"><span><b>Ödenecek KDV</b></span><b style="color:${kdv.payable >= 0 ? 'var(--bad)' : 'var(--ok)'}">${fmt(kdv.payable)}</b></div>`;
 $('#margin-list').innerHTML = margins.filter(m => m.revenue || m.cost).map(m => `
 <div class="li"><span>${esc(m.name)}<div class="mut">Gelir ${fmt(m.revenue)} · Maliyet ${fmt(m.cost)}</div></span>
 <b style="color:${m.margin >= 0 ? 'var(--ok)' : 'var(--bad)'}">${fmt(m.margin)}</b></div>`).join('') || '<div class="mut">Henüz hareket yok</div>';
 $('#txn-list').innerHTML = txns.slice(0, 30).map(t => `
 <div class="li"><span>${t.kind === 'income' ? '➕' : '➖'} ${esc(t.description || t.category)}<div class="mut"><span class="plink" data-pid="${t.patient_id}">${esc(t.patient_name || '')}</span> · ${esc(t.account_name || '')}${t.vkn ? ' · VKN ' + esc(t.vkn) : ''}</div></span>
 <b style="color:${t.kind === 'income' ? 'var(--ok)' : 'var(--bad)'}">${t.kind === 'income' ? '+' : '−'}${fmt(t.amount)}</b></div>`).join('') || '<div class="mut">—</div>';
 $('#invoice-list').innerHTML = invs.map(i => `
 <div class="li"><span><b>${i.number}</b> — <span class="plink" data-pid="${i.patient_id}">${esc(i.patient_name || '')}</span>
 <div class="mut">${i.direction === 'purchase' ? 'GELEN' : 'SATIŞ'} · ${i.scenario || ''} · ${fmt(i.amount)}${i.kdv_amount ? ' (KDV ' + fmt(i.kdv_amount) + ')' : ''} · ${i.issued_at || ''}</div></span>
 <span>${i.status === 'sent_ivd' ? `<span class="tag green">İVD ✓ ${i.ivd_ref}</span>` : `<button class="btn ghost mini" onclick="sendIvd(${i.id})">İVD'ye gönder</button>`}</span></div>`).join('') || '<div class="mut">—</div>';
}
window.showStatement = async id => {
 const s = await api(`/api/accounts/${id}/statement`);
 $('#statement-box').innerHTML = `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">
 <b>${esc(s.account.name)} — Ekstre/Mutabakat</b>
 ${s.account.vkn ? `<div class="mut" style="font-size:11px">VKN ${esc(s.account.vkn)} · ${esc(s.account.vergi_dairesi || '')} · ${esc(s.account.address || '')}</div>` : ''}
 ${s.transactions.slice(-10).map(t => `<div class="li"><span class="mut">${esc(t.description || t.category)}</span>
 <b>${t.kind === 'income' ? '+' : '−'}${fmt(t.amount)}</b></div>`).join('') || '<div class="mut">Hareket yok</div>'}
 <div class="li"><span><b>Bakiye</b></span><b style="color:${s.balance >= 0 ? 'var(--ok)' : 'var(--bad)'}">${fmt(s.balance)}</b></div></div>`;
};
$('#inv-create').onclick = async () => {
 const pid = +$('#inv-patient').value;
 if (!pid) return toast('Lütfen hasta seçiniz');
 await api('/api/invoices', 'POST', {
 patient_id: pid, items: [{ desc: $('#inv-desc').value + ($('#inv-dab') && $('#inv-dab').value ? ' · DAB:' + $('#inv-dab').value : ''), qty: 1, unit: +$('#inv-amount').value }],
 vkn: $('#inv-vkn').value, vergi_dairesi: $('#inv-vd').value,
 scenario: $('#inv-scenario').value, invoice_type: $('#inv-type').value,
 kdv_rate: +$('#inv-kdv').value, iskonto: +$('#inv-isk').value,
 payment_terms: $('#inv-pay').value, cashbank_id: +$('#inv-cashbank').value || null,
 });
 toast('Fatura kesildi'); loadAccounting(); loadKpis();
};
$('#pin-create').onclick = async () => {
 const r = await api('/api/invoices/inbound', 'POST', {
 vendor: $('#pin-vendor').value, desc: $('#pin-desc').value,
 amount: +$('#pin-amount').value, vkn: $('#pin-vkn').value,
 });
 toast('Gelen fatura içe alındı: ' + (r.number || '')); loadAccounting(); loadKpis();
};
window.sendIvd = async id => { await api(`/api/invoices/${id}/send-ivd`, 'POST'); toast('İVD aktarımı başlatıldı…'); };
socket.on('ivd', () => { toast('İVD aktarımı tamamlandı ✓'); loadAccounting(); });
socket.on('kpi', loadKpis);

// ---------- Compliance ----------
$('#usha-send').onclick = async () => {
 const pid = +$('#usha-patient').value;
 const r = await api('/api/usha/send', 'POST', { patient_id: pid });
 if (r.error) return toast(' ' + r.error + ': ' + (r.missing || []).join(', '));
 toast('USHAŞ bildirimi gönderiliyor…');
};
socket.on('usha', () => { toast('USHAŞ bildirimi onaylandı ✓'); loadCompliance(); });
async function loadCompliance() {
 const [us, inc] = await Promise.all([api('/api/usha'), api('/api/incentive')]);
 $('#usha-list').innerHTML = '<h2 style="margin-top:14px">Bildirim Geçmişi</h2>' + us.map(u => `
 <div class="li"><span><span class="plink" data-pid="${u.patient_id}">${esc(u.patient_name)}</span><div class="mut">${esc(u.service_detail || '').slice(0, 60)}</div></span>
 <span class="tag ${u.status === 'acknowledged' ? 'green' : 'yellow'}">${u.status === 'acknowledged' ? '✓ ' + u.usha_ref : 'gönderiliyor'}</span></div>`).join('');
 $('#inc-list').innerHTML = '<h2 style="margin-top:14px">Teşvik Paketleri</h2>' + inc.map(i => `
 <div class="li"><span><span class="plink" data-pid="${i.patient_id}">${esc(i.patient_name)}</span></span><span class="tag green">${i.status} · ${i.created_at}</span></div>`).join('');
}
$('#inc-check').onclick = async () => {
 const pid = +$('#inc-patient').value;
 const r = await api('/api/incentive/checklist/' + pid);
 $('#inc-checklist').innerHTML = r.docs.map(d => `
 <div class="li"><span>${d.present ? '' : ''} ${d.doc}<div class="mut">${esc(d.source || 'eksik')}</div></span></div>`).join('');
 $('#inc-package').disabled = !r.ready;
 $('#inc-package').textContent = r.ready ? 'Tek tıkla paketle & gönder' : 'Eksik evrak var';
};
$('#inc-package').onclick = async () => {
 const pid = +$('#inc-patient').value;
 const r = await api('/api/incentive/package/' + pid, 'POST');
 if (r.error) return toast(' ' + r.error + ': ' + (r.missing || []).join(', '));
 toast('Teşvik paketi Ticaret Bakanlığı\'na iletildi ✓'); loadCompliance();
};

// ---------- v2: notifications / agents ----------
async function loadNotifs() {
 const n = await api('/api/notifications');
 const unread = n.filter(x => !x.read).length;
 $('#notif-badge').textContent = unread; $('#notif-badge').classList.toggle('hidden', !unread);
 $('#notif-panel').innerHTML = n.slice(0, 15).map(x => `
 <div class="li"><span>${x.kind === 'sla_breach' ? '' : ''} ${esc(x.message)}
 <div class="mut">${esc(x.recipient || '')} · ${x.created_at}</div></span>
 ${x.read ? '' : '<span class="tag red">yeni</span>'}</div>`).join('') || '<div class="mut">Bildirim yok</div>';
}
$('#notif-btn').onclick = async () => {
 $('#notif-panel').classList.toggle('hidden');
 if (!$('#notif-panel').classList.contains('hidden')) { await loadNotifs(); await api('/api/notifications/read-all', 'POST'); }
};
socket.on('notify', d => {
 const exec = d.kind === 'sla_exec';
 toast(exec ? ' ÜST YÖNETİCİ ESKALASYONU: ' + d.patient : ' SLA aşımı: ' + d.patient);
 logActivity((exec ? 'Üst yönetici SLA eskalasyonu' : 'SLA aşımı bildirimi') + ' — ' + d.patient);
 loadNotifs(); loadKpis();
});

// ---------- v2: doctor filters + wallet + doctor portal ----------
let specialtiesLoaded = false;
async function loadDoctorFilters() {
 const docs = await api('/api/doctors');
 if (!specialtiesLoaded) {
 const specs = [...new Set(docs.map(d => d.specialty))];
 $('#f-specialty').innerHTML = '<option value="">Branş (tümü)</option>' + specs.map(s => `<option>${s}</option>`).join('');
 specialtiesLoaded = true;
 }
}
$('#f-search').onclick = async () => {
 const q = new URLSearchParams({ specialty: $('#f-specialty').value, title: $('#f-title').value,
 city: $('#f-city').value, hospital: $('#f-hospital').value, org_type: $('#f-org').value });
 const docs = await api('/api/doctors?' + q);
 $('#f-result').innerHTML = docs.map(d => `
 <div class="li"><span><b>${esc(d.name)}</b><div class="mut">${esc(d.specialty)} · ${esc(d.hospital)} · ${esc(d.city)} · ★${d.rating}</div></span>
 <label class="mut"><input type="checkbox" class="fdoc-check" value="${d.id}"> RFQ</label></div>`).join('') +
 `<button class="btn primary" style="margin-top:8px" onclick="sendRfqFiltered()">Seçililere çoklu RFQ gönder</button>`;
};
window.sendRfqFiltered = async () => {
 const ids = $$('.fdoc-check').filter(c => c.checked).map(c => +c.value);
 const pid = +$('#ai-patient').value;
 if (!ids.length || !pid) return toast('Hasta ve doktor seçin');
 const r = await api('/api/rfq', 'POST', { patient_id: pid, doctor_ids: ids });
 if (r.error) return toast(' ' + r.error);
 toast(ids.length + ' doktora RFQ gönderildi'); loadRfqs(); loadWallet();
};
async function loadWallet() {
 const w = await api('/api/wallet');
 $('#wallet-credits').textContent = w.credits.toLocaleString('tr-TR') + ' kredi';
 $('#wallet-txns').innerHTML = w.txns.map(t => `
 <div class="li"><span class="mut">${esc(t.description)}</span>
 <b style="color:${t.amount < 0 ? 'var(--bad)' : 'var(--ok)'}">${t.amount > 0 ? '+' : ''}${t.amount}</b></div>`).join('');
}
$('#wallet-topup').onclick = async () => { await api('/api/wallet/topup', 'POST', { amount: 10000 }); loadWallet(); };
socket.on('wallet', loadWallet);
$('#dp-verify').onclick = async () => {
 const rfq = $('#dp-rfq').value, pass = $('#dp-pass').value, idno = $('#dp-idno').value;
 const v = await api(`/api/rfq/${rfq}/verify-identity`, 'POST', { password: pass, id_number: idno });
 if (v.error) { $('#dp-result').innerHTML = `<div style="color:var(--bad);font-size:12px"> ${esc(v.error)}</div>`; return; }
 const d = await api(`/api/rfq/${rfq}/secure-view?password=${encodeURIComponent(pass)}`);
 $('#dp-result').innerHTML = d.error ? `<div style="color:var(--bad)">${esc(d.error)}</div>` : `
 <div class="opinion-box">Hasta: <b>${esc(d.patient_initials)}</b> (${esc(d.nationality)}) — kişisel veriler maskelendi<br>
 Şikâyet: ${esc(d.complaint)}<br>${esc(d.complaint_tr || '')}
 <div class="sig">✓ KVK/GDPR kimlik doğrulaması tamamlandı</div></div>
 <div style="margin-top:8px"><input id="dp-opinion" class="input" placeholder="Tıbbi görüşünüz">
 <input id="dp-price" class="input" type="number" placeholder="Ücret teklifiniz (EUR)">
 <button class="btn primary" onclick="dpRespond(${rfq},'${pass}')">Görüş + Fiyat Gönder</button></div>`;
};
window.dpRespond = async (rfq, pass) => {
 const r = await api(`/api/rfq/${rfq}/respond`, 'POST', { opinion: $('#dp-opinion').value, price: +$('#dp-price').value });
 toast(r.error || 'Görüş + teklif gönderildi (fiyat sadece acenteye görünür)'); loadRfqs();
};

// ---------- v2: offers ----------
async function loadOffers() {
 const pkgs = await api('/api/postop-packages');
 $('#offer-postop').innerHTML = '<option value="">— seçin (zorunlu) —</option>' +
 pkgs.map(p => `<option value="${p.id}">${esc(p.name)} (${fmt(p.price)})</option>`).join('');
 $('#offer-patient').innerHTML = patients.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
 const offers = await api('/api/offers');
 $('#offer-list').innerHTML = offers.map(o => `
 <div class="li li-col">
 <div style="display:flex;justify-content:space-between"><b class="plink" data-pid="${o.patient_id}">${esc(o.patient_name)}</b>
 <span class="tag ${{ draft: 'yellow', sent: 'blue', approved: 'green', paid: 'green' }[o.status]}">${o.status}</span></div>
 <div class="mut">${(JSON.parse(o.items || '[]')).map(i => esc(i.desc) + ' ' + fmt(i.price)).join(' · ')}</div>
 <div class="mut">Post-op: ${esc(o.postop_name || '—')} · Toplam <b>${fmt(o.total)}</b></div>
 <div style="display:flex;gap:6px;margin-top:6px">
 ${o.status === 'draft' ? `<button class="btn ghost mini" onclick="offerAction(${o.id},'send')">Gönder</button>` : ''}
 ${o.status === 'sent' ? `<button class="btn ghost mini" onclick="offerAction(${o.id},'approve')"> Hasta mobil onay (e-imza)</button>` : ''}
 ${o.status === 'approved' ? `<button class="btn primary mini" onclick="offerAction(${o.id},'pay')"> Ödeme al</button>` : ''}
 ${o.e_signature ? `<span class="tag green">${o.e_signature}</span>` : ''}
 </div></div>`).join('') || '<div class="mut">Teklif yok</div>';
}
const parseItem = (v, kind) => { const [desc, price] = v.split(','); return desc ? { kind, desc: desc.trim(), price: +price || 0 } : null; };
$('#offer-create').onclick = async () => {
 const items = [parseItem($('#offer-treatment').value, 'medical'), parseItem($('#offer-hotel').value, 'hotel'),
 parseItem($('#offer-transport').value, 'transport')].filter(Boolean);
 const r = await api('/api/offers', 'POST', { patient_id: +$('#offer-patient').value, items, postop_package_id: +$('#offer-postop').value });
 if (r.error) return toast(' ' + r.error);
 await api(`/api/offers/${r.id}/send`, 'POST');
 toast('Teklif mektubu hastaya gönderildi'); loadOffers();
};
window.offerAction = async (id, act) => {
 const r = await api(`/api/offers/${id}/${act}`, 'POST');
 if (r.error) return toast(' ' + r.error);
 toast(act === 'approve' ? 'Hasta e-imzaladı ✓' : act === 'pay' ? 'Ödeme alındı ✓' : 'Gönderildi');
 loadOffers(); loadAccounting(); loadPatients(); loadKpis(); applyRole();
};
socket.on('offer', loadOffers);

// ---------- v2: assignments + driver app + visa/insurance ----------
async function loadLogisticsV2() {
 const agents = await api('/api/agents');
 const drv = agents.filter(a => ['driver', 'translator'].includes(a.role));
 $('#as-agent').innerHTML = drv.map(a => `<option value="${a.id}">${esc(a.name)} (${a.role})</option>`).join('');
 $('#drv-agent').innerHTML = drv.map(a => `<option value="${a.id}">${esc(a.name)} (${a.role})</option>`).join('');
 $('#as-patient').innerHTML = patients.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
 $('#as-date').value = new Date().toISOString().slice(0, 10);
 loadAssignments(); loadDriverTasks(); loadVisaIns();
}
async function loadAssignments() {
 const as = await api('/api/assignments');
 $('#as-list').innerHTML = as.map(a => `
 <div class="li"><span>${esc(a.agent_name)}<div class="mut">${a.date} ${a.slot} · ${esc(a.task || '')} · <span class="plink" data-pid="${a.patient_id}">${esc(a.patient_name || '')}</span></div></span></div>`).join('') || '<div class="mut">Atama yok</div>';
}
$('#as-create').onclick = async () => {
 const r = await api('/api/assignments', 'POST', { agent_id: +$('#as-agent').value, patient_id: +$('#as-patient').value,
 date: $('#as-date').value, slot: $('#as-slot').value, task: $('#as-task').value });
 $('#as-conflict').textContent = r.error || '';
 if (!r.error) { toast('Atama yapıldı'); loadAssignments(); }
};
async function loadDriverTasks() {
 const aid = $('#drv-agent').value; if (!aid) return;
 const ts = await api('/api/driver/tasks?agent_id=' + aid);
 $('#drv-tasks').innerHTML = ts.map(t => `
 <div class="li"><span>${t.seq}. ${esc(t.label)}<div class="mut"><span class="plink" data-pid="${t.patient_id}">${esc(t.patient_name || '')}</span> · ${esc(t.ref_label || '')}</div></span>
 <span>${t.status === 'done' ? '<span class="tag green">✓</span>'
 : t.status === 'in_progress' ? '<span class="tag yellow">yolda</span>'
 : `<button class="btn ghost mini" onclick="drvTask(${t.id},'start')">Başlat</button>`}
 ${t.status === 'in_progress' ? `<button class="btn primary mini" onclick="drvTask(${t.id},'done')">Tamamla</button>` : ''}</span></div>`).join('') || '<div class="mut">Görev yok</div>';
}
$('#drv-agent').onchange = loadDriverTasks;
window.drvTask = async (id, act) => {
 await api(`/api/driver/tasks/${id}/${act}`, 'POST');
 if (act === 'start') { const t = await api('/api/driver/tasks'); const task = t.find(x => x.id === id); if (task?.booking_id) startMapAnim(task.booking_id); }
 loadDriverTasks();
};
socket.on('driver_task', loadDriverTasks);
async function loadVisaIns() {
 const vs = await api('/api/visa');
 $('#visa-country').innerHTML = vs.map(v => `<option>${v.country}</option>`).join('');
 const showVisa = async () => {
 const v = await api('/api/visa/lookup?country=' + encodeURIComponent($('#visa-country').value));
 const icon = { muafiyet: '', '90gun': '', kimlik: '', vize_gerekli: '' }[v.rule] || '';
 $('#visa-result').innerHTML = `${icon} <b>${esc(v.country)}:</b> ${esc(v.note)}`;
 };
 $('#visa-country').onchange = showVisa; showVisa();
 const ins = await api('/api/insurance');
 $('#ins-list').innerHTML = ins.map(i => `
 <div class="li"><span>${esc(i.provider)}<div class="mut">${esc(i.coverage)}</div></span>
 <span><b>${fmt(i.price)}</b> <button class="btn ghost mini bkbtn" data-k="ins" disabled onclick="issueInsurance(${i.id})">Poliçe kes</button></span></div>`).join('');
}

// ---------- v2: FX + profit + commissions ----------
async function loadFxProfit() {
 const fx = await api('/api/fx');
 $('#fx-list').innerHTML = `<div class="fx-item"><span>TCMB canlı</span></div>` +
 fx.map(f => `<div class="fx-item"><span>${f.code}</span><b>₺${f.rate}</b><span>${(f.updated_at || '').slice(11, 16)}</span></div>`).join('');
 $('#profit-patient').innerHTML = patients.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
 const comm = await api('/api/commissions');
 $('#comm-list').innerHTML = comm.map(c => `
 <div class="li"><span>${esc(c.agent)}<div class="mut">${c.rule} · gelir ${fmt(c.income)}</div></span><b>${fmt(c.commission)}</b></div>`).join('') || '<div class="mut">—</div>';
}
$('#profit-calc').onclick = async () => {
 const r = await api('/api/profit/' + $('#profit-patient').value);
 if (r.error) return;
 const costRows = Object.entries(r.costs).filter(([, v]) => v);
 const total = Math.max(r.income, costRows.reduce((s, [, v]) => s + v, 0), 1);
 $('#profit-result').innerHTML = `<div style="margin-top:8px">
 <div class="ws-row"><span>Gelir (paket)</span><b>${fmt(r.income)}</b></div>
 ${costRows.map(([k, v]) => `<div style="font-size:12px;color:var(--mut);margin-top:6px">${esc(k)} — ${fmt(v)}</div>
 <div class="profit-bar"><div style="width:${v / total * 100}%;background:var(--bad)"></div></div>`).join('')}
 <div class="ws-row" style="background:var(--acc-soft)"><span><b>Net Kâr</b></span>
 <b style="color:${r.net_profit >= 0 ? 'var(--ok)' : 'var(--bad)'};font-size:17px">${fmt(r.net_profit)}</b></div></div>`;
};

// ---------- v2: incentive checklist + export ----------
$('#inc-check').onclick = async () => {
 const pid = +$('#inc-patient').value;
 const r = await api('/api/checklist/' + pid);
 $('#inc-checklist').innerHTML = r.docs.map(d => `
 <div class="li"><span>${d.present ? '' : ''} ${d.doc}</span></div>`).join('');
 const missing = r.docs.filter(d => !d.present);
 $('#inc-warn').textContent = missing.length ? ' Eksik evrak: ' + missing.map(d => d.doc).join(', ') + ' — teşvik havuzuna aktarılamaz' : '';
 $('#inc-package').disabled = !r.complete;
 $('#inc-export').disabled = false;
};
$('#inc-package').onclick = async () => {
 const pid = +$('#inc-patient').value;
 const r = await api('/api/incentive/pool/' + pid, 'POST');
 if (r.error) { $('#inc-warn').textContent = ' ' + r.error + ': ' + (r.missing || []).join(', '); return; }
 toast('Teşvik havuzuna aktarıldı & paketlendi ✓'); loadCompliance();
};
$('#inc-export').onclick = () => {
 const pid = +($('#zx-patient')?.value || $('#inc-patient').value);
 window.open('/api/incentive/export/' + pid, '_blank');
};

// ---------- boot ----------
buildMap();
(async function boot() {
 await Promise.all([loadPatients(), loadConvs(), loadKpis(), loadRfqs(), loadLogistics(), loadAccounting(), loadCompliance(),
 loadNotifs(), loadDoctorFilters(), loadWallet(), loadOffers(), loadPostop(), loadVariance(), loadSubagents(), loadClinic(), loadField(),
 loadMarketing()]);
 loadTemplates();
 await loadBuilder(); // patients yüklendikten sonra
 await loadLogisticsV2();
 await loadFxProfit();
 renderActivity();
})();
socket.on('patient_update', () => { loadPatients(); });

// ---------- Hipokrat AI asistan ----------
const hkPanel = $('#hipokrat-panel'), hkMsgs = $('#hk-msgs');
const hkPush = (text, me) => {
 const el = document.createElement('div');
 el.className = 'hk-msg ' + (me ? 'me' : 'bot');
 el.textContent = text;
 hkMsgs.appendChild(el); hkMsgs.scrollTop = hkMsgs.scrollHeight;
};
$('#hipokrat-btn').onclick = () => {
 hkPanel.classList.toggle('hidden');
 if (!hkPanel.classList.contains('hidden') && !hkMsgs.children.length)
 hkPush('Merhaba! Ben Hipokrat — durum özeti, SLA, gelir, RFQ, uçuş/transfer durumu, teşvik ve kurlar hakkında sorabilirsiniz.');
};
$('#hk-close').onclick = () => hkPanel.classList.add('hidden');
$('#hk-form').onsubmit = async e => {
 e.preventDefault();
 const q = $('#hk-input').value.trim(); if (!q) return;
 hkPush(q, true); $('#hk-input').value = '';
 hkPush('…');
 const r = await api('/api/hipokrat', 'POST', { message: q });
 hkMsgs.lastChild.textContent = r.reply || '—';
};

// ================= PANEL 1: Post-Op AI & Erken Uyarı =================
let postopSel = null;
async function loadPostop() {
 const rows = await api('/api/postop');
 $('#postop-badge').textContent = rows.reduce((s, r) => s + r.open_alerts, 0) || '';
 $('#postop-badge').classList.toggle('hidden', !rows.some(r => r.open_alerts));
 const alerts = await api('/api/postop/' + (postopSel || 0)).catch(() => null);
 $('#postop-list').innerHTML = rows.map(r => {
 const flagCls = { red: 'bad', watch: 'warn', ok: 'ok' }[r.last_flag] || 'ok';
 const milestones = [30, 60, 90].map(m => `<span class="dc ${r.day >= m ? 'reached' : ''}">${m}g</span>`).join('');
 return `<div class="li ${postopSel === r.id ? 'active' : ''}" onclick="openPostop(${r.id})" style="cursor:pointer">
 <span><b>${esc(r.name)}</b>${r.open_alerts ? ' <span class="chip bad"> ALARM</span>' : ''}
 <div class="day-chips">${milestones}<span class="dc">Gün ${r.day}</span></div>
 <div class="mut">${esc(r.nationality)} · ${r.checkins} check-in${r.last_pain != null ? ' · son ağrı ' + r.last_pain + '/10' : ''}</div></span>
 <span class="chip ${flagCls}">${r.last_flag === 'red' ? 'risk' : r.last_flag === 'watch' ? 'izlem' : 'stabil'}</span></div>`;
 }).join('') || '<div class="mut">Post-op hasta yok</div>';
 const openAlerts = rows.filter(r => r.open_alerts);
 $('#postop-alerts').innerHTML = openAlerts.map(r => `
 <div class="alert-banner"><span class="dot"></span>
 <div style="flex:1"><b>Kırmızı Alarm — ${esc(r.name)}</b><div class="mut" style="font-size:12px">Komplikasyon / olumsuz deneyim riski tespit edildi. Acil müdahale önerilir.</div></div>
 <button class="btn primary mini" onclick="openPostop(${r.id})">İncele →</button></div>`).join('');
}
window.openPostop = async pid => {
 postopSel = pid; loadPostop();
 const d = await api('/api/postop/' + pid);
 $('#postop-detail').classList.remove('mut');
 $('#postop-detail').innerHTML = `
 <div class="ws-row"><span><b>${esc(d.patient.name)}</b><div class="mut">Taburcu sonrası <b>Gün ${d.day}</b> · ${esc(d.patient.nationality)}</div></span>
 <span class="chip ${d.day >= 90 ? 'ok' : 'acc'}">${d.day >= 90 ? 'takip tamam' : 'takipte'}</span></div>
 <div style="display:flex;gap:8px;margin:10px 0">
 <button class="btn ghost mini" onclick="simCheckin(${pid})">+ Check-in simüle et</button>
 <button class="btn ghost mini" style="border-color:var(--bad);color:var(--bad)" onclick="simCheckin(${pid},'red')"> Riskli check-in sim</button></div>
 ${d.alerts.filter(a => a.status === 'open').map(a => `
 <div class="alert-banner"><span class="dot"></span>
 <div style="flex:1"><b>KIRMIZI ALARM</b><div class="mut" style="font-size:12px">${esc(a.message)}</div></div>
 <div style="display:flex;flex-direction:column;gap:6px">
 <button class="btn primary mini" onclick="interveneAlert(${a.id},'video_consult')"> Görüntülü doktor görüşmesi teklif et</button>
 <button class="btn ghost mini" onclick="interveneAlert(${a.id},'call')"> Hastayı ara</button>
 <button class="btn ghost mini" onclick="interveneAlert(${a.id},'dismiss')">Kapat</button></div></div>`).join('')}
 ${d.alerts.filter(a => a.status !== 'open').slice(0, 3).map(a => `<div class="ws-row"><span class="mut">${esc(a.action_taken || a.status)}</span><span class="chip ok">✓</span></div>`).join('')}
 <h3 style="margin:12px 0 6px">Check-in Akışı</h3>
 ${d.checkins.map(c => `<div class="ws-row"><span>
 <b>Gün ${c.day}</b> · Ağrı ${c.pain_score}/10 · Memnuniyet ${'★'.repeat(c.satisfaction || 0) || '—'}
 <div class="pain-bar" style="margin-top:4px"><div style="width:${c.pain_score * 10}%;background:${c.pain_score >= 7 ? 'var(--bad)' : c.pain_score >= 5 ? 'var(--warn)' : 'var(--ok)'}"></div></div>
 <div class="mut" style="margin-top:4px">${esc(c.note || '')}${c.photo_note ? ' · ' + esc(c.photo_note) : ''}</div></span>
 <span class="chip ${{ red: 'bad', watch: 'warn', ok: 'ok' }[c.ai_flag]}">${{ red: ' risk', watch: ' izlem', ok: '✓' }[c.ai_flag]}</span></div>`).join('') || '<div class="mut">Check-in yok</div>'}`;
};
window.simCheckin = async (pid, risk) => {
 const r = await api(`/api/postop/${pid}/simulate`, 'POST', { risk });
 toast(r.ai_flag === 'red' ? ' AI kırmızı alarm verdi!' : r.ai_flag === 'watch' ? ' İzlem işaretlendi' : '✓ Check-in kaydedildi');
 openPostop(pid);
};
window.interveneAlert = async (id, action) => {
 await api(`/api/postop/alerts/${id}/intervene`, 'POST', { action });
 toast(action === 'video_consult' ? ' Görüntülü doktor görüşmesi teklifi hastaya iletildi' : action === 'call' ? ' Arama görevi temsilciye atandı' : 'Alarm kapatıldı');
 if (postopSel) openPostop(postopSel); loadPostop();
};
socket.on('postop_alert', a => { toast(` POST-OP KIRMIZI ALARM: ${a.patient_name}`); loadPostop(); loadNotifs(); });

// ================= PANEL 2: Bütçe & Sapma =================
async function loadVariance() {
 const d = await api('/api/variance');
 $('#var-summary').innerHTML = `
 <div class="kpi"><div class="v">${fmt(d.totals.est)}</div><div class="l">Tahmini Maliyet (teklif)</div></div>
 <div class="kpi"><div class="v">${fmt(d.totals.act)}</div><div class="l">Gerçekleşen Maliyet</div></div>
 <div class="kpi"><div class="v">${fmt(d.totals.income)}</div><div class="l">Toplam Gelir</div></div>
 <div class="kpi ${d.totals.overruns ? 'alert' : ''}"><div class="v">${d.totals.overruns}</div><div class="l">Bütçe Aşımı Uyarısı</div></div>`;
 $('#var-list').innerHTML = `
 <div class="var-row var-head"><span>Hasta</span><span>Tahmini</span><span>Gerçekleşen</span><span>Net</span><span>Sapma</span></div>` +
 d.patients.map(r => `
 <div class="var-row">
 <span><b>${esc(r.name)}</b><div class="mut" style="font-size:11px">${esc(r.nationality)} · ${LEADS.find(l => l[0] === r.lead_status)?.[1] || ''}</div>
 <div class="mut" style="font-size:11px">otel ${fmt(r.actual.hotel)}/${fmt(r.estimated.hotel)} · transfer ${fmt(r.actual.transport)}/${fmt(r.estimated.transport)} · hastane ${fmt(r.actual.medical)}/${fmt(r.estimated.medical)}</div></span>
 <span>${fmt(r.est_total)}</span><span>${fmt(r.act_total)}</span>
 <span style="color:${r.net >= 0 ? 'var(--ok)' : 'var(--bad)'}">${fmt(r.net)}</span>
 <span class="chip ${{ red: 'bad', warn: 'warn', ok: 'ok' }[r.flag]}">${r.variance_pct > 0 ? '+' : ''}${r.variance_pct}%${r.flag === 'red' ? ' ' : ''}</span>
 </div>`).join('') || '<div class="mut">Teklifli hasta yok</div>';
}

// ================= PANEL 3: B2B Sub-Agent =================
let saSel = null;
const STAGE_TR = { new: 'Yeni', quoted: 'Teklif', agreed: 'Anlaşıldı', in_operation: 'Ameliyat', completed: 'Taburcu' };
async function loadSubagents() {
 const list = await api('/api/subagents');
 $('#subagent-list').innerHTML = list.map(s => `
 <div class="li" onclick="openSubagent(${s.id})" style="cursor:pointer">
 <span><b>${esc(s.name)}</b><div class="mut">${esc(s.country || '')} · %${s.commission_pct} komisyon · ${s.patient_count} hasta</div></span>
 <b>${fmt(s.commission_earned)}</b></div>`).join('') || '<div class="mut">Sub-agent yok</div>';
 $('#sa-assign').innerHTML = '<option value="">Acente seç…</option>' + list.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
 $('#sa-patient').innerHTML = patients.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
 if (saSel) openSubagent(saSel);
}
window.openSubagent = async id => {
 saSel = id;
 const s = await api('/api/subagents/' + id);
 $('#subagent-detail').classList.remove('mut');
 $('#subagent-detail').innerHTML = `
 <div class="ws-row"><span><b>${esc(s.name)}</b><div class="mut">${esc(s.contact || '')} · %${s.commission_pct} hakediş</div></span>
 <b>${fmt(s.patients.reduce((x, p) => x + p.commission, 0))}</b></div>
 <h3 style="margin:10px 0 6px">Yönlendirilen Hastalar (${s.patients.length})</h3>
 ${s.patients.map(p => `<div class="ws-row"><span>${esc(p.name)}<div class="mut">${esc(p.nationality)} · fatura ${fmt(p.invoice_total)}</div></span>
 <span><span class="patient-stage chip ${{ new: '', quoted: 'acc', agreed: 'violet', in_operation: 'warn', completed: 'ok' }[p.lead_status] || ''}">${STAGE_TR[p.lead_status] || p.lead_status}</span>
 <b style="margin-left:8px">${fmt(p.commission)}</b></span></div>`).join('') || '<div class="mut">Bu acentenin hastası yok</div>'}`;
};
$('#sa-create').onclick = async () => {
 const name = $('#sa-name').value.trim(); if (!name) return;
 await api('/api/subagents', 'POST', { name, country: $('#sa-country').value, contact: $('#sa-contact').value, commission_pct: +$('#sa-pct').value || 10 });
 toast('Sub-agent eklendi'); $('#sa-name').value = $('#sa-country').value = $('#sa-contact').value = ''; loadSubagents();
};
$('#sa-assign-btn').onclick = async () => {
 const sid = +$('#sa-assign').value, pid = +$('#sa-patient').value;
 if (!sid) return toast('Önce acente seçin');
 await api('/api/patients/' + pid, 'PATCH', { subagent_id: sid });
 toast('Hasta acenteye atandı'); loadSubagents(); loadPatients();
};

// ================= PANEL 4: Klinik Cari =================
async function loadClinic() {
 const recv = await api('/api/receivables');
 $('#recv-list').innerHTML = recv.map(r => `
 <div class="li"><span><b>${esc(r.hospital_name || '—')}</b> — ${esc(r.patient_name || 'genel')}
 <div class="mut">Vade: ${r.due_date || '—'}${r.collected_at ? ' · tahsil ' + r.collected_at.slice(0, 10) : ''}</div></span>
 <span><b>${fmt(r.amount)}</b>
 ${r.status === 'collected' ? ' <span class="chip ok">tahsil edildi</span>'
 : r.status === 'overdue' ? ` <span class="chip bad">vadesi geçti</span> <button class="btn primary mini" onclick="collectRecv(${r.id})">Tahsil et</button>`
 : ` <span class="chip acc">bekliyor</span> <button class="btn ghost mini" onclick="collectRecv(${r.id})">Tahsil et</button>`}</span></div>`).join('') || '<div class="mut">Alacak yok</div>';
 const accounts = await api('/api/accounts');
 const hospitals = accounts.filter(a => a.type === 'vendor');
 $('#clinic-balances').innerHTML = hospitals.map(a => `
 <div class="li"><span>${esc(a.name)}<div class="mut">${a.vkn ? 'VKN ' + a.vkn + ' · ' : ''}${esc(a.vergi_dairesi || '')}</div></span>
 <b style="color:${a.balance >= 0 ? 'var(--ok)' : 'var(--bad)'}">${fmt(a.balance)}</b></div>`).join('') || '<div class="mut">—</div>';
 $('#recv-account').innerHTML = hospitals.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
 $('#recv-patient').innerHTML = '<option value="">Hasta (ops.)</option>' + patients.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
}
window.collectRecv = async id => {
 await api(`/api/receivables/${id}/collect`, 'POST');
 toast('Komisyon tahsil edildi → cari gelir işlendi'); loadClinic(); loadAccounting(); loadKpis();
};
$('#recv-create').onclick = async () => {
 const amount = +$('#recv-amount').value; if (!amount) return;
 await api('/api/receivables', 'POST', { account_id: +$('#recv-account').value, patient_id: +$('#recv-patient').value || null, amount, due_date: $('#recv-due').value });
 toast('Alacak eklendi'); $('#recv-amount').value = ''; loadClinic();
};
socket.on('receivable_collected', () => { loadClinic(); });

// ================= PANEL 5: Saha Kiosk =================
let kioskOcr = null;
async function loadField() {
 const arr = await api('/api/field/arrivals');
 $('#arrival-list').innerHTML = arr.map(a => `
 <div class="li" onclick="$('#kiosk-patient').value=${a.patient_id}" style="cursor:pointer">
 <span>✈ ${esc(a.ref_label || '')} — <b class="plink" data-pid="${a.patient_id}">${esc(a.patient_name)}</b><div class="mut">${esc(a.nationality)} · ${esc(a.passport_no || 'pasaport yok')}</div></span>
 <span class="flight-live" id="dfs-${a.booking_id}">${esc(a.flight_status || 'Scheduled')}</span></div>`).join('') || '<div class="mut">Planlı karşılama yok</div>';
 $('#kiosk-patient').innerHTML = patients.map(p => `<option value="${p.id}">${esc(p.name)} — ${esc(p.nationality)}</option>`).join('');
}
$('#kiosk-ocr').onclick = async () => {
 $('#kiosk-ocr-result').innerHTML = '<div class="ocr-scan"></div><div class="mut" style="font-size:12px;margin-top:6px">Pasaport taranıyor…</div>';
 const r = await api('/api/field/ocr', 'POST', { patient_id: +$('#kiosk-patient').value });
 kioskOcr = r.data;
 setTimeout(() => {
 $('#kiosk-ocr-result').innerHTML = `<div class="ocr-card">
 <div style="display:flex;justify-content:space-between"><b> OCR Sonucu</b><span class="chip ok">%${Math.round(r.confidence * 100)} güven</span></div>
 <div class="row"><span class="mut">Ad Soyad</span><b>${esc(r.data.name)}</b></div>
 <div class="row"><span class="mut">Pasaport No</span><b>${esc(r.data.passport_no)}</b></div>
 <div class="row"><span class="mut">Uyruk</span><b>${esc(r.data.nationality)}</b></div>
 <div class="row"><span class="mut">Doğum</span><b>${esc(r.data.dob)}</b></div></div>`;
 }, 900);
};
// dijital imza pedi
const sigPad = $('#sig-pad'), sigCtx = sigPad.getContext('2d');
let sigDrawing = false, sigEmpty = true;
sigCtx.lineWidth = 2.2; sigCtx.lineCap = 'round'; sigCtx.strokeStyle = '#0a84ff';
const sigPos = e => { const r = sigPad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
sigPad.onpointerdown = e => { sigDrawing = true; sigEmpty = false; sigCtx.beginPath(); sigCtx.moveTo(...sigPos(e)); sigPad.setPointerCapture(e.pointerId); };
sigPad.onpointermove = e => { if (sigDrawing) { sigCtx.lineTo(...sigPos(e)); sigCtx.stroke(); } };
sigPad.onpointerup = () => sigDrawing = false;
$('#sig-clear').onclick = () => { sigCtx.clearRect(0, 0, sigPad.width, sigPad.height); sigEmpty = true; };
$('#kiosk-sign').onclick = async () => {
 if (sigEmpty) return toast('Önce imza atın');
 const r = await api('/api/kvkk', 'POST', {
 patient_id: +$('#kiosk-patient').value, form_type: $('#kiosk-form').value,
 signer_name: kioskOcr ? kioskOcr.name : undefined, passport_no: kioskOcr ? kioskOcr.passport_no : undefined,
 signature: sigPad.toDataURL().slice(-2000), ocr: kioskOcr,
 });
 if (r.error) return toast(' ' + r.error);
 $('#kiosk-log').innerHTML = `✓ ${$('#kiosk-form').selectedOptions[0].text} kaydedildi — <b>${r.signature_hash}</b> · hasta dosyasına işlendi`;
 sigCtx.clearRect(0, 0, sigPad.width, sigPad.height); sigEmpty = true;
 toast('✍ Form imzalandı ve arşivlendi'); loadNotifs();
};

// ================= PANEL 6: Pazarlama & ROAS =================
async function loadMarketing() {
 const m = await api('/api/marketing');
 const t = m.totals;
 $('#mkt-kpis').innerHTML = [
 ['Toplam Harcama', fmt(t.spend)], ['Toplam Ciro', fmt(t.rev)],
 ['Ortalama CAC', fmt(t.cac) + '/lead'], ['ROAS', 'x' + t.roas],
 ].map(([l, v]) => `<div class="kpi"><div class="kpi-v">${v}</div><div class="kpi-l">${l}</div></div>`).join('');
 const maxRev = Math.max(...m.countries.map(c => c.revenue), 1);
 $('#mkt-countries').innerHTML = m.countries.map((c, i) => `
 <div class="var-row"><span><b>${CFLAG[c.country] || ''} ${esc(c.country)}</b>
 ${i === 0 ? '<span class="chip" style="background:var(--ok-soft);color:#1a9e6b;font-size:10px">En yüksek ciro</span>' : ''}
 <div class="mut">${c.leads} lead · ${c.conversions} dönüşüm (%${c.conv_rate})</div>
 <div class="pain-bar"><div style="width:${Math.round(c.revenue / maxRev * 100)}%;background:#4f7cff"></div></div></span>
 <span>${fmt(c.spend)}</span><span>${fmt(c.revenue)}</span>
 <span><span class="mut">CAC</span> ${fmt(c.cac)}</span>
 <span class="chip" style="background:${c.roas >= 4 ? 'var(--ok-soft)' : c.roas >= 2 ? '#fff4d6' : '#ffe2e0'};color:${c.roas >= 4 ? '#1a9e6b' : c.roas >= 2 ? '#b07d00' : '#d9392b'}">ROAS x${c.roas}</span></div>`).join('');
 $('#mkt-camps').innerHTML = m.campaigns.map(c => `
 <div class="li"><span><b>${c.channel === 'meta' ? 'Ⓜ' : ''}</b> ${esc(c.name)}
 <div class="mut">${esc(c.country)} · ${c.leads} lead · CAC ${fmt(c.cac)}</div></span>
 <span><div>${fmt(c.spend)}</div><div class="mut">ROAS x${c.roas}</div></span></div>`).join('');
 const cs = $('#mc-country');
 if (cs && !cs.options.length) cs.innerHTML = m.countries.map(c => `<option>${esc(c.country)}</option>`).join('');
}
$('#mkt-sync').onclick = async () => { await api('/api/marketing/sync', 'POST'); toast('Meta & Google verileri senkronize edildi'); loadMarketing(); };
$('#mc-create').onclick = async () => {
 const name = $('#mc-name').value.trim();
 if (!name) return toast('Kampanya adı girin', 'warn');
 await api('/api/marketing/campaigns', 'POST', { channel: $('#mc-channel').value, country: $('#mc-country').value, name, spend: +$('#mc-spend').value || 0 });
 $('#mc-name').value = ''; $('#mc-spend').value = '';
 toast('Kampanya eklendi'); loadMarketing();
};

// ================= PANEL 7: Paket & Teklif =================
const HOTEL_P = { 3: 90, 4: 130, 5: 190 }, TRANSFER_P = { sedan: 40, vito: 60, sprinter: 80 };
let treatments = [], postopPacks = [];
async function loadBuilder() {
 const [ts, pks, offs] = await Promise.all([api('/api/treatments'), api('/api/postop-packages'), api('/api/offers')]);
 treatments = ts; postopPacks = pks;
 $('#pb-patient').innerHTML = patients.map(p => `<option value="${p.id}">${esc(p.name)} — ${esc(p.nationality)}</option>`).join('');
 $('#pb-treatment').innerHTML = ts.map(t => `<option value="${t.id}">${esc(t.name)} — ${fmt(t.base_price)}</option>`).join('');
 $('#pb-postop').innerHTML = pks.map(p => `<option value="${p.id}">${esc(p.name)} — ${fmt(p.price)}</option>`).join('');
 renderOffers(offs);
 previewPackage();
}
function renderOffers(offs) {
 $('#pb-offers').innerHTML = offs.slice(0, 12).map(o => `
 <div class="li"><span><span class="plink" data-pid="${o.patient_id}">${esc(o.patient_name)}</span> — ${fmt(o.total)}
 <div class="mut">${o.lang || 'en'} · ${o.delivered_via || '—'} · ${esc(o.postop_name || '')}${o.fx_locked ? ' · kur kilit ₺' + o.fx_locked : ''}</div></span>
 <span><span class="chip">${o.status}</span>
 ${o.share_token ? `<button class="btn ghost mini" onclick="deliverOffer(${o.id},'whatsapp')">WhatsApp</button>
 <button class="btn ghost mini" onclick="deliverOffer(${o.id},'mail')">Mail</button>` : ''}</span></div>`).join('') || '<div class="mut">Teklif yok</div>';
}
let pbExtras = [], pbRfqs = [];
async function loadPatientRfqs() {
 const pid = +$('#pb-patient').value;
 pbRfqs = (await api('/api/rfq')).filter(r => r.patient_id === pid && r.status === 'responded' && r.quote_price);
 $('#pb-rfqbox').innerHTML = pbRfqs.length
 ? `<select id="pb-rfq" class="input" style="margin-top:8px"><option value="">Tedavi: liste fiyatı (RFQ yok — manuel)</option>
 ${pbRfqs.map(r => `<option value="${r.id}">RFQ #${r.id} — ${esc(r.doctor_name)}: ${fmt(r.quote_price)}</option>`).join('')}</select>
 <div class="mut" style="font-size:11px;margin:4px 0">Hasta için ${pbRfqs.length} doktor teklifi — seçim teklif fiyatını baz alır</div>`
 : '<div class="mut" style="font-size:11px;margin-top:6px">Bu hastaya yanıtlanmış RFQ yok — tedavi liste fiyatından hesaplanır</div>';
}
function previewPackage() {
 const t = treatments.find(x => x.id === +$('#pb-treatment').value);
 const pk = postopPacks.find(x => x.id === +$('#pb-postop').value);
 if (!t || !pk) return;
 const rfq = pbRfqs.find(r => r.id === +($('#pb-rfq')?.value || 0));
 const base = rfq ? rfq.quote_price : t.base_price;
 const tot = base + HOTEL_P[+$('#pb-stars').value || 4] * (+$('#pb-nights').value || 3)
 + TRANSFER_P[$('#pb-transfer').value] + pk.price + pbExtras.reduce((s, e) => s + e.price, 0);
 $('#pb-preview').innerHTML = `Önizleme toplam: <b>${fmt(tot)}</b> (${rfq ? 'RFQ fiyatı' : 'tedavi'} + otel + transfer + post-op${pbExtras.length ? ' + ' + pbExtras.length + ' ek kalem' : ''})`;
}
document.addEventListener('click', e => {
 if (e.target.id === 'pb-add') { const d = $('#pb-xdesc').value.trim(), p = +$('#pb-xprice').value;
 if (!d || !p) return toast('Açıklama ve fiyat girin'); pbExtras.push({ desc: d, price: p });
 $('#pb-xdesc').value = ''; $('#pb-xprice').value = ''; previewPackage(); }
});
$('#pb-patient').addEventListener('change', loadPatientRfqs);
['pb-treatment', 'pb-stars', 'pb-nights', 'pb-transfer', 'pb-postop'].forEach(id => {
 const el = $('#' + id); if (el) el.onchange = previewPackage;
});
$('#pb-build').onclick = async () => {
 if (!$('#pb-postop').value) return toast('Post-op takip paketi zorunlu — seçin');
 const r = await api('/api/packages/build', 'POST', {
 patient_id: +$('#pb-patient').value, treatment_id: +$('#pb-treatment').value,
 rfq_id: +($('#pb-rfq')?.value || 0) || undefined, extras: pbExtras,
 stars: +$('#pb-stars').value, nights: +$('#pb-nights').value, transfer: $('#pb-transfer').value,
 postop_package_id: +$('#pb-postop').value, lang: $('#pb-lang').value });
 pbExtras = [];
 if (!r.id) return toast(r.error || 'Hata', 'warn');
 $('#pb-result').innerHTML = `<div class="ocr-card" style="margin-top:12px"><div class="row"><b>✔ Teklif #${r.id} hazır — ${fmt(r.total)}</b></div>
 <div class="row mut">${location.origin}${r.url} <button class="btn ghost mini" onclick="navigator.clipboard.writeText('${location.origin}${r.url}');toast('Link kopyalandı')">Kopyala</button>
 <a class="btn ghost mini" href="${r.url}" target="_blank">PDF/Mektup</a></div>
 <div class="row"><button class="btn primary mini" onclick="deliverOffer(${r.id},'whatsapp')">WhatsApp ile gönder</button>
 <button class="btn ghost mini" onclick="deliverOffer(${r.id},'mail')">Mail ile gönder</button></div></div>`;
 toast('Teklif oluşturuldu'); loadBuilder();
};
window.deliverOffer = async (id, ch) => {
 const r = await api(`/api/offers/${id}/deliver`, 'POST', { channel: ch });
 toast(ch === 'whatsapp' ? 'WhatsApp ile gönderildi' : 'Mail ile gönderildi');
 loadBuilder();
};


async function loadTour() {
 const bs = await api('/api/bookings');
 $('#tour-list').innerHTML = bs.filter(b => b.kind === 'tour').map(b => `
 <div class="li"><span> ${esc(b.ref_label)}<div class="mut"><span class="plink" data-pid="${b.patient_id}">${esc(b.patient_name || '')}</span></div></span><b>${fmt(b.price)}</b></div>`).join('')
 || '<div class="mut">Planlanan tur yok</div>';
}
window.createTour = async () => {
 const pid = +$('#tour-patient').value;
 if (!pid) return toast('Lütfen hasta seçiniz');
 await api('/api/bookings', 'POST', { patient_id: pid, kind: 'tour',
 ref_label: 'Kültürel Gezi — ' + $('#tour-program').value + ' (' + ($('#tour-timing').value === 'pre-op' ? 'ameliyat öncesi' : 'ameliyat sonrası') + ')',
 details: { guide: $('#tour-guide').value, timing: $('#tour-timing').value, tursab: 'A Grubu' }, price: +$('#tour-price').value });
 toast('Kültürel gezi tanımlandı — TÜRSAB A Grubu uyumlu'); logActivity('Kültürel gezi tanımlandı'); loadTour();
};
window.createContract = async pid => {
 const dep = prompt('Ön ödeme / kapora tutarı (EUR) — boş bırakılırsa sadece sözleşme oluşur:', '500');
 if (dep === null) return;
 const r = await api('/api/contract', 'POST', { patient_id: pid, deposit: +dep || 0 });
 if (r.error) return toast(r.error);
 toast('Sözleşme oluşturuldu: ' + r.file); logActivity('İki dilli sözleşme + kapora'); openDrawer(pid);
};

// ---------- 6 yeni panel ----------
async function createFieldTask() {
 const r = await api('/api/field-tasks', 'POST', { agent_id: +$('#ft-agent').value, patient_id: +$('#ft-patient').value,
 task: $('#ft-task').value, payout: +$('#ft-payout').value });
 if (r.id) { toast('Saha görevi atandı'); loadFieldTasks(); }
}
async function loadFieldTasks() {
 const el = $('#ft-list'); if (!el) return;
 const [ts, ags] = await Promise.all([api('/api/field-tasks'), api('/api/translators')]);
 $('#ft-agent').innerHTML = ags.map(g => `<option value="${g.id}">${esc(g.name)} (${g.role === 'ops' ? 'Operasyon' : 'Tercüman'})</option>`).join('');
 $('#ft-patient').innerHTML = patients.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
 el.innerHTML = ts.slice(0, 15).map(t => `<div class="li"><span><b>${esc(t.agent_name || '—')}</b> → <span class="plink" data-pid="${t.patient_id}">${esc(t.patient_name || '—')}</span>
 <div class="mut">${esc(t.task)} · hakediş ${fmt(t.payout)}</div></span>
 ${t.location_ok ? '<span class="chip ok">Konum onaylı · ödendi</span>' : `<button class="btn primary mini" onclick="api('/api/field-tasks/${t.id}/confirm','POST').then(loadFieldTasks)">Karşılama onayı ver</button>`}</div>`).join('') || '<div class="mut">Görev yok</div>';
}
async function loadRepPerf() {
 const el = $('#rep-perf'); if (!el) return;
 const rs = await api('/api/rep-performance');
 el.innerHTML = `<div class="tr" style="font-weight:600"><span>Temsilci</span><span>Bağlı hasta</span><span>Ciro</span><span>Net kâr</span><span>Prim</span></div>` +
 rs.map(r => `<div class="tr"><span>${esc(r.name)}</span><span>${r.patients}</span><span>${fmt(r.revenue)}</span><span>${fmt(r.net_profit)}</span><span class="chip ok">${fmt(r.premium)}</span></div>`).join('');
}
async function startClaim(pid) {
 const amt = prompt('Hasar / revizyon tutarı (€):', '1500'); if (amt === null) return;
 const r = await api('/api/claims', 'POST', { patient_id: pid, amount: +amt, reason: 'Ameliyat sonrası revizyon komplikasyonu' });
 if (r.id) toast('Hasar dosyası #' + r.id + ' açıldı — sigorta cari dosyasına düştü'); else toast(r.error || 'Hata', 'warn');
}
async function marketingConsent(pid) {
 if (!confirm('Hastanın Sosyal Medya ve Pazarlama Görsel İzin Onayı dijital olarak alındı mı?')) return;
 const r = await api(`/api/patients/${pid}/marketing-consent`, 'POST');
 if (r.ok) { toast('Pazarlama izin onayı kaydedildi — esign dosyaya düştü'); openDrawer(pid); }
}

async function renderRecent() {
 const el = $('#recent-timeline'); if (!el) return;
 const ps = patients.slice(0, 5);
 const STEPS = ['Lead','KVKK & Anamnez','Medikal / RFQ','Sözleşme','Lojistik','Hastane & Fatura','Teşvik & Post-Op'];
 const rows = await Promise.all(ps.map(async p => {
 try { const d = await api(`/api/patients/${p.id}/dossier`);
 const done = [true, d.files?.some(f=>f.filename.startsWith('KVKK_Onay')) || d.files?.length>1,
 d.rfqs?.length>0, d.files?.some(f=>f.filename.includes('Sozlesme')||f.filename.includes('Satis')),
 d.bookings?.length>0, (d.invoices||[]).length>0, d.checklist?.zip_ready].filter(Boolean).length;
 return { p, done };
 } catch { return { p, done: 1 }; }
 }));
 el.innerHTML = rows.map(({p, done}) => `<div class="li" style="align-items:center;gap:14px">
 <span style="min-width:150px"><b class="plink" data-pid="${p.id}">${esc(p.name)}</b><div class="mut">${esc(p.lead_status || '')}</div></span>
 <span style="flex:1;display:flex;gap:4px">${STEPS.map((s,i)=>`<span title="${s}" style="flex:1;height:6px;border-radius:3px;background:${i<done?'var(--acc)':'var(--line)'}"></span>`).join('')}</span>
 <span class="mut" style="font-size:11px;min-width:70px;text-align:right">${done}/7 adım</span>
 <button class="btn ghost mini" onclick="openDrawer(${p.id})">Dosya</button></div>`).join('') || '<div class="mut">Aktivite yok</div>';
}

// ---------- RBAC ----------
const NAV_MODS = ['crm','comms','rfq','ops','finance','analytics','compliance','postop'];
let PERMS = {};
async function applyRole() {
 try {
 const rp = $('#role-pick'); if (rp) rp.value = ROLE;
 const d = await api('/api/role-permissions').catch(() => null);
 PERMS = {};
 if (d && Array.isArray(d.permissions)) d.permissions.forEach(p => { PERMS[p.role + ':' + p.module] = !!p.allowed; });
 const allowed = m => { try { return ROLE === 'admin' || PERMS[ROLE + ':' + m] !== false; } catch { return true; } };
 $$('#nav > .nav-group').forEach((g, i) => {
 try { const mod = g.dataset.rbac === 'admin' ? 'admin' : NAV_MODS[i];
 g.style.display = allowed(mod) ? '' : 'none'; } catch { g.style.display = ''; }
 });
 $$('.qcard').forEach(q => { try {
 const map = { 'Yeni Hasta': 'crm', 'Mesajlaşma': 'comms', 'Doktor Teklifi': 'rfq', 'VIP Transfer': 'ops', 'e-Fatura': 'finance', 'Teşvik': 'compliance' };
 for (const k in map) if (q.textContent.includes(k)) q.style.display = allowed(map[k]) ? '' : 'none';
 } catch { q.style.display = ''; } });
 } catch (e) { console.warn('applyRole safe-fallback', e); $$('#nav > .nav-group').forEach(g => g.style.display = ''); $$('.qcard').forEach(q => q.style.display = ''); }
}
$('#role-pick').onchange = async e => { ROLE = e.target.value; localStorage.setItem('clinica-role', ROLE); await applyRole(); goTab('dashboard'); toast('Rol değiştirildi: ' + e.target.selectedOptions[0].text); };
async function loadRbac() {
 try {
 const d = await api('/api/role-permissions');
 if (!d || !d.roles) return;
 const mods = ['dashboard','crm','comms','rfq','ops','finance','analytics','compliance','postop','admin'];
 const names = { dashboard:'Anasayfa', crm:'Hasta/CRM', comms:'İletişim & Anamnez', rfq:'Hekim & RFQ', ops:'Operasyon', finance:'Finans', analytics:'Analitik', compliance:'Mevzuat/Teşvik', postop:'Post-Op', admin:'Yetki Paneli' };
 const el = $('#rbac-matrix');
 el.innerHTML = '<div class="tr" style="font-weight:600"><span>Modül</span>' + d.roles.filter(r=>r!=='admin').map(r => `<span>${r}</span>`).join('') + '</div>' +
 mods.filter(m => m !== 'admin').map(m => `<div class="tr"><span>${names[m]}</span>` +
 d.roles.filter(r=>r!=='admin').map(r => {
 const on = PERMS[r + ':' + m] ?? d.permissions.find(p => p.role === r && p.module === m)?.allowed;
 return `<span><label class="sw"><input type="checkbox" ${on ? 'checked' : ''} onchange="api('/api/role-permissions','POST',{role:'${r}',module:'${m}',allowed:this.checked}).then(()=>{PERMS['${r}:${m}']=this.checked;toast('${names[m]} → ${r}: '+(this.checked?'açık':'kapalı'));applyRole()})"><i></i></label></span>`;
 }).join('') + '</div>').join('');
 } catch (e) { console.warn('loadRbac', e); }
}

// ---------- AI öneri + affiliates + vize davetiyesi ----------
async function loadUpsell() {
 const pid = +$('#pb-patient').value; if (!pid) return;
 const u = await api('/api/upsell/' + pid);
 $('#pb-ai-body').innerHTML = `<div>Önerilen paket: <b>${esc(u.recommended)}</b></div>
 <div>Çapraz satış: <b>${esc(u.cross_sell)}</b></div>
 <div>Dönüşüm ihtimali: <b style="color:var(--acc)">%${u.conv_pct}</b></div>
 <div style="font-size:11px;margin-top:4px">${esc(u.tip)}</div>`;
}
const _lrf = loadPatientRfqs; loadPatientRfqs = async function(){ await _lrf(); loadUpsell(); };
async function loadAffiliates() {
 const el = $('#aff-list'); if (!el) return;
 const as = await api('/api/affiliates');
 el.innerHTML = as.map(sa => `<div class="card"><h2>${esc(sa.name)} <span class="chip">${esc(sa.country)}</span></h2>
 <div class="mut">Komisyon oranı: <b>%${sa.commission_pct}</b></div>
 <div>Getirilen hasta: <b>${sa.patients.length}</b> — ${sa.patients.slice(0,4).map(p=>esc(p.name)).join(', ')}</div>
 <div>Toplam ciro: <b>${fmt(sa.revenue)}</b> → hakediş: <b class="chip ok">${fmt(sa.commission)}</b></div></div>`).join('') || '<div class="mut">Kayıt yok</div>';
}
async function visaLetter(pid) {
 const r = await api(`/api/patients/${pid}/visa-letter`, 'POST');
 if (r.ok) { toast(`Davetiye üretildi: ${r.file} (Yetki: ${r.ref})`); openDrawer(pid); }
}

const TPL = {
 en: { flight: 'Dear patient, your flight details have been confirmed. Please be at the airport 3 hours before departure. Your passport and boarding documents are ready.', transfer: 'Your VIP transfer is arranged. Our driver will meet you at the arrivals hall holding a Clinicia sign. Vehicle tracking is active.', discharge: 'Post-discharge guide: take your medication as prescribed, attend your follow-up calls on days 30/60/90, and contact us 24/7 for any complication.' },
 de: { flight: 'Sehr geehrter Patient, Ihre Flugdaten wurden bestätigt. Bitte seien Sie 3 Stunden vor Abflug am Flughafen.', transfer: 'Ihr VIP-Transfer ist organisiert. Unser Fahrer erwartet Sie in der Ankunftshalle mit einem Clinicia-Schild.', discharge: 'Nachsorge: Medikamente wie verordnet einnehmen, Kontrolltermine an Tag 30/60/90 wahrnehmen, bei Komplikationen 24/7 anrufen.' },
 ar: { flight: 'عزيزي المريض، تم تأكيد تفاصيل رحلتك. يرجى التواجد في المطار قبل 3 ساعات من الإقلاع.', transfer: 'تم ترتيب نقلك الخاص. سيكون سائقنا في قاعة الوصول حاملاً لافتة Clinicia.', discharge: 'دليل ما بعد الخروج: تناول أدويتك كما هو موصوف، واحضر مواعيد المتابعة في الأيام 30/60/90.' },
 ru: { flight: 'Уважаемый пациент, данные вашего рейса подтверждены. Просим прибыть в аэропорт за 3 часа до вылета.', transfer: 'Ваш VIP-трансфер организован. Водитель встретит вас в зоне прилёта с табличкой Clinicia.', discharge: 'После выписки: принимайте лекарства по назначению, посещайте контрольные осмотры на 30/60/90 день.' },
 tr: { flight: 'Sayın hastamız, uçuş bilgileriniz onaylandı. Kalkıştan 3 saat önce havalimanında olunuz.', transfer: 'VIP transferiniz ayarlandı. Şoförümüz sizi Clinicia tabelasıyla karşılayacak.', discharge: 'Taburcu sonrası rehber: ilaçlarınızı düzenli kullanın, 30/60/90 gün kontrollerine katılın.' },
};
async function patientPass(pid) {
 const r = await api(`/api/patients/${pid}/pass`, 'POST');
 if (r.url) { const u = location.origin + r.url; await navigator.clipboard.writeText(u).catch(()=>{});
 toast('Takip linki kopyalandı: ' + r.url); window.open(r.url, '_blank'); }
}

// ---------- DAB + kur sapma alarmı ----------
async function loadFxAlarm() {
 const el = $('#fx-alarm'); if (!el) return;
 try {
 const fx = await api('/api/fx');
 const eur = fx.find(f => f.code === 'EUR');
 const offs = await api('/api/offers');
 const locked = offs.find(o => o.fx_locked);
 if (!eur || !locked) { el.textContent = 'Kur: veri yok'; return; }
 const drift = ((eur.rate - locked.fx_locked) / locked.fx_locked * 100);
 el.textContent = `EUR ₺${eur.rate.toFixed(2)} · teklif kilit ₺${locked.fx_locked.toFixed(2)} · sapma %${drift.toFixed(2)}${Math.abs(drift) > 3 ? ' — KUR ZARARI RİSKİ' : ''}`;
 el.className = 'chip ' + (Math.abs(drift) > 3 ? 'bad' : 'ok');
 } catch { el.textContent = 'Kur: —'; }
}

// ---------- v2.0: lead score + ai analysis + franchise ----------
async function leadScore(pid) {
 const s = await api('/api/lead-score/' + pid);
 if (s.pct) toast(`AI Skor: %${s.pct} (${s.segment}) · Bütçe ${s.budget}${s.rep ? ' · Önerilen: ' + s.rep : ''}`); return s;
}
async function aiAnalysis(pid) {
 const r = await api('/api/ai-analysis/' + pid);
 const el = document.createElement('div'); el.className = 'toast';
 el.innerHTML = `<b>AI Ön Analiz:</b> ${r.files_analyzed} dosya incelendi → <b>${esc(r.draft_offer)}</b>${r.analysis ? ` (güven %${r.analysis.conf})` : ''}`;
 $('#toast').appendChild(el); setTimeout(() => el.remove(), 6000);
}
async function loadFranchise() {
 const el = $('#aff-list'); if (!el) return;
 const f = await api('/api/franchise');
 const as = await api('/api/affiliates');
 el.innerHTML = Object.values(f).map(b => `<div class="card"><h2>${b.name}</h2>
 <div class="mut">Temsilciler: ${b.agents.join(', ') || '—'}</div>
 <div>Hasta: <b>${b.patients}</b> · Ciro: <b>${fmt(b.revenue)}</b> · Şube hakedişi: <b class="chip ok">${fmt(b.hakedis)}</b></div></div>`).join('')
 + as.map(sa => `<div class="card"><h2>${esc(sa.name)} <span class="chip">${esc(sa.country)}</span></h2>
 <div class="mut">Komisyon %${sa.commission_pct} · ${sa.patients.length} hasta · hakediş <b>${fmt(sa.commission)}</b></div></div>`).join('');
}

// ---------- Akıllı otomatik veri bağlantısı (context-aware auto-fill) ----------
async function patientContext(pid) {
 const [dos, bks, quote] = await Promise.all([
 api('/api/patients/' + pid + '/dossier'),
 api('/api/bookings?patient_id=' + pid),
 api('/api/patients/' + pid + '/latest-quote')]);
 return { dos, bks, quote };
}
function attachNote(sel, msg) {
 let n = document.querySelector(sel + '-ctx');
 if (!n) { n = document.createElement('div'); n.id = sel.slice(1) + '-ctx'; n.className = 'mut'; n.style.cssText = 'font-size:11px;margin:4px 0 8px;color:var(--cyan)';
 document.querySelector(sel).insertAdjacentElement('afterend', n); }
 n.textContent = msg;
}
// RFQ ekranı: anamnez dosyaları + şikayet + pasaport otomatik bağlanır
const _aiChg = $('#ai-patient') && $('#ai-patient').onchange;
$('#ai-patient').onchange = async () => {
 const pid = $('#ai-patient').value; if (!pid) return;
 if (_aiChg) await _aiChg();
 const { dos } = await patientContext(pid);
 const files = dos.files ? dos.files.length : 0;
 attachNote('#ai-patient', ` Otomatik bağlandı: ${files} belge + anamnez özeti + pasaport (${dos.patient?.passport_no || '—'}) → RFQ eklerine eklenecek`);
};
// Fatura: onaylı RFQ fiyatı + tedavi detayı otomatik dolar
$('#inv-patient').onchange = async () => {
 const pid = $('#inv-patient').value; if (!pid) return;
 const { quote } = await patientContext(pid);
 if (quote.quote_price) {
 $('#inv-amount').value = quote.quote_price;
 $('#inv-desc').value = `${quote.specialty} — ${quote.doctor_name} paketi`;
 attachNote('#inv-patient', ` RFQ teklifi otomatik bağlandı: ${fmt(quote.quote_price)} · ${quote.specialty}`);
 } else attachNote('#inv-patient', 'ℹ Onaylı RFQ teklifi yok — manuel fiyat girin');
};
// Transfer: uçuş kodu, iniş saati, otel tarihleri takvime bağlanır
$('#tr-patient').onchange = async () => {
 const pid = $('#tr-patient').value; if (!pid) return;
 const { bks } = await patientContext(pid);
 const fl = bks.find(b => b.kind === 'flight'); const ho = bks.find(b => b.kind === 'hotel');
 const det = fl ? JSON.parse(fl.details || '{}') : {};
 attachNote('#tr-patient', ` ${fl ? `Uçuş ${fl.flight_no || det.flight_no || ''} · ${fl.flight_date || det.flight_date || ''}` : 'Uçuş yok'}${ho ? ' · Otel: ' + (ho.ref_label || '') : ''} — görev zinciri otomatik kurulacak`);
};
// Atama takvimi: uçuş tarihi ve görev adı otomatik dolar
const asP = $('#as-patient');
if (asP) asP.onchange = async () => {
 const pid = asP.value; if (!pid) return;
 const { bks } = await patientContext(pid);
 const fl = bks.find(b => b.kind === 'flight');
 const det = fl ? JSON.parse(fl.details || '{}') : {};
 if (fl && $('#as-date')) $('#as-date').value = fl.flight_date || det.flight_date || '';
 if ($('#as-task') && !$('#as-task').value) $('#as-task').value = fl ? `Havalimanı karşılama — ${fl.flight_no || det.flight_no || ''}` : 'VIP transfer';
};
// Sözleşme linki: yeni teklif ekranında hasta seçimi fiyatı bağlar (builder'da zaten pbRfqs var — ek: inv ucus)

// ---------- Hasta Odak Paneli sekmeleri ----------
let WS_PID = null;
$$('.wstab').forEach(b => b.onclick = () => {
 $$('.wstab').forEach(x => x.classList.toggle('on', x === b));
 const t = b.dataset.ws;
 ['timeline','medical','travel','finance'].forEach(k => $('#ws-' + k).classList.toggle('hidden', k !== t));
 if (WS_PID) loadWsPane(t, WS_PID);
});
async function loadWsPane(t, pid, cached) {
 const d = cached || await api('/api/patients/' + pid + '/dossier');
 const p = d.patient;
 if (t === 'timeline') {
 const [logs, calls] = await Promise.all([api('/api/audit?patient_id=' + pid), api('/api/calls?patient_id=' + pid)]);
 const ev = [
 ...d.rfqs.map(r => ({ ts: r.created_at, ico: '', txt: `<b>RFQ → ${esc(r.doctor_name)}</b> <span class="mut">${esc(r.specialty)}</span> <span class="tag ${r.status === 'responded' ? 'green' : r.status === 'declined' ? 'red' : 'yellow'}">${r.status}${r.quote_price ? ' · ' + fmt(r.quote_price) : ''}</span>` })),
 ...d.offers.map(o => ({ ts: o.created_at, ico: '', txt: `<b>Teklif #${o.id}</b> ${fmt(o.total)} <span class="tag ${{ draft: 'yellow', sent: 'blue', approved: 'violet', paid: 'green' }[o.status] || 'yellow'}">${o.status}</span>` })),
 ...d.bookings.map(b => ({ ts: b.created_at, ico: { hotel: '', flight: '✈', transfer: '', insurance: ' ' }[b.kind] || '', txt: `<b>${esc(b.ref_label || b.kind)}</b> <span class="mut">${fmt(b.price)}</span>` })),
 ...calls.map(c => ({ ts: c.created_at, ico: c.type === 'video' ? ' ' : c.type === 'callback' ? '⏰' : ' ', txt: `<b>${c.type === 'video' ? 'Görüntülü görüşme' : c.type === 'callback' ? 'Geri arama' : 'Çağrı'}</b> ${esc(c.note || '')} <span class="mut">${esc(c.created_by)}</span>` })),
 ...logs.map(l => ({ ts: l.ts, ico: ' ', txt: `<b>${esc(l.user_label || l.role)}</b> — ${esc(l.action)}` })),
 ].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
 $('#ws-timeline').innerHTML = `<div class="card"><h3> Zaman Çizelgesi</h3>
 ${ev.map(e => `<div class="tl-row"><span class="tl-ico">${e.ico}</span><div class="tl-body"><div class="tl-txt">${e.txt}</div><div class="tl-ts mut">${esc(e.ts || '')}</div></div></div>`).join('') || '<div class="mut">Henüz aktivite yok</div>'}</div>`;
 } else if (t === 'medical') {
 const pacs = d.files.filter(f => f.category === 'radiology');
 const docs = d.files.filter(f => f.category !== 'radiology');
 $('#ws-medical').innerHTML = `<div class="card"><h3> Medikal & PACS</h3>
 ${d.anamnesis && d.anamnesis.length ? d.anamnesis.map(a => a.status === 'submitted'
 ? `<div class="scard ok" style="margin-bottom:8px"><div class="sc-l">Anamnez — ${esc(a.specialty || 'Genel')}</div><div class="mut">${esc(a.submitted_at || '')}</div>${Object.entries(JSON.parse(a.answers || '{}')).slice(0, 8).map(([k, v]) => `<div style="font-size:12px"><b>${esc(k)}:</b> ${esc(v)}</div>`).join('')}</div>`
 : `<div class="scard warn" style="margin-bottom:8px"><div class="sc-l">Anamnez bekliyor</div><a href="/a/${a.token}" target="_blank">/a/${a.token}</a></div>`).join('') : '<div class="mut">Anamnez kaydı yok</div>'}
 <h3 style="margin:14px 0 6px"> PACS / Radyoloji</h3>
 ${pacs.map(f => `<div class="checkline done"><span class="tick"> </span>${esc(f.filename)} <span class="mut">${esc(f.uploaded_at || '')}</span>${f.path ? ` <a href="${f.path}" target="_blank">görüntüle</a>` : ''}</div>`).join('') || '<div class="mut">Röntgen/görüntü yok</div>'}
 <h3 style="margin:14px 0 6px"> Hekim Değerlendirmeleri</h3>
 ${d.rfqs.map(r => `<div class="checkline ${r.status === 'responded' ? 'done' : ''}"><span class="tick">${r.status === 'responded' ? '✓' : '◌'}</span>
 <b>${esc(r.doctor_name)}</b> · ${esc(r.specialty)} <span class="mut">${esc(r.hospital)}</span>
 ${r.quote_price ? `<span class="tag green">${fmt(r.quote_price)}</span>` : ''}</div>`).join('') || '<div class="mut">RFQ yok</div>'}
 <h3 style="margin:14px 0 6px"> Diğer Evraklar</h3>
 ${docs.map(f => `<div class="checkline done"><span class="tick"></span>${esc(f.filename)} <span class="mut">${esc(f.category)}</span>${f.path ? ` <a href="${f.path}" target="_blank">indir</a>` : ''}</div>`).join('') || '<div class="mut">Dosya yok</div>'}
 <form onsubmit="return uploadFile(${p.id},this)" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
 <input type="file" name="file" class="input" style="flex:2;margin:0">
 <select name="category" class="input" style="flex:1;margin:0"><option value="radiology">Röntgen/PACS</option><option value="passport">Pasaport</option><option value="boarding_pass">Boarding Pass</option><option value="invoice">Fatura</option><option value="contract">Sözleşme</option><option value="other">Diğer</option></select>
 <button class="btn ghost mini" type="submit">Yükle</button></form></div>`;
 } else if (t === 'travel') {
 const flights = d.bookings.filter(b => b.kind === 'flight'), hotels = d.bookings.filter(b => b.kind === 'hotel'),
 transfers = d.bookings.filter(b => b.kind === 'transfer'), ins = d.bookings.filter(b => b.kind === 'insurance');
 $('#ws-travel').innerHTML = `<div class="card"><h3>✈ Seyahat & Lojistik</h3>
 ${d.visa_rule ? `<div class="scard ${d.visa_rule.rule && d.visa_rule.rule.includes('vizesiz') ? 'ok' : 'warn'}" style="margin-bottom:10px"><div class="sc-l">Vize Durumu</div><div class="sc-v">${esc(d.visa_rule.rule)}</div><div class="mut">${esc(p.nationality)}</div></div>` : `<div class="scard warn" style="margin-bottom:10px"><div class="sc-l">Vize Durumu</div><div class="sc-v">Kural tanımsız</div></div>`}
 <div class="scard-row">
 <div class="scard ${flights.length ? 'ok' : ''}"><div class="sc-l">Uçuş</div>${flights.map(b => `<div class="sc-v">✈ ${esc(b.ref_label || '')}</div><div class="mut">${esc(b.flight_status || 'Scheduled')}</div>`).join('') || '<div class="mut">Kayıt yok</div>'}</div>
 <div class="scard ${hotels.length ? 'ok' : ''}"><div class="sc-l">Otel</div>${hotels.map(b => `<div class="sc-v"> ${esc(b.ref_label || '')}</div><div class="mut">${fmt(b.price)}</div>`).join('') || '<div class="mut">Kayıt yok</div>'}</div>
 <div class="scard ${transfers.length || d.driver_tasks.length ? 'ok' : ''}"><div class="sc-l">VIP Transfer</div>${d.driver_tasks.map(t => `<div class="sc-v"> ${esc(t.label)}</div><div class="mut">${esc(t.agent_name || '')} · ${t.status === 'done' ? '✓ tamam' : t.status === 'in_progress' ? 'yolda' : 'bekliyor'}</div>`).join('') || '<div class="mut">Görev yok</div>'}</div>
 <div class="scard ${ins.length ? 'ok' : ''}"><div class="sc-l">Sigorta</div>${ins.map(b => `<div class="sc-v"> ${esc(b.ref_label || '')}</div><div class="mut">${fmt(b.price)}</div>`).join('') || '<div class="mut">Poliçe yok</div>'}</div>
 </div>
 <div class="ws-actions" style="margin-top:10px">
 <button class="btn ghost mini" onclick="qa('flights','#bk-patient',${p.id})">+ Uçuş</button>
 <button class="btn ghost mini" onclick="qa('hotels','#hotel-patient',${p.id})">+ Otel</button>
 <button class="btn ghost mini" onclick="qa('transfer','#tr-patient',${p.id})">+ VIP Transfer</button>
 <button class="btn ghost mini" onclick="qa('flights','#ins-patient',${p.id})">+ Poliçe</button>
 <button class="btn ghost mini" onclick="visaLetter(${p.id})">Medikal Davetiye</button>
 <button class="btn ghost mini" onclick="patientPass(${p.id})"> Takip Linki</button></div></div>`;
 } else if (t === 'finance') {
 const cari = await api('/api/patients/' + pid + '/cari');
 $('#ws-finance').innerHTML = `<div class="card"><h3> Finans & İmzalar</h3>
 <div class="scard-row">
 <div class="scard ${cari.balance >= 0 ? 'ok' : 'bad'}"><div class="sc-l">Hasta Carisi</div><div class="sc-v">${fmt(cari.balance)}</div></div>
 <div class="scard ${d.offers.some(o => o.status === 'paid') ? 'ok' : d.offers.length ? 'warn' : ''}"><div class="sc-l">Teklif/Sözleşme</div>${d.offers.slice(0, 3).map(o => `<div class="sc-v">#${o.id} · ${fmt(o.total)} <span class="tag ${{ draft: 'yellow', sent: 'blue', approved: 'violet', paid: 'green' }[o.status] || 'yellow'}">${o.status}</span></div>`).join('') || '<div class="mut">Yok</div>'}</div>
 <div class="scard ${d.invoices.some(i => i.status === 'sent_ivd') ? 'ok' : 'warn'}"><div class="sc-l">e-Fatura / İVD</div>${d.invoices.map(i => `<div class="sc-v">${i.number} · ${fmt(i.amount)}</div><div class="mut">${i.status === 'sent_ivd' ? 'İVD ✓' : esc(i.status)}</div>`).join('') || '<div class="mut">Fatura yok</div>'}</div>
 </div>
 <h3 style="margin:14px 0 6px">İmza & Onam Belgeleri</h3>
 ${d.files.filter(f => ['contract', 'passport'].includes(f.category) || f.filename.match(/KVKK|Onay|Sozlesme|sign/i)).map(f => `<div class="checkline done"><span class="tick">✍</span>${esc(f.filename)} <span class="mut">${esc(f.category)}</span></div>`).join('') || '<div class="mut">İmzalı belge yok</div>'}
 <h3 style="margin:14px 0 6px">İşlem Geçmişi (Cari)</h3>
 ${d.transactions.slice(0, 10).map(t => `<div class="checkline"><span class="tick">${t.kind === 'income' ? '➕' : '➖'}</span>${esc(t.description || t.category)} <b>${fmt(t.amount)}</b> <span class="mut">${esc(t.created_at || '')}</span></div>`).join('') || '<div class="mut">Hareket yok</div>'}
 <div class="ws-actions" style="margin-top:10px">
 <button class="btn ghost mini" onclick="closeWs();goTab('builder')"> Paket & Teklif</button>
 <button class="btn ghost mini" onclick="createContract(${p.id})">Sözleşme & Kapora</button>
 <button class="btn ghost mini" onclick="closeWs();goTab('fatura')"> e-Fatura</button>
 <a class="btn ghost mini" href="/api/incentive/export/${p.id}" target="_blank"> DYS ZIP</a>
 <button class="btn ghost mini" onclick="closeWs();goTab('usha')"> USHAŞ</button></div></div>`;
 }
}
window.startCall = async (pid, type) => {
 const note = type === 'video' ? 'Şifreli tele-sağlık konsültasyonu' : type === 'callback' ? 'Geri arama planlandı' : prompt('Çağrı notu (opsiyonel):', 'Hasta bilgilendirme') || 'Çağrı';
 const cb = type === 'callback' ? prompt('Geri arama zamanı (YYYY-MM-DD HH:mm):', '2026-11-05 10:00') : null;
 const r = await api('/api/calls', 'POST', { patient_id: pid, type, note, callback_at: cb });
 if (r.room) { window.open(r.room, '_blank'); toast(' Görüntülü görüşme odası açıldı'); }
 else toast(type === 'callback' ? '⏰ Geri arama alarmı kuruldu' : ' Çağrı kaydedildi');
 if (WS_PID) loadWsPane('iletisim', pid);
};
// drawer açılırken pid'yi sakla
const _openDrawer = window.openDrawer;

// ---------- HSYS + Audit Log + Takvim ----------
async function loadHsys() {
 const rows = await api('/api/hsys/report');
 $('#hsys-list').innerHTML = `<table class="tbl"><thead><tr><th>Hasta</th><th>Pasaport</th><th>Ülke</th><th>Tedavi</th><th>Aşama</th><th>KVKK</th><th>e-Fatura</th></tr></thead><tbody>
 ${rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.passport_no || '—')}</td><td>${esc(r.nationality)}</td>
 <td class="mut">${esc((r.complaint || '').slice(0, 40))}</td><td>${esc(r.lead_status)}</td>
 <td>${r.kvkk_count ? '<span class="chip ok">Onamlı ✓</span>' : '<span class="chip bad">Eksik</span>'}</td>
 <td class="mut">${esc(r.last_invoice || '—')}</td></tr>`).join('')}</tbody></table>`;
}
async function loadAuditLog() {
 const logs = await api('/api/audit');
 $('#audit-list').innerHTML = logs.map(l => `<div class="checkline"><span class="tick">·</span>
 <span class="mut">[${esc(l.ts)}]</span> <b>${esc(l.user_label || l.role)}</b>
 ${l.patient_name ? '· ' + esc(l.patient_name) : ''} — ${esc(l.action)}
 ${l.detail ? `<div class="mut" style="font-size:11px">${esc(l.detail.slice(0, 140))}</div>` : ''}</div>`).join('')
 || '<div class="mut">Henüz kayıt yok — mutasyonlar otomatik loglanacak</div>';
}
async function loadOpcal() {
 const { ops, postops } = await api('/api/calendar/ops');
 $('#oc-list').innerHTML = ops.map(o => `<div class="li"><span><b>${esc(o.label)}</b><div class="mut"><span class="plink" data-pid="${o.patient_id}">${esc(o.patient_name)}</span> · ${esc(o.room)} · ${esc(o.scheduled_at)}</div></span>
 <span class="tag ${o.status === 'scheduled' ? 'blue' : 'green'}">${esc(o.status)}</span></div>`).join('') || '<div class="mut">Planlanmış operasyon yok</div>';
 $('#oc-postop').innerHTML = postops.map(p => `<div class="li li-col"><b>${esc(p.name)}</b>
 ${p.checkpoints.map(c => `<div class="checkline ${c.done ? 'done' : 'miss'}"><span class="tick">${c.done ? '✓' : '◌'}</span>
 ${c.day}. gün kontrol — ${c.date} ${c.done ? '' : '<span class="chip warn">yaklaşıyor</span>'}</div>`).join('')}</div>`).join('')
 || '<div class="mut">Post-op hasta yok</div>';
}
$('#oc-create').onclick = async () => {
 const pid = +$('#oc-patient').value;
 if (!pid || !$('#oc-date').value) return toast('Hasta ve tarih seçin');
 await api('/api/calendar/ops', 'POST', { patient_id: pid, label: $('#oc-label').value || 'Operasyon',
 scheduled_at: $('#oc-date').value, room: $('#oc-room').value });
 toast(' Operasyon planlandı'); loadOpcal();
};

// ---------- Executive Dashboard ----------
async function loadExecutive() {
 const d = await api('/api/executive');
 if (!d || !$('#exec-body')) return;
 const maxWon = Math.max(1, ...d.reps.map(r => r.won));
 $('#exec-body').innerHTML = `<div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">
 <div class="kpi"><div class="v">${fmt(d.revenue)}</div><div class="l">Canlı Ciro</div></div>
 <div class="kpi"><div class="v">${fmt(d.receivables)}</div><div class="l">Açık Alacak</div></div>
 <div class="kpi"><div class="v">%${d.rfq_accept_pct}</div><div class="l">RFQ Kabul Oranı (${d.rfq_answered}/${d.rfq_total})</div></div>
 <div class="kpi"><div class="v">€${d.incentive_receivable.toLocaleString('tr')}</div><div class="l">Beklenen DYS Teşvik Alacağı</div></div></div>
 <div class="mut" style="margin-bottom:6px">Temsilci Dönüşüm Performansı</div>
 ${d.reps.map(r => `<div class="funnel-row"><div style="width:110px">${esc(r.name)}</div><div class="funnel-bar" style="width:${r.won / maxWon * 100}%">${r.won}/${r.assigned} kazanılan</div></div>`).join('')}`;
}
// ---------- AI Translate + Night Agent + Push ----------
window.aiTranslate = async (pid) => {
 const lang = prompt('Hedef dil (en/de/fr/ar/ru):', 'en') || 'en';
 const text = prompt('Çevrilecek mesaj/teklif metni:', 'Sayın hastamız, teklifiniz hazırdır. Detaylar ektedir.') || '';
 const d = (await api('/api/ai/translate', 'POST', { text, direction: 'out', lang }));
 toast(' ' + (d.translated || 'çeviri yok'));
};
window.translateIn = async (el, pid) => {
 const raw = el.dataset.body || '';
 const lang = el.dataset.lang || 'en';
 const d = (await api('/api/ai/translate', 'POST', { text: raw, direction: 'in', lang }));
 el.insertAdjacentHTML('afterend', `<div class="mut" style="font-size:11px;margin:2px 0 8px">${esc(d.translated)}</div>`);
};
window.nightAgent = async (pid) => {
 const r = await api('/api/night-agent', 'POST', { patient_id: pid });
 if (r.ok) toast(' AI gece asistanı hastayı karşıladı — sabah 09:00 vakası hazır');
};
window.sendPush = async (pid) => {
 const body = prompt('Push bildirim metni:', 'Transfer aracınız kapıda — lütfen lobide hazır olun.') || 'Transfer aracınız kapıda';
 await api('/api/pass/push', 'POST', { patient_id: pid, body });
 toast(' Push bildirim hastanın takip kartına düştü (/p linki)');
};
