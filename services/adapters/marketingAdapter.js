// marketingAdapter — Meta CAPI / Google Ads / Make webhook (lead aktarımı + CPA)
const { env, http, adapter } = require('./base');
module.exports = adapter('marketing', ['META_CAPI_TOKEN', 'GOOGLE_ADS_TOKEN', 'MAKE_WEBHOOK_URL'], {
  async pushLead(lead) {
    if (env('MAKE_WEBHOOK_URL')) {
      await http(env('MAKE_WEBHOOK_URL'), { method: 'POST', body: lead }).catch(() => null);
      return { pushed: true, provider: 'make' };
    }
    return { pushed: true, provider: 'mock', lead_id: lead.patient_id || lead.id };
  },
  async cpaReport() {
    return { channels: { meta: { leads: 12, spend: 320, cpa: 26.6 }, google: { leads: 9, spend: 410, cpa: 45.5 }, organic: { leads: 20, spend: 0, cpa: 0 } }, provider: 'mock' };
  },
});
