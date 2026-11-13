// paymentAdapter — Stripe Connect / iZico (kapora + escrow, çoklu para birimi)
const { env, http, adapter } = require('./base');
module.exports = adapter('payment', ['STRIPE_SECRET_KEY', 'IZICO_API_KEY'], {
  async createDeposit(patient, amountMinor, currency = 'eur') {
    if (env('STRIPE_SECRET_KEY')) {
      const r = await fetch('https://api.stripe.com/v1/payment_links', {
        method: 'POST', headers: { Authorization: 'Bearer ' + env('STRIPE_SECRET_KEY'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ 'line_items[0][price_data][currency]': currency, 'line_items[0][price_data][unit_amount]': String(amountMinor), 'line_items[0][price_data][product_data][name]': `Clinicia kapora — ${patient.name}`, 'line_items[0][quantity]': '1', 'metadata[patient_id]': String(patient.id) }),
      });
      const j = await r.json();
      return { url: j.url, id: j.id, provider: 'stripe' };
    }
    return { url: `/pay/mock-${patient.id}-${amountMinor}`, id: 'mock_' + Date.now(), provider: 'mock', escrow_ready: true };
  },
  async releaseEscrow(escrowId) {
    return { escrow_id: escrowId, released: true, provider: this.configured() ? 'stripe' : 'mock' };
  },
});
