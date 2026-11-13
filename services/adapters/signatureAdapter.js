// signatureAdapter — DocuSign / Dropbox Sign (onam & KVKK/GDPR e-imza)
const { env, http, adapter } = require('./base');
module.exports = adapter('signature', ['DOCUSIGN_ACCESS_TOKEN', 'DROPBOX_SIGN_API_KEY'], {
  async sendForSignature(patient, docType = 'kvkk_onam', docPath = null) {
    if (env('DOCUSIGN_ACCESS_TOKEN') && env('DOCUSIGN_ACCOUNT_ID')) {
      const r = await http(`https://demo.docusign.net/restapi/v2.1/accounts/${env('DOCUSIGN_ACCOUNT_ID')}/envelopes`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + env('DOCUSIGN_ACCESS_TOKEN') },
        body: { emailSubject: `Clinicia ${docType} — ${patient.name}`, status: 'sent', recipients: { signers: [{ email: patient.email || 'patient@example.com', name: patient.name, recipientId: '1' }] } },
      });
      return { envelope_id: r.envelopeId, provider: 'docusign', status: r.status };
    }
    return { envelope_id: 'mock-env-' + Date.now(), provider: 'mock', sign_url: `/sign/mock/${patient.id}/${docType}`, status: 'sent' };
  },
});
