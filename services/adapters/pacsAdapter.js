// pacsAdapter — Orthanc PACS / Ambra Health (web DICOM viewer)
const { env, http, adapter } = require('./base');
module.exports = adapter('pacs', ['ORTHANC_URL', 'AMBRA_API_KEY'], {
  async viewerUrl(file) {
    if (env('ORTHANC_URL')) {
      const base = env('ORTHANC_URL').replace(/\/$/, '');
      return { url: `${base}/app/explorer.html#study?uuid=${file.id}`, provider: 'orthanc', dicom: true };
    }
    return { url: file.path || ('/pacs/mock/' + file.id), provider: 'mock', dicom: /\.dcm$/i.test(file.filename || '') };
  },
  async listStudies(patient) {
    return { patient_id: patient.id, studies: [], provider: this.configured() ? 'orthanc' : 'mock' };
  },
});
