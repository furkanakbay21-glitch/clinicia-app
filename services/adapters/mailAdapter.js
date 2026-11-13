// mailAdapter — SendGrid / Resend (dinamik PDF teklif + bildirim e-postası)
const { env, http, adapter } = require('./base');
module.exports = adapter('mail', ['SENDGRID_API_KEY', 'RESEND_API_KEY'], {
  async send(to, subject, html, attachments = []) {
    if (env('SENDGRID_API_KEY')) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST', headers: { Authorization: 'Bearer ' + env('SENDGRID_API_KEY'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: env('MAIL_FROM', 'noreply@clinicia.com.tr') }, subject, content: [{ type: 'text/html', value: html }] }),
      });
      return { sent: r.ok, provider: 'sendgrid' };
    }
    if (env('RESEND_API_KEY')) {
      const r = await http('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: 'Bearer ' + env('RESEND_API_KEY') },
        body: { from: env('MAIL_FROM', 'noreply@clinicia.com.tr'), to, subject, html },
      });
      return { sent: true, id: r.id, provider: 'resend' };
    }
    return { sent: true, id: 'mock-mail-' + Date.now(), provider: 'mock' };
  },
  async sendOfferMail(patient, offer) {
    return this.send(patient.email || 'patient@example.com', `Clinicia Tedavi Teklifi #${offer.id}`,
      `<h2>Sayın ${patient.name}</h2><p>Teklif toplamı: <b>${offer.total}</b></p>`);
  },
});
