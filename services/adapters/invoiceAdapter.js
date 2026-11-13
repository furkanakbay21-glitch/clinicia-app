// invoiceAdapter — Paraşüt / Sovos Foriba (%0 KDV 351 istisna kodlu e-Fatura)
const { env, http, adapter } = require('./base');
module.exports = adapter('invoice', ['PARASUT_CLIENT_ID', 'SOVOS_API_KEY'], {
  async issue351(invoice, patient) {
    if (env('SOVOS_API_KEY')) {
      return { ettn: 'SOVOS-' + invoice.id, status: 'queued', provider: 'sovos', exemption_code: '351' };
    }
    return { ettn: 'HTA-' + invoice.id + '-' + Date.now(), status: 'issued', provider: 'mock', exemption_code: '351', kdv_rate: 0 };
  },
  async webhook(payload, ctx) {
    // Paraşüt/Sovos gönderi durum webhooku: {invoice_no, status}
    if (ctx && ctx.run && payload.invoice_no) {
      ctx.run("UPDATE invoices SET status=? WHERE number=?", payload.status || 'sent_ivd', payload.invoice_no);
    }
    return { ok: true };
  },
});
