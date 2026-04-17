const addressEl = document.getElementById('address');
const radiusEl = document.getElementById('radius');
const enrichmentModeEl = document.getElementById('enrichmentMode');
const aggressivenessEl = document.getElementById('aggressiveness');
const aiProviderEl = document.getElementById('aiProvider');
const apiKeyEl = document.getElementById('apiKey');
const statusEl = document.getElementById('status');
const reportEl = document.getElementById('report');
const generateBtn = document.getElementById('generate');
const saveMdBtn = document.getElementById('saveMd');
const savePdfBtn = document.getElementById('savePdf');

let latestReport = '';

function setStatus(msg) {
  statusEl.textContent = msg;
}

generateBtn.addEventListener('click', async () => {
  const address = addressEl.value.trim();
  const radiusMiles = Number(radiusEl.value || 10);
  const enrichmentMode = enrichmentModeEl.value;
  const aggressiveness = aggressivenessEl.value;
  const aiProvider = aiProviderEl.value;
  const apiKey = apiKeyEl.value.trim();

  if (!address) {
    setStatus('Please enter an address (including city/state).');
    return;
  }

  generateBtn.disabled = true;
  saveMdBtn.disabled = true;
  savePdfBtn.disabled = true;

  try {
    const usingEnrichment = enrichmentMode === 'enrich' && Boolean(apiKey);
    setStatus(usingEnrichment
      ? `Generating + AI enrichment (${aggressiveness}) in progress...`
      : 'Generating report from public sources...');

    const data = await window.areaforge.generateReport({
      address,
      radiusMiles,
      enrichmentMode,
      aggressiveness,
      aiProvider,
      apiKey
    });

    latestReport = data.reportMarkdown;
    reportEl.value = latestReport;

    const enrichmentNote = data.metadata.enrichedBy
      ? ` | Enriched: ${data.metadata.enrichedBy}`
      : (data.metadata.enrichmentError ? ' | Enrichment failed (used base report)' : '');

    setStatus(`Done. ${data.metadata.resolvedAddress} | POIs: ${data.metadata.poiCount} | Flood zone: ${data.metadata.flood.fldZone}${enrichmentNote}`);
    saveMdBtn.disabled = false;
    savePdfBtn.disabled = false;
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    generateBtn.disabled = false;
  }
});

saveMdBtn.addEventListener('click', async () => {
  if (!latestReport) return;
  const out = await window.areaforge.saveMarkdown(latestReport);
  if (!out.canceled) setStatus(`Saved markdown: ${out.filePath}`);
});

savePdfBtn.addEventListener('click', async () => {
  const out = await window.areaforge.savePdf();
  if (!out.canceled) setStatus(`Saved PDF: ${out.filePath}`);
});
