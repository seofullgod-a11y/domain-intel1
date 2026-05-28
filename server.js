/**
 * DomainIntel Backend Server
 * Plesk + Google Sheets Integration
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const PLESK_HOST = process.env.PLESK_HOST || '';
const PLESK_USER = process.env.PLESK_USER || 'admin';
const PLESK_PASS = process.env.PLESK_PASS || '';
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

// Parse Google Service Account from env
let SERVICE_ACCOUNT = null;
try {
  SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
} catch(e) {
  console.error('[Sheets] ไม่สามารถ parse GOOGLE_SERVICE_ACCOUNT ได้');
}

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const PLESK_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CF_DOWN_CODES = new Set([521, 522, 523, 524, 525, 526, 530]);
const CF_WARN_CODES = new Set([520, 527, 528, 529]);

// In-memory cache (Google Sheets เป็น persistent storage)
let memoryDomains = [];
let lastUpdated = null;
let gscAccessToken = null;

// ===== HELPERS =====
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

// ===== GOOGLE SHEETS AUTH =====
async function getGoogleToken(scopes) {
  if (!SERVICE_ACCOUNT?.private_key) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: SERVICE_ACCOUNT.client_email,
    scope: scopes,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).toString('base64url');

  const { createSign } = require('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(SERVICE_ACCOUNT.private_key, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;

  return new Promise(resolve => {
    const body = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`;
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).access_token || null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

// ===== GOOGLE SHEETS API =====
async function sheetsRequest(method, path, body = null, token = null) {
  if (!token) token = await getGoogleToken('https://www.googleapis.com/auth/spreadsheets');
  if (!token) return null;
  return new Promise(resolve => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({
      hostname: 'sheets.googleapis.com', path, method, headers
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// sheet headers
const HEADERS = ['domain','status','statusCode','responseTime','checkedAt','error','pleskId','pleskStatus','pleskActive','hostingType','sslExpiry','sslDaysLeft','notes','tags','gscClicks','gscImpressions','gscAvgPosition','gscKeywordCount','gscTopKeyword','gscTopPosition','pleskSyncedAt','addedAt'];

function domainToRow(d) {
  return [
    d.domain || '', d.status || 'unknown', d.statusCode || 0, d.responseTime || 0,
    d.checkedAt || '', d.error || '', d.pleskId || '', d.pleskStatus || '',
    d.pleskActive ? 'true' : 'false', d.hostingType || '',
    d.sslExpiry || '', d.sslDaysLeft !== null && d.sslDaysLeft !== undefined ? d.sslDaysLeft : '',
    d.notes || '', (d.tags || []).join(';'),
    d.gsc?.clicks || 0, d.gsc?.impressions || 0, d.gsc?.avgPosition || 0,
    d.gsc?.keywordCount || 0, d.gsc?.topKeyword || '', d.gsc?.topPosition || 0,
    d.pleskSyncedAt || '', d.addedAt || new Date().toISOString()
  ];
}

function rowToDomain(row) {
  if (!row[0]) return null;
  const gscClicks = parseInt(row[14]) || 0;
  const gscImpressions = parseInt(row[15]) || 0;
  return {
    domain: row[0], status: row[1] || 'unknown', statusCode: parseInt(row[2]) || 0,
    responseTime: parseInt(row[3]) || 0, checkedAt: row[4] || null, error: row[5] || null,
    pleskId: row[6] ? parseInt(row[6]) : null, pleskStatus: row[7] || 'unknown',
    pleskActive: row[8] === 'true', hostingType: row[9] || '',
    sslExpiry: row[10] || null, sslDaysLeft: row[11] !== '' ? parseInt(row[11]) : null,
    notes: row[12] || '', tags: row[13] ? row[13].split(';').filter(Boolean) : [],
    gsc: (gscClicks > 0 || gscImpressions > 0) ? {
      clicks: gscClicks, impressions: gscImpressions,
      avgPosition: parseFloat(row[16]) || 0, keywordCount: parseInt(row[17]) || 0,
      topKeyword: row[18] || '', topPosition: parseFloat(row[19]) || 0
    } : null,
    pleskSyncedAt: row[20] || null, addedAt: row[21] || new Date().toISOString(),
    expiryDate: row[10] || null, daysLeft: row[11] !== '' ? parseInt(row[11]) : null
  };
}

async function loadFromSheets() {
  if (!SHEET_ID) return [];
  const res = await sheetsRequest('GET', `/v4/spreadsheets/${SHEET_ID}/values/Sheet1!A2:V5000`);
  if (!res?.values) return [];
  return res.values.map(rowToDomain).filter(Boolean);
}

async function saveToSheets(domains) {
  if (!SHEET_ID) return;
  const token = await getGoogleToken('https://www.googleapis.com/auth/spreadsheets');
  // clear เก่าก่อน
  await sheetsRequest('POST', `/v4/spreadsheets/${SHEET_ID}/values/Sheet1!A1:V5000:clear`, {}, token);
  // เขียน header + data
  const values = [HEADERS, ...domains.map(domainToRow)];
  await sheetsRequest('PUT', `/v4/spreadsheets/${SHEET_ID}/values/Sheet1!A1:V${values.length}?valueInputOption=RAW`, { values }, token);
  lastUpdated = new Date().toISOString();
  console.log(`[Sheets] บันทึก ${domains.length} โดเมนแล้ว`);
}

async function initSheets() {
  if (!SHEET_ID) { console.log('[Sheets] ไม่มี SHEET_ID'); return; }
  console.log('[Sheets] โหลดข้อมูลจาก Google Sheets...');
  memoryDomains = await loadFromSheets();
  console.log(`[Sheets] โหลด ${memoryDomains.length} โดเมน`);
}

// ===== PLESK =====
function pleskRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${PLESK_USER}:${PLESK_PASS}`).toString('base64');
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({
      hostname: PLESK_HOST, port: 8443, path: `/api/v2${apiPath}`, method,
      headers, rejectUnauthorized: false
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`[Plesk] ${method} ${apiPath} -> ${res.statusCode}: ${data.slice(0,200)}`);
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function fetchPleskDomains() {
  if (!PLESK_HOST || !PLESK_PASS) return [];
  try {
    console.log(`[Plesk] ดึงโดเมนจาก ${PLESK_HOST}...`);
    const domsRes = await pleskRequest('GET', '/domains');
    if (domsRes.status !== 200) { console.log(`[Plesk] error: ${domsRes.status}`); return []; }
    const domains = Array.isArray(domsRes.data) ? domsRes.data : [];
    console.log(`[Plesk] พบ ${domains.length} โดเมน`);
    const results = [];
    for (const d of domains) {
      const domainName = d.name || d.ascii_name || '';
      if (!domainName) continue;
      let sslExpiry = null, sslDaysLeft = null;
      try {
        const sslRes = await pleskRequest('GET', `/domains/${d.id}/ssl-certificate`);
        if (sslRes.status === 200 && sslRes.data?.valid_to) {
          const expDate = new Date(sslRes.data.valid_to);
          sslExpiry = expDate.toISOString().split('T')[0];
          sslDaysLeft = Math.floor((expDate - new Date()) / 86400000);
        }
      } catch {}
      results.push({ domain: domainName, pleskId: d.id, pleskStatus: d.status || 'unknown', pleskActive: d.status === 0 || d.status === '0', hostingType: d.hosting_type || '', sslExpiry, sslDaysLeft, pleskSyncedAt: new Date().toISOString() });
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
  let added = 0, updated = 0;
  for (const pd of pleskDomains) {
    const idx = memoryDomains.findIndex(d => d.domain === pd.domain);
    if (idx !== -1) {
      Object.assign(memoryDomains[idx], pd);
      if (!memoryDomains[idx].tags) memoryDomains[idx].tags = [];
      if (!memoryDomains[idx].tags.includes('plesk')) memoryDomains[idx].tags.push('plesk');
      updated++;
    } else {
      memoryDomains.push({ domain: pd.domain, status: 'unknown', statusCode: 0, responseTime: 0, checkedAt: null, error: null, expiryDate: pd.sslExpiry, daysLeft: pd.sslDaysLeft, notes: 'นำเข้าจาก Plesk', tags: ['plesk'], gsc: null, addedAt: new Date().toISOString(), ...pd });
      added++;
    }
  }
  await saveToSheets(memoryDomains);
  console.log(`[Plesk Sync] เพิ่ม ${added} อัพเดต ${updated}`);
  setTimeout(() => checkAllDomains(), 2000);
  return added + updated;
}

// ===== DOMAIN CHECKER =====
function getErrorLabel(code, errMsg) {
  const labels = { 521:'CF 521 — Web server is down', 522:'CF 522 — Connection timed out', 523:'CF 523 — Origin unreachable', 524:'CF 524 — Timeout', 525:'CF 525 — SSL handshake failed', 526:'CF 526 — Invalid SSL', 530:'CF 530 — Origin DNS error', 520:'CF 520 — Unknown error', 500:'HTTP 500', 502:'HTTP 502 — Bad gateway', 503:'HTTP 503 — Unavailable', 504:'HTTP 504 — Gateway timeout' };
  if (labels[code]) return labels[code];
  if (errMsg?.includes('ECONNREFUSED')) return 'Connection refused';
  if (errMsg?.includes('ENOTFOUND')) return 'Domain not found (DNS)';
  if (errMsg?.includes('ETIMEDOUT')) return 'Connection timeout';
  return errMsg || null;
}

function checkDomain(domain) {
  return new Promise(resolve => {
    const clean = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const start = Date.now();
    // ใช้ User-Agent จริงๆ เพื่อไม่ให้ถูกบล็อก
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'th,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
    };
    const req = https.get(`https://${clean}`, { timeout: 12000, headers, rejectUnauthorized: false }, res => {
      const responseTime = Date.now() - start;
      res.destroy();
      const code = res.statusCode;
      // ตรวจสอบ x-deny-reason header (Railway proxy block)
      const denyReason = res.headers['x-deny-reason'];
      if (denyReason) {
        // Railway บล็อก outbound — ไม่นับว่าโดเมนล่ม ให้เป็น unknown
        resolve({ domain: clean, status: 'unknown', statusCode: code, responseTime, checkedAt: new Date().toISOString(), error: `Proxy block: ${denyReason}` });
        return;
      }
      let status = 'up', errorLabel = null;
      // 200-399 = up (รวม redirect)
      if (code >= 200 && code < 400) { status = 'up'; }
      // Cloudflare specific errors = down
      else if (CF_DOWN_CODES.has(code)) { status = 'down'; errorLabel = getErrorLabel(code); }
      // 403 Forbidden = up (เว็บทำงานแต่บล็อก bot)
      else if (code === 403) { status = 'up'; errorLabel = 'HTTP 403 (bot blocked)'; }
      // 404 = up (เว็บทำงานแต่ไม่พบหน้า)
      else if (code === 404) { status = 'up'; }
      // 5xx = down
      else if (code >= 500) { status = 'down'; errorLabel = getErrorLabel(code); }
      // CF warn codes
      else if (CF_WARN_CODES.has(code)) { status = 'warn'; errorLabel = getErrorLabel(code); }
      // อื่นๆ
      else { status = 'warn'; errorLabel = `HTTP ${code}`; }
      resolve({ domain: clean, status, statusCode: code, responseTime, checkedAt: new Date().toISOString(), error: errorLabel });
    });
    req.on('error', err => {
      const msg = err.message || '';
      // ENOTFOUND = DNS ไม่เจอ = domain หมดหรือ config ผิด
      // ECONNREFUSED = server ปิด
      // ETIMEDOUT = timeout
      const errLabel = getErrorLabel(0, msg);
      resolve({ domain: clean, status: 'down', statusCode: 0, responseTime: Date.now() - start, checkedAt: new Date().toISOString(), error: errLabel });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ domain: clean, status: 'down', statusCode: 0, responseTime: 12000, checkedAt: new Date().toISOString(), error: 'Connection timeout' });
    });
  });
}

async function checkAllDomains() {
  if (!memoryDomains.length) return;
  console.log(`[Check] ${memoryDomains.length} domains...`);
  const BATCH = 20;
  for (let i = 0; i < memoryDomains.length; i += BATCH) {
    const batch = memoryDomains.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => checkDomain(d.domain)));
    for (const r of results) {
      const idx = memoryDomains.findIndex(d => d.domain === r.domain);
      if (idx === -1) continue;
      const prev = memoryDomains[idx].status;
      Object.assign(memoryDomains[idx], r);
      if (r.status === 'down') await autoFix(memoryDomains[idx], prev);
    }
  }
  await saveToSheets(memoryDomains);
  console.log('[Check] done');
}

// ===== AUTO FIX =====
async function autoFix(domainObj, prevStatus) {
  const domain = domainObj.domain;
  const code = domainObj.statusCode;
  const isNewDown = prevStatus !== 'down';
  let fixed = false;

  // 1. Plesk Suspended -> Unsuspend อัตโนมัติ
  if (domainObj.pleskId && !domainObj.pleskActive) {
    console.log(`[AutoFix] Unsuspend ${domain}...`);
    const ok = await pleskUnsuspend(domainObj.pleskId);
    if (ok) {
      const idx = memoryDomains.findIndex(d => d.domain === domain);
      if (idx !== -1) { memoryDomains[idx].pleskActive = true; memoryDomains[idx].pleskStatus = 0; }
      console.log(`[AutoFix] Unsuspend ${domain} OK`);
      sendLineAlert(`Auto-fix: Unsuspend ${domain} via Plesk OK`);
      fixed = true;
      setTimeout(async () => {
        const r = await checkDomain(domain);
        const i = memoryDomains.findIndex(d => d.domain === domain);
        if (i !== -1) { Object.assign(memoryDomains[i], r); await saveToSheets(memoryDomains); }
      }, 30000);
    } else {
      console.log(`[AutoFix] Unsuspend ${domain} FAILED`);
    }
  }

  // 2. CF 521/522/523/524 -> Pause Cloudflare อัตโนมัติ
  if (CF_API_TOKEN && [521, 522, 523, 524].includes(code)) {
    console.log(`[AutoFix] Pause CF ${domain} (${code})...`);
    const zoneId = await pauseCloudflareZone(domain);
    if (zoneId) {
      console.log(`[AutoFix] Pause CF ${domain} OK`);
      sendLineAlert(`Auto-fix: Pause Cloudflare ${domain} (CF ${code}) traffic to origin`);
      fixed = true;
      let attempts = 0;
      const iv = setInterval(async () => {
        attempts++;
        const r = await checkDomain(domain);
        console.log(`[AutoFix] check ${domain} #${attempts}: ${r.status}`);
        if (r.status === 'up' || attempts >= 6) {
          clearInterval(iv);
          await unpauseCloudflareZone(domain, zoneId);
          const i = memoryDomains.findIndex(d => d.domain === domain);
          if (i !== -1) { Object.assign(memoryDomains[i], r); await saveToSheets(memoryDomains); }
          sendLineAlert(r.status === 'up' ? `${domain} is back online` : `${domain} still down after 30min - check needed`);
        }
      }, 5 * 60 * 1000);
    } else {
      console.log(`[AutoFix] Pause CF ${domain} FAILED - zone not found`);
    }
  }

  if (isNewDown && !fixed) sendLineAlert(`${domain} is down (${domainObj.error || 'HTTP ' + code})`);
}

// ===== PLESK UNSUSPEND =====
async function pleskUnsuspend(pleskId) {
  if (!PLESK_HOST || !PLESK_PASS) return false;
  try {
    // วิธีที่ 1: PUT with status=0 (Plesk 18+)
    let result = await pleskRequest('PUT', `/domains/${pleskId}`, { status: 0 });
    if (result?.status === 200) return true;
    console.log(`[Plesk] PUT status=0 failed (${result?.status}), trying enable endpoint...`);

    // วิธีที่ 2: POST to enable endpoint
    result = await pleskRequest('POST', `/domains/${pleskId}/enable`);
    if (result?.status === 200) return true;
    console.log(`[Plesk] enable failed (${result?.status}), trying hosting enable...`);

    // วิธีที่ 3: เปิด hosting
    result = await pleskRequest('POST', `/domains/${pleskId}/hosting/enable`);
    if (result?.status === 200) return true;

    console.log(`[Plesk] All unsuspend methods failed for pleskId ${pleskId}`);
    return false;
  } catch(e) {
    console.error(`[Plesk] Unsuspend error:`, e.message);
    return false;
  }
}

// ===== CLOUDFLARE =====
async function cfRequest(method, cfPath, body = null) {
  return new Promise(resolve => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({ hostname: 'api.cloudflare.com', path: `/client/v4${cfPath}`, method, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function pauseCloudflareZone(domain) {
  if (!CF_API_TOKEN) return null;
  try {
    const zones = await cfRequest('GET', `/zones?name=${domain}`);
    if (!zones?.result?.length) return null;
    const zoneId = zones.result[0].id;
    const r = await cfRequest('PATCH', `/zones/${zoneId}`, { paused: true });
    return r?.success ? zoneId : null;
  } catch { return null; }
}

async function unpauseCloudflareZone(domain, zoneId) {
  if (!CF_API_TOKEN) return;
  try {
    if (!zoneId) {
      const zones = await cfRequest('GET', `/zones?name=${domain}`);
      if (zones?.result?.length) zoneId = zones.result[0].id;
    }
    if (zoneId) {
      await cfRequest('PATCH', `/zones/${zoneId}`, { paused: false });
      console.log(`[CF] Unpause ${domain} done`);
    }
  } catch {}
}


// ===== TELEGRAM ALERT =====
function sendLineAlert(message) {
  sendTelegram(message);
}

function sendTelegram(message) {
  const token = TG_TOKEN;
  const chatId = TG_CHAT;
  if (!token || !chatId) { console.log('[Telegram] No token/chat configured'); return; }
  sendTelegramDirect(message, token, chatId);
}

function sendTelegramDirect(message, token, chatId) {
  return new Promise(resolve => {
    const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (!r.ok) console.error('[Telegram] Error:', r.description);
          else console.log('[Telegram] Sent OK');
          resolve(r.ok);
        } catch { resolve(false); }
      });
    });
    req.on('error', err => { console.error('[Telegram] Error:', err.message); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ===== CONFIG (local file — เล็กพอ) =====
const CONFIG_FILE = path.join('/tmp', 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { gsc: { clientId: '', clientSecret: '', refreshToken: '', accessToken: '' }, alerts: { lineToken: '', notifyOnDown: true, notifyOnExpiry: true, expiryDaysThreshold: 30 } }; }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

// ===== GSC =====
async function refreshGSCToken() {
  const cfg = loadConfig();
  if (!cfg.gsc?.refreshToken) return null;
  return new Promise(resolve => {
    const body = JSON.stringify({ client_id: cfg.gsc.clientId, client_secret: cfg.gsc.clientSecret, refresh_token: cfg.gsc.refreshToken, grant_type: 'refresh_token' });
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { const t = JSON.parse(data); if (t.access_token) { cfg.gsc.accessToken = t.access_token; saveConfig(cfg); resolve(t.access_token); } else resolve(null); } catch { resolve(null); } });
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
  return new Promise(resolve => {
    const body = JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: 1000 });
    const apiPath = `/webmasters/v3/sites/${encodeURIComponent(`https://${domainObj.domain}/`)}/searchAnalytics/query`;
    const req = https.request({ hostname: 'www.googleapis.com', path: apiPath, method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result?.rows) {
            const keywords = result.rows.map(r => ({ keyword: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 }));
            domainObj.gsc = { clicks: result.rows.reduce((s, r) => s + r.clicks, 0), impressions: result.rows.reduce((s, r) => s + r.impressions, 0), avgPosition: keywords.length ? Math.round(keywords.reduce((s, k) => s + k.position, 0) / keywords.length * 10) / 10 : 0, keywords, topKeyword: keywords[0]?.keyword || '-', topPosition: keywords[0]?.position || 0, keywordCount: keywords.length };
          }
        } catch {}
        resolve(domainObj);
      });
    });
    req.on('error', () => resolve(domainObj));
    req.write(body); req.end();
  });
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
  }).filter(r => r.domain || r['domain name']);
}

// ===== ROUTER =====
async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/api/domains') {
    const cfg = loadConfig();
    json(res, { domains: memoryDomains, lastUpdated, gscConnected: !!cfg.gsc?.accessToken, pleskConnected: !!(PLESK_HOST && PLESK_PASS), pleskHost: PLESK_HOST });
    return;
  }

  if (req.method === 'GET' && url === '/api/stats') {
    const d = memoryDomains;
    json(res, {
      total: d.length, up: d.filter(x => x.status === 'up').length,
      down: d.filter(x => x.status === 'down').length, warn: d.filter(x => x.status === 'warn').length,
      unknown: d.filter(x => x.status === 'unknown').length,
      withTraffic: d.filter(x => x.gsc?.clicks > 0).length,
      noTraffic: d.filter(x => x.gsc && x.gsc.clicks === 0).length,
      expiringIn30: d.filter(x => x.sslDaysLeft !== null && x.sslDaysLeft <= 30 && x.sslDaysLeft >= 0).length,
      pleskActive: d.filter(x => x.pleskActive === true).length,
      pleskSuspended: d.filter(x => x.pleskId && x.pleskActive === false).length,
      totalClicks: d.reduce((s, x) => s + (x.gsc?.clicks || 0), 0),
      totalImpressions: d.reduce((s, x) => s + (x.gsc?.impressions || 0), 0),
    });
    return;
  }

  if (req.method === 'POST' && url === '/api/plesk/sync') {
    if (!PLESK_HOST || !PLESK_PASS) { json(res, { error: 'ไม่มี Plesk credentials' }, 400); return; }
    syncPleskDomains().catch(console.error);
    json(res, { success: true, message: 'กำลัง sync โดเมนจาก Plesk...' });
    return;
  }

  if (req.method === 'GET' && url === '/api/plesk/status') {
    if (!PLESK_HOST || !PLESK_PASS) { json(res, { connected: false }); return; }
    try {
      const r = await pleskRequest('GET', '/server');
      json(res, { connected: r.status === 200, hostname: r.data?.hostname, version: r.data?.panel_version });
    } catch (e) { json(res, { connected: false, reason: e.message }); }
    return;
  }

  if (req.method === 'POST' && url === '/api/domains/add') {
    const body = await parseBody(req);
    const domain = body.domain?.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (!domain) { json(res, { error: 'ต้องระบุ domain' }, 400); return; }
    if (memoryDomains.find(d => d.domain === domain)) { json(res, { error: 'มีโดเมนนี้อยู่แล้ว' }, 409); return; }
    const newD = { domain, status: 'unknown', statusCode: 0, responseTime: 0, checkedAt: null, error: null, sslExpiry: null, sslDaysLeft: null, expiryDate: null, daysLeft: null, notes: body.notes || '', tags: body.tags || [], gsc: null, addedAt: new Date().toISOString() };
    memoryDomains.push(newD);
    await saveToSheets(memoryDomains);
    checkDomain(domain).then(r => { const idx = memoryDomains.findIndex(d => d.domain === domain); if (idx !== -1) { Object.assign(memoryDomains[idx], r); saveToSheets(memoryDomains); } });
    json(res, { success: true, domain: newD });
    return;
  }

  if (req.method === 'POST' && url === '/api/domains/import') {
    const body = await parseBody(req);
    const rows = parseCSV(body.csv || '');
    let added = 0, skipped = 0;
    rows.forEach(row => {
      const domain = (row.domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase().trim();
      if (!domain || memoryDomains.find(d => d.domain === domain)) { skipped++; return; }
      memoryDomains.push({ domain, status: 'unknown', statusCode: 0, responseTime: 0, checkedAt: null, error: null, sslExpiry: null, sslDaysLeft: null, expiryDate: row.expiry_date || null, daysLeft: row.days_left ? parseInt(row.days_left) : null, notes: row.notes || '', tags: row.tags ? row.tags.split(';') : [], gsc: null, addedAt: new Date().toISOString() });
      added++;
    });
    await saveToSheets(memoryDomains);
    setTimeout(() => checkAllDomains(), 500);
    json(res, { success: true, added, skipped, total: memoryDomains.length });
    return;
  }

  if (req.method === 'DELETE' && url.startsWith('/api/domains/')) {
    const domain = decodeURIComponent(url.split('/api/domains/')[1]);
    const before = memoryDomains.length;
    memoryDomains = memoryDomains.filter(d => d.domain !== domain);
    await saveToSheets(memoryDomains);
    json(res, { success: true, removed: before - memoryDomains.length });
    return;
  }

  if (req.method === 'POST' && url.startsWith('/api/check/')) {
    const domain = decodeURIComponent(url.split('/api/check/')[1]);
    const result = await checkDomain(domain);
    const idx = memoryDomains.findIndex(d => d.domain === domain);
    if (idx !== -1) { Object.assign(memoryDomains[idx], result); await saveToSheets(memoryDomains); }
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
    const idx = memoryDomains.findIndex(d => d.domain === domain);
    if (idx === -1) { json(res, { error: 'ไม่พบโดเมน' }, 404); return; }
    memoryDomains[idx] = await syncGSCForDomain(memoryDomains[idx]);
    await saveToSheets(memoryDomains);
    json(res, { success: true });
    return;
  }

  if (req.method === 'POST' && url === '/api/gsc/sync-all') {
    (async () => {
      for (let i = 0; i < memoryDomains.length; i++) {
        memoryDomains[i] = await syncGSCForDomain(memoryDomains[i]);
        if (i % 10 === 0) await saveToSheets(memoryDomains);
      }
      await saveToSheets(memoryDomains);
    })().catch(console.error);
    json(res, { success: true, message: 'Sync GSC กำลังทำงาน...' });
    return;
  }

  if (url === '/api/config') {
    if (req.method === 'GET') {
      const cfg = loadConfig();
      const safe = JSON.parse(JSON.stringify(cfg));
      if (safe.gsc?.clientSecret) safe.gsc.clientSecret = '***';
      if (safe.alerts?.lineToken) safe.alerts.lineToken = safe.alerts.lineToken.slice(0, 8) + '...';
      json(res, { ...safe, pleskHost: PLESK_HOST, pleskConnected: !!(PLESK_HOST && PLESK_PASS), sheetsConnected: !!(SHEET_ID && SERVICE_ACCOUNT?.client_email) });
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

  if (req.method === 'POST' && url.startsWith('/api/autofix/')) {
    const domain = decodeURIComponent(url.split('/api/autofix/')[1]);
    const idx = memoryDomains.findIndex(d => d.domain === domain);
    if (idx === -1) { json(res, { error: 'ไม่พบโดเมน' }, 404); return; }
    const domainObj = memoryDomains[idx];
    const actions = [];

    // 1. Plesk Unsuspend
    if (domainObj.pleskId && !domainObj.pleskActive) {
      const ok = await pleskUnsuspend(domainObj.pleskId);
      if (ok) {
        memoryDomains[idx].pleskActive = true;
        memoryDomains[idx].pleskStatus = 0;
        actions.push('Unsuspend Plesk สำเร็จ');
        sendTelegram(`Auto-fix: Unsuspend ${domain} via Plesk OK`);
      } else {
        actions.push('Unsuspend Plesk ไม่สำเร็จ');
      }
    }

    // 2. Cloudflare Pause ถ้าเป็น CF error
    if (CF_API_TOKEN && [521, 522, 523, 524].includes(domainObj.statusCode)) {
      const zoneId = await pauseCloudflareZone(domain);
      if (zoneId) {
        actions.push('Pause Cloudflare สำเร็จ');
        sendTelegram(`Auto-fix: Pause CF ${domain} (${domainObj.statusCode})`);
        // Unpause หลัง 10 นาทีถ้าเว็บกลับมา
        setTimeout(async () => {
          const r = await checkDomain(domain);
          if (r.status === 'up') {
            await unpauseCloudflareZone(domain, zoneId);
            sendTelegram(`${domain} กลับมาปกติแล้ว Unpause CF แล้ว`);
          }
          const i = memoryDomains.findIndex(d => d.domain === domain);
          if (i !== -1) { Object.assign(memoryDomains[i], r); await saveToSheets(memoryDomains); }
        }, 10 * 60 * 1000);
      } else {
        actions.push('Pause Cloudflare ไม่พบ zone');
      }
    }

    // เช็คสถานะใหม่หลัง 30 วินาที
    setTimeout(async () => {
      const r = await checkDomain(domain);
      const i = memoryDomains.findIndex(d => d.domain === domain);
      if (i !== -1) { Object.assign(memoryDomains[i], r); await saveToSheets(memoryDomains); }
    }, 30000);

    await saveToSheets(memoryDomains);
    const msg = actions.length ? actions.join(', ') : 'ไม่มีการแก้ไขอัตโนมัติ (ตรวจสอบเอง)';
    json(res, { success: true, message: msg, actions });
    return;
  }

  if (req.method === 'POST' && url === '/api/test-alert') {
    const body = await parseBody(req);
    const msg = body.message || 'DomainIntel Test Alert';
    // ใช้ token จาก request body ถ้ามี (สำหรับทดสอบ) หรือจาก env
    const testToken = body.telegramToken || TG_TOKEN;
    const testChat = body.telegramChatId || TG_CHAT;
    if (testToken && testChat) {
      await sendTelegramDirect(msg, testToken, testChat);
      json(res, { success: true });
    } else {
      json(res, { error: 'ไม่มี Telegram Token หรือ Chat ID' }, 400);
    }
    return;
  }

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
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║   DomainIntel + Plesk + Google Sheets    ║`);
  console.log(`║   http://localhost:${PORT}                 ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  // โหลดข้อมูลจาก Sheets ตอน start
  await initSheets();

  if (PLESK_HOST && PLESK_PASS && memoryDomains.length === 0) {
    console.log('[Plesk] ไม่มีข้อมูล — sync อัตโนมัติ...');
    await syncPleskDomains();
  }

  setInterval(checkAllDomains, CHECK_INTERVAL_MS);
  setInterval(() => syncPleskDomains(), PLESK_SYNC_INTERVAL_MS);
  console.log(`[Auto] เช็คโดเมนทุก ${CHECK_INTERVAL_MS/60000} นาที, Sync Plesk ทุก ${PLESK_SYNC_INTERVAL_MS/3600000} ชั่วโมง`);
});
