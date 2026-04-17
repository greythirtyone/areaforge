const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, 'template.md');

async function jget(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
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

async function geocodeAddress(address) {
  const queries = [
    address,
    `${address}, Washington`,
    `${address}, Oregon`,
    `${address}, WA`,
    `${address}, OR`
  ];

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
      const state = (top?.address?.state || '').toLowerCase();
      if (state.includes('washington') || state.includes('oregon')) return top;
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

async function generateAreaStudy({ address, radiusMiles = 10 }) {
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

  const reportMarkdown = [
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

  return {
    reportMarkdown,
    metadata: { resolvedAddress: geo.display_name, lat, lon, poiCount: poi.length, flood }
  };
}

module.exports = { generateAreaStudy };
