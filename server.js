/**
 * DomainIntel Backend Server v2.1
 * Plesk + Google Sheets + Agent Integration
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const PLESK_HOST = process.env.PLESK_HOST || '';
const PLESK_USER = process.env.PLESK_USER || 'admin';
const PLESK_PASS = process.env.PLESK_PASS || '';

// Multi-server support
let PLESK_SERVERS = [];
try {
  if (process.env.PLESK_SERVERS) {
    PLESK_SERVERS = JSON.parse(process.env.PLESK_SERVERS);
    console.log(`[Plesk] โหลด ${PLESK_SERVERS.length} servers จาก PLESK_SERVERS`);
  } else if (PLESK_HOST && PLESK_PASS) {
    // fallback to single server
    PLESK_SERVERS = [{ host: PLESK_HOST, user: PLESK_USER, pass: PLESK_PASS, name: 'Server 1' }];
  }
} catch(e) {
  console.error('[Plesk] ไม่สามารถ parse PLESK_SERVERS:', e.message);
  if (PLESK_HOST && PLESK_PASS) {
    PLESK_SERVERS = [{ host: PLESK_HOST, user: PLESK_USER, pass: PLESK_PASS, name: 'Server 1' }];
  }
}
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

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // เช็คทุก 5 นาที
const PLESK_SYNC_INTERVAL_MS = 1 * 60 * 60 * 1000; // Sync Plesk ทุก 1 ชั่วโมง
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
function pleskRequest(method, apiPath, body = null, server = null) {
  // ถ้าไม่ระบุ server ให้ใช้ server แรก
  const srv = server || PLESK_SERVERS[0] || { host: PLESK_HOST, user: PLESK_USER, pass: PLESK_PASS };
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${srv.user}:${srv.pass}`).toString('base64');
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({
      hostname: srv.host, port: 8443, path: `/api/v2${apiPath}`, method,
      headers, rejectUnauthorized: false
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
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

async function fetchPleskDomainsFromServer(srv) {
  try {
    console.log(`[Plesk] ดึงโดเมนจาก ${srv.name} (${srv.host})...`);
    const domsRes = await pleskRequest('GET', '/domains', null, srv);
    if (domsRes.status !== 200) {
      console.log(`[Plesk] ${srv.name} error: ${domsRes.status}`);
      return [];
    }
    const domains = Array.isArray(domsRes.data) ? domsRes.data : [];
    console.log(`[Plesk] ${srv.name} พบ ${domains.length} โดเมน`);

    // สร้าง domain list ก่อนโดยไม่รอ SSL
    const results = domains
      .filter(d => d.name || d.ascii_name)
      .map(d => ({
        domain: d.name || d.ascii_name,
        pleskId: d.id,
        pleskServer: srv.name,
        pleskHost: srv.host,
        pleskStatus: d.status || 'unknown',
        pleskActive: d.status === 0 || d.status === '0',
        hostingType: d.hosting_type || '',
        sslExpiry: null,
        sslDaysLeft: null,
        pleskSyncedAt: new Date().toISOString()
      }));

    // ดึง SSL แบบ parallel batch 20 ตัวพร้อมกัน (background ไม่บล็อก)
    const SSL_BATCH = 20;
    (async () => {
      for (let i = 0; i < results.length; i += SSL_BATCH) {
        const batch = results.slice(i, i + SSL_BATCH);
        await Promise.all(batch.map(async (r, bi) => {
          try {
            const d = domains.find(x => (x.name || x.ascii_name) === r.domain);
            if (!d) return;
            const sslRes = await pleskRequest('GET', `/domains/${d.id}/ssl-certificate`, null, srv);
            if (sslRes.status === 200 && sslRes.data?.valid_to) {
              const expDate = new Date(sslRes.data.valid_to);
              results[i + bi].sslExpiry = expDate.toISOString().split('T')[0];
              results[i + bi].sslDaysLeft = Math.floor((expDate - new Date()) / 86400000);
            }
          } catch {}
        }));
      }
      console.log(`[Plesk] ${srv.name} SSL sync เสร็จ`);
    })();

    return results;
  } catch (err) {
    console.error(`[Plesk] ${srv.name} Error:`, err.message);
    return [];
  }
}

async function fetchPleskDomains() {
  if (!PLESK_SERVERS.length) return [];
  const allResults = [];
  for (const srv of PLESK_SERVERS) {
    const domains = await fetchPleskDomainsFromServer(srv);
    allResults.push(...domains);
  }
  console.log(`[Plesk] รวมทั้งหมด ${allResults.length} โดเมนจาก ${PLESK_SERVERS.length} servers`);
  return allResults;
}

async function syncPleskDomains() {
  const pleskDomains = await fetchPleskDomains();
  if (!pleskDomains.length) return 0;
  let added = 0, updated = 0;
  for (const pd of pleskDomains) {
    const idx = memoryDomains.findIndex(d => d.domain === pd.domain);
    if (idx !== -1) {
      // อัพเดตเฉพาะข้อมูล Plesk ไม่แตะ HTTP status ที่เช็คไว้แล้ว
      const pleskFields = ['pleskId','pleskServer','pleskHost','pleskStatus','pleskActive','hostingType','sslExpiry','sslDaysLeft','pleskSyncedAt'];
      pleskFields.forEach(f => { if (pd[f] !== undefined) memoryDomains[idx][f] = pd[f]; });
      if (!memoryDomains[idx].tags) memoryDomains[idx].tags = [];
      if (!memoryDomains[idx].tags.includes('plesk')) memoryDomains[idx].tags.push('plesk');
      const serverTag = pd.pleskServer ? pd.pleskServer.toLowerCase().replace(/\s+/g,'-') : null;
      if (serverTag && !memoryDomains[idx].tags.includes(serverTag)) memoryDomains[idx].tags.push(serverTag);
      updated++;
    } else {
      const serverTag = pd.pleskServer ? pd.pleskServer.toLowerCase().replace(/\s+/g,'-') : 'plesk';
      memoryDomains.push({ domain: pd.domain, status: 'unknown', statusCode: 0, responseTime: 0, checkedAt: null, error: null, expiryDate: pd.sslExpiry, daysLeft: pd.sslDaysLeft, notes: `นำเข้าจาก ${pd.pleskServer || 'Plesk'}`, tags: ['plesk', serverTag], gsc: null, addedAt: new Date().toISOString(), ...pd });
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
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'th,en;q=0.9',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
    };
    const req = https.get(`https://${clean}`, { timeout: 12000, headers, rejectUnauthorized: false }, res => {
      const responseTime = Date.now() - start;
      const code = res.statusCode;
      const cfRay = res.headers['cf-ray'];
      const server = res.headers['server'] || '';
      const denyReason = res.headers['x-deny-reason'];

      // อ่าน body เล็กน้อยเพื่อตรวจ error page จาก Cloudflare
      let body = '';
      res.on('data', chunk => { if (body.length < 2000) body += chunk.toString(); });
      res.on('end', () => {
        // Railway proxy block
        if (denyReason) {
          resolve({ domain: clean, status: 'unknown', statusCode: code, responseTime, checkedAt: new Date().toISOString(), error: `Proxy block: ${denyReason}` });
          return;
        }

        let status = 'up', errorLabel = null;

        // Cloudflare error codes = down
        if (CF_DOWN_CODES.has(code)) {
          status = 'down';
          errorLabel = getErrorLabel(code);
        }
        // ตรวจ CF error page ใน body แม้ code จะเป็น 200/530
        else if (cfRay && (
          body.includes('Error 521') || body.includes('Web server is down') ||
          body.includes('Error 522') || body.includes('Error 523') ||
          body.includes('Error 524') || body.includes('Error 530') ||
          body.includes('Ray ID') && body.includes('origin') && body.includes('error')
        )) {
          status = 'down';
          const cfErr = body.match(/Error (5\d{2})/);
          errorLabel = cfErr ? `CF ${cfErr[1]} — Web server is down` : 'Cloudflare error page';
        }
        // 5xx จาก origin = down
        else if (code >= 500) {
          status = 'down';
          errorLabel = getErrorLabel(code);
        }
        // CF warn
        else if (CF_WARN_CODES.has(code)) {
          status = 'warn';
          errorLabel = getErrorLabel(code);
        }
        // 403 = up (บล็อก bot แต่เว็บทำงาน)
        else if (code === 403) {
          status = 'up';
          errorLabel = 'HTTP 403 (bot blocked)';
        }
        // 404 = up (เว็บทำงานแต่ไม่พบหน้า)
        else if (code === 404) {
          status = 'up';
        }
        // 200-399 = up
        else if (code >= 200 && code < 400) {
          status = 'up';
        }
        else {
          status = 'warn';
          errorLabel = `HTTP ${code}`;
        }

        resolve({ domain: clean, status, statusCode: code, responseTime, checkedAt: new Date().toISOString(), error: errorLabel });
      });
    });
    req.on('error', err => {
      resolve({ domain: clean, status: 'down', statusCode: 0, responseTime: Date.now() - start, checkedAt: new Date().toISOString(), error: getErrorLabel(0, err.message) });
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
    const ok = await pleskUnsuspend(domainObj.pleskId, domainObj.pleskHost);
    if (ok) {
      const idx = memoryDomains.findIndex(d => d.domain === domain);
      if (idx !== -1) { memoryDomains[idx].pleskActive = true; memoryDomains[idx].pleskStatus = 0; }
      console.log(`[AutoFix] Unsuspend ${domain} OK`);
      sendTelegram(`🔧 <b>Auto-Fix: Unsuspend Plesk สำเร็จ!</b>
🌐 โดเมน: <code>${domain}</code>
✅ เปิดใช้งานแล้ว
🕐 ${new Date().toLocaleString('th-TH')}`);
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
      sendTelegram(`☁️ <b>Auto-Fix: Pause Cloudflare สำเร็จ!</b>
🌐 โดเมน: <code>${domain}</code>
⚡ Error: CF ${code}
✅ Traffic ไป Origin โดยตรงแล้ว
🕐 ${new Date().toLocaleString('th-TH')}`);
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

  if (isNewDown && !fixed) sendTelegram(`🚨 <b>โดเมนล่ม!</b>
🌐 โดเมน: <code>${domain}</code>
❌ สาเหตุ: ${domainObj.error || 'HTTP ' + code}
⏱️ Response: ${domainObj.responseTime}ms
🕐 เวลา: ${new Date().toLocaleString('th-TH')}
👨‍💻 ไม่สามารถแก้อัตโนมัติได้ กรุณาตรวจสอบ`);
}

// ===== PLESK UNSUSPEND =====
async function pleskUnsuspend(pleskId, pleskHost = null) {
  if (!PLESK_SERVERS.length) return false;
  // หา server ที่ถูกต้องจาก pleskHost
  const srv = pleskHost
    ? PLESK_SERVERS.find(s => s.host === pleskHost) || PLESK_SERVERS[0]
    : PLESK_SERVERS[0];
  try {
    console.log(`[Plesk] Unsuspend domain ${pleskId} บน ${srv.name}...`);
    let result = await pleskRequest('PUT', `/domains/${pleskId}`, { status: 0 }, srv);
    if (result?.status === 200) return true;
    result = await pleskRequest('POST', `/domains/${pleskId}/enable`, null, srv);
    if (result?.status === 200) return true;
    result = await pleskRequest('POST', `/domains/${pleskId}/hosting/enable`, null, srv);
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
    // ลองหา zone หลายวิธี
    const domainVariants = [
      domain,
      domain.replace(/^www\./, ''), // ตัด www ออก
      domain.split('.').slice(-2).join('.'), // เอาแค่ root domain เช่น example.com
    ];
    
    for (const d of [...new Set(domainVariants)]) {
      console.log(`[CF] หา zone สำหรับ ${d}...`);
      const zones = await cfRequest('GET', `/zones?name=${d}&status=active`);
      if (zones?.result?.length) {
        const zoneId = zones.result[0].id;
        console.log(`[CF] พบ zone ${zoneId} สำหรับ ${d}`);
        const r = await cfRequest('PATCH', `/zones/${zoneId}`, { paused: true });
        if (r?.success) return zoneId;
      }
    }
    
    // ลองดึง zone ทั้งหมดแล้วค้นหา
    console.log(`[CF] ลองดึง zones ทั้งหมด...`);
    const allZones = await cfRequest('GET', '/zones?per_page=100&status=active');
    if (allZones?.result?.length) {
      const rootDomain = domain.split('.').slice(-2).join('.');
      const match = allZones.result.find(z => 
        z.name === domain || z.name === rootDomain || domain.endsWith('.' + z.name)
      );
      if (match) {
        console.log(`[CF] พบ zone ${match.id} (${match.name}) จากรายการทั้งหมด`);
        const r = await cfRequest('PATCH', `/zones/${match.id}`, { paused: true });
        if (r?.success) return match.id;
      }
      console.log(`[CF] Zones ที่มี:`, allZones.result.map(z => z.name).join(', '));
    }
    
    console.log(`[CF] ไม่พบ zone สำหรับ ${domain}`);
    return null;
  } catch(e) { 
    console.error(`[CF] Error:`, e.message);
    return null; 
  }
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


// ===== TELEGRAM BOT COMMANDS =====
async function handleTelegramMessage(msg) {
  const chatId = msg.chat?.id?.toString();
  const text = (msg.text || '').trim();
  if (!text) return;

  console.log(`[TG Bot] ข้อความจาก ${chatId}: ${text}`);

  // /status - สรุปภาพรวม
  if (text === '/status' || text === '/start') {
    const d = memoryDomains;
    const up = d.filter(x => x.status === 'up').length;
    const down = d.filter(x => x.status === 'down').length;
    const warn = d.filter(x => x.status === 'warn').length;
    const unknown = d.filter(x => x.status === 'unknown').length;
    const suspended = d.filter(x => x.pleskId && !x.pleskActive).length;
    sendTelegramTo(chatId, '📊 <b>DomainIntel สรุปภาพรวม</b>\n🌐 โดเมนทั้งหมด: '+d.length+'\n✅ Up: '+up+'\n🔴 Down: '+down+'\n⚠️ Warning: '+warn+'\n❓ Unknown: '+unknown+'\n🚫 Plesk Suspended: '+suspended+'\n🕐 อัพเดตล่าสุด: '+new Date().toLocaleString('th-TH'));
    return;
  }

  // /down - รายการโดเมนที่ Down
  if (text === '/down') {
    const downs = memoryDomains.filter(d => d.status === 'down').slice(0, 20);
    if (!downs.length) { sendTelegramTo(chatId, '✅ ไม่มีโดเมนที่ Down ตอนนี้'); return; }
    const list = downs.map((d,i) => (i+1)+'. '+d.domain+' - '+(d.error||'HTTP '+d.statusCode)).join('\n');
    const _downTotal = memoryDomains.filter(d=>d.status==='down').length;
    sendTelegramTo(chatId, '🔴 <b>โดเมนที่ Down ('+downs.length+' ตัว)</b>\n'+list+(_downTotal>20?'\n...และอีก '+(_downTotal-20)+' ตัว':''));
    return;
  }

  // /suspended - รายการ Plesk Suspended
  if (text === '/suspended') {
    const sus = memoryDomains.filter(d => d.pleskId && !d.pleskActive).slice(0, 20);
    if (!sus.length) { sendTelegramTo(chatId, '✅ ไม่มีโดเมนที่ Suspended'); return; }
    const list = sus.map((d,i) => (i+1)+'. '+d.domain+' - '+(d.pleskServer||'Plesk')).join('\n');
    sendTelegramTo(chatId, '🚫 <b>Plesk Suspended ('+sus.length+' ตัว)</b>\n'+list);
    return;
  }

  // /server1 /server2 /server3 /server4
  const serverMatch = text.match(/^\/server([1-4])$/);
  if (serverMatch) {
    const num = serverMatch[1];
    const srv = PLESK_SERVERS[parseInt(num)-1];
    const domains = memoryDomains.filter(d => d.pleskServer === `Server ${num}`);
    if (!srv) { sendTelegramTo(chatId, `❌ ไม่พบ Server ${num}`); return; }
    const up = domains.filter(d => d.status === 'up').length;
    const down = domains.filter(d => d.status === 'down').length;
    sendTelegramTo(chatId, '🖥️ <b>Server '+num+' ('+srv.host+')</b>\n📦 โดเมนทั้งหมด: '+domains.length+'\n✅ Up: '+up+'\n🔴 Down: '+down+'\n🚫 Suspended: '+domains.filter(d=>d.pleskId&&!d.pleskActive).length);
    return;
  }

  // /fix domain.com - Auto-fix โดเมน
  if (text.startsWith('/fix ')) {
    const domain = text.replace('/fix ', '').trim().toLowerCase();
    const domainObj = memoryDomains.find(d => d.domain === domain);
    if (!domainObj) { sendTelegramTo(chatId, `❌ ไม่พบโดเมน <code>${domain}</code>`); return; }
    sendTelegramTo(chatId, `⚙️ กำลัง Auto-fix <code>${domain}</code>...`);
    const actions = [];
    if (domainObj.pleskId && !domainObj.pleskActive) {
      const ok = await pleskUnsuspend(domainObj.pleskId, domainObj.pleskHost);
      if (ok) { const i = memoryDomains.findIndex(d=>d.domain===domain); if(i!==-1){memoryDomains[i].pleskActive=true;} actions.push('Unsuspend Plesk OK'); }
      else actions.push('Unsuspend Plesk FAILED');
    }
    if (CF_API_TOKEN && [521,522,523,524].includes(domainObj.statusCode)) {
      const zoneId = await pauseCloudflareZone(domain);
      if (zoneId) actions.push('Pause CF OK');
      else actions.push('CF zone not found');
    }
    await saveToSheets(memoryDomains);
    sendTelegramTo(chatId, actions.length ? `✅ Fix <code>${domain}</code>: ${actions.join(', ')}` : `⚠️ ไม่พบการแก้ไขอัตโนมัติสำหรับ <code>${domain}</code>`);
    return;
  }

  // ค้นหาโดเมน (พิมพ์ชื่อโดเมนตรงๆ)
  const searchTerm = text.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const found = memoryDomains.filter(d => d.domain.includes(searchTerm)).slice(0, 5);
  if (found.length === 0) {
    sendTelegramTo(chatId, `❌ ไม่พบโดเมน <code>${searchTerm}</code>`);
    return;
  }
  if (found.length === 1) {
    const d = found[0];
    const statusIcon = d.status === 'up' ? '✅' : d.status === 'down' ? '🔴' : d.status === 'warn' ? '⚠️' : '❓';
    const pleskStatus = d.pleskActive ? '✅ Active' : d.pleskId ? '🚫 Suspended' : '—';
    const srv = PLESK_SERVERS.find(s => s.host === d.pleskHost);
    const errLine = d.error ? '❌ Error: '+d.error+'\n' : '';
    const fixLine = (d.status==='down'||(d.pleskId&&!d.pleskActive)) ? '\n💡 พิมพ์ /fix '+d.domain+' เพื่อ Auto-fix' : '';
    const sslLine = d.sslDaysLeft!==null ? '('+d.sslDaysLeft+' วัน)' : '';
    sendTelegramTo(chatId, '🌐 <b>'+d.domain+'</b>\n'+statusIcon+' สถานะ: '+(d.status||'').toUpperCase()+' '+(d.statusCode?'('+d.statusCode+')':'')+' '+(d.responseTime?d.responseTime+'ms':'')+'\n'+errLine+'🖥️ Server: '+(d.pleskServer||'—')+' ('+(d.pleskHost||'—')+')\n👤 User: '+(srv?.user||'admin')+'\n⚡ Plesk: '+pleskStatus+'\n🔒 SSL: '+(d.sslExpiry||'—')+' '+sslLine+'\n🕐 เช็คล่าสุด: '+(d.checkedAt?new Date(d.checkedAt).toLocaleString('th-TH'):'—')+fixLine);
  } else {
    const list = found.map(d => (d.status==='up'?'✅':d.status==='down'?'🔴':'⚠️')+' '+d.domain+' - '+(d.pleskServer||'—')).join('\n');
    sendTelegramTo(chatId, '🔍 พบ '+found.length+' โดเมนที่ตรงกับ "'+searchTerm+'":\n'+list+'\n\n💡 พิมพ์ชื่อโดเมนแบบเต็มเพื่อดูรายละเอียด');
  }
}

function sendTelegramTo(chatId, message) {
  const token = TG_TOKEN;
  if (!token || !chatId) return;
  const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, () => {});
  req.on('error', () => {});
  req.write(body); req.end();
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
// ===== SERVER HEALTH (Plesk API) =====

async function getServerStats(srv) {
  try {
    // ดึงข้อมูล server info
    const serverInfo = await pleskRequest('GET', '/server', null, srv);
    
    // ดึงข้อมูล statistics
    const stats = await pleskRequest('GET', '/server/statistics', null, srv);
    
    // ดึง services status
    const services = await pleskRequest('GET', '/server/services', null, srv);

    return {
      name: srv.name,
      host: srv.host,
      connected: true,
      hostname: serverInfo?.data?.hostname,
      version: serverInfo?.data?.panel_version,
      stats: stats?.data || null,
      services: Array.isArray(services?.data) ? services.data : Array.isArray(services) ? services : [],
    };
  } catch(e) {
    return { name: srv.name, host: srv.host, connected: false, error: e.message };
  }
}

async function restartService(srv, serviceName) {
  try {
    console.log(`[Server] Restart ${serviceName} on ${srv.name}...`);
    // Plesk API: POST /server/services/{name}/restart
    const result = await pleskRequest('POST', `/server/services/${serviceName}/restart`, null, srv);
    if (result?.status === 200) {
      sendTelegram(`🔄 Restart ${serviceName} บน ${srv.name} สำเร็จ`);
      return { success: true };
    }
    return { success: false, error: result?.data };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ตรวจสอบ server health ทุก 5 นาที
async function checkServerHealth() {
  for (const srv of PLESK_SERVERS) {
    try {
      const services = await pleskRequest('GET', '/server/services', null, srv);
      if (!services?.data) continue;
      
      const svcList = Array.isArray(services?.data) ? services.data : 
                     Array.isArray(services) ? services : [];
      const stopped = svcList.filter(s => s.status !== 'running' && s.status !== 'active');
      for (const svc of stopped) {
        console.log(`[Health] ${srv.name}: ${svc.name} หยุดทำงาน! กำลัง restart...`);
        sendTelegram(`⚠️ <b>${srv.name}</b>: service <code>${svc.name}</code> หยุดทำงาน\nกำลัง restart อัตโนมัติ...`);
        await restartService(srv, svc.name);
      }
    } catch(e) {
      console.error(`[Health] ${srv.name}:`, e.message);
    }
  }
}

// ===== AGENT SYSTEM =====
const agentCommands = {}; // { server1: [{id, cmd, status}] }
const agentResults = {};  // { commandId: result }

function queueCommand(serverHost, command) {
  const id = Date.now() + '_' + Math.random().toString(36).slice(2);
  const serverKey = serverHost.replace(/\./g, '_');
  if (!agentCommands[serverKey]) agentCommands[serverKey] = [];
  agentCommands[serverKey].push({ id, cmd: command, status: 'pending', queuedAt: new Date().toISOString() });
  console.log(`[Agent] Queue command for ${serverHost}: ${command.slice(0,60)}`);
  return id;
}

async function runOnServer(serverName, command) {
  const srv = PLESK_SERVERS.find(s => 
    s.name === serverName || 
    s.host === serverName ||
    s.name.toLowerCase() === serverName.toLowerCase() ||
    s.name.toLowerCase().replace(/\s+/g,'') === serverName.toLowerCase().replace(/\s+/g,'')
  );
  if (!srv) throw new Error('ไม่พบ server: ' + serverName);
  const cmdId = queueCommand(srv.host, command);
  
  // รอผล max 30 วินาที
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (agentResults[cmdId]) {
      const result = agentResults[cmdId];
      delete agentResults[cmdId];
      return result;
    }
  }
  throw new Error('Agent timeout');
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
  const url = req.url.split('?')[0];
  const rawUrl = req.url;

  if (req.method === 'GET' && url === '/api/domains') {
    const cfg = loadConfig();
    // ส่ง server configs แบบ masked password
    const pleskServerConfigs = PLESK_SERVERS.map(s => ({
      name: s.name,
      host: s.host,
      user: s.user,
      pass: s.pass // frontend จะซ่อนด้วย *** แสดงเฉพาะตอนกดค้าง
    }));
    json(res, { domains: memoryDomains, lastUpdated, gscConnected: !!cfg.gsc?.accessToken, pleskConnected: PLESK_SERVERS.length > 0, pleskHost: PLESK_SERVERS.map(s=>s.name).join(', '), pleskServerConfigs });
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
    if (!PLESK_SERVERS.length) { json(res, { error: 'ไม่มี Plesk credentials' }, 400); return; }
    syncPleskDomains().catch(console.error);
    json(res, { success: true, message: 'กำลัง sync โดเมนจาก Plesk...' });
    return;
  }

  if (req.method === 'GET' && url === '/api/plesk/status') {
    if (!PLESK_SERVERS.length) { json(res, { connected: false, servers: [] }); return; }
    const statuses = [];
    for (const srv of PLESK_SERVERS) {
      try {
        const r = await pleskRequest('GET', '/server', null, srv);
        statuses.push({ name: srv.name, host: srv.host, connected: r.status === 200, hostname: r.data?.hostname, version: r.data?.panel_version });
      } catch (e) {
        statuses.push({ name: srv.name, host: srv.host, connected: false, reason: e.message });
      }
    }
    json(res, { connected: statuses.some(s => s.connected), servers: statuses });
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
      json(res, { ...safe, pleskHost: PLESK_SERVERS.map(s=>s.name).join(', '), pleskConnected: PLESK_SERVERS.length > 0, pleskServers: PLESK_SERVERS.length, sheetsConnected: !!(SHEET_ID && SERVICE_ACCOUNT?.client_email) });
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

  // Bulk auto-fix
  if (req.method === 'POST' && url === '/api/autofix-all') {
    const body = await parseBody(req);
    const domains = body.domains || [];
    const results = [];
    for (const domain of domains) {
      const idx = memoryDomains.findIndex(d => d.domain === domain);
      if (idx === -1) { results.push({ domain, success: false, message: 'ไม่พบโดเมน' }); continue; }
      const domainObj = memoryDomains[idx];
      if (domainObj.status !== 'down') { results.push({ domain, success: false, message: 'ไม่ใช่สถานะ Down' }); continue; }
      const actions = [];
      if (domainObj.pleskId && !domainObj.pleskActive) {
        const ok = await pleskUnsuspend(domainObj.pleskId, domainObj.pleskHost);
        if (ok) { memoryDomains[idx].pleskActive = true; actions.push('Unsuspend Plesk OK'); }
        else actions.push('Unsuspend Plesk FAILED');
      }
      if (CF_API_TOKEN && [521,522,523,524].includes(domainObj.statusCode)) {
        const zoneId = await pauseCloudflareZone(domain);
        if (zoneId) actions.push('Pause CF OK');
        else actions.push('Pause CF ไม่พบ zone');
      }
      results.push({ domain, success: true, message: actions.join(', ') || 'ไม่มีการแก้ไข' });
    }
    await saveToSheets(memoryDomains);
    // แจ้ง Telegram สรุป
    const fixed = results.filter(r => r.success && r.message !== 'ไม่มีการแก้ไข').length;
    if (fixed > 0) {
      sendTelegram(`🔧 <b>Bulk Auto-Fix สำเร็จ!</b>
✅ แก้ไขได้: ${fixed} โดเมน
📋 ทั้งหมด: ${domains.length} โดเมน
🕐 ${new Date().toLocaleString('th-TH')}`);
    }
    json(res, { success: true, results });
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
      const ok = await pleskUnsuspend(domainObj.pleskId, domainObj.pleskHost);
      if (ok) {
        memoryDomains[idx].pleskActive = true;
        memoryDomains[idx].pleskStatus = 0;
        actions.push('Unsuspend Plesk สำเร็จ');
        sendTelegram(`🔧 <b>Auto-Fix สำเร็จ!</b>
🌐 โดเมน: <code>${domain}</code>
⚡ การดำเนินการ: Unsuspend ผ่าน Plesk
✅ สถานะ: เปิดใช้งานแล้ว
🕐 เวลา: ${new Date().toLocaleString('th-TH')}`)
      } else {
        actions.push('Unsuspend Plesk ไม่สำเร็จ');
      }
    }

    // 2. Cloudflare Pause ถ้าเป็น CF error
    if (CF_API_TOKEN && [521, 522, 523, 524].includes(domainObj.statusCode)) {
      const zoneId = await pauseCloudflareZone(domain);
      if (zoneId) {
        actions.push('Pause Cloudflare สำเร็จ');
        sendTelegram(`☁️ <b>Auto-Fix Cloudflare!</b>
🌐 โดเมน: <code>${domain}</code>
⚡ การดำเนินการ: Pause Cloudflare (Error ${domainObj.statusCode})
✅ Traffic ไป Origin โดยตรงแล้ว
🕐 เวลา: ${new Date().toLocaleString('th-TH')}`);
        // Unpause หลัง 10 นาทีถ้าเว็บกลับมา
        setTimeout(async () => {
          const r = await checkDomain(domain);
          if (r.status === 'up') {
            await unpauseCloudflareZone(domain, zoneId);
            sendTelegram(`✅ <b>โดเมนกลับมาแล้ว!</b>
🌐 โดเมน: <code>${domain}</code>
☁️ Unpause Cloudflare แล้ว
🕐 ${new Date().toLocaleString('th-TH')}`);
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
    let noFixReason = 'ไม่พบสาเหตุที่แก้ไขอัตโนมัติได้';
    if (!domainObj.pleskId) noFixReason = 'ไม่พบข้อมูล Plesk — กรุณา Sync Plesk ใหม่';
    else if (domainObj.pleskActive && ![521,522,523,524].includes(domainObj.statusCode)) {
      noFixReason = `Plesk Active แล้ว และ Error ${domainObj.statusCode || 'Timeout'} — ปัญหาที่ Origin Server`;
      // mark as cannot-fix
      const cidx = memoryDomains.findIndex(d => d.domain === domain);
      if (cidx !== -1) memoryDomains[cidx].cannotAutoFix = true;
    } else if (!CF_API_TOKEN) {
      noFixReason = 'ไม่มี Cloudflare API Token';
    }
    const msg = actions.length ? actions.join(', ') : noFixReason;
    json(res, { success: true, message: msg, actions });
    return;
  }

  // Telegram Webhook
  if (req.method === 'POST' && url === '/api/telegram/webhook') {
    const body = await parseBody(req);
    const msg = body.message || body.edited_message;
    if (msg) await handleTelegramMessage(msg);
    json(res, { ok: true });
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

  // Server Health
  // Agent endpoints
  if (req.method === 'GET' && url.startsWith('/api/agent/commands')) {
    // parse host from raw URL (before query strip)
    const qmark = rawUrl.indexOf('?');
    const qs = qmark >= 0 ? rawUrl.slice(qmark + 1) : '';
    let host = '';
    qs.split('&').forEach(p => {
      const eq = p.indexOf('=');
      if (eq > 0) {
        const k = p.slice(0, eq);
        const v = p.slice(eq + 1);
        if (k === 'host') host = decodeURIComponent(v);
      }
    });
    const hostKey = host.replace(/\./g, '_');
    // search all keys in agentCommands
    const allKeys = Object.keys(agentCommands);
    const matchKey = allKeys.find(k => k === hostKey) || hostKey;
    const cmds = agentCommands[matchKey] || [];
    const pending = cmds.filter(c => c.status === 'pending');
    pending.forEach(c => c.status = 'sent');
    console.log('[Agent] host='+host+' key='+hostKey+' matchKey='+matchKey+' found='+pending.length+' allKeys='+allKeys.join(','));
    json(res, { commands: pending.map(c => ({ id: c.id, cmd: c.cmd })) });
    return;
  }

  if (req.method === 'POST' && url.startsWith('/api/agent/result')) {
    const body = await parseBody(req);
    const { commandId, output, exitCode, host } = body;
    if (commandId) {
      agentResults[commandId] = { output, exitCode, host };
      // mark command as done
      Object.values(agentCommands).forEach(cmds => {
        const cmd = cmds.find(c => c.id === commandId);
        if (cmd) { cmd.status = 'done'; cmd.result = output; }
      });
    }
    json(res, { ok: true });
    return;
  }

  // Run command on server via agent
  if (req.method === 'POST' && url.startsWith('/api/agent/run/')) {
    const serverName = decodeURIComponent(url.split('/api/agent/run/')[1]);
    const body = await parseBody(req);
    const { command, wait } = body;
    if (!command) { json(res, { error: 'ไม่มี command' }, 400); return; }
    const srv = PLESK_SERVERS.find(s => 
      s.name === serverName || s.host === serverName ||
      s.name.toLowerCase() === serverName.toLowerCase() ||
      s.name.toLowerCase().replace(/\s+/g,'') === serverName.toLowerCase().replace(/\s+/g,'')
    );
    if (!srv) { json(res, { error: 'ไม่พบ server: '+serverName }, 404); return; }
    const cmdId = queueCommand(srv.host, command);
    if (!wait) {
      // ตอบทันทีไม่รอผล
      json(res, { success: true, cmdId, message: 'คำสั่งถูก queue แล้ว' });
      return;
    }
    // wait=true: รอผล 30 วินาที
    try {
      const result = await runOnServer(serverName, command);
      json(res, { success: true, ...result });
    } catch(e) {
      json(res, { success: false, error: e.message });
    }
    return;
  }

  // Debug agent queue
  if (req.method === 'GET' && url === '/api/agent/debug') {
    json(res, { 
      commands: agentCommands, 
      results: Object.keys(agentResults),
      servers: PLESK_SERVERS.map(s => ({ name: s.name, host: s.host, key: s.host.replace(/\./g,'_') }))
    });
    return;
  }

  // Get result by cmdId
  if (req.method === 'GET' && url.startsWith('/api/agent/result/')) {
    const cmdId = url.split('/api/agent/result/')[1];
    if (agentResults[cmdId]) {
      const result = agentResults[cmdId];
      delete agentResults[cmdId];
      json(res, { success: true, ...result });
    } else {
      json(res, { success: false, pending: true });
    }
    return;
  }

  // Fix all servers PHP-FPM via agent
  if (req.method === 'POST' && url === '/api/agent/fix-phpfpm') {
    const body = await parseBody(req);
    const serverName = body.server || 'all';
    const servers = serverName === 'all' ? PLESK_SERVERS : PLESK_SERVERS.filter(s => s.name === serverName);
    const results = [];
    for (const srv of servers) {
      try {
        const result = await runOnServer(srv.name, 
          "sed -i 's/pm = ondemand/pm = static/' /etc/sw-engine/pool.d/plesk.conf 2>/dev/null; " +
          "sed -i 's/pm.max_children = [0-9]*/pm.max_children = 40/' /etc/sw-engine/pool.d/plesk.conf 2>/dev/null; " +
          "systemctl restart sw-engine 2>&1; echo 'Done'"
        );
        results.push({ server: srv.name, success: true, output: result.output });
        sendTelegram(`✅ Fix PHP-FPM <b>${srv.name}</b> สำเร็จ`);
      } catch(e) {
        results.push({ server: srv.name, success: false, error: e.message });
        sendTelegram(`❌ Fix PHP-FPM <b>${srv.name}</b> ล้มเหลว: ${e.message}`);
      }
    }
    json(res, { results });
    return;
  }

  // Get server stats via agent
  if (req.method === 'GET' && url.startsWith('/api/agent/stats/')) {
    const serverName = decodeURIComponent(url.split('/api/agent/stats/')[1]);
    try {
      const result = await runOnServer(serverName,
        "echo CPU:$(top -bn1 | grep 'Cpu(s)' | awk '{print $2}'); " +
        "free -m | awk 'NR==2{printf \"RAM:%s/%s\", $3,$2}'; " +
        "df -h / | awk 'NR==2{printf \" DISK:%s/%s\", $3,$2}'; " +
        "echo ' LOAD:'$(uptime | awk -F'load average:' '{print $2}')"
      );
      json(res, { success: true, stats: result.output, server: serverName });
    } catch(e) {
      json(res, { success: false, error: e.message });
    }
    return;
  }

  if (req.method === 'GET' && url === '/api/server/health') {
    const results = await Promise.all(PLESK_SERVERS.map(srv => getServerStats(srv)));
    json(res, { servers: results });
    return;
  }

  if (req.method === 'GET' && url.startsWith('/api/server/stats/')) {
    const serverName = decodeURIComponent(url.split('/api/server/stats/')[1]);
    const srv = PLESK_SERVERS.find(s => s.name === serverName || s.host === serverName);
    if (!srv) { json(res, { error: 'ไม่พบ server' }, 404); return; }
    const result = await getServerStats(srv);
    json(res, result);
    return;
  }

  if (req.method === 'POST' && url.startsWith('/api/server/restart/')) {
    const parts = url.split('/api/server/restart/')[1].split('/');
    const serverName = decodeURIComponent(parts[0]);
    const serviceName = decodeURIComponent(parts[1] || 'httpd');
    const srv = PLESK_SERVERS.find(s => s.name === serverName || s.host === serverName);
    if (!srv) { json(res, { error: 'ไม่พบ server' }, 404); return; }
    const result = await restartService(srv, serviceName);
    json(res, result);
    return;
  }

  if (req.method === 'GET' && url.startsWith('/api/server/logs/')) {
    const serverName = decodeURIComponent(url.split('/api/server/logs/')[1]);
    const srv = PLESK_SERVERS.find(s => s.name === serverName || s.host === serverName);
    if (!srv) { json(res, { error: 'ไม่พบ server' }, 404); return; }
    try {
      // ดึง event log จาก Plesk
      const logs = await pleskRequest('GET', '/eventlog?count=50', null, srv);
      json(res, { logs: logs?.data || [] });
    } catch(e) { json(res, { error: e.message }, 500); }
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

// ===== PROACTIVE MONITOR =====
async function proactiveMonitor() {
  for (const srv of PLESK_SERVERS) {
    try {
      const statCmd2 = 'L=$(cat /proc/loadavg | cut -d" " -f1); D=$(df / | tail -1 | tr -s " " | cut -d" " -f5 | tr -d "%"); echo LOAD:$L DISK:$D';
      const cmdId = queueCommand(srv.host, statCmd2);
      setTimeout(async () => {
        const result = agentResults[cmdId];
        if (!result) return;
        delete agentResults[cmdId];
        const output = result.output || '';
        const load = parseFloat((output.match(/LOAD:([\d.]+)/) || [])[1] || 0);
        const disk = parseInt((output.match(/DISK:(\d+)/) || [])[1] || 0);
        
        if (load > 15) {
          sendTelegram(`⚠️ <b>Proactive Alert!</b>
🖥️ ${srv.name}: Load Average สูง <b>${load}</b>
กำลัง Fix อัตโนมัติ...`);
          queueCommand(srv.host, 
            'pkill -f "wp-toolkit" 2>/dev/null; pkill -f "auto-update" 2>/dev/null; ' +
            'systemctl restart sw-engine; echo "Auto-fixed"'
          );
        }
        if (disk > 80) {
          sendTelegram(`⚠️ <b>Disk Warning!</b>
🖥️ ${srv.name}: Disk ใช้ไป <b>${disk}%</b>
กรุณาตรวจสอบ!`);
        }
      }, 35000);
    } catch(e) {
      console.error('[Proactive]', srv.name, e.message);
    }
  }
}

// ===== SMART STATUS CHECKER =====
const domainDownHistory = {}; // track consecutive down counts

async function smartStatusCheck() {
  const downDomains = memoryDomains.filter(d => d.status === 'down');
  const upDomains = memoryDomains.filter(d => d.status === 'up');
  
  // Re-check down domains
  for (const domain of downDomains.slice(0, 20)) {
    try {
      const result = await checkDomain(domain.domain);
      const idx = memoryDomains.findIndex(d => d.domain === domain.domain);
      if (idx === -1) continue;
      
      if (result.status === 'up') {
        // Domain recovered!
        memoryDomains[idx].status = 'up';
        memoryDomains[idx].statusCode = result.statusCode;
        memoryDomains[idx].error = null;
        memoryDomains[idx].recoveredAt = new Date().toISOString();
        delete domainDownHistory[domain.domain];
        sendTelegram(`✅ <b>โดเมนกลับมาแล้ว!</b>
🌐 <code>${domain.domain}</code>
⏱️ Response: ${result.responseTime}ms`);
        console.log(`[Smart] ${domain.domain} recovered!`);
      } else {
        // Still down - increment counter
        domainDownHistory[domain.domain] = (domainDownHistory[domain.domain] || 0) + 1;
        // diagnose after 3 consecutive checks
        if (domainDownHistory[domain.domain] === 3) {
          await diagnoseDomain(memoryDomains[idx]);
        }
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  
  await saveToSheets(memoryDomains);
}

async function checkDomain(domain) {
  return new Promise(resolve => {
    const protocol = 'https';
    const options = {
      hostname: domain,
      port: 443,
      path: '/',
      method: 'HEAD',
      timeout: 10000,
      rejectUnauthorized: false,
      headers: { 'User-Agent': 'DomainIntel-Monitor/1.0' }
    };
    const startTime = Date.now();
    const req = https.request(options, res => {
      resolve({ status: res.statusCode < 500 ? 'up' : 'down', statusCode: res.statusCode, responseTime: Date.now() - startTime });
    });
    req.on('error', () => resolve({ status: 'down', statusCode: 0, error: 'Connection failed' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'down', statusCode: 0, error: 'Timeout' }); });
    req.end();
  });
}

// ===== DOMAIN DIAGNOSIS =====
const diagnosisCache = {};

async function diagnoseDomain(domain) {
  if (diagnosisCache[domain.domain] && Date.now() - diagnosisCache[domain.domain] < 30 * 60 * 1000) return;
  diagnosisCache[domain.domain] = Date.now();
  
  let cause = 'unknown';
  let fix = 'manual';
  let autoFixed = false;
  
  // Check 1: Plesk Suspended
  if (domain.pleskId && !domain.pleskActive) {
    cause = 'plesk_suspended';
    fix = 'auto_unsuspend';
    const ok = await pleskUnsuspend(domain.pleskId, domain.pleskHost);
    if (ok) {
      autoFixed = true;
      const idx = memoryDomains.findIndex(d => d.domain === domain.domain);
      if (idx !== -1) memoryDomains[idx].pleskActive = true;
    }
  }
  // Check 2: Cloudflare error
  else if ([521, 522, 523, 524].includes(domain.statusCode)) {
    cause = 'cloudflare_error';
    fix = 'auto_pause_cf';
    if (CF_API_TOKEN) {
      const zoneId = await pauseCloudflareZone(domain.domain);
      if (zoneId) autoFixed = true;
    }
  }
  // Check 3: 502/503 - restart services via agent
  else if ([502, 503].includes(domain.statusCode) && domain.pleskHost) {
    cause = 'service_error_502_503';
    fix = 'auto_restart_service';
    const srv = PLESK_SERVERS.find(s => s.host === domain.pleskHost);
    if (srv) {
      queueCommand(srv.host, 'systemctl restart sw-engine; systemctl restart httpd 2>/dev/null; echo "Restarted"');
      autoFixed = true;
    }
  }
  // Check 4: Timeout
  else if (domain.error && domain.error.includes('timeout')) {
    cause = 'timeout';
    fix = 'check_server_load';
    const srv = PLESK_SERVERS.find(s => s.host === domain.pleskHost);
    if (srv) queueCommand(srv.host, 'uptime');
  }
  // Check 5: SSL expired
  else if (domain.sslDaysLeft !== null && domain.sslDaysLeft <= 0) {
    cause = 'ssl_expired';
    fix = 'renew_ssl';
  }
  
  // Save diagnosis
  const idx = memoryDomains.findIndex(d => d.domain === domain.domain);
  if (idx !== -1) {
    memoryDomains[idx].diagnosis = { cause, fix, autoFixed, diagnosedAt: new Date().toISOString() };
  }
  
  const causeLabels = {
    'plesk_suspended': 'Plesk Suspended',
    'cloudflare_error': 'Cloudflare Error',
    'service_error_502_503': '502/503 Service Error',
    'timeout': 'Connection Timeout',
    'ssl_expired': 'SSL หมดอายุ',
    'unknown': 'ไม่ทราบสาเหตุ'
  };
  
  const fixLabels = {
    'auto_unsuspend': '✅ Auto-Unsuspend แล้ว',
    'auto_pause_cf': '✅ Auto-Pause Cloudflare แล้ว',
    'auto_restart_service': '✅ Auto-Restart Service แล้ว',
    'check_server_load': '⚠️ ตรวจสอบ Server Load',
    'renew_ssl': '⚠️ ต้อง Renew SSL',
    'manual': '⚠️ ต้องแก้ไขเอง'
  };
  
  sendTelegram(
    `🔍 <b>วิเคราะห์โดเมน Down</b>
` +
    `🌐 <code>${domain.domain}</code>
` +
    `📊 Status: ${domain.statusCode || 'Timeout'}
` +
    `🔴 สาเหตุ: ${causeLabels[cause] || cause}
` +
    `🔧 การแก้ไข: ${fixLabels[fix] || fix}
` +
    `${autoFixed ? '✅ แก้ไขอัตโนมัติแล้ว' : '⚠️ ต้องการการแก้ไขเพิ่มเติม'}`
  );
  
  console.log(`[Diagnosis] ${domain.domain}: ${cause} → ${fix} (autoFixed: ${autoFixed})`);
}

// ===== SSL AUTO RENEWAL =====
async function checkSSLRenewal() {
  const expiringSoon = memoryDomains.filter(d => d.sslDaysLeft !== null && d.sslDaysLeft <= 14 && d.sslDaysLeft > 0);
  for (const domain of expiringSoon) {
    if (domain.sslRenewNotified && Date.now() - new Date(domain.sslRenewNotified).getTime() < 24 * 60 * 60 * 1000) continue;
    
    const idx = memoryDomains.findIndex(d => d.domain === domain.domain);
    if (idx !== -1) memoryDomains[idx].sslRenewNotified = new Date().toISOString();
    
    const urgency = domain.sslDaysLeft <= 3 ? '🚨' : domain.sslDaysLeft <= 7 ? '🔴' : '⚠️';
    sendTelegram(
      `${urgency} <b>SSL ใกล้หมดอายุ!</b>
` +
      `🌐 <code>${domain.domain}</code>
` +
      `📅 หมดอายุใน <b>${domain.sslDaysLeft} วัน</b> (${domain.sslExpiry || '—'})
` +
      `🖥️ Server: ${domain.pleskServer || '—'}
` +
      `💡 กรุณา Renew SSL ใน Plesk`
    );
    console.log(`[SSL] ${domain.domain} expires in ${domain.sslDaysLeft} days`);
  }
}

// ===== BLACKLIST MONITOR =====
async function checkBlacklists() {
  const serverIPs = [...new Set(PLESK_SERVERS.map(s => s.host))];
  for (const ip of serverIPs) {
    try {
      // Check via DNS blacklist (DNSBL)
      const reversed = ip.split('.').reverse().join('.');
      const blacklists = ['zen.spamhaus.org', 'bl.spamcop.net', 'dnsbl.sorbs.net'];
      for (const bl of blacklists) {
        await new Promise((resolve, reject) => {
          require('dns').lookup(`${reversed}.${bl}`, (err, addr) => {
            if (!err && addr) {
              const srv = PLESK_SERVERS.find(s => s.host === ip);
              sendTelegram(`🚨 <b>IP Blacklisted!</b>
🖥️ ${srv?.name || ip} (${ip})
📋 Blacklist: ${bl}
💡 ต้องติดต่อ provider เพื่อ delist`);
              console.log(`[Blacklist] ${ip} found in ${bl}`);
            }
            resolve();
          });
        });
      }
    } catch(e) {}
  }
}

// ===== WEEKLY REPORT =====
let weeklyStats = { fixed: 0, checked: 0, uptime: 0, startTime: Date.now() };

function updateWeeklyStats(fixed, checked) {
  weeklyStats.fixed += fixed;
  weeklyStats.checked += checked;
}

async function sendWeeklyReport() {
  const upDomains = memoryDomains.filter(d => d.status === 'up').length;
  const downDomains = memoryDomains.filter(d => d.status === 'down').length;
  const uptimePct = memoryDomains.length ? Math.round(upDomains / memoryDomains.length * 100) : 0;
  const sslExpiring = memoryDomains.filter(d => d.sslDaysLeft !== null && d.sslDaysLeft <= 30).length;
  const uptimeHours = Math.round((Date.now() - weeklyStats.startTime) / 3600000);
  
  sendTelegram(
    `📊 <b>Weekly Report — DomainIntel</b>

` +
    `🌐 โดเมนทั้งหมด: ${memoryDomains.length}
` +
    `✅ Up: ${upDomains} (${uptimePct}%)
` +
    `🔴 Down: ${downDomains}
` +
    `🔧 Auto-fixed: ${weeklyStats.fixed} ครั้ง
` +
    `🔍 เช็คทั้งหมด: ${weeklyStats.checked} ครั้ง
` +
    `🔒 SSL ใกล้หมด: ${sslExpiring} โดเมน
` +
    `⏱️ System Uptime: ${uptimeHours} ชั่วโมง

` +
    `🕐 ${new Date().toLocaleString('th-TH')}`
  );
  
  // Reset stats
  weeklyStats = { fixed: 0, checked: 0, uptime: 0, startTime: Date.now() };
}

server.listen(PORT, async () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║   DomainIntel + Plesk + Google Sheets    ║`);
  console.log(`║   http://localhost:${PORT}                 ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  // โหลดข้อมูลจาก Sheets ตอน start
  await initSheets();

  if (PLESK_SERVERS.length > 0 && memoryDomains.length === 0) {
    console.log('[Plesk] ไม่มีข้อมูล — sync อัตโนมัติจาก ' + PLESK_SERVERS.length + ' servers...');
    await syncPleskDomains();
  }

  setInterval(checkAllDomains, CHECK_INTERVAL_MS);
  setInterval(() => syncPleskDomains(), PLESK_SYNC_INTERVAL_MS);
  setInterval(checkServerHealth, CHECK_INTERVAL_MS);
  setInterval(proactiveMonitor, CHECK_INTERVAL_MS); // Proactive monitor ทุก 5 นาที
  setInterval(smartStatusCheck, CHECK_INTERVAL_MS * 2); // Smart status check ทุก 10 นาที
  setInterval(checkSSLRenewal, 6 * 60 * 60 * 1000); // SSL check ทุก 6 ชั่วโมง
  setInterval(checkBlacklists, 24 * 60 * 60 * 1000); // Blacklist check ทุกวัน
  setInterval(sendWeeklyReport, 7 * 24 * 60 * 60 * 1000); // Weekly report ทุก 7 วัน
  console.log(`[Auto] เช็คโดเมนทุก ${CHECK_INTERVAL_MS/60000} นาที, Sync Plesk ทุก ${PLESK_SYNC_INTERVAL_MS/3600000} ชั่วโมง`);
  console.log('[Auto] Proactive Monitor, Smart Status Check, SSL Renewal, Blacklist Monitor เริ่มทำงาน');
});
