const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, 'template.md');
const FOCUS_REGIONS_PATH = path.join(__dirname, 'focus-regions.json');

async function jget(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function postJson(url, payload, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} for ${url}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
  return res.json();
}

function ratio(n, d) {
  const nn = Number(n), dd = Number(d);
  if (!dd) return 'Unknown';
  return `${((nn / dd) * 100).toFixed(1)}%`;
}

function pickTop(poi, kinds, n = 8) {
  return poi.filter(p => kinds.includes(p.kind)).slice(0, n).map(p => `${p.name} (${p.kind})`).join('; ') || 'No matching POIs captured';
}

function fillTemplate(template, answers) {
  return template.split(/\r?\n/).map((line) => {
    if (!line.trim().startsWith('*')) return line;
    const key = line.trim().replace(/^\*\s*/, '').toLowerCase();
    const answer = answers[key] || 'Data not yet available automatically; verify manually.';
    return `${line}\n  - Answer: ${answer}`;
  }).join('\n');
}

function loadFocusRegions() {
  const raw = fs.readFileSync(FOCUS_REGIONS_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  return cfg?.states || [];
}

function normalizeCountyName(name = '') {
  return name.toLowerCase().replace(/\s+county$/i, '').trim();
}

function buildPreferredQueries(address, focusStates) {
  const base = [address];
  for (const state of focusStates) {
    base.push(`${address}, ${state.name}`);
    for (const abbr of state.abbreviations || []) {
      base.push(`${address}, ${abbr}`);
    }
  }
  return [...new Set(base)];
}

function isPreferredResult(result, focusStates) {
  const stateName = (result?.address?.state || '').toLowerCase();
  const countyName = normalizeCountyName(result?.address?.county || '');

  for (const state of focusStates) {
    const stateMatch = stateName.includes((state.name || '').toLowerCase()) ||
      (state.abbreviations || []).some((abbr) => stateName.includes(String(abbr).toLowerCase()));
    if (!stateMatch) continue;

    const counties = (state.counties || []).map(normalizeCountyName).filter(Boolean);
    if (!counties.length) return true;
    if (counties.includes(countyName)) return true;
  }

  return false;
}

async function geocodeAddress(address) {
  const focusStates = loadFocusRegions();
  const queries = buildPreferredQueries(address, focusStates);
  let fallback = null;

  for (const query of queries) {
    const q = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      addressdetails: '1',
      limit: '1',
      countrycodes: 'us'
    });
    const data = await jget(`https://nominatim.openstreetmap.org/search?${q}`, {
      'User-Agent': 'AreaForge/1.0'
    });
    if (data?.length) {
      const top = data[0];
      if (isPreferredResult(top, focusStates)) return top;
      if (!fallback) fallback = top;
    }
  }

  if (fallback) return fallback;
  throw new Error('Address not found');
}

async function censusGeographies(lon, lat) {
  const q = new URLSearchParams({
    x: lon,
    y: lat,
    benchmark: 'Public_AR_Current',
    vintage: 'Current_Current',
    format: 'json'
  });
  const data = await jget(`https://geocoding.geo.census.gov/geocoder/geographies/coordinates?${q}`);
  const geos = data?.result?.geographies || {};
  const county = (geos['Counties'] || [])[0] || null;
  const place = (geos['Incorporated Places'] || [])[0] || null;
  return {
    county,
    place,
    stateFips: county?.STATE || place?.STATE || null,
    countyFips: county?.COUNTY || null,
    placeFips: place?.PLACE || null
  };
}

async function acsSnapshot(stateFips, countyFips, placeFips) {
  const vars = [
    'NAME', 'B01003_001E', 'B01002_001E', 'B19013_001E',
    'B17001_002E', 'B17001_001E', 'B25003_001E', 'B25003_002E', 'B25003_003E'
  ].join(',');

  const out = {};
  if (stateFips && countyFips) {
    const c = await jget(`https://api.census.gov/data/2023/acs/acs5?get=${vars}&for=county:${countyFips}&in=state:${stateFips}`);
    out.county = Object.fromEntries(c[0].map((k, i) => [k, c[1][i]]));
  }
  if (stateFips && placeFips) {
    const p = await jget(`https://api.census.gov/data/2023/acs/acs5?get=${vars}&for=place:${placeFips}&in=state:${stateFips}`);
    out.place = Object.fromEntries(p[0].map((k, i) => [k, p[1][i]]));
  }
  return out;
}

async function floodZone(lon, lat) {
  const q = new URLSearchParams({
    f: 'json', geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', sr: '4326',
    layers: 'all:28', tolerance: '3',
    mapExtent: `${Number(lon)-0.01},${Number(lat)-0.01},${Number(lon)+0.01},${Number(lat)+0.01}`,
    imageDisplay: '800,600,96', returnGeometry: 'false'
  });
  const data = await jget(`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/identify?${q}`);
  const hit = (data.results || [])[0]?.attributes || {};
  return { fldZone: hit.FLD_ZONE || 'Unknown', sfha: hit.SFHA_TF || 'Unknown' };
}

async function overpassPOI(lat, lon, radiusM = 16093) {
  const q = `[out:json][timeout:90];(\nnode(around:${radiusM},${lat},${lon})[shop~"supermarket|convenience|hardware|farm|doityourself"];\nnode(around:${radiusM},${lat},${lon})[amenity~"fuel|pharmacy|hospital|clinic|fire_station|police|post_office|community_centre|library|place_of_worship"];\nway(around:${radiusM},${lat},${lon})[shop~"supermarket|convenience|hardware|farm|doityourself"];\nway(around:${radiusM},${lat},${lon})[amenity~"fuel|pharmacy|hospital|clinic|fire_station|police|post_office|community_centre|library|place_of_worship"];\n);out center tags;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'User-Agent': 'AreaForge/1.0' },
    body: q
  });
  if (!res.ok) throw new Error(`Overpass error ${res.status}`);
  const data = await res.json();
  return (data.elements || []).map((e) => ({
    name: e.tags?.name || e.tags?.brand || 'Unnamed',
    kind: e.tags?.shop || e.tags?.amenity || 'other',
    lat: e.lat ?? e.center?.lat,
    lon: e.lon ?? e.center?.lon
  })).filter((x) => x.lat && x.lon);
}

function getEnrichmentSettings(level = 'balanced') {
  const key = String(level || 'balanced').toLowerCase();
  if (key === 'conservative') {
    return { temperature: 0.1, style: 'Make minimal edits, only replacing clearly weak placeholders.' };
  }
  if (key === 'maximal') {
    return { temperature: 0.4, style: 'Aggressively improve weak sections while preserving structure and factual caveats.' };
  }
  return { temperature: 0.2, style: 'Improve weak placeholders with concise factual guidance.' };
}

async function enrichWithOpenAI(markdown, context, openaiKey, aggressiveness) {
  const settings = getEnrichmentSettings(aggressiveness);
  const prompt = [
    'You are enriching an Area Study markdown document.',
    'Keep the same section and bullet structure.',
    'Only improve lines where the answer is generic, placeholder, or missing.',
    settings.style,
    'Use concise, non-speculative wording and include caveats where data is uncertain.',
    'Focus on Washington and Oregon context when relevant.',
    'Return ONLY the full updated markdown text with no code fences or commentary.',
    '',
    'Context JSON:',
    JSON.stringify(context)
  ].join('\n');

  const data = await postJson('https://api.openai.com/v1/responses', {
    model: 'gpt-4.1-mini',
    input: [
      { role: 'system', content: [{ type: 'input_text', text: prompt }] },
      { role: 'user', content: [{ type: 'input_text', text: markdown }] }
    ],
    temperature: settings.temperature
  }, { Authorization: `Bearer ${openaiKey}` });

  const enriched = data?.output_text?.trim();
  if (!enriched) throw new Error('OpenAI enrichment returned empty output');
  return enriched;
}

async function enrichWithClaude(markdown, context, claudeKey, aggressiveness) {
  const settings = getEnrichmentSettings(aggressiveness);
  const system = [
    'You are enriching an Area Study markdown document.',
    'Preserve sections and bullet structure.',
    'Only improve weak placeholder answers; keep strong factual answers intact.',
    settings.style,
    'Use concise, non-speculative language and caveats when needed.',
    'Prefer Washington/Oregon context when relevant.',
    'Return only the full markdown document.'
  ].join(' ');

  const data = await postJson('https://api.anthropic.com/v1/messages', {
    model: 'claude-3-5-sonnet-latest',
    max_tokens: 4000,
    temperature: settings.temperature,
    system,
    messages: [
      {
        role: 'user',
        content: `Context JSON:\n${JSON.stringify(context)}\n\nMarkdown to enrich:\n${markdown}`
      }
    ]
  }, {
    'x-api-key': claudeKey,
    'anthropic-version': '2023-06-01'
  });

  const enriched = (data?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  if (!enriched) throw new Error('Claude enrichment returned empty output');
  return enriched;
}

async function maybeEnrichReport(markdown, metadata, options = {}) {
  const enrichmentMode = String(options.enrichmentMode || 'public').toLowerCase();
  const aggressiveness = String(options.aggressiveness || 'balanced').toLowerCase();
  const openaiKey = (options.openaiKey || '').trim();
  const claudeKey = (options.claudeKey || '').trim();

  if (enrichmentMode !== 'enrich') {
    return { reportMarkdown: markdown, enrichedBy: null, enrichmentError: null };
  }

  if (!openaiKey && !claudeKey) {
    return { reportMarkdown: markdown, enrichedBy: null, enrichmentError: 'Enrichment mode enabled but no API key provided.' };
  }

  const context = {
    resolvedAddress: metadata?.resolvedAddress,
    coordinates: { lat: metadata?.lat, lon: metadata?.lon },
    poiCount: metadata?.poiCount,
    flood: metadata?.flood,
    generatedAt: new Date().toISOString()
  };

  try {
    if (claudeKey) {
      const reportMarkdown = await enrichWithClaude(markdown, context, claudeKey, aggressiveness);
      return { reportMarkdown, enrichedBy: `claude (${aggressiveness})`, enrichmentError: null };
    }
    const reportMarkdown = await enrichWithOpenAI(markdown, context, openaiKey, aggressiveness);
    return { reportMarkdown, enrichedBy: `openai (${aggressiveness})`, enrichmentError: null };
  } catch (err) {
    return { reportMarkdown: markdown, enrichedBy: null, enrichmentError: err.message };
  }
}

async function generateAreaStudy({
  address,
  radiusMiles = 10,
  enrichmentMode = 'public',
  aggressiveness = 'balanced',
  openaiKey = '',
  claudeKey = ''
}) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const geo = await geocodeAddress(address);
  const lat = Number(geo.lat), lon = Number(geo.lon);

  const [geoCensus, flood, poi] = await Promise.all([
    censusGeographies(lon, lat),
    floodZone(lon, lat),
    overpassPOI(lat, lon, Math.round(radiusMiles * 1609.34))
  ]);

  const acs = await acsSnapshot(geoCensus.stateFips, geoCensus.countyFips, geoCensus.placeFips);
  const place = acs.place || {};
  const county = acs.county || {};

  const answers = {
    'what significant terrain features exist': `Center point ${lat.toFixed(5)}, ${lon.toFixed(5)}. Validate slopes, waterways, and chokepoints with local maps.`,
    'how will these physical terrain features affect you in an emergency': 'Expect route chokepoints and weather-sensitive corridors around waterways and elevation changes.',
    'what seasonal climate and weather factors affect the area': 'Use NOAA seasonal outlooks plus local climate normals for rain/freeze/smoke impacts.',
    'identify flood plains in the area': `FEMA flood point result: Zone ${flood.fldZone}; SFHA=${flood.sfha}.`,
    'population': place.B01003_001E ? `${place.NAME}: ${place.B01003_001E}; County: ${county.B01003_001E || 'Unknown'}` : `${county.NAME || 'County'}: ${county.B01003_001E || 'Unknown'}`,
    'socio-economic status': `Median income place/county: ${place.B19013_001E || 'Unknown'} / ${county.B19013_001E || 'Unknown'}. Poverty place/county: ${ratio(place.B17001_002E, place.B17001_001E)} / ${ratio(county.B17001_002E, county.B17001_001E)}.`,
    'medical': pickTop(poi, ['hospital', 'clinic', 'pharmacy'], 8),
    'religious': pickTop(poi, ['place_of_worship'], 8),
    'farms and ranch': pickTop(poi, ['farm'], 8),
    'grocery stores': pickTop(poi, ['supermarket'], 10),
    'convenience stores': pickTop(poi, ['convenience'], 10),
    'gas stations': pickTop(poi, ['fuel'], 10),
    'lumber yards': pickTop(poi, ['hardware', 'doityourself'], 10),
    'location': `Resolved location: ${geo.display_name}`,
    'websites': 'Use official city/county/state websites and emergency management portals.',
    'major financial drivers and industries': 'Infer from local business clusters, healthcare, retail, logistics, and public-sector employers.'
  };

  const baseReportMarkdown = [
    '# AreaForge Auto-Generated Area Study (WA/OR Focus)',
    '',
    `- Input address: ${address}`,
    `- Resolved address: ${geo.display_name}`,
    `- Coordinates: ${lat.toFixed(6)}, ${lon.toFixed(6)}`,
    `- Radius: ${radiusMiles} miles`,
    `- Generated: ${new Date().toISOString()}`,
    '',
    '## Auto-Collected Data Snapshot',
    `- Total POIs: ${poi.length}`,
    `- Flood zone: ${flood.fldZone} (SFHA=${flood.sfha})`,
    `- Place: ${acs.place?.NAME || 'N/A'}`,
    `- County: ${acs.county?.NAME || 'N/A'}`,
    '',
    fillTemplate(template, answers)
  ].join('\n');

  const metadata = { resolvedAddress: geo.display_name, lat, lon, poiCount: poi.length, flood };
  const enrichment = await maybeEnrichReport(baseReportMarkdown, metadata, {
    enrichmentMode,
    aggressiveness,
    openaiKey,
    claudeKey
  });

  return {
    reportMarkdown: enrichment.reportMarkdown,
    metadata: {
      ...metadata,
      enrichedBy: enrichment.enrichedBy,
      enrichmentError: enrichment.enrichmentError
    }
  };
}

module.exports = { generateAreaStudy };
