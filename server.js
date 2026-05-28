/**
 * DomainIntel Backend Server
 * ติดตั้ง: npm install
 * รัน:    node server.js
 * Port:   3001
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ===== CONFIG =====
const PORT = 3001;
const DATA_FILE = path.join(__dirname, 'data', 'domains.json');
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // เช็คทุก 30 นาที

// ===== INIT DATA FILES =====
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ domains: [], lastUpdated: null }, null, 2));
}

if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    gsc: { clientId: '', clientSecret: '', refreshToken: '', accessToken: '' },
    alerts: { lineToken: '', email: '', notifyOnDown: true, notifyOnExpiry: true, expiryDaysThreshold: 30 }
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

// ===== DOMAIN CHECKER =====
function checkDomain(domain) {
  return new Promise(resolve => {
    const clean = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const url = `https://${clean}`;
    const start = Date.now();
    const req = https.get(url, { timeout: 8000, headers: { 'User-Agent': 'DomainIntel/1.0' } }, res => {
      const responseTime = Date.now() - start;
      res.destroy();
      const statusCode = res.statusCode;
      let status = 'up';
      if (statusCode >= 500) status = 'down';
      else if (statusCode >= 400 && statusCode !== 404) status = 'warn';
      resolve({ domain: clean, status, statusCode, responseTime, checkedAt: new Date().toISOString(), error: null });
    });
    req.on('error', err => {
      resolve({ domain: clean, status: 'down', statusCode: 0, responseTime: Date.now() - start, checkedAt: new Date().toISOString(), error: err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ domain: clean, status: 'down', statusCode: 0, responseTime: 8000, checkedAt: new Date().toISOString(), error: 'Timeout' });
    });
  });
}

async function checkAllDomains() {
  const data = loadData();
  if (!data.domains.length) return;
  console.log(`[${new Date().toLocaleTimeString()}] เช็ค ${data.domains.length} โดเมน...`);

  // เช็คพร้อมกันสูงสุด 20 โดเมน
  const BATCH = 20;
  for (let i = 0; i < data.domains.length; i += BATCH) {
    const batch = data.domains.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => checkDomain(d.domain)));
    results.forEach(r => {
      const idx = data.domains.findIndex(d => d.domain === r.domain);
      if (idx !== -1) {
        const prev = data.domains[idx].status;
        data.domains[idx].status = r.status;
        data.domains[idx].statusCode = r.statusCode;
        data.domains[idx].responseTime = r.responseTime;
        data.domains[idx].checkedAt = r.checkedAt;
        data.domains[idx].error = r.error;
        // แจ้งเตือนถ้าสถานะเปลี่ยนเป็น down
        if (prev === 'up' && r.status === 'down') {
          sendLineAlert(`🚨 โดเมน ${r.domain} ล่มแล้ว! (${r.error || 'HTTP ' + r.statusCode})`);
        }
      }
    });
  }
  saveData(data);
  console.log(`[${new Date().toLocaleTimeString()}] เช็คเสร็จแล้ว`);
}

// ===== WHOIS / EXPIRY CHECKER =====
function checkExpiryWhois(domain) {
  try {
    const clean = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const result = execSync(`whois ${clean} 2>/dev/null | grep -i "expir" | head -5`, { timeout: 10000 }).toString();
    const match = result.match(/(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/);
    if (match) {
      const expDate = new Date(match[1]);
      const daysLeft = Math.floor((expDate - new Date()) / (1000 * 60 * 60 * 24));
      return { expiryDate: expDate.toISOString().split('T')[0], daysLeft };
    }
    return { expiryDate: null, daysLeft: null };
  } catch {
    return { expiryDate: null, daysLeft: null };
  }
}

// ===== GSC API =====
async function refreshGSCToken() {
  const cfg = loadConfig();
  if (!cfg.gsc?.refreshToken) return null;
  return new Promise(resolve => {
    const body = JSON.stringify({ client_id: cfg.gsc.clientId, client_secret: cfg.gsc.clientSecret, refresh_token: cfg.gsc.refreshToken, grant_type: 'refresh_token' });
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const t = JSON.parse(data);
          if (t.access_token) {
            cfg.gsc.accessToken = t.access_token;
            saveConfig(cfg);
            resolve(t.access_token);
          } else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function getGSCData(siteUrl, startDate, endDate, accessToken) {
  return new Promise(resolve => {
    const body = JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: 1000 });
    const path = `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const req = https.request({ hostname: 'www.googleapis.com', path, method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function syncGSCForDomain(domainObj) {
  const cfg = loadConfig();
  let token = cfg.gsc?.accessToken;
  if (!token) token = await refreshGSCToken();
  if (!token) return domainObj;

  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const siteUrl = `https://${domainObj.domain}/`;
  const result = await getGSCData(siteUrl, startDate, endDate, token);

  if (result?.rows) {
    const totalClicks = result.rows.reduce((s, r) => s + (r.clicks || 0), 0);
    const totalImpressions = result.rows.reduce((s, r) => s + (r.impressions || 0), 0);
    const keywords = result.rows.map(r => ({ keyword: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10, ctr: Math.round(r.ctr * 10000) / 100 }));
    const topKw = keywords[0] || null;
    domainObj.gsc = { clicks: totalClicks, impressions: totalImpressions, avgPosition: keywords.length ? Math.round(keywords.reduce((s, k) => s + k.position, 0) / keywords.length * 10) / 10 : 0, keywords, topKeyword: topKw?.keyword || '-', topPosition: topKw?.position || 0, keywordCount: keywords.length, syncedAt: new Date().toISOString() };
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
  req.write(body);
  req.end();
}

// ===== CSV PARSER =====
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

  // GET /api/domains
  if (req.method === 'GET' && url === '/api/domains') {
    const data = loadData();
    const cfg = loadConfig();
    json(res, { ...data, gscConnected: !!cfg.gsc?.accessToken, lastUpdated: data.lastUpdated });
    return;
  }

  // POST /api/domains/add
  if (req.method === 'POST' && url === '/api/domains/add') {
    const body = await parseBody(req);
    const data = loadData();
    const domain = body.domain?.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (!domain) { json(res, { error: 'ต้องระบุ domain' }, 400); return; }
    if (data.domains.find(d => d.domain === domain)) { json(res, { error: 'มีโดเมนนี้อยู่แล้ว' }, 409); return; }
    const newDomain = { domain, status: 'unknown', statusCode: 0, responseTime: 0, checkedAt: null, error: null, expiryDate: null, daysLeft: null, notes: body.notes || '', tags: body.tags || [], gsc: null, addedAt: new Date().toISOString() };
    data.domains.push(newDomain);
    saveData(data);
    // เช็คทันที
    checkDomain(domain).then(r => {
      const idx = data.domains.findIndex(d => d.domain === domain);
      if (idx !== -1) { Object.assign(data.domains[idx], r); saveData(data); }
    });
    json(res, { success: true, domain: newDomain });
    return;
  }

  // POST /api/domains/import (CSV)
  if (req.method === 'POST' && url === '/api/domains/import') {
    const body = await parseBody(req);
    const rows = parseCSV(body.csv || '');
    const data = loadData();
    let added = 0, skipped = 0;
    rows.forEach(row => {
      const domain = (row.domain || row['domain name'] || row['url'] || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase().trim();
      if (!domain) { skipped++; return; }
      if (data.domains.find(d => d.domain === domain)) { skipped++; return; }
      data.domains.push({ domain, status: 'unknown', statusCode: 0, responseTime: 0, checkedAt: null, error: null, expiryDate: row.expiry_date || null, daysLeft: row.days_left ? parseInt(row.days_left) : null, notes: row.notes || '', tags: row.tags ? row.tags.split(';') : [], gsc: null, addedAt: new Date().toISOString() });
      added++;
    });
    saveData(data);
    // เช็คสถานะทั้งหมดที่เพิ่งเพิ่ม background
    setTimeout(() => checkAllDomains(), 500);
    json(res, { success: true, added, skipped, total: data.domains.length });
    return;
  }

  // DELETE /api/domains/:domain
  if (req.method === 'DELETE' && url.startsWith('/api/domains/')) {
    const domain = decodeURIComponent(url.split('/api/domains/')[1]);
    const data = loadData();
    const before = data.domains.length;
    data.domains = data.domains.filter(d => d.domain !== domain);
    saveData(data);
    json(res, { success: true, removed: before - data.domains.length });
    return;
  }

  // POST /api/check/:domain (เช็คเดี่ยว)
  if (req.method === 'POST' && url.startsWith('/api/check/')) {
    const domain = decodeURIComponent(url.split('/api/check/')[1]);
    const result = await checkDomain(domain);
    const data = loadData();
    const idx = data.domains.findIndex(d => d.domain === domain);
    if (idx !== -1) { Object.assign(data.domains[idx], result); saveData(data); }
    json(res, result);
    return;
  }

  // POST /api/check-all
  if (req.method === 'POST' && url === '/api/check-all') {
    checkAllDomains().catch(console.error);
    json(res, { success: true, message: 'กำลังเช็คทุกโดเมน...' });
    return;
  }

  // POST /api/whois/:domain
  if (req.method === 'POST' && url.startsWith('/api/whois/')) {
    const domain = decodeURIComponent(url.split('/api/whois/')[1]);
    const expiry = checkExpiryWhois(domain);
    const data = loadData();
    const idx = data.domains.findIndex(d => d.domain === domain);
    if (idx !== -1) { Object.assign(data.domains[idx], expiry); saveData(data); }
    json(res, expiry);
    return;
  }

  // POST /api/gsc/sync/:domain
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

  // POST /api/gsc/sync-all
  if (req.method === 'POST' && url === '/api/gsc/sync-all') {
    const data = loadData();
    // sync แบบ async background
    (async () => {
      for (let i = 0; i < data.domains.length; i++) {
        data.domains[i] = await syncGSCForDomain(data.domains[i]);
        if (i % 10 === 0) saveData(data);
      }
      saveData(data);
      console.log('GSC sync เสร็จแล้ว');
    })().catch(console.error);
    json(res, { success: true, message: `กำลัง sync GSC สำหรับ ${data.domains.length} โดเมน...` });
    return;
  }

  // GET/POST /api/config
  if (url === '/api/config') {
    if (req.method === 'GET') {
      const cfg = loadConfig();
      // ซ่อน secret
      const safe = JSON.parse(JSON.stringify(cfg));
      if (safe.gsc?.clientSecret) safe.gsc.clientSecret = '***';
      if (safe.gsc?.refreshToken) safe.gsc.refreshToken = safe.gsc.refreshToken.slice(0, 10) + '...';
      if (safe.alerts?.lineToken) safe.alerts.lineToken = safe.alerts.lineToken.slice(0, 8) + '...';
      json(res, safe);
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

  // GET /api/stats
  if (req.method === 'GET' && url === '/api/stats') {
    const data = loadData();
    const domains = data.domains;
    json(res, {
      total: domains.length,
      up: domains.filter(d => d.status === 'up').length,
      down: domains.filter(d => d.status === 'down').length,
      warn: domains.filter(d => d.status === 'warn').length,
      unknown: domains.filter(d => d.status === 'unknown').length,
      withTraffic: domains.filter(d => d.gsc?.clicks > 0).length,
      noTraffic: domains.filter(d => d.gsc && d.gsc.clicks === 0).length,
      expiringIn30: domains.filter(d => d.daysLeft !== null && d.daysLeft <= 30 && d.daysLeft >= 0).length,
      totalClicks: domains.reduce((s, d) => s + (d.gsc?.clicks || 0), 0),
      totalImpressions: domains.reduce((s, d) => s + (d.gsc?.impressions || 0), 0),
    });
    return;
  }

  // Static files
  if (req.method === 'GET') {
    const filePath = url === '/' ? '/public/index.html' : `/public${url}`;
    const fullPath = path.join(__dirname, filePath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath);
      const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json' };
      cors(res);
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      res.end(fs.readFileSync(fullPath));
      return;
    }
  }

  json(res, { error: 'Not found' }, 404);
}

// ===== START SERVER =====
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   DomainIntel Server v1.0            ║
║   http://localhost:${PORT}               ║
╚══════════════════════════════════════╝
  `);
  // เริ่ม Auto-check ทุก 30 นาที
  setInterval(checkAllDomains, CHECK_INTERVAL_MS);
  console.log(`[Auto-check] จะเช็คโดเมนทุก ${CHECK_INTERVAL_MS / 60000} นาที`);
});
