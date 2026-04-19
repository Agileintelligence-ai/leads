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
  }).on('error', (e) => { res.writeHead(500, corsHeaders()); res.end(JSON.stringify({ error: e.message, results: [] })); });
}

function getPlaceDetails(placeId, mapsKey, res) {
  const fields = 'name,formatted_address,website,formatted_phone_number,rating,url,geometry';
  const mapsPath = `/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${mapsKey}`;
  https.get(`https://maps.googleapis.com${mapsPath}`, (apiRes) => {
    let result = '';
    apiRes.on('data', chunk => result += chunk);
    apiRes.on('end', () => { res.writeHead(200, corsHeaders()); res.end(result); });
  }).on('error', (e) => { res.writeHead(500, corsHeaders()); res.end(JSON.stringify({ error: e.message })); });
}

// Proxy satellite image — returns image bytes so browser can display without CORS issues
function getSatelliteImage(address, mapsKey, res) {
  const encoded = encodeURIComponent(address);
  const mapsPath = `/maps/api/staticmap?center=${encoded}&zoom=19&size=600x400&maptype=satellite&key=${mapsKey}`;
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

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return; }

  // Serve app
  if (req.method === 'GET' && (parsed.pathname === '/' || parsed.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // Serve static files (favicon etc)
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

  // Google Places search
  if (req.method === 'GET' && parsed.pathname === '/api/places/search') {
    const { query, key } = parsed.query;
    if (!query || !key) { res.writeHead(400, corsHeaders()); res.end(JSON.stringify({ error: 'Missing params' })); return; }
    searchPlaces(query, key, res);
    return;
  }

  // Google Place details
  if (req.method === 'GET' && parsed.pathname === '/api/places/details') {
    const { place_id, key } = parsed.query;
    if (!place_id || !key) { res.writeHead(400, corsHeaders()); res.end(JSON.stringify({ error: 'Missing params' })); return; }
    getPlaceDetails(place_id, key, res);
    return;
  }

  // Satellite image proxy
  if (req.method === 'GET' && parsed.pathname === '/api/satellite') {
    const { address, key } = parsed.query;
    if (!address || !key) { res.writeHead(400); res.end(); return; }
    getSatelliteImage(address, key, res);
    return;
  }

  res.writeHead(404, corsHeaders());
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Agile Energy Solar Qualifier running on port ${PORT}\n`);
});
