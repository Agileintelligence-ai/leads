const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version',
    'Content-Type': 'application/json'
  };
}

// ── Claude API proxy ──────────────────────────────────────────────────────────
function proxyToAnthropic(body, res) {
  const apiKey = body._apiKey;
  delete body._apiKey;
  const cleanData = JSON.stringify(body);
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(cleanData),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
  };
  const req = https.request(options, (apiRes) => {
    let result = '';
    apiRes.on('data', chunk => result += chunk);
    apiRes.on('end', () => { res.writeHead(apiRes.statusCode, corsHeaders()); res.end(result); });
  });
  req.on('error', (e) => { res.writeHead(500, corsHeaders()); res.end(JSON.stringify({ error: e.message })); });
  req.write(cleanData);
  req.end();
}

// ── Google Places text search ─────────────────────────────────────────────────
function searchPlaces(query, mapsKey, res) {
  const encoded = encodeURIComponent(query);
  const mapsPath = `/maps/api/place/textsearch/json?query=${encoded}&key=${mapsKey}`;
  https.get(`https://maps.googleapis.com${mapsPath}`, (apiRes) => {
    let result = '';
    apiRes.on('data', chunk => result += chunk);
    apiRes.on('end', () => {
      try {
        const data = JSON.parse(result);
        const places = (data.results || [])
          .filter(p => !p.business_status || p.business_status === 'OPERATIONAL')
          .map(p => ({
            name: p.name,
            address: p.formatted_address,
            place_id: p.place_id,
            rating: p.rating || null,
            reviews: p.user_ratings_total || 0,
            types: p.types || []
          }));
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ results: places, status: data.status }));
      } catch(e) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ error: e.message, results: [] }));
      }
    });
  }).on('error', (e) => {
    res.writeHead(500, corsHeaders());
    res.end(JSON.stringify({ error: e.message, results: [] }));
  });
}

// ── Google Place details (includes geometry/lat+lng) ─────────────────────────
function getPlaceDetails(placeId, mapsKey, res) {
  const fields = 'name,formatted_address,website,formatted_phone_number,rating,geometry';
  const mapsPath = `/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${mapsKey}`;
  https.get(`https://maps.googleapis.com${mapsPath}`, (apiRes) => {
    let result = '';
    apiRes.on('data', chunk => result += chunk);
    apiRes.on('end', () => { res.writeHead(200, corsHeaders()); res.end(result); });
  }).on('error', (e) => {
    res.writeHead(500, corsHeaders());
    res.end(JSON.stringify({ error: e.message }));
  });
}

// ── Google Geocoding API ──────────────────────────────────────────────────────
function geocodeAddress(address, mapsKey, res) {
  const encoded = encodeURIComponent(address);
  const mapsPath = `/maps/api/geocode/json?address=${encoded}&key=${mapsKey}`;
  https.get(`https://maps.googleapis.com${mapsPath}`, (apiRes) => {
    let result = '';
    apiRes.on('data', chunk => result += chunk);
    apiRes.on('end', () => { res.writeHead(200, corsHeaders()); res.end(result); });
  }).on('error', (e) => {
    res.writeHead(500, corsHeaders());
    res.end(JSON.stringify({ error: e.message }));
  });
}

// ── Google Solar API — building insights ─────────────────────────────────────
function getSolarInsights(lat, lng, mapsKey, res) {
  const mapsPath = `/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${mapsKey}`;
  https.get(`https://solar.googleapis.com${mapsPath}`, (apiRes) => {
    let result = '';
    apiRes.on('data', chunk => result += chunk);
    apiRes.on('end', () => { res.writeHead(200, corsHeaders()); res.end(result); });
  }).on('error', (e) => {
    res.writeHead(500, corsHeaders());
    res.end(JSON.stringify({ error: e.message }));
  });
}

// ── Google Maps Static API — satellite image ──────────────────────────────────
function getSatelliteImage(lat, lng, mapsKey, res) {
  const center = `${lat},${lng}`;
  const mapsPath = `/maps/api/staticmap?center=${center}&zoom=19&size=600x400&maptype=satellite&key=${mapsKey}`;
  https.get(`https://maps.googleapis.com${mapsPath}`, (apiRes) => {
    const contentType = apiRes.headers['content-type'] || 'image/png';
    res.writeHead(apiRes.statusCode, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400'
    });
    apiRes.pipe(res);
  }).on('error', (e) => { res.writeHead(500); res.end(); });
}

// ── Request router ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return; }

  // Serve HTML app
  if (req.method === 'GET' && (parsed.pathname === '/' || parsed.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/favicon.ico') {
    res.writeHead(204); res.end(); return;
  }

  // Claude proxy
  if (req.method === 'POST' && parsed.pathname === '/api/claude') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { proxyToAnthropic(JSON.parse(body), res); }
      catch(e) { res.writeHead(400, corsHeaders()); res.end(JSON.stringify({ error: 'Invalid JSON' })); }
    });
    return;
  }

  // Places search
  if (req.method === 'GET' && parsed.pathname === '/api/places/search') {
    const { query, key } = parsed.query;
    if (!query || !key) { res.writeHead(400, corsHeaders()); res.end(JSON.stringify({ error: 'Missing params' })); return; }
    searchPlaces(query, key, res);
    return;
  }

  // Place details
  if (req.method === 'GET' && parsed.pathname === '/api/places/details') {
    const { place_id, key } = parsed.query;
    if (!place_id || !key) { res.writeHead(400, corsHeaders()); res.end(JSON.stringify({ error: 'Missing params' })); return; }
    getPlaceDetails(place_id, key, res);
    return;
  }

  // Geocoding
  if (req.method === 'GET' && parsed.pathname === '/api/geocode') {
    const { address, key } = parsed.query;
    if (!address || !key) { res.writeHead(400, corsHeaders()); res.end(JSON.stringify({ error: 'Missing params' })); return; }
    geocodeAddress(address, key, res);
    return;
  }

  // Solar API — building insights
  if (req.method === 'GET' && parsed.pathname === '/api/solar/insights') {
    const { lat, lng, key } = parsed.query;
    if (!lat || !lng || !key) { res.writeHead(400, corsHeaders()); res.end(JSON.stringify({ error: 'Missing params' })); return; }
    getSolarInsights(lat, lng, key, res);
    return;
  }

  // Satellite image
  if (req.method === 'GET' && parsed.pathname === '/api/satellite') {
    const { lat, lng, key } = parsed.query;
    if (!lat || !lng || !key) { res.writeHead(400); res.end(); return; }
    getSatelliteImage(lat, lng, key, res);
    return;
  }

  res.writeHead(404, corsHeaders());
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Agile Energy Solar Qualifier running on port ${PORT}\n`);
});
