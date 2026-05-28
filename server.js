/**
 * DomainIntel Backend Server + Plesk Integration
 * รัน: node server.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const PLESK_HOST = process.env.PLESK_HOST || '';
const PLESK_USER = process.env.PLESK_USER || 'admin';
const PLESK_PASS = process.env.PLESK_PASS || '';

const DATA_FILE = path.join(__dirname, 'data', 'domains.json');
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const PLESK_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ domains: [], lastUpdated: null }, null, 2));
}
if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    gsc: { clientId: '', clientSecret: '', refreshToken: '', accessToken: '' },
    alerts: { lineToken: '', notifyOnDown: true, notifyOnExpiry: true, expiryDaysThreshold: 30 }
  }, null, 2));
}

// ===== HELPERS =====
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { domains: [], lastUpdated: null }; }
}
function saveData(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

// ===== PLESK API =====
function pleskRequest(method, apiPath) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${PLESK_USER}:${PLESK_PASS}`).toString('base64');
    const options = {
      hostname: PLESK_HOST,
      port: 8443,
      path: `/api/v2${apiPath}`,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      rejectUnauthorized: false // Plesk ใช้ self-signed cert ได้
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function fetchPleskDomains() {
  if (!PLESK_HOST || !PLESK_PASS) {
    console.log('[Plesk] ไม่มี credentials — ข้าม');
    return [];
  }
  try {
    console.log(`[Plesk] กำลังดึงโดเมนจาก ${PLESK_HOST}...`);

    // ดึง domains ทั้งหมด
    const domsRes = await pleskRequest('GET', '/domains');
    if (domsRes.status !== 200) {
      console.log(`[Plesk] domains error: ${domsRes.status}`);
      return [];
    }

    const domains = Array.isArray(domsRes.data) ? domsRes.data : [];
    console.log(`[Plesk] พบ ${domains.length} โดเมน`);

    const results = [];
    for (const d of domains) {
      const domainName = d.name || d.ascii_name || '';
      if (!domainName) continue;

      // ดึง SSL info ถ้ามี
      let sslExpiry = null;
      let sslDaysLeft = null;
      try {
        const sslRes = await pleskRequest('GET', `/domains/${d.id}/ssl-certificate`);
        if (sslRes.status === 200 && sslRes.data?.valid_to) {
          const expDate = new Date(sslRes.data.valid_to);
          sslExpiry = expDate.toISOString().split('T')[0];
          sslDaysLeft = Math.floor((expDate - new Date()) / (1000 * 60 * 60 * 24));
        }
      } catch {}

      results.push({
        domain: domainName,
        pleskId: d.id,
        pleskStatus: d.status || 'unknown', // 0=active, 16=suspended
        pleskActive: d.status === 0 || d.status === '0',
        hostingType: d.hosting_type || '',
        sslExpiry,
        sslDaysLeft,
        pleskSyncedAt: new Date().toISOString()
      });
    }
    return results;
  } catch (err) {
    console.error('[Plesk] Error:', err.message);
    return [];
  }
}

async function syncPleskDomains() {
  const pleskDomains = await fetchPleskDomains();
  if (!pleskDomains.length) return 0;

  const data = loadData();
  let added = 0, updated = 0;

  for (const pd of pleskDomains) {
    const existing = data.domains.find(d => d.domain === pd.domain);
    if (existing) {
      // อัพเดตข้อมูล Plesk
      existing.pleskId = pd.pleskId;
      existing.pleskStatus = pd.pleskStatus;
      existing.pleskActive = pd.pleskActive;
      existing.hostingType = pd.hostingType;
      existing.sslExpiry = pd.sslExpiry;
      existing.sslDaysLeft = pd.sslDaysLeft;
      existing.pleskSyncedAt = pd.pleskSyncedAt;
      if (!existing.tags) existing.tags = [];
      if (!existing.tags.includes('plesk')) existing.tags.push('plesk');
      updated++;
    } else {
      // เพิ่มโดเมนใหม่จาก Plesk
      data.domains.push({
        domain: pd.domain,
        status: 'unknown',
        statusCode: 0,
        responseTime: 0,
        checkedAt: null,
        error: null,
        expiryDate: pd.sslExpiry,
        daysLeft: pd.sslDaysLeft,
        notes: 'นำเข้าจาก Plesk',
        tags: ['plesk'],
        gsc: null,
        addedAt: new Date().toISOString(),
        pleskId: pd.pleskId,
        pleskStatus: pd.pleskStatus,
        pleskActive: pd.pleskActive,
        hostingType: pd.hostingType,
        sslExpiry: pd.sslExpiry,
        sslDaysLeft: pd.sslDaysLeft,
        pleskSyncedAt: pd.pleskSyncedAt
      });
      added++;
    }
  }

  saveData(data);
  console.log(`[Plesk Sync] เพิ่ม ${added} อัพเดต ${updated} โดเมน`);

  // เช็คสถานะทันทีหลัง sync
  setTimeout(() => checkAllDomains(), 2000);
  return added + updated;
}

// ===== DOMAIN CHECKER =====
// Cloudflare error codes ที่แปลว่า origin server ดับ
const CF_DOWN_CODES = new Set([521, 522, 523, 524, 525, 526, 530]);
const CF_WARN_CODES = new Set([520, 527, 528, 529]);

function getErrorLabel(code, errMsg) {
  const labels = {
    521: 'CF 521 — Web server is down',
    522: 'CF 522 — Connection timed out',
    523: 'CF 523 — Origin unreachable',
    524: 'CF 524 — Timeout occurred',
    525: 'CF 525 — SSL handshake failed',
    526: 'CF 526 — Invalid SSL certificate',
    530: 'CF 530 — Origin DNS error',
    520: 'CF 520 — Unknown error',
    527: 'CF 527 — Railgun error',
    528: 'CF 528 — Timeout',
    529: 'CF 529 — Site overloaded',
    500: 'HTTP 500 — Internal server error',
    502: 'HTTP 502 — Bad gateway',
    503: 'HTTP 503 — Service unavailable',
    504: 'HTTP 504 — Gateway timeout',
  };
  if (labels[code]) return labels[code];
  if (errMsg?.includes('ECONNREFUSED')) return 'Connection refused';
  if (errMsg?.includes('ENOTFOUND')) return 'Domain not found (DNS)';
  if (errMsg?.includes('ETIMEDOUT')) return 'Connection timeout';
  if (errMsg?.includes('CERT') || errMsg?.includes('SSL')) return 'SSL error';
  return errMsg || null;
}

function checkDomain(domain) {
  return new Promise(resolve => {
    const clean = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const url = `https://${clean}`;
    const start = Date.now();
    const req = https.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 DomainIntel/1.0' }
    }, res => {
      const responseTime = Date.now() - start;
      res.destroy();
      const code = res.statusCode;
      let status = 'up';
      let errorLabel = null;

      if (CF_DOWN_CODES.has(code)) {
        status = 'down';
        errorLabel = getErrorLabel(code);
      } else if (CF_WARN_CODES.has(code)) {
        status = 'warn';
        errorLabel = getErrorLabel(code);
      } else if (code >= 500) {
        status = 'down';
        errorLabel = getErrorLabel(code);
      } else if (code >= 400 && code !== 404 && code !== 403) {
        status = 'warn';
      }

      resolve({
        domain: clean, status, statusCode: code, responseTime,
        checkedAt: new Date().toISOString(), error: errorLabel
      });
    });
    req.on('error', err => {
      resolve({
        domain: clean, status: 'down', statusCode: 0,
        responseTime: Date.now() - start,
        checkedAt: new Date().toISOString(),
        error: getErrorLabel(0, err.message)
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({
        domain: clean, status: 'down', statusCode: 0, responseTime: 10000,
        checkedAt: new Date().toISOString(), error: 'Connection timeout'
      });
    });
  });
}

async function checkAllDomains() {
  const data = loadData();
  if (!data.domains.length) return;
  console.log(`[Check] เช็ค ${data.domains.length} โดเมน...`);
  const BATCH = 20;
  for (let i = 0; i < data.domains.length; i += BATCH) {
    const batch = data.domains.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => checkDomain(d.domain)));
    results.forEach(r => {
      const idx = data.domains.findIndex(d => d.domain === r.domain);
      if (idx !== -1) {
        const prev = data.domains[idx].status;
        Object.assign(data.domains[idx], r);
        if (prev === 'up' && r.status === 'down') sendLineAlert(`🚨 ${r.domain} ล่มแล้ว!`);
      }
    });
  }
  saveData(data);
  console.log(`[Check] เสร็จแล้ว`);
}

// ===== GSC =====
async function refreshGSCToken() {
  const cfg = loadConfig();
  if (!cfg.gsc?.refreshToken) return null;
  return new Promise(resolve => {
    const body = JSON.stringify({ client_id: cfg.gsc.clientId, client_secret: cfg.gsc.clientSecret, refresh_token: cfg.gsc.refreshToken, grant_type: 'refresh_token' });
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const t = JSON.parse(data); if (t.access_token) { cfg.gsc.accessToken = t.access_token; saveConfig(cfg); resolve(t.access_token); } else resolve(null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

async function getGSCData(siteUrl, startDate, endDate, accessToken) {
  return new Promise(resolve => {
    const body = JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: 1000 });
    const apiPath = `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const req = https.request({ hostname: 'www.googleapis.com', path: apiPath, method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

async function syncGSCForDomain(domainObj) {
  const cfg = loadConfig();
  let token = cfg.gsc?.accessToken;
  if (!token) token = await refreshGSCToken();
  if (!token) return domainObj;
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const result = await getGSCData(`https://${domainObj.domain}/`, startDate, endDate, token);
  if (result?.rows) {
    const keywords = result.rows.map(r => ({ keyword: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10, ctr: Math.round(r.ctr * 10000) / 100 }));
    domainObj.gsc = { clicks: result.rows.reduce((s, r) => s + r.clicks, 0), impressions: result.rows.reduce((s, r) => s + r.impressions, 0), avgPosition: keywords.length ? Math.round(keywords.reduce((s, k) => s + k.position, 0) / keywords.length * 10) / 10 : 0, keywords, topKeyword: keywords[0]?.keyword || '-', topPosition: keywords[0]?.position || 0, keywordCount: keywords.length, syncedAt: new Date().toISOString() };
  }
  return domainObj;
}

// ===== LINE ALERT =====
function sendLineAlert(message) {
  const cfg = loadConfig();
  if (!cfg.alerts?.lineToken) return;
  const body = `message=${encodeURIComponent(message)}`;
  const req = https.request({ hostname: 'notify-api.line.me', path: '/api/notify', method: 'POST', headers: { 'Authorization': `Bearer ${cfg.alerts.lineToken}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, () => {});
  req.on('error', () => {});
  req.write(body); req.end();
}

// ===== CSV =====
function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/"/g, ''));
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i] || '');
    return obj;
  }).filter(r => r.domain || r['domain name'] || r['url']);
}

// ===== ROUTER =====
async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/api/domains') {
    const data = loadData();
    const cfg = loadConfig();
    json(res, { ...data, gscConnected: !!cfg.gsc?.accessToken, pleskConnected: !!(PLESK_HOST && PLESK_PASS), pleskHost: PLESK_HOST });
    return;
  }

  if (req.method === 'GET' && url === '/api/stats') {
    const data = loadData();
    const d = data.domains;
    json(res, {
      total: d.length,
      up: d.filter(x => x.status === 'up').length,
      down: d.filter(x => x.status === 'down').length,
      warn: d.filter(x => x.status === 'warn').length,
      unknown: d.filter(x => x.status === 'unknown').length,
      withTraffic: d.filter(x => x.gsc?.clicks > 0).length,
      noTraffic: d.filter(x => x.gsc && x.gsc.clicks === 0).length,
      expiringIn30: d.filter(x => x.sslDaysLeft !== null && x.sslDaysLeft <= 30 && x.sslDaysLeft >= 0).length,
      pleskActive: d.filter(x => x.pleskActive === true).length,
      pleskSuspended: d.filter(x => x.pleskActive === false && x.pleskId).length,
      totalClicks: d.reduce((s, x) => s + (x.gsc?.clicks || 0), 0),
      totalImpressions: d.reduce((s, x) => s + (x.gsc?.impressions || 0), 0),
    });
    return;
  }

  // Plesk sync
  if (req.method === 'POST' && url === '/api/plesk/sync') {
    if (!PLESK_HOST || !PLESK_PASS) { json(res, { error: 'ไม่มี Plesk credentials — ตั้งค่า environment variables ก่อน' }, 400); return; }
    syncPleskDomains().catch(console.error);
    json(res, { success: true, message: 'กำลัง sync โดเมนจาก Plesk...' });
    return;
  }

  // Plesk status
  if (req.method === 'GET' && url === '/api/plesk/status') {
    if (!PLESK_HOST || !PLESK_PASS) { json(res, { connected: false, reason: 'ไม่มี credentials' }); return; }
    try {
      const r = await pleskRequest('GET', '/server');
      json(res, { connected: r.status === 200, hostname: r.data?.hostname, version: r.data?.panel_version, status: r.status });
    } catch (e) {
      json(res, { connected: false, reason: e.message });
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/domains/add') {
    const body = await parseBody(req);
    const data = loadData();
    const domain = body.domain?.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (!domain) { json(res, { error: 'ต้องระบุ domain' }, 400); return; }
    if (data.domains.find(d => d.domain === domain)) { json(res, { error: 'มีโดเมนนี้อยู่แล้ว' }, 409); return; }
    const newD = { domain, status: 'unknown', statusCode: 0, responseTime: 0, checkedAt: null, error: null, sslExpiry: null, sslDaysLeft: null, expiryDate: null, daysLeft: null, notes: body.notes || '', tags: body.tags || [], gsc: null, addedAt: new Date().toISOString() };
    data.domains.push(newD);
    saveData(data);
    checkDomain(domain).then(r => { const idx = data.domains.findIndex(d => d.domain === domain); if (idx !== -1) { Object.assign(data.domains[idx], r); saveData(data); } });
    json(res, { success: true, domain: newD });
    return;
  }

  if (req.method === 'POST' && url === '/api/domains/import') {
    const body = await parseBody(req);
    const rows = parseCSV(body.csv || '');
    const data = loadData();
    let added = 0, skipped = 0;
    rows.forEach(row => {
      const domain = (row.domain || row['domain name'] || row['url'] || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase().trim();
      if (!domain || data.domains.find(d => d.domain === domain)) { skipped++; return; }
      data.domains.push({ domain, status: 'unknown', statusCode: 0, responseTime: 0, checkedAt: null, error: null, sslExpiry: null, sslDaysLeft: null, expiryDate: row.expiry_date || null, daysLeft: row.days_left ? parseInt(row.days_left) : null, notes: row.notes || '', tags: row.tags ? row.tags.split(';') : [], gsc: null, addedAt: new Date().toISOString() });
      added++;
    });
    saveData(data);
    setTimeout(() => checkAllDomains(), 500);
    json(res, { success: true, added, skipped, total: data.domains.length });
    return;
  }

  if (req.method === 'DELETE' && url.startsWith('/api/domains/')) {
    const domain = decodeURIComponent(url.split('/api/domains/')[1]);
    const data = loadData();
    const before = data.domains.length;
    data.domains = data.domains.filter(d => d.domain !== domain);
    saveData(data);
    json(res, { success: true, removed: before - data.domains.length });
    return;
  }

  if (req.method === 'POST' && url.startsWith('/api/check/')) {
    const domain = decodeURIComponent(url.split('/api/check/')[1]);
    const result = await checkDomain(domain);
    const data = loadData();
    const idx = data.domains.findIndex(d => d.domain === domain);
    if (idx !== -1) { Object.assign(data.domains[idx], result); saveData(data); }
    json(res, result);
    return;
  }

  if (req.method === 'POST' && url === '/api/check-all') {
    checkAllDomains().catch(console.error);
    json(res, { success: true, message: 'กำลังเช็คทุกโดเมน...' });
    return;
  }

  if (req.method === 'POST' && url.startsWith('/api/gsc/sync/')) {
    const domain = decodeURIComponent(url.split('/api/gsc/sync/')[1]);
    const data = loadData();
    const idx = data.domains.findIndex(d => d.domain === domain);
    if (idx === -1) { json(res, { error: 'ไม่พบโดเมน' }, 404); return; }
    data.domains[idx] = await syncGSCForDomain(data.domains[idx]);
    saveData(data);
    json(res, { success: true, gsc: data.domains[idx].gsc });
    return;
  }

  if (req.method === 'POST' && url === '/api/gsc/sync-all') {
    const data = loadData();
    (async () => {
      for (let i = 0; i < data.domains.length; i++) {
        data.domains[i] = await syncGSCForDomain(data.domains[i]);
        if (i % 10 === 0) saveData(data);
      }
      saveData(data);
    })().catch(console.error);
    json(res, { success: true, message: `Sync GSC ${data.domains.length} โดเมน...` });
    return;
  }

  if (url === '/api/config') {
    if (req.method === 'GET') {
      const cfg = loadConfig();
      const safe = JSON.parse(JSON.stringify(cfg));
      if (safe.gsc?.clientSecret) safe.gsc.clientSecret = '***';
      if (safe.gsc?.refreshToken) safe.gsc.refreshToken = safe.gsc.refreshToken.slice(0, 10) + '...';
      if (safe.alerts?.lineToken) safe.alerts.lineToken = safe.alerts.lineToken.slice(0, 8) + '...';
      json(res, { ...safe, pleskHost: PLESK_HOST, pleskConnected: !!(PLESK_HOST && PLESK_PASS) });
    } else {
      const body = await parseBody(req);
      const cfg = loadConfig();
      if (body.gsc) Object.assign(cfg.gsc, body.gsc);
      if (body.alerts) Object.assign(cfg.alerts, body.alerts);
      saveConfig(cfg);
      json(res, { success: true });
    }
    return;
  }

  // Static files
  if (req.method === 'GET') {
    const filePath = url === '/' ? '/public/index.html' : `/public${url}`;
    const fullPath = path.join(__dirname, filePath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath);
      const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
      cors(res);
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      res.end(fs.readFileSync(fullPath));
      return;
    }
  }

  json(res, { error: 'Not found' }, 404);
}

// ===== START =====
const server = http.createServer(handleRequest);
server.listen(PORT, async () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   DomainIntel + Plesk Integration    ║`);
  console.log(`║   http://localhost:${PORT}               ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  if (PLESK_HOST && PLESK_PASS) {
    console.log(`[Plesk] เชื่อมต่อ ${PLESK_HOST}`);
    // Sync Plesk ทันทีตอน start
    await syncPleskDomains();
    // Auto sync ทุก 6 ชั่วโมง
    setInterval(() => syncPleskDomains(), PLESK_SYNC_INTERVAL_MS);
  } else {
    console.log('[Plesk] ไม่มี credentials — ข้าม');
  }

  // Auto check ทุก 30 นาที
  setInterval(checkAllDomains, CHECK_INTERVAL_MS);
  console.log(`[Auto-check] ทุก ${CHECK_INTERVAL_MS / 60000} นาที`);
});
