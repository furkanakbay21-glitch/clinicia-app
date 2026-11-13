// ocrAdapter — Google Cloud Vision / AWS Textract (pasaport MRZ + epikriz OCR)
const { env, http, adapter } = require('./base');
module.exports = adapter('ocr', ['GOOGLE_VISION_API_KEY', 'AWS_ACCESS_KEY_ID'], {
  async readDocument(filePath, hint = 'passport') {
    if (env('GOOGLE_VISION_API_KEY')) {
      const fs = require('fs');
      const b64 = fs.readFileSync(filePath).toString('base64');
      const r = await http(`https://vision.googleapis.com/v1/images:annotate?key=${env('GOOGLE_VISION_API_KEY')}`, {
        method: 'POST',
        body: { requests: [{ image: { content: b64 }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }] },
      });
      const text = r.responses && r.responses[0] && r.responses[0].fullTextAnnotation && r.responses[0].fullTextAnnotation.text;
      return { text, provider: 'gvision', mrz: parseMrz(text || '') };
    }
    // AWS Textract wiring goes through aws4-signed calls; mock until creds are set
    return { text: null, provider: 'mock', mrz: parseMrz('') };
  },
});
function parseMrz(t) {
  const lines = t.split('\n').map(l => l.replace(/\s/g, '')).filter(l => l.length >= 30 && l.includes('<'));
  if (!lines.length) return null;
  const l1 = lines[0];
  return { doc_type: l1.slice(0, 2).replace(/</g, ''), issuer: l1.slice(2, 5), name: l1.slice(5).split('<<').join(' ').replace(/</g, '').trim(), raw: lines };
}
