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
const HEADERS = ['domain','status','statusCode','responseTime','checkedAt','error','pleskId','pleskStatus','pleskActive','hostingType','sslExpiry','sslDaysLeft','notes','tags','gscClicks','gscImpressions','gscAvgPosition','gscKeywordCount','gscTopKeyword','gscTopPosition','pleskSyncedAt','addedAt','pleskServer','pleskHost'];

function domainToRow(d) {
  return [
    d.domain || '', d.status || 'unknown', d.statusCode || 0, d.responseTime || 0,
    d.checkedAt || '', d.error || '', d.pleskId || '', d.pleskStatus || '',
    d.pleskActive ? 'true' : 'false', d.hostingType || '',
    d.sslExpiry || '', d.sslDaysLeft !== null && d.sslDaysLeft !== undefined ? d.sslDaysLeft : '',
    d.notes || '', (d.tags || []).join(';'),
    d.gsc?.clicks || 0, d.gsc?.impressions || 0, d.gsc?.avgPosition || 0,
    d.gsc?.keywordCount || 0, d.gsc?.topKeyword || '', d.gsc?.topPosition || 0,
    d.pleskSyncedAt || '', d.addedAt || new Date().toISOString(),
    d.pleskServer || '', d.pleskHost || ''
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
    pleskServer: row[22] || '', pleskHost: row[23] || '',
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
  loadTasks();
  console.log('[Tasks] โหลด', memoryTasks.length, 'tasks');
  loadEmployeeState();
  loadApprovals();
  loadReports();
  console.log('[Employees] พนักงาน', EMPLOYEES.length, 'คน | รออนุมัติ', approvalQueue.filter(a=>a.status==='pending').length);
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
        pleskActive: d.status === 0 || d.status === '0' || d.status === null || d.status === undefined || d.status === '',
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

let isCheckingDomains = false;
async function checkAllDomains() {
  if (!memoryDomains.length) return;
  if (isCheckingDomains) { console.log('[Check] already running, skip'); return; }
  isCheckingDomains = true;

  // เช็คเฉพาะโดเมนที่อยู่บนโฮสเรา — ข้าม GSC-only (import มาเป็น property เฉยๆ ไม่ได้อยู่บน server)
  const isGscOnly = d => {
    const tags = d.tags || [];
    return tags.includes('gsc') && !tags.includes('plesk') && !d.pleskServer;
  };
  const checkable = memoryDomains.filter(d => !isGscOnly(d));

  // reset GSC-only ที่เคยถูก mark down ให้เป็น unknown (ครั้งเดียว)
  memoryDomains.forEach(d => {
    if (isGscOnly(d) && d.status === 'down') {
      d.status = 'unknown'; d.statusCode = 0; d.error = null;
    }
  });

  console.log(`[Check] ${checkable.length} domains (ข้าม GSC-only ${memoryDomains.length - checkable.length})...`);
  const BATCH = 10; // ลดจาก 20 เป็น 10 เพื่อลด memory
  let downCount = 0;
  try {
    for (let i = 0; i < checkable.length; i += BATCH) {
      const batch = checkable.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(d => checkDomain(d.domain)));
      for (const r of results) {
        const idx = memoryDomains.findIndex(d => d.domain === r.domain);
        if (idx === -1) continue;
        const prev = memoryDomains[idx].status;
        Object.assign(memoryDomains[idx], r);
      // Track performance
      if (r.responseTime && r.status === 'up') trackPerformance(r.domain, r.responseTime);
        // Track SLA uptime
        recordUptimeCheck(r.domain, r.status === 'up');
        if (r.status === 'down') { downCount++; autoFix(memoryDomains[idx], prev).catch(()=>{}); }
      }
      // หยุดพัก 200ms ระหว่าง batch เพื่อลด memory spike
      await new Promise(r => setTimeout(r, 200));
      // Save ทุก 100 โดเมน แทนที่จะรอจนครบ
      if ((i + BATCH) % 100 === 0) {
        await saveToSheets(memoryDomains).catch(()=>{});
      }
    }
    await saveToSheets(memoryDomains);
    console.log(`[Check] done — down: ${downCount}`);
  } catch(e) {
    console.error('[Check] error:', e.message);
  } finally {
    isCheckingDomains = false;
  }
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
      smartAlert('info', `🔧 Auto-Fix: Unsuspend Plesk สำเร็จ</b>
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
      smartAlert('info', `☁️ Auto-Fix: Pause Cloudflare สำเร็จ</b>
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

  if (isNewDown && !fixed) smartAlert('critical', `🚨 โดเมนล่ม
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
// cache token in memory
let _gscToken = null;
let _gscTokenExp = 0;

async function refreshGSCToken() {
  if (_gscToken && Date.now() < _gscTokenExp) return _gscToken;
  const cid = process.env.GSC_CLIENT_ID;
  const csec = process.env.GSC_CLIENT_SECRET;
  const rtok = process.env.GSC_REFRESH_TOKEN;
  if (!cid || !csec || !rtok) { console.log('[GSC] env vars missing'); return null; }
  return new Promise(resolve => {
    const body = JSON.stringify({ client_id: cid, client_secret: csec, refresh_token: rtok, grant_type: 'refresh_token' });
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const t = JSON.parse(data);
          if (t.access_token) {
            _gscToken = t.access_token;
            _gscTokenExp = Date.now() + ((t.expires_in||3600) - 120) * 1000;
            console.log('[GSC] Token refreshed OK');
            resolve(t.access_token);
          } else { console.log('[GSC] Token error:', JSON.stringify(t).slice(0,80)); resolve(null); }
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', e => { console.log('[GSC] error:', e.message); resolve(null); });
    req.write(body); req.end();
  });
}

// cache site list
let _gscSites = null;

async function getGSCSiteList(token) {
  if (_gscSites) return _gscSites;
  return new Promise(resolve => {
    const req = https.request({ hostname: 'www.googleapis.com', path: '/webmasters/v3/sites', headers: { 'Authorization': 'Bearer ' + token } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const sites = (JSON.parse(d).siteEntry || []).map(s => s.siteUrl.toLowerCase().replace(/\/$/,''));
          _gscSites = sites;
          console.log('[GSC] Site list loaded:', sites.length);
          resolve(sites);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

// ดึงข้อมูล GSC สำหรับ 1 period
function fetchGSCPeriod(token, siteUrl, days) {
  return new Promise(resolve => {
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    const body = JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: 1000 });
    const apiPath = '/webmasters/v3/sites/' + encodeURIComponent(siteUrl + '/') + '/searchAnalytics/query';
    const req = https.request({
      hostname: 'www.googleapis.com', path: apiPath, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const rows = JSON.parse(data)?.rows || [];
          const kw = rows.map(r => ({ keyword: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position*10)/10 }));
          resolve({
            clicks: rows.reduce((s,r) => s+r.clicks, 0),
            impressions: rows.reduce((s,r) => s+r.impressions, 0),
            avgPosition: kw.length ? Math.round(kw.reduce((s,k) => s+k.position,0)/kw.length*10)/10 : 0,
            keywords: kw, topKeyword: kw[0]?.keyword||'-', topPosition: kw[0]?.position||0,
            keywordCount: kw.length
          });
        } catch(e) {
          resolve({ clicks:0, impressions:0, avgPosition:0, keywords:[], topKeyword:'-', topPosition:0, keywordCount:0 });
        }
      });
    });
    req.on('error', () => resolve({ clicks:0, impressions:0, avgPosition:0, keywords:[], topKeyword:'-', topPosition:0, keywordCount:0 }));
    req.write(body); req.end();
  });
}

async function syncGSCForDomain(domainObj) {
  const token = await refreshGSCToken();
  if (!token) return domainObj;
  const sites = await getGSCSiteList(token);
  const normalized = 'https://' + domainObj.domain.toLowerCase().replace(/\/$/,'');
  if (sites.indexOf(normalized) < 0) return domainObj;

  // ดึงข้อมูล 3 periods พร้อมกัน
  const [d7, d30, d90] = await Promise.all([
    fetchGSCPeriod(token, normalized, 7),
    fetchGSCPeriod(token, normalized, 30),
    fetchGSCPeriod(token, normalized, 90)
  ]);

  domainObj.gsc = {
    inGSC: true,
    // default แสดงข้อมูล 30 วัน
    clicks: d30.clicks, impressions: d30.impressions,
    avgPosition: d30.avgPosition, keywords: d30.keywords,
    topKeyword: d30.topKeyword, topPosition: d30.topPosition,
    keywordCount: d30.keywordCount,
    // เก็บแยกทุก period
    d7, d30, d90,
    syncedAt: new Date().toISOString()
  };
  console.log('[GSC] ' + domainObj.domain + ': 7d=' + d7.clicks + ' 30d=' + d30.clicks + ' 90d=' + d90.clicks);
  return domainObj;
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
      smartAlert('info', `🔄 Restart ${serviceName} บน ${srv.name} สำเร็จ`);
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
        smartAlert('warning', `⚠️ ${srv.name}: service ${svc.name} หยุดทำงาน\nกำลัง restart อัตโนมัติ...`);
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
    json(res, { domains: memoryDomains, lastUpdated, gscConnected: !!process.env.GSC_REFRESH_TOKEN, pleskConnected: PLESK_SERVERS.length > 0, pleskHost: PLESK_SERVERS.map(s=>s.name).join(', '), pleskServerConfigs });
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

  // Debug: เช็ค domain overlap ระหว่าง GSC และ DomainIntel
  // Import domains จาก GSC เข้า DomainIntel
  if (req.method === 'POST' && url === '/api/gsc/import-domains') {
    (async () => {
      const token = await refreshGSCToken();
      if (!token) return json(res, { error: 'no token' });

      _gscSites = null;
      const sites = await getGSCSiteList(token);
      const existingDomains = new Set(memoryDomains.map(d => d.domain.toLowerCase()));

      let imported = 0;
      const newDomains = [];

      for (const site of sites) {
        // แปลง https://domain.com → domain.com
        const domain = site.replace('https://', '').replace('http://', '').replace(/\/$/, '').toLowerCase();
        if (!existingDomains.has(domain)) {
          const newD = {
            domain,
            status: 'unknown',
            statusCode: 0,
            responseTime: 0,
            checkedAt: null,
            error: null,
            sslExpiry: null,
            sslDaysLeft: null,
            expiryDate: null,
            daysLeft: null,
            notes: 'นำเข้าจาก GSC',
            tags: ['gsc'],
            gsc: null,
            addedAt: new Date().toISOString()
          };
          memoryDomains.push(newD);
          newDomains.push(domain);
          imported++;
        }
      }

      if (imported > 0) {
        await saveToSheets(memoryDomains);
        console.log('[GSC] Import', imported, 'domains from GSC');
        smartAlert('info', '📥 GSC Import เสร็จ\n✅ เพิ่ม ' + imported + ' โดเมนจาก GSC\nรวมทั้งหมด: ' + memoryDomains.length + ' โดเมน');
      }

      json(res, {
        success: true,
        imported,
        total: memoryDomains.length,
        newDomains: newDomains.slice(0, 20)
      });
    })().catch(e => { console.error('[GSC Import]', e.message); json(res, { error: e.message }); });
    return;
  }

  if (req.method === 'GET' && url === '/api/gsc/debug') {
    (async () => {
      const token = await refreshGSCToken();
      if (!token) return json(res, { error: 'no token' });
      _gscSites = null;
      const sites = await getGSCSiteList(token);
      const domainList = memoryDomains.map(d => d.domain.toLowerCase());
      const matched = sites.filter(s => {
        const domain = s.replace('https://', '').replace(/\/$/, '');
        return domainList.includes(domain);
      });
      const notMatched = sites.filter(s => {
        const domain = s.replace('https://', '').replace(/\/$/, '');
        return !domainList.includes(domain);
      });
      json(res, {
        gscTotal: sites.length,
        domainIntelTotal: domainList.length,
        matched: matched.length,
        matchedSample: matched.slice(0, 10),
        notMatchedSample: notMatched.slice(0, 10),
        domainSample: domainList.slice(0, 5),
        gscSample: sites.slice(0, 5)
      });
    })().catch(e => json(res, { error: e.message }));
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
      _gscSites = null; // reset site cache
      console.log('[GSC] sync-all start:', memoryDomains.length, 'domains');
      let synced = 0;
      for (let i = 0; i < memoryDomains.length; i++) {
        memoryDomains[i] = await syncGSCForDomain(memoryDomains[i]);
        if (memoryDomains[i].gsc && memoryDomains[i].gsc.inGSC) synced++;
        if (i > 0 && i % 20 === 0) {
          await saveToSheets(memoryDomains);
          await new Promise(r => setTimeout(r, 300));
        }
      }
      await saveToSheets(memoryDomains);
      console.log('[GSC] sync-all done:', synced, 'in GSC');
      smartAlert('info', '✅ GSC Sync เสร็จ\n📊 ' + synced + ' โดเมนใน GSC');
    })().catch(e => console.error('[GSC] sync-all error:', e.message));
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
      smartAlert('info', `🔧 Bulk Auto-Fix สำเร็จ</b>
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
        smartAlert('info', `🔧 Auto-Fix สำเร็จ</b>
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
        smartAlert('warning', `☁️ Auto-Fix Cloudflare</b>
🌐 โดเมน: <code>${domain}</code>
⚡ การดำเนินการ: Pause Cloudflare (Error ${domainObj.statusCode})
✅ Traffic ไป Origin โดยตรงแล้ว
🕐 เวลา: ${new Date().toLocaleString('th-TH')}`);
        // Unpause หลัง 10 นาทีถ้าเว็บกลับมา
        setTimeout(async () => {
          const r = await checkDomain(domain);
          if (r.status === 'up') {
            await unpauseCloudflareZone(domain, zoneId);
            smartAlert('info', `✅ โดเมนกลับมาแล้ว
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





  // ===== BULK GSC API =====
  if (req.method === 'POST' && url === '/api/gsc/bulk-add') {
    let body = '';
    req.on('data', ch => body += ch);
    req.on('end', async () => {
      try {
        const { domains } = JSON.parse(body || '{}');
        if (!domains || !domains.length) return json(res, { error: 'ไม่มีโดเมน' });
        const result = await bulkAddToGSC(domains);
        json(res, result);
      } catch(e) { json(res, { error: e.message }); }
    });
    return;
  }
  if (req.method === 'GET' && url === '/api/gsc/bulk-progress') {
    json(res, { success: true, progress: bulkGSCProgress });
    return;
  }
  // ตรวจ DNS provider ของโดเมน (preview ก่อน bulk)
  if (req.method === 'GET' && url.startsWith('/api/gsc/check-dns/')) {
    const domain = decodeURIComponent(url.split('/api/gsc/check-dns/')[1]);
    const info = await detectDNSProvider(domain);
    json(res, { success: true, domain, ...info });
    return;
  }


  // Verify โดเมนที่ค้าง (TXT เขียนแล้ว รอ propagate)
  if (req.method === 'POST' && url === '/api/gsc/verify-pending') {
    let body = '';
    req.on('data', ch => body += ch);
    req.on('end', async () => {
      try {
        const token = await refreshGSCToken();
        if (!token) return json(res, { error: 'GSC token ใช้ไม่ได้' });
        // หาโดเมนที่ pendingVerify จาก progress
        const pending = (bulkGSCProgress.results || []).filter(r => r.pendingVerify && !r.ok);
        if (!pending.length) return json(res, { error: 'ไม่มีโดเมนที่ค้าง verify' });

        let verified = 0, stillPending = 0;
        for (const r of pending) {
          const vr = await gscVerifyDomain(token, r.domain);
          if (vr.ok) {
            r.ok = true; r.pendingVerify = false;
            r.error = ''; verified++;
            bulkGSCProgress.success++; bulkGSCProgress.failed--;
            logEvent('gsc', 'เพิ่ม ' + r.domain + ' เข้า GSC สำเร็จ (retry)', { domain: r.domain });
          } else {
            stillPending++;
          }
          await new Promise(rs => setTimeout(rs, 1000));
        }
        json(res, { success: true, verified, stillPending, total: pending.length });
      } catch(e) { json(res, { error: e.message }); }
    });
    return;
  }


  // ===== EMPLOYEES / COMPANY API =====
  if (req.method === 'GET' && url === '/api/employees') {
    const list = EMPLOYEES.map(e => ({
      ...e,
      state: employeeState[e.id] || { status:'idle', tasksToday:0, tasksTotal:0, lastActiveAt:null, lastTask:null }
    }));
    json(res, { success: true, employees: list,
      totalToday: Object.values(employeeState).reduce((s,st)=>s+(st.tasksToday||0),0),
      totalAll: Object.values(employeeState).reduce((s,st)=>s+(st.tasksTotal||0),0)
    });
    return;
  }
  if (req.method === 'GET' && url.startsWith('/api/employees/activity')) {
    const u = new URL('http://x' + url);
    const empId = u.searchParams.get('emp');
    const limit = parseInt(u.searchParams.get('limit') || '100');
    let acts = employeeActivity;
    if (empId && empId !== 'all') acts = acts.filter(a => a.empId === empId);
    json(res, { success: true, activity: acts.slice(0, limit) });
    return;
  }



  // ให้ Diagnostician วิเคราะห์แล้วเสนองาน (เข้า approval queue)
  if (req.method === 'POST' && url === '/api/employees/propose') {
    proposeActionsFromAnalysis().then(result => json(res, result))
      .catch(e => json(res, { ok: false, error: e.message }));
    return;
  }
  // ดู safe actions ที่มี
  if (req.method === 'GET' && url === '/api/safe-actions') {
    const actions = Object.entries(SAFE_ACTIONS).map(([key, a]) => ({ key, label: a.label, desc: a.desc, emp: a.emp }));
    json(res, { success: true, actions });
    return;
  }


  // ดึงงานที่พนักงานคนนี้ทำได้
  if (req.method === 'GET' && url.startsWith('/api/employees/tasks/')) {
    const empId = url.split('/api/employees/tasks/')[1];
    const tasks = (EMPLOYEE_TASKS[empId] || []).map(t => ({ id: t.id, type: t.type, label: t.label }));
    json(res, { success: true, tasks, hasAI: !!process.env.ANTHROPIC_API_KEY });
    return;
  }
  // รันงานของพนักงาน (real-time)
  if (req.method === 'POST' && url.startsWith('/api/employees/run/')) {
    const rest = url.split('/api/employees/run/')[1];
    const [empId, taskId] = rest.split('/');
    runEmployeeTask(empId, taskId).then(result => json(res, result))
      .catch(e => json(res, { ok: false, error: e.message }));
    return;
  }
  // Live activity feed (สำหรับ polling แบบ real-time)
  if (req.method === 'GET' && url.startsWith('/api/employees/live')) {
    const u = new URL('http://x' + url);
    const since = u.searchParams.get('since');
    let acts = employeeActivity;
    if (since) acts = acts.filter(a => a.at > since);
    json(res, { success: true, activity: acts.slice(0, 30), now: new Date().toISOString() });
    return;
  }


  // ดึงรายการปัญหาที่ตรวจพบ (พร้อม action แก้)
  if (req.method === 'GET' && url === '/api/problems') {
    const problems = [];
    // โดเมน down
    const down = memoryDomains.filter(d => d.status === 'down' && !(d.tags||[]).includes('gsc') && d.pleskServer);
    down.slice(0, 50).forEach(d => {
      problems.push({
        id: 'down-' + d.domain, severity: 'high', emoji: '🔴',
        title: 'โดเมน down: ' + d.domain,
        detail: 'Server: ' + (d.pleskServer||'-') + ' · Status: ' + (d.statusCode||'timeout'),
        action: 'fix-down-domain', actionLabel: 'กู้โดเมน', meta: { domain: d.domain },
        canAutoFix: true
      });
    });
    // server สุขภาพต่ำ
    const health = (typeof getAllHealthScores === 'function') ? getAllHealthScores() : [];
    health.filter(h => h.score < 70).forEach(h => {
      problems.push({
        id: 'health-' + h.server, severity: h.score < 50 ? 'high' : 'medium', emoji: '⚠️',
        title: h.server + ' สุขภาพต่ำ (เกรด ' + h.grade + ')',
        detail: 'คะแนน ' + h.score + '/100 · down ' + h.down + ' โดเมน',
        action: 'disk-cleanup', actionLabel: 'ทำความสะอาด', meta: {},
        canAutoFix: true
      });
    });
    // SSL ใกล้หมด
    const sslSoon = memoryDomains.filter(d => d.sslDaysLeft !== null && d.sslDaysLeft <= 14 && d.sslDaysLeft > 0);
    sslSoon.slice(0, 30).forEach(d => {
      problems.push({
        id: 'ssl-' + d.domain, severity: d.sslDaysLeft <= 7 ? 'high' : 'medium', emoji: '🔒',
        title: 'SSL ใกล้หมด: ' + d.domain,
        detail: 'เหลือ ' + d.sslDaysLeft + ' วัน',
        action: null, actionLabel: null, meta: { domain: d.domain },
        canAutoFix: false, note: 'certbot ต่ออายุอัตโนมัติทุก 90 วัน'
      });
    });
    // โดเมนใกล้หมดอายุ
    const expSoon = memoryDomains.filter(d => d.daysLeft !== null && d.daysLeft <= 30 && d.daysLeft > 0);
    expSoon.slice(0, 30).forEach(d => {
      problems.push({
        id: 'exp-' + d.domain, severity: d.daysLeft <= 7 ? 'high' : 'low', emoji: '📅',
        title: 'โดเมนใกล้หมดอายุ: ' + d.domain,
        detail: 'เหลือ ' + d.daysLeft + ' วัน',
        action: null, actionLabel: null, meta: { domain: d.domain },
        canAutoFix: false, note: 'ต้องต่ออายุที่ผู้ให้บริการโดเมน'
      });
    });

    problems.sort((a,b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.severity] - order[b.severity];
    });
    json(res, { success: true, problems, total: problems.length,
      autoFixable: problems.filter(p => p.canAutoFix).length });
    return;
  }

  // แก้ปัญหาทันที (กดจากรายงาน) — งานปลอดภัยทำเลย งานเสี่ยงขออนุมัติ
  if (req.method === 'POST' && url === '/api/problems/fix') {
    let body = '';
    req.on('data', ch => body += ch);
    req.on('end', async () => {
      try {
        const { action, meta, immediate } = JSON.parse(body || '{}');
        if (!action || !SAFE_ACTIONS[action]) return json(res, { ok: false, error: 'action ไม่ถูกต้อง' });
        const act = SAFE_ACTIONS[action];

        if (immediate) {
          // ทำเลย (เฉพาะ action ปลอดภัย)
          setEmployeeWorking(act.emp, act.label, 30000);
          const result = await act.run(meta || {});
          logAutoFix(act.emp, 'สั่งแก้จากรายงาน', act.label, result);
          empLog(act.emp, 'แก้ปัญหา (สั่งด้วยมือ)', act.label);
          json(res, { ok: true, immediate: true, result });
        } else {
          // ขออนุมัติ
          requestApproval(act.emp, act.label, act.desc, action, meta || {});
          json(res, { ok: true, immediate: false, message: 'ส่งขออนุมัติแล้ว' });
        }
      } catch(e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }

  // Auto-fix history + toggle
  if (req.method === 'GET' && url === '/api/autofix/history') {
    json(res, { success: true, history: autoFixHistory.slice(0, 50), enabled: autoFixEnabled });
    return;
  }
  if (req.method === 'POST' && url === '/api/autofix/toggle') {
    autoFixEnabled = !autoFixEnabled;
    json(res, { success: true, enabled: autoFixEnabled });
    return;
  }
  if (req.method === 'POST' && url === '/api/autofix/run') {
    runAutoFixCycle().then(r => json(res, r)).catch(e => json(res, { ok: false, error: e.message }));
    return;
  }



  // วินิจฉัย server ทีละตัว
  if (req.method === 'GET' && url.startsWith('/api/diagnose/')) {
    const serverName = decodeURIComponent(url.split('/api/diagnose/')[1]);
    const srv = PLESK_SERVERS.find(s => s.name === serverName);
    if (!srv) return json(res, { ok: false, error: 'ไม่พบ server' });
    empLog('diagnostician', 'วินิจฉัย server', serverName);
    diagnoseServer(srv).then(r => json(res, r)).catch(e => json(res, { ok: false, error: e.message }));
    return;
  }


  // Deep remediation — วินิจฉัยแล้วแก้เอง
  if (req.method === 'POST' && url === '/api/remediate/run') {
    runDeepRemediation().then(r => json(res, r)).catch(e => json(res, { ok: false, error: e.message }));
    return;
  }
  if (req.method === 'GET' && url === '/api/remediate/status') {
    const today = new Date().toISOString().split('T')[0];
    if (today !== autoFixDayStamp) { autoFixDayStamp = today; autoFixDailyCount = 0; }
    json(res, { success: true, enabled: autoRemediateEnabled, dailyCount: autoFixDailyCount, dailyCap: AUTO_FIX_DAILY_CAP,
      cooldowns: Object.entries(autoFixCooldowns).map(([k,t]) => ({ key: k, minsLeft: Math.max(0, Math.ceil((AUTO_FIX_COOLDOWN_MS-(Date.now()-t))/60000)) })).filter(c=>c.minsLeft>0) });
    return;
  }
  if (req.method === 'POST' && url === '/api/remediate/toggle') {
    autoRemediateEnabled = !autoRemediateEnabled;
    json(res, { success: true, enabled: autoRemediateEnabled });
    return;
  }

  // ===== COMMAND CENTER API =====
  if (req.method === 'GET' && url === '/api/command-center') {
    try { json(res, { success: true, data: buildCommandCenter() }); }
    catch(e) { json(res, { success: false, error: e.message }); }
    return;
  }

  // ===== EMPLOYEE BRAIN API =====
  // สั่งให้พนักงานวิเคราะห์ (manual trigger)
  if (req.method === 'POST' && url.startsWith('/api/employees/think/')) {
    const empId = url.split('/api/employees/think/')[1];
    runEmployeeBrain(empId).then(result => {
      json(res, result);
    }).catch(e => json(res, { ok: false, error: e.message }));
    return;
  }
  // ดูรายงานล่าสุดของพนักงาน
  if (req.method === 'GET' && url.startsWith('/api/employees/report/')) {
    const empId = url.split('/api/employees/report/')[1];
    const report = employeeReports[empId];
    json(res, { success: true, report: report || null, hasAI: !!process.env.ANTHROPIC_API_KEY });
    return;
  }
  // ดูรายงานทั้งหมด (สำหรับ CEO dashboard)
  if (req.method === 'GET' && url === '/api/reports') {
    json(res, { success: true, reports: employeeReports, hasAI: !!process.env.ANTHROPIC_API_KEY });
    return;
  }

  // ===== APPROVAL QUEUE API =====
  if (req.method === 'GET' && url === '/api/approvals') {
    json(res, { success: true,
      approvals: approvalQueue.slice(0, 100),
      pending: approvalQueue.filter(a => a.status === 'pending').length
    });
    return;
  }
  if (req.method === 'POST' && url.startsWith('/api/approvals/')) {
    const parts = url.split('/');
    const id = parts[3];
    const decision = parts[4]; // approve | reject
    const idx = approvalQueue.findIndex(a => a.id === id);
    if (idx === -1) return json(res, { error: 'ไม่พบคำขอ' });
    const apr = approvalQueue[idx];
    if (decision === 'approve') {
      apr.status = 'approved'; apr.decidedAt = new Date().toISOString();
      empLog(apr.empId, 'ได้รับอนุมัติ', apr.title, { approvalId: id });
      logEvent('approval', 'เจ้าของอนุมัติ: ' + apr.title, { empId: apr.empId });
      saveApprovals();
      // เฟส 3: รัน action จริงหลังอนุมัติ (async ไม่ block response)
      if (apr.action && typeof executeApprovedAction === 'function') {
        executeApprovedAction(apr).then(result => {
          apr.executed = true; apr.executeResult = result; saveApprovals();
        }).catch(e => { apr.executeResult = { ok: false, detail: e.message }; saveApprovals(); });
      }
    } else if (decision === 'reject') {
      apr.status = 'rejected'; apr.decidedAt = new Date().toISOString();
      empLog(apr.empId, 'ถูกปฏิเสธ', apr.title, { approvalId: id });
    }
    saveApprovals();
    json(res, { success: true, approval: apr });
    return;
  }

  // ===== TASKS API =====
  if (req.method === 'GET' && url === '/api/tasks') {
    json(res, { success: true, tasks: memoryTasks });
    return;
  }
  if (req.method === 'POST' && url === '/api/tasks') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const t = JSON.parse(body);
        const task = {
          id: 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
          title: t.title || 'งานใหม่',
          description: t.description || '',
          status: t.status || 'todo',
          priority: t.priority || 'normal',
          domain: t.domain || '',
          server: t.server || '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        memoryTasks.unshift(task);
        saveTasks();
        json(res, { success: true, task });
      } catch(e) { json(res, { error: e.message }); }
    });
    return;
  }
  if (req.method === 'PUT' && url.startsWith('/api/tasks/')) {
    const id = url.split('/api/tasks/')[1];
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        const idx = memoryTasks.findIndex(t => t.id === id);
        if (idx === -1) return json(res, { error: 'not found' });
        Object.assign(memoryTasks[idx], updates, { updatedAt: new Date().toISOString() });
        saveTasks();
        json(res, { success: true, task: memoryTasks[idx] });
      } catch(e) { json(res, { error: e.message }); }
    });
    return;
  }
  if (req.method === 'DELETE' && url.startsWith('/api/tasks/')) {
    const id = url.split('/api/tasks/')[1];
    memoryTasks = memoryTasks.filter(t => t.id !== id);
    saveTasks();
    json(res, { success: true });
    return;
  }

  // Health Scores API
  if (req.method === 'GET' && url === '/api/health-scores') {
    json(res, { success: true, scores: getAllHealthScores(), overallAvg: (() => {
      const s = getAllHealthScores();
      return s.length ? Math.round(s.reduce((a,b) => a+b.score, 0) / s.length) : 0;
    })() });
    return;
  }

  // Event Log API
  if (req.method === 'GET' && url.startsWith('/api/events')) {
    const u = new URL('http://x' + url);
    const type = u.searchParams.get('type');
    const limit = parseInt(u.searchParams.get('limit') || '100');
    let events = eventLog;
    if (type && type !== 'all') events = events.filter(e => e.type === type);
    json(res, { success: true, events: events.slice(0, limit), total: eventLog.length });
    return;
  }

  // Response Time History API
  if (req.method === 'GET' && url.startsWith('/api/perf/')) {
    const domain = decodeURIComponent(url.split('/api/perf/')[1]);
    const hourly = perfHourly[domain] || {};
    const data = Object.entries(hourly).sort().map(([hour, v]) => ({
      hour, avg: Math.round(v.sum / v.count)
    }));
    json(res, { success: true, domain, data });
    return;
  }

  // Slow domains API (read-only)
  if (req.method === 'GET' && url === '/api/perf-slow') {
    const slow = memoryDomains
      .filter(d => d.responseTime > 2000 && d.status === 'up')
      .sort((a,b) => b.responseTime - a.responseTime)
      .slice(0, 30)
      .map(d => ({ domain: d.domain, responseTime: d.responseTime, server: d.pleskServer, status: d.status }));
    json(res, { success: true, slow });
    return;
  }

  // SLA Stats API
  if (req.method === 'GET' && url === '/api/sla/stats') {
    json(res, { success: true, stats: getAllSLAStats(), history: uptimeHistory });
    return;
  }

  // Resource Usage API
  // Resource usage ทีละ server (ป้องกัน Railway timeout)
  if (req.method === 'POST' && url.startsWith('/api/resource-usage')) {
    const srvName = url.includes('/api/resource-usage/') 
      ? decodeURIComponent(url.split('/api/resource-usage/')[1]) 
      : null;
    (async () => {
      if (srvName) {
        // ดึงทีละ server
        const srv = PLESK_SERVERS.find(s => s.name === srvName || s.host === srvName);
        if (!srv) return json(res, { error: 'ไม่พบ server: ' + srvName });
        const r = await getDomainResourceUsage(srv);
        json(res, { success: true, results: [r] });
      } else {
        // ดึงแค่ server แรก (backward compat)
        const r = await getDomainResourceUsage(PLESK_SERVERS[0]);
        json(res, { success: true, results: [r] });
      }
    })().catch(e => json(res, { error: e.message }));
    return;
  }

  // GSC Traffic Drop Check API
  if (req.method === 'POST' && url === '/api/gsc/check-drop') {
    (async () => {
      await checkGSCTrafficDrop();
      json(res, { success: true, message: 'ตรวจสอบ traffic drop เสร็จแล้ว' });
    })().catch(e => json(res, { error: e.message }));
    return;
  }

  // Blacklist Check API
  if (req.method === 'POST' && url === '/api/blacklist/check') {
    (async () => {
      const results = await checkBlacklists();
      json(res, { success: true, results });
    })().catch(e => json(res, { error: e.message }));
    return;
  }

  // Send Weekly Report API (manual trigger)
  if (req.method === 'POST' && url === '/api/report/weekly') {
    await sendWeeklyReport();
    json(res, { success: true, message: 'ส่ง Weekly Report แล้ว' });
    return;
  }


  if (req.method === 'POST' && url === '/api/phpfpm-ondemand') {
    json(res, { success: true, message: 'กำลังเปลี่ยน PHP-FPM เป็น ondemand...' });
    applyAllPhpFpmOndemand().catch(console.error);
    return;
  }
  if (req.method === 'POST' && url === '/api/disk-cleanup') {
    json(res, { success: true, message: 'กำลัง cleanup disk...' });
    runManualDiskCleanup().catch(console.error);
    return;
  }
  if (req.method === 'POST' && url === '/api/limit-phpfpm') {
    json(res, { success: true, message: 'กำลังจำกัด PHP-FPM...' });
    limitAllPhpFpm().catch(console.error);
    return;
  }
  if (req.method === 'POST' && url === '/api/install-apache-watchdog') {
    json(res, { success: true, message: 'กำลังติดตั้ง Apache Watchdog...' });
    installAllApacheWatchdogs().catch(console.error);
    return;
  }
  if (req.method === 'POST' && url === '/api/setup-cloudflare-whitelist') {
    json(res, { success: true, message: 'กำลังตั้งค่า Cloudflare Whitelist...' });
    setupAllCloudflareWhitelists().catch(console.error);
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

  if (req.method === 'POST' && url === '/api/fix-ssl') {
    autoInstallSSL().catch(console.error);
    json(res, { success: true, message: 'กำลังติดตั้ง SSL ทุก server...' });
    return;
  }

  if (req.method === 'POST' && url === '/api/fix-php-upload') {
    fixPHPUploadLimits().catch(console.error);
    json(res, { success: true, message: 'กำลังปรับค่า PHP Upload Limits ทุก server...' });
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
        smartAlert('info', '✅ Fix PHP-FPM ' + srv.name + ' สำเร็จ');
      } catch(e) {
        results.push({ server: srv.name, success: false, error: e.message });
        smartAlert('warning', `❌ Fix PHP-FPM ${srv.name} ล้มเหลว: ${e.message}`);
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
  try { empLog('diagnostician', 'ตรวจสุขภาพระบบ', 'proactive scan'); } catch(e){}
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
          smartAlert('warning', `⚠️ Proactive Alert
🖥️ ${srv.name}: Load Average สูง <b>${load}</b>
กำลัง Fix อัตโนมัติ...`);
          queueCommand(srv.host, 
            'pkill -f "wp-toolkit" 2>/dev/null; pkill -f "auto-update" 2>/dev/null; ' +
            'systemctl restart sw-engine; echo "Auto-fixed"'
          );
        }
        if (disk > 80) {
          smartAlert('warning', `⚠️ Disk Warning
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
  const startTime = Date.now();
  const checkedAt = new Date().toISOString();
  
  // Try HTTPS first, then HTTP fallback
  const tryRequest = (useHttps) => new Promise(resolve => {
    const mod = useHttps ? https : http;
    const port = useHttps ? 443 : 80;
    const options = {
      hostname: domain, port, path: '/', method: 'HEAD',
      timeout: 8000, rejectUnauthorized: false,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Host': domain }
    };
    const req = mod.request(options, res => {
      res.resume();
      const rt = Date.now() - startTime;
      const status = res.statusCode < 500 ? 'up' : 'down';
      resolve({ ok: true, domain, status, statusCode: res.statusCode, responseTime: rt, error: null, checkedAt });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message.slice(0,50) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
    req.end();
  });

  // Try HTTPS
  const httpsResult = await tryRequest(true);
  if (httpsResult.ok) return httpsResult;
  
  // Fallback to HTTP
  const httpResult = await tryRequest(false);
  if (httpResult.ok) return httpResult;
  
  // Both failed
  return { 
    domain, status: 'down', statusCode: 0, 
    error: httpsResult.error || httpResult.error || 'Connection failed',
    responseTime: Date.now() - startTime, checkedAt 
  };
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

// ===== AUTO SSL INSTALL =====
async function autoInstallSSL() {
  console.log('[SSL] ติดตั้ง SSL + redirect ทุกโดเมน...');
  
  for (const srv of PLESK_SERVERS) {
    try {
      // รัน plesk loop ผ่าน Agent — ติดตั้ง SSL + redirect ทุกโดเมนใน server นั้น
      const cmd = 'for domain in $(plesk bin domain --list); do ' +
        'plesk bin extension --exec letsencrypt cli.php -d $domain -m seofullgod@gmail.com --redirect 2>/dev/null && echo "SSL_OK:$domain"; ' +
        'done; echo "SSL_DONE"';
      
      const cmdId = queueCommand(srv.host, cmd);
      console.log(`[SSL] ส่งคำสั่งไป ${srv.name}...`);
      
      // รอผล max 10 นาที (โดเมนเยอะ)
      setTimeout(async () => {
        const result = agentResults[cmdId];
        if (!result) {
          console.log(`[SSL] ${srv.name}: ไม่ได้รับผล (Agent อาจ timeout)`);
          return;
        }
        delete agentResults[cmdId];
        const output = (result.output || '').replace(/~/g, ' ');
        const installed = (output.match(/SSL_OK:(\S+)/g) || []).map(m => m.replace('SSL_OK:', ''));
        
        console.log(`[SSL] ${srv.name}: ติดตั้งสำเร็จ ${installed.length} โดเมน`);
        
        if (installed.length > 0) {
          sendTelegram(
            `✅ <b>Auto SSL + Redirect สำเร็จ</b>
` +
            `🖥️ ${srv.name}
` +
            `🔒 ติดตั้ง ${installed.length} โดเมน
` +
            `📋 ${installed.slice(0,10).join(', ')}${installed.length > 10 ? '...' : ''}`
          );
          // Update domain records
          installed.forEach(domain => {
            const idx = memoryDomains.findIndex(d => d.domain === domain);
            if (idx !== -1) {
              memoryDomains[idx].sslDaysLeft = 90;
              memoryDomains[idx].sslExpiry = new Date(Date.now() + 90*24*60*60*1000).toISOString().split('T')[0];
            }
          });
          await saveToSheets(memoryDomains).catch(() => {});
        }
      }, 10 * 60 * 1000); // รอ 10 นาที
      
    } catch(e) {
      console.error('[SSL]', srv.name, e.message);
    }
  }
}

// ===== FIX PHP UPLOAD LIMITS =====
async function fixPHPUploadLimits() {
  console.log('[PHP] ปรับค่า upload limits ทุก server...');
  const cmd = [
    // แก้ php.ini หลัก
    'for f in /etc/php.ini /etc/php/*/php.ini /opt/plesk/php/*/etc/php.ini; do [ -f "$f" ] && sed -i "s/upload_max_filesize = .*/upload_max_filesize = 128M/" "$f" && sed -i "s/post_max_size = .*/post_max_size = 256M/" "$f" && sed -i "s/memory_limit = .*/memory_limit = 256M/" "$f"; done',
    // แก้ sw-engine (PHP ของ Plesk)
    'for f in /etc/sw-engine/php.ini /usr/local/psa/admin/conf/php.ini; do [ -f "$f" ] && sed -i "s/upload_max_filesize = .*/upload_max_filesize = 128M/" "$f" && sed -i "s/post_max_size = .*/post_max_size = 256M/" "$f"; done',
    // Restart PHP-FPM
    'systemctl restart sw-engine 2>/dev/null; systemctl restart php-fpm 2>/dev/null',
    // ยืนยันค่า
    'php -r "echo ini_get(\'upload_max_filesize\')" 2>/dev/null | xargs -I{} echo "upload_max: {}" || echo "PHP OK"',
    'echo "PHP Upload Limit Fixed: 128M"'
  ].join('; ');

  for (const srv of PLESK_SERVERS) {
    const cmdId = queueCommand(srv.host, cmd);
    console.log(`[PHP] ส่งคำสั่งไปที่ ${srv.name}...`);
    
    setTimeout(async () => {
      const result = agentResults[cmdId];
      if (result) {
        delete agentResults[cmdId];
        const output = (result.output || '').replace(/~/g, ' ');
        const success = output.includes('128M') || output.includes('Fixed');
        sendTelegram(
          `${success ? '✅' : '⚠️'} <b>PHP Upload Limit</b>
` +
          `🖥️ ${srv.name}
` +
          `📋 ${output.slice(0, 200)}`
        );
        console.log(`[PHP] ${srv.name}: ${output.slice(0, 100)}`);
      }
    }, 90000);
  }
}

// ===== BLACKLIST MONITOR =====
// Blacklist cooldown (แจ้งซ้ำทุก 6 ชั่วโมง)
const blacklistCooldown = {};
const BLACKLISTS = ['zen.spamhaus.org', 'bl.spamcop.net', 'dnsbl.sorbs.net', 'b.barracudacentral.org', 'dnsbl-1.uceprotect.net'];

async function checkBlacklists() {
  try { empLog('security', 'ตรวจ IP blacklist', 'สแกน DNSBL'); } catch(e){}
  const dns = require('dns');
  const serverIPs = [...new Set(PLESK_SERVERS.map(s => s.host))];
  const results = [];
  console.log('[Blacklist] ตรวจสอบ', serverIPs.length, 'IPs...');

  for (const ip of serverIPs) {
    const reversed = ip.split('.').reverse().join('.');
    const listed = [];
    for (const bl of BLACKLISTS) {
      try {
        await new Promise(resolve => {
          dns.lookup(reversed + '.' + bl, (err, addr) => {
            if (!err && addr) listed.push(bl);
            resolve();
          });
        });
      } catch(e) {}
    }
    const srv = PLESK_SERVERS.find(s => s.host === ip);
    const key = 'bl:' + ip;
    if (listed.length > 0) {
      if (!blacklistCooldown[key] || Date.now() - blacklistCooldown[key] > 6*60*60*1000) {
        blacklistCooldown[key] = Date.now();
        smartAlert('critical',
          '🚨 IP Blacklisted!\n' +
          '🖥️ ' + (srv?.name || ip) + ' (' + ip + ')\n' +
          '📋 พบใน: ' + listed.join(', ') + '\n' +
          '💡 ต้องติดต่อ provider เพื่อ delist ด่วน'
        );
      }
      results.push({ ip, server: srv?.name, listed });
    } else {
      console.log('[Blacklist] ' + ip + ': clean ✅');
    }
  }
  return results;
}

// ===== WEEKLY REPORT =====
let weeklyStats = { fixed: 0, checked: 0, uptime: 0, startTime: Date.now() };

function updateWeeklyStats(fixed, checked) {
  weeklyStats.fixed += fixed;
  weeklyStats.checked += checked;
}

async function sendWeeklyReport() {
  try { empLog('ceo', 'ส่งรายงานประจำสัปดาห์', 'สรุปภาพรวมให้เจ้าของ'); } catch(e){}
  const total = memoryDomains.length;
  const upDomains = memoryDomains.filter(d => d.status === 'up').length;
  const downDomains = memoryDomains.filter(d => d.status === 'down').length;
  const uptimePct = total ? Math.round(upDomains / total * 100) : 0;
  const sslExpiring = memoryDomains.filter(d => d.sslDaysLeft !== null && d.sslDaysLeft <= 30 && d.sslDaysLeft > 0).length;
  const domainExpiring = memoryDomains.filter(d => d.daysLeft !== null && d.daysLeft <= 30 && d.daysLeft > 0).length;
  const uptimeHours = Math.round((Date.now() - weeklyStats.startTime) / 3600000);

  // Top 5 GSC traffic this week
  const topGSC = [...memoryDomains]
    .filter(d => d.gsc?.d7?.clicks > 0)
    .sort((a,b) => (b.gsc.d7.clicks||0) - (a.gsc.d7.clicks||0))
    .slice(0, 5);

  // SSL expiring soon
  const sslList = memoryDomains.filter(d => d.sslDaysLeft !== null && d.sslDaysLeft <= 14 && d.sslDaysLeft > 0)
    .sort((a,b) => a.sslDaysLeft - b.sslDaysLeft).slice(0, 5);

  let msg = '📊 <b>Weekly Report — DomainIntel</b>\n';
  msg += '🗓️ ' + new Date().toLocaleDateString('th-TH', {weekday:'long',year:'numeric',month:'long',day:'numeric'}) + '\n\n';
  msg += '🌐 โดเมนทั้งหมด: <b>' + total + '</b>\n';
  msg += '✅ Up: <b>' + upDomains + '</b> (' + uptimePct + '%)\n';
  msg += '🔴 Down: <b>' + downDomains + '</b>\n';
  msg += '🔧 Auto-fixed: ' + weeklyStats.fixed + ' ครั้ง\n';
  msg += '⏱️ System Uptime: ' + uptimeHours + ' ชั่วโมง\n\n';

  if (sslExpiring > 0) msg += '⚠️ SSL ใกล้หมด: ' + sslExpiring + ' โดเมน\n';
  if (domainExpiring > 0) msg += '⚠️ Domain ใกล้หมด: ' + domainExpiring + ' โดเมน\n';
  if (sslList.length > 0) {
    msg += '\n🔒 <b>SSL ใกล้หมด (14 วัน):</b>\n';
    sslList.forEach(d => { msg += '  • ' + d.domain + ' (' + d.sslDaysLeft + ' วัน)\n'; });
  }
  if (topGSC.length > 0) {
    msg += '\n📈 <b>Top Traffic 7 วันล่าสุด:</b>\n';
    topGSC.forEach((d,i) => { msg += '  ' + (i+1) + '. ' + d.domain + ' — ' + d.gsc.d7.clicks + ' clicks\n'; });
  }

  sendTelegram(msg);
  weeklyStats = { fixed: 0, checked: 0, uptime: 0, startTime: Date.now() };
  console.log('[WeeklyReport] ส่งรายงานรายสัปดาห์แล้ว');
}



// ===== GSC TRAFFIC DROP ALERT =====
const gscDropCooldown = {}; // { domain: lastAlertTime }

async function checkGSCTrafficDrop() {
  try { empLog('security', 'ตรวจ traffic drop', 'สแกนทุกโดเมน'); } catch(e){}
  const withGSC = memoryDomains.filter(d => d.gsc && d.gsc.d7 && d.gsc.d30);
  let alerts = 0;
  for (const d of withGSC) {
    try {
      // เปรียบเทียบ 7 วันนี้ vs 7 วันก่อน (โดยใช้ d30 - d7)
      const recent7 = d.gsc.d7?.clicks || 0;
      const d30clicks = d.gsc.d30?.clicks || 0;
      const prev7 = Math.max(0, d30clicks - recent7); // clicks ใน 7-30 วันที่แล้ว
      if (prev7 < 5) continue; // ไม่นับถ้า traffic น้อยเกินไป

      const dropPct = Math.round((prev7 - recent7) / prev7 * 100);
      if (dropPct >= 30) {
        const key = d.domain;
        if (!gscDropCooldown[key] || Date.now() - gscDropCooldown[key] > 7*24*60*60*1000) {
          gscDropCooldown[key] = Date.now();
          smartAlert('warning',
            '📉 Traffic Drop Alert\n' +
            '🌐 ' + d.domain + '\n' +
            '📊 7 วันนี้: ' + recent7 + ' clicks\n' +
            '📊 7 วันก่อน: ' + prev7 + ' clicks\n' +
            '⬇️ ลดลง <b>' + dropPct + '%</b>\n' +
            '💡 ตรวจสอบ GSC — อาจโดน penalty'
          );
          alerts++;
        }
      }
    } catch(e) {}
  }
  if (alerts === 0) console.log('[GSCDrop] ไม่พบ traffic drop ผิดปกติ');
}
// ===== DDOS DETECTION =====
const requestCounts = {}; // { ip: { count, firstSeen } }
const blockedIPs = new Set();

function trackRequest(ip) {
  const now = Date.now();
  if (!requestCounts[ip]) requestCounts[ip] = { count: 0, firstSeen: now };
  requestCounts[ip].count++;
  
  // Reset after 1 minute
  if (now - requestCounts[ip].firstSeen > 60000) {
    requestCounts[ip] = { count: 1, firstSeen: now };
  }
  
  // DDoS threshold: 500 requests/minute
  if (requestCounts[ip].count > 500 && !blockedIPs.has(ip)) {
    blockedIPs.add(ip);
    console.log(`[DDoS] บล็อก IP: ${ip} (${requestCounts[ip].count} req/min)`);
    smartAlert('critical', `🚨 DDoS Detection
🌐 IP: <code>${ip}</code>
📊 ${requestCounts[ip].count} requests/นาที
🛡️ บล็อกอัตโนมัติแล้ว`);
    
    // Auto-unblock after 1 hour
    setTimeout(() => {
      blockedIPs.delete(ip);
      console.log(`[DDoS] ปลดบล็อก IP: ${ip}`);
    }, 60 * 60 * 1000);
  }
  
  return blockedIPs.has(ip);
}

// Clean up old request counts every 5 minutes
setInterval(() => {
  const now = Date.now();
  Object.keys(requestCounts).forEach(ip => {
    if (now - requestCounts[ip].firstSeen > 60000) delete requestCounts[ip];
  });
}, 5 * 60 * 1000);

// ===== DATABASE BACKUP MONITOR =====
async function checkDatabaseBackups() {
  console.log('[Backup] ตรวจสอบ backup ทุก server...');
  
  for (const srv of PLESK_SERVERS) {
    const cmd = [
      // เช็ค backup ล่าสุด
      'BACKUP_DIR="/var/lib/psa/dumps"',
      'if [ -d "$BACKUP_DIR" ]; then',
      '  LATEST=$(ls -t $BACKUP_DIR/*.tar.gz 2>/dev/null | head -1)',
      '  if [ -n "$LATEST" ]; then',
      '    AGE=$(( ($(date +%s) - $(stat -c %Y "$LATEST")) / 3600 ))',
      '    SIZE=$(du -sh "$LATEST" | cut -f1)',
      '    echo "BACKUP_OK:$AGE:$SIZE:$(basename $LATEST)"',
      '  else',
      '    echo "BACKUP_MISSING"',
      '  fi',
      'else',
      '  echo "BACKUP_DIR_MISSING"',
      'fi'
    ].join('\n');
    
    const cmdId = queueCommand(srv.host, cmd);
    
    setTimeout(async () => {
      const result = agentResults[cmdId];
      if (!result) return;
      delete agentResults[cmdId];
      
      const output = (result.output || '').replace(/~/g, ' ');
      
      if (output.includes('BACKUP_MISSING') || output.includes('BACKUP_DIR_MISSING')) {
        sendTelegram(`⚠️ <b>Backup Warning!</b>
🖥️ ${srv.name}
❌ ไม่พบ backup file
กรุณาตรวจสอบ backup system`);
      } else if (output.includes('BACKUP_OK:')) {
        const match = output.match(/BACKUP_OK:(\d+):([^:]+):(.+)/);
        if (match) {
          const [, age, size, filename] = match;
          if (parseInt(age) > 48) {
            sendTelegram(`⚠️ <b>Backup เก่าเกินไป!</b>
🖥️ ${srv.name}
⏰ Backup ล่าสุด: ${age} ชั่วโมงที่แล้ว
📦 ไฟล์: ${filename} (${size})`);
          } else {
            console.log(`[Backup] ${srv.name}: OK - ${age}h ago, ${size}`);
          }
        }
      }
    }, 90000);
  }
}

// ===== DOMAIN EXPIRY MONITOR =====
// Domain expiry alert cooldown (ป้องกัน spam)
const domainExpiryCooldown = {}; // { 'domain+threshold': lastAlertTime }

async function checkDomainExpiry() {
  console.log('[DomainExpiry] ตรวจสอบวันหมดอายุโดเมน...');
  // แจ้งเตือนที่ 60/30/14/7/1 วัน
  const thresholds = [60, 30, 14, 7, 1];
  const now = new Date();
  const COOLDOWN = 20 * 60 * 60 * 1000; // cooldown 20 ชั่วโมง (แจ้งซ้ำได้วันละครั้ง)
  const expiringList = [];

  for (const domain of memoryDomains) {
    if (!domain.expiryDate) continue;
    const expiry = new Date(domain.expiryDate);
    const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
    const idx = memoryDomains.findIndex(d => d.domain === domain.domain);
    if (idx !== -1) memoryDomains[idx].daysLeft = daysLeft;

    for (const t of thresholds) {
      if (daysLeft <= t && daysLeft > (t === 1 ? 0 : thresholds[thresholds.indexOf(t)+1] || 0)) {
        const key = domain.domain + ':' + t;
        if (!domainExpiryCooldown[key] || Date.now() - domainExpiryCooldown[key] > COOLDOWN) {
          domainExpiryCooldown[key] = Date.now();
          const icon = daysLeft <= 1 ? '🚨' : daysLeft <= 7 ? '🔴' : daysLeft <= 14 ? '🟠' : '⚠️';
          sendTelegram(
            icon + ' <b>Domain หมดอายุใน ' + daysLeft + ' วัน!</b>\n' +
            '🌐 <code>' + domain.domain + '</code>\n' +
            '📅 หมดอายุ: ' + domain.expiryDate + '\n' +
            '🖥️ Server: ' + (domain.pleskServer || '—') + '\n' +
            (daysLeft <= 7 ? '🚨 <b>ต่ออายุด่วนมาก!</b>' : '💡 กรุณาต่ออายุโดเมน')
          );
          expiringList.push({ domain: domain.domain, daysLeft, expiryDate: domain.expiryDate });
        }
        break;
      }
    }
  }

  // สรุปรายการใกล้หมดอายุ (เฉพาะ <= 30 วัน) ลง log
  const expiring30 = memoryDomains.filter(d => d.daysLeft !== null && d.daysLeft <= 30 && d.daysLeft > 0);
  if (expiring30.length) console.log('[DomainExpiry] ใกล้หมดอายุ:', expiring30.map(d => d.domain + '(' + d.daysLeft + 'd)').join(', '));
}



// ===== RESOURCE USAGE PER DOMAIN =====
async function getDomainResourceUsage(srv) {
  try {
    const cmd = [
      // System overview (เร็วมาก)
      'echo "=SYS="',
      'echo "Load:$(cat /proc/loadavg | cut -d" " -f1-3)"',
      'echo "RAM:$(free -m | grep Mem | tr -s " " | cut -d" " -f3)/$(free -m | grep Mem | tr -s " " | cut -d" " -f2)MB"',
      'echo "Disk:$(df -h / | tail -1 | tr -s " " | cut -d" " -f3)/$(df -h / | tail -1 | tr -s " " | cut -d" " -f2) ($(df -h / | tail -1 | tr -s " " | cut -d" " -f5))"',
      'echo "Domains:$(ls /var/www/vhosts/ 2>/dev/null | wc -l)"',
      // PHP-FPM processes (เร็วมาก)
      'echo "=PHP="',
      'ps aux | grep -E "php-fpm|php[0-9]" | grep -v grep | awk "{print $NF}" | sort | uniq -c | sort -rn | head -20',
      // Top processes by CPU (เร็วมาก)
      'echo "=TOP="',
      'ps aux --sort=-%cpu | awk "NR>1 && NR<=11 {print $3\\"% \\"$11}" | head -10',
      // Apache connections per domain (เร็ว)
      'echo "=CONN="',
      'ss -tn state established 2>/dev/null | wc -l || echo "0"'
    ].join('; ');

    const cmdId = queueCommand(srv.host, cmd);
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (agentResults[cmdId]) {
        const res = agentResults[cmdId]; delete agentResults[cmdId];
        return { server: srv.name, output: (res.output||'').replace(/~/g,'\n'), ok: true };
      }
    }
    return { server: srv.name, output: 'timeout', ok: false };
  } catch(e) { return { server: srv.name, output: e.message, ok: false }; }
}
// ===== UPTIME SLA TRACKER =====
// เก็บ uptime history รายวัน คำนวณ % SLA รายเดือน
const uptimeHistory = {}; // { 'domain': [{ date, checks, up, pct }] }
const dailyChecks = {};   // { 'domain': { checks, up, date } } สำหรับวันนี้

function recordUptimeCheck(domain, isUp) {
  const today = new Date().toISOString().split('T')[0];
  if (!dailyChecks[domain]) dailyChecks[domain] = { checks: 0, up: 0, date: today };
  if (dailyChecks[domain].date !== today) {
    // บันทึกวันเมื่อวาน
    const prev = dailyChecks[domain];
    if (!uptimeHistory[domain]) uptimeHistory[domain] = [];
    uptimeHistory[domain].push({ date: prev.date, checks: prev.checks, up: prev.up, pct: prev.checks > 0 ? Math.round(prev.up/prev.checks*1000)/10 : 0 });
    // เก็บแค่ 90 วัน
    if (uptimeHistory[domain].length > 90) uptimeHistory[domain].shift();
    dailyChecks[domain] = { checks: 0, up: 0, date: today };
  }
  dailyChecks[domain].checks++;
  if (isUp) dailyChecks[domain].up++;
}

function getSLAStats(domain, days) {
  const history = uptimeHistory[domain] || [];
  const recent = history.slice(-days);
  if (!recent.length) return { uptime: null, checks: 0, days: 0 };
  const totalChecks = recent.reduce((s,d) => s+d.checks, 0);
  const totalUp = recent.reduce((s,d) => s+d.up, 0);
  return {
    uptime: totalChecks > 0 ? Math.round(totalUp/totalChecks*1000)/10 : 0,
    checks: totalChecks, days: recent.length
  };
}

function getAllSLAStats() {
  return memoryDomains.map(d => ({
    domain: d.domain,
    d7:  getSLAStats(d.domain, 7),
    d30: getSLAStats(d.domain, 30),
    status: d.status
  })).filter(d => d.d30.checks > 0);
}
// ===== PERFORMANCE MONITOR =====
const performanceHistory = {}; // { domain: [responseTimes] }

const perfHourly = {}; // เก็บค่าเฉลี่ยรายชั่วโมง สำหรับ chart

function trackPerformance(domain, responseTime) {
  if (!performanceHistory[domain]) performanceHistory[domain] = [];
  performanceHistory[domain].push({ time: responseTime, at: Date.now() });
  if (performanceHistory[domain].length > 10) performanceHistory[domain].shift();

  // เก็บ hourly average (สำหรับ trend chart - 48 ชั่วโมงล่าสุด)
  const hourKey = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  if (!perfHourly[domain]) perfHourly[domain] = {};
  if (!perfHourly[domain][hourKey]) perfHourly[domain][hourKey] = { sum: 0, count: 0 };
  perfHourly[domain][hourKey].sum += responseTime;
  perfHourly[domain][hourKey].count++;
  // เก็บแค่ 48 ชั่วโมง
  const keys = Object.keys(perfHourly[domain]).sort();
  while (keys.length > 48) { delete perfHourly[domain][keys.shift()]; }
  
  // Alert if consistently slow (avg > 5000ms over last 3 checks)
  const recent = performanceHistory[domain].slice(-3);
  if (recent.length === 3) {
    const avg = recent.reduce((s, r) => s + r.time, 0) / 3;
    if (avg > 5000) {
      const idx = memoryDomains.findIndex(d => d.domain === domain);
      const srv = idx !== -1 ? memoryDomains[idx].pleskServer : '—';
      console.log(`[Perf] ${domain}: ช้าผิดปกติ avg ${Math.round(avg)}ms`);
      // Only alert once per hour
      const lastAlert = performanceHistory[domain].lastAlert || 0;
      if (Date.now() - lastAlert > 60 * 60 * 1000) {
        performanceHistory[domain].lastAlert = Date.now();
        smartAlert('warning', '🐌 Performance Warning\n🌐 ' + domain + '\n⏱️ Response เฉลี่ย: ' + Math.round(avg) + 'ms\n🖥️ Server: ' + srv, 'perf:' + domain);
        logEvent('slow', domain + ' ช้าผิดปกติ ' + Math.round(avg) + 'ms', { domain, avgMs: Math.round(avg), server: srv });
      }
    }
  }
}

// ===== EMAIL/SPAM MONITOR =====
async function checkEmailSpam() {
  console.log('[Email] ตรวจสอบ mail queue...');
  
  for (const srv of PLESK_SERVERS) {
    const cmd = [
      'QUEUE=$(postqueue -p 2>/dev/null | tail -1)',
      'DEFERRED=$(postqueue -p 2>/dev/null | grep -c "^[A-F0-9]" 2>/dev/null || echo 0)',
      'BL_CHECK=$(grep -c "blocked" /var/log/maillog 2>/dev/null | head -1 || echo 0)',
      'echo "MAIL_QUEUE:$QUEUE DEFERRED:$DEFERRED BLOCKED:$BL_CHECK"'
    ].join('; ');
    
    const cmdId = queueCommand(srv.host, cmd);
    
    setTimeout(async () => {
      const result = agentResults[cmdId];
      if (!result) return;
      delete agentResults[cmdId];
      
      const output = (result.output || '').replace(/~/g, ' ');
      const deferred = parseInt((output.match(/DEFERRED:(\d+)/) || [])[1] || 0);
      const blocked = parseInt((output.match(/BLOCKED:(\d+)/) || [])[1] || 0);
      
      if (deferred > 100) {
        sendTelegram(
          `📧 <b>Email Queue Warning!</b>
` +
          `🖥️ ${srv.name}
` +
          `📬 Deferred mail: ${deferred} ข้อความ
` +
          `🚫 Blocked: ${blocked}
` +
          `💡 อาจถูก blacklist หรือมี spam`
        );
      }
      console.log(`[Email] ${srv.name}: deferred=${deferred} blocked=${blocked}`);
    }, 90000);
  }
}

// ===== MONTHLY REPORT =====
async function sendMonthlyReport() {
  const now = new Date();
  const upDomains = memoryDomains.filter(d => d.status === 'up').length;
  const downDomains = memoryDomains.filter(d => d.status === 'down').length;
  const uptimePct = memoryDomains.length ? Math.round(upDomains / memoryDomains.length * 100) : 0;
  const sslExpiring = memoryDomains.filter(d => d.sslDaysLeft !== null && d.sslDaysLeft <= 30 && d.sslDaysLeft > 0).length;
  const suspended = memoryDomains.filter(d => d.pleskId && !d.pleskActive).length;
  const domainExpiring = memoryDomains.filter(d => d.daysLeft !== null && d.daysLeft <= 30 && d.daysLeft > 0).length;
  
  // Server stats summary
  const serverSummary = PLESK_SERVERS.map(srv => {
    const domains = memoryDomains.filter(d => d.pleskServer === srv.name);
    const up = domains.filter(d => d.status === 'up').length;
    const pct = domains.length ? Math.round(up / domains.length * 100) : 0;
    return `  🖥️ ${srv.name}: ${up}/${domains.length} Up (${pct}%)`;
  }).join('\n');
  
  sendTelegram(
    `📊 <b>Monthly Report — ${now.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' })}</b>

` +
    `🌐 โดเมนทั้งหมด: ${memoryDomains.length}
` +
    `✅ Uptime: ${uptimePct}% (${upDomains} Up / ${downDomains} Down)
` +
    `🚫 Plesk Suspended: ${suspended}
` +
    `🔒 SSL ใกล้หมด: ${sslExpiring} โดเมน
` +
    `📅 Domain ใกล้หมด: ${domainExpiring} โดเมน

` +
    `<b>สรุปแต่ละ Server:</b>
${serverSummary}

` +
    `🕐 ${now.toLocaleString('th-TH')}`
  );
  
  console.log('[Monthly] ส่ง Monthly Report แล้ว');
}


// ===== PHP-FPM ONDEMAND FIXER =====
const PHPFPM_ONDEMAND_SCRIPT = [
  'CHANGED=0',
  'for CONF in $(find /opt/plesk/php/*/etc/php-fpm.d/ -name "*.conf" 2>/dev/null | grep -v plesk.conf | grep -v www.conf); do',
  '  sed -i "s/^pm = .*/pm = ondemand/" "$CONF" 2>/dev/null && CHANGED=$((CHANGED+1));',
  '  grep -q "^pm.max_children" "$CONF" && sed -i "s/^pm.max_children.*/pm.max_children = 3/" "$CONF" || echo "pm.max_children = 3" >> "$CONF";',
  '  grep -q "^pm.process_idle_timeout" "$CONF" || echo "pm.process_idle_timeout = 10s" >> "$CONF";',
  'done',
  'GLOBAL=/etc/sw-engine/pool.d/plesk.conf',
  '[ -f "$GLOBAL" ] && sed -i "s/^pm = .*/pm = ondemand/" "$GLOBAL"',
  '[ -f "$GLOBAL" ] && grep -q "^pm.process_idle_timeout" "$GLOBAL" || echo "pm.process_idle_timeout = 10s" >> "$GLOBAL" 2>/dev/null',
  'systemctl list-units --state=active --no-legend | grep plesk-php | awk \'{print $1}\' | xargs -I_ systemctl restart _ 2>/dev/null',
  'systemctl restart sw-engine 2>/dev/null',
  'echo "ONDEMAND_DONE CHANGED:$CHANGED"'
].join('; ');

async function applyPhpFpmOndemand(srv) {
  try {
    console.log('[OndemandFix] ' + srv.name + ': เปลี่ยน PHP-FPM เป็น ondemand...');
    const cmdId = queueCommand(srv.host, PHPFPM_ONDEMAND_SCRIPT);
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (agentResults[cmdId]) {
        const result = agentResults[cmdId]; delete agentResults[cmdId];
        const output = (result.output || '').replace(/~/g, ' ');
        const changed = parseInt((output.match(/CHANGED:(\d+)/) || [])[1] || 0);
        const ok = output.includes('ONDEMAND_DONE');
        console.log('[OndemandFix] ' + srv.name + ': ' + (ok?'✅':'❌') + ' ' + changed + ' configs');
        return { ok, changed };
      }
    }
    return { ok: false, changed: 0 };
  } catch(e) { return { ok: false, changed: 0 }; }
}

async function applyAllPhpFpmOndemand() {
  const results = [];
  for (const srv of PLESK_SERVERS) {
    const r = await applyPhpFpmOndemand(srv);
    results.push({ server: srv.name, ...r });
    await new Promise(r => setTimeout(r, 5000));
  }
  const msg = results.map(r => (r.ok?'✅':'❌') + ' ' + r.server + ': ' + r.changed + ' configs').join('\n');
  smartAlert('info', '⚙️ PHP-FPM Ondemand Done\n' + msg + '\n\n✅ pm=ondemand + idle=10s → Load ลดลง');
  return results;
}

// ===== DISK AUTO-CLEANUP =====
const DISK_CLEANUP_THRESHOLD = 80;
const DISK_CRITICAL_THRESHOLD = 90;

const DISK_CLEANUP_SCRIPT = 'find /var/www/vhosts/*/logs/ -name "*.log" -mtime +3 -size +10M -exec truncate -s 0 {} \; 2>/dev/null; ' +
  'find /var/www/vhosts/*/logs/ -name "*.log.*" -mtime +7 -delete 2>/dev/null; ' +
  'find /tmp/ -name "sess_*" -mtime +1 -delete 2>/dev/null; ' +
  'find /var/lib/php/sessions/ -mtime +1 -delete 2>/dev/null; ' +
  'find /tmp/ -maxdepth 2 -mtime +7 -type f -delete 2>/dev/null; ' +
  'rm -rf /var/cache/plesk_installer/* 2>/dev/null; ' +
  'find /var/www/vhosts/*/httpdocs/wp-content/cache/ -type f -mtime +1 -delete 2>/dev/null; ' +
  'yum clean all -q 2>/dev/null || apt-get clean -q 2>/dev/null; ' +
  'DP=$(df / | tail -1 | tr -s " " | cut -d" " -f5 | tr -d "%"); echo "CLEANUP_DONE DISK_AFTER:$DP"';

async function diskCleanup(srv, diskPct) {
  try {
    const cmdId = queueCommand(srv.host, DISK_CLEANUP_SCRIPT);
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (agentResults[cmdId]) {
        const result = agentResults[cmdId]; delete agentResults[cmdId];
        const output = (result.output || '').replace(/~/g, ' ');
        const diskAfter = parseInt((output.match(/DISK_AFTER:(\d+)/) || [])[1] || diskPct);
        console.log('[DiskCleanup] ' + srv.name + ': ' + diskPct + '% → ' + diskAfter + '%');
        try { empLog('janitor', 'ทำความสะอาด disk', srv.name, { server: srv.name }); } catch(e){}
        smartAlert('info', '🧹 Disk Cleanup สำเร็จ\n🖥️ ' + srv.name + '\n📊 ' + diskPct + '% → ' + diskAfter + '%\n✅ ข้อมูลโดเมนปลอดภัย');
        return { ok: true, diskAfter };
      }
    }
    return { ok: false };
  } catch(e) { return { ok: false }; }
}

async function checkAndCleanDisk() {
  for (const srv of PLESK_SERVERS) {
    try {
      const cmdId = queueCommand(srv.host, 'DP=$(df / | tail -1 | tr -s " " | cut -d" " -f5 | tr -d "%"); echo "DISK:$DP"');
      await new Promise(r => setTimeout(r, 35000));
      const result = agentResults[cmdId]; if (!result) continue;
      delete agentResults[cmdId];
      const diskPct = parseInt((result.output||'').match(/DISK:(\d+)/)?.[1] || 0);
      if (diskPct >= DISK_CRITICAL_THRESHOLD) {
        smartAlert('critical', '🚨 Disk Critical!\n🖥️ ' + srv.name + ': <b>' + diskPct + '%</b>\n🧹 Auto-Cleanup...');
        await diskCleanup(srv, diskPct);
      } else if (diskPct >= DISK_CLEANUP_THRESHOLD) {
        smartAlert('warning', '⚠️ Disk Warning\n🖥️ ' + srv.name + ': <b>' + diskPct + '%</b>\n🧹 Auto-Cleanup...');
        await diskCleanup(srv, diskPct);
      }
    } catch(e) {}
  }
}

async function runManualDiskCleanup() {
  const results = [];
  for (const srv of PLESK_SERVERS) {
    const r = await diskCleanup(srv, 0);
    results.push({ server: srv.name, ok: r.ok });
    await new Promise(r => setTimeout(r, 3000));
  }
  return results;
}

// ===== PHP-FPM PER-DOMAIN LIMITER =====
const PHPFPM_LIMIT_SCRIPT = [
  'CHANGED=0',
  'for CONF in $(find /opt/plesk/php/*/etc/php-fpm.d/ -name "*.conf" 2>/dev/null | grep -v plesk.conf | grep -v www.conf); do',
  '  CURRENT=$(grep -m1 "^pm.max_children" "$CONF" 2>/dev/null | awk \'{print $3}\'); ',
  '  if [ -z "$CURRENT" ] || [ "$CURRENT" -gt 3 ] 2>/dev/null; then',
  '    sed -i "s/^pm = .*/pm = dynamic/" "$CONF" 2>/dev/null;',
  '    grep -q "^pm.max_children" "$CONF" && sed -i "s/^pm.max_children.*/pm.max_children = 3/" "$CONF" || echo "pm.max_children = 3" >> "$CONF";',
  '    grep -q "^pm.start_servers" "$CONF" || echo "pm.start_servers = 1" >> "$CONF";',
  '    grep -q "^pm.min_spare_servers" "$CONF" || echo "pm.min_spare_servers = 1" >> "$CONF";',
  '    grep -q "^pm.max_spare_servers" "$CONF" || echo "pm.max_spare_servers = 2" >> "$CONF";',
  '    CHANGED=$((CHANGED+1));',
  '  fi',
  'done',
  'systemctl list-units --state=active --no-legend | grep plesk-php | awk \'{print $1}\' | xargs -I_ systemctl restart _ 2>/dev/null',
  'echo "PHPFPM_DONE CHANGED:$CHANGED"'
].join(' ');

async function limitPhpFpm(srv) {
  try {
    const cmdId = queueCommand(srv.host, PHPFPM_LIMIT_SCRIPT);
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (agentResults[cmdId]) {
        const result = agentResults[cmdId]; delete agentResults[cmdId];
        const output = (result.output||'').replace(/~/g,' ');
        const changed = parseInt((output.match(/CHANGED:(\d+)/)||[])[1]||0);
        const ok = output.includes('PHPFPM_DONE');
        return { ok, changed };
      }
    }
    return { ok: false, changed: 0 };
  } catch(e) { return { ok: false, changed: 0 }; }
}

async function limitAllPhpFpm() {
  const results = [];
  for (const srv of PLESK_SERVERS) {
    const { ok, changed } = await limitPhpFpm(srv);
    results.push({ server: srv.name, ok, changed });
    await new Promise(r => setTimeout(r, 3000));
  }
  smartAlert('info', '⚙️ PHP-FPM Limiter เสร็จ\n' + results.map(r=>(r.ok?'✅':'❌')+' '+r.server+': '+r.changed+' domains').join('\n'));
  return results;
}

// ===== APACHE WATCHDOG INSTALLER =====
const APACHE_WATCHDOG_SCRIPT = [
  '#!/bin/bash',
  'if ! systemctl is-active --quiet httpd; then',
  '  systemctl restart httpd',
  '  echo "[$(date)] Apache restarted" >> /var/log/apache-watchdog.log',
  'fi'
].join('\n');

async function installApacheWatchdog(srv) {
  try {
    const cmd = [
      'cat > /usr/local/bin/apache-watchdog.sh << WDEOF',
      '#!/bin/bash',
      'if ! systemctl is-active --quiet httpd; then',
      '  systemctl restart httpd',
      '  echo "[$(date)] Apache restarted" >> /var/log/apache-watchdog.log',
      'fi',
      'WDEOF',
      'chmod +x /usr/local/bin/apache-watchdog.sh',
      'echo "* * * * * root /usr/local/bin/apache-watchdog.sh" > /etc/cron.d/apache-watchdog',
      'chmod 644 /etc/cron.d/apache-watchdog',
      'echo "WATCHDOG_OK"'
    ].join('; ');
    const cmdId = queueCommand(srv.host, cmd);
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (agentResults[cmdId]) {
        const result = agentResults[cmdId]; delete agentResults[cmdId];
        return (result.output || '').includes('WATCHDOG_OK');
      }
    }
    return false;
  } catch(e) { return false; }
}

async function installAllApacheWatchdogs() {
  const results = [];
  for (const srv of PLESK_SERVERS) {
    const ok = await installApacheWatchdog(srv);
    results.push({ server: srv.name, ok });
    await new Promise(r => setTimeout(r, 2000));
  }
  smartAlert('info', '🛡️ Apache Watchdog ติดตั้งแล้ว\n' + results.map(r=>(r.ok?'✅':'❌')+' '+r.server).join('\n'));
  return results;
}

// ===== CLOUDFLARE IP WHITELIST =====
const CF_IPS = ['173.245.48.0/20','103.21.244.0/22','103.22.200.0/22','103.31.4.0/22','141.101.64.0/18','108.162.192.0/18','190.93.240.0/20','188.114.96.0/20','197.234.240.0/22','198.41.128.0/17','162.158.0.0/15','104.16.0.0/13','104.24.0.0/14','172.64.0.0/13','131.0.72.0/22'];

async function setupCloudflareWhitelist(srv) {
  try {
    const cmd = CF_IPS.map(ip => 'iptables -C INPUT -s ' + ip + ' -j ACCEPT 2>/dev/null || iptables -I INPUT -s ' + ip + ' -j ACCEPT').join('; ') + '; iptables-save > /etc/sysconfig/iptables; echo "CF_DONE"';
    const cmdId = queueCommand(srv.host, cmd);
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (agentResults[cmdId]) {
        const result = agentResults[cmdId]; delete agentResults[cmdId];
        return result.output?.includes('CF_DONE') || result.exitCode === 0;
      }
    }
    return false;
  } catch(e) { return false; }
}

async function setupAllCloudflareWhitelists() {
  const results = [];
  for (const srv of PLESK_SERVERS) {
    const ok = await setupCloudflareWhitelist(srv);
    results.push({ server: srv.name, ok });
    await new Promise(r => setTimeout(r, 3000));
  }
  smartAlert('info', '🛡️ Cloudflare Whitelist Done\n' + results.map(r=>(r.ok?'✅':'❌')+' '+r.server).join('\n') + '\n✅ ป้องกัน Error 521');
  return results;
}


// ===== SMART ALERT SYSTEM =====
// 🚨 Critical → ส่งทันที (cooldown 1 ชั่วโมง)
// ⚠️ Warning  → รวม digest ทุก 30 นาที
// ℹ️ Info     → รวม daily summary เท่านั้น

const alertCooldowns = {};   // { key: lastSentTime }
const warningDigest  = [];   // รอส่งใน digest
const infoDigest     = [];   // รอส่งใน daily
const CRITICAL_COOLDOWN = 60 * 60 * 1000;    // 1 ชั่วโมง
const WARNING_COOLDOWN  = 30 * 60 * 1000;    // 30 นาที

function smartAlert(level, message, key) {
  const now = Date.now();
  const cooldownKey = key || message.slice(0, 50);
  // เก็บทุก alert เป็น event (สำหรับ timeline)
  try { logEvent(level, message.split('\n')[0], { level, key: cooldownKey }); } catch(e) {}

  if (level === 'critical') {
    // ส่งทันที ถ้าไม่อยู่ใน cooldown
    if (!alertCooldowns[cooldownKey] || now - alertCooldowns[cooldownKey] > CRITICAL_COOLDOWN) {
      alertCooldowns[cooldownKey] = now;
      sendTelegram('🚨 <b>CRITICAL</b>\n' + message);
      console.log('[Alert] CRITICAL:', message.slice(0, 60));
    }
  } else if (level === 'warning') {
    // เพิ่มเข้า digest ถ้าไม่ซ้ำ
    if (!alertCooldowns['w:'+cooldownKey] || now - alertCooldowns['w:'+cooldownKey] > WARNING_COOLDOWN) {
      alertCooldowns['w:'+cooldownKey] = now;
      warningDigest.push({ time: new Date().toLocaleTimeString('th-TH', {hour:'2-digit',minute:'2-digit'}), msg: message });
      console.log('[Alert] Warning queued:', message.slice(0, 60));
    }
  } else {
    // info → เก็บใน daily เท่านั้น
    infoDigest.push({ time: new Date().toLocaleTimeString('th-TH', {hour:'2-digit',minute:'2-digit'}), msg: message });
    console.log('[Alert] Info (silent):', message.slice(0, 60));
  }
}

// ส่ง Warning Digest ทุก 30 นาที
function sendWarningDigest() {
  if (!warningDigest.length) return;
  const items = warningDigest.splice(0, warningDigest.length);
  const grouped = {};
  items.forEach(i => {
    const key = i.msg.split('\n')[0];
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(i.time);
  });
  let msg = '⚠️ <b>Warning Digest</b> (30 นาทีล่าสุด)\n\n';
  Object.entries(grouped).forEach(([k, times]) => {
    msg += '• ' + k + (times.length > 1 ? ' (' + times.length + ' ครั้ง)' : '') + '\n';
  });
  msg += '\n🕐 ' + new Date().toLocaleTimeString('th-TH');
  sendTelegram(msg);
  console.log('[Digest] ส่ง warning digest', items.length, 'รายการ');
}

// ส่ง Daily Summary ตอนเที่ยงคืน
function sendDailySummary() {
  try { empLog('ceo', 'สรุปรายวัน', 'รายงานเที่ยงคืน'); resetEmployeeDailyStats(); if(process.env.ANTHROPIC_API_KEY){ runEmployeeBrain('ceo').catch(()=>{}); } } catch(e){}
  const infoItems = infoDigest.splice(0, infoDigest.length);
  const warnings = []; // เก็บ warning ที่ผ่านมาวันนี้
  const up = memoryDomains.filter(d => d.status === 'up').length;
  const down = memoryDomains.filter(d => d.status === 'down').length;

  let msg = '📊 <b>Daily Summary</b>\n';
  msg += '📅 ' + new Date().toLocaleDateString('th-TH') + '\n\n';
  msg += '🌐 โดเมน Up: <b>' + up + '</b> | Down: <b>' + down + '</b>\n';
  msg += '🔧 Auto-heal: ' + (weeklyStats?.fixed || 0) + ' ครั้ง\n';
  if (infoItems.length) msg += 'ℹ️ Events: ' + infoItems.length + ' รายการ (ดูใน DomainIntel)\n';
  msg += '\n✅ ระบบทำงานปกติ';
  sendTelegram(msg);
}


// ===== EVENT LOG / AUDIT TRAIL =====
const eventLog = []; // เก็บ events ล่าสุด (in-memory, ไม่กระทบโฮส)
const MAX_EVENTS = 500;

function logEvent(type, message, meta) {
  const event = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2,7),
    type, // 'down', 'up', 'fix', 'ssl', 'sync', 'alert', 'expiry', 'blacklist'
    message,
    meta: meta || {},
    at: new Date().toISOString()
  };
  eventLog.unshift(event);
  if (eventLog.length > MAX_EVENTS) eventLog.pop();
  return event;
}

// ===== HEALTH SCORE (คำนวณจากข้อมูลที่มี - read only) =====
function calcServerHealthScore(serverName) {
  // หาโดเมนใน server นี้
  const domains = memoryDomains.filter(d => d.pleskServer === serverName);
  if (!domains.length) return null;

  const up = domains.filter(d => d.status === 'up').length;
  const down = domains.filter(d => d.status === 'down').length;
  const total = domains.length;

  // uptime score (40%)
  const uptimeScore = total ? (up / total) * 40 : 0;

  // SSL health (20%)
  const sslOk = domains.filter(d => d.sslDaysLeft === null || d.sslDaysLeft > 14).length;
  const sslScore = total ? (sslOk / total) * 20 : 20;

  // response time (20%) - เร็ว = คะแนนสูง
  const withRt = domains.filter(d => d.responseTime > 0);
  const avgRt = withRt.length ? withRt.reduce((s,d) => s+d.responseTime, 0) / withRt.length : 1000;
  const rtScore = avgRt < 1000 ? 20 : avgRt < 3000 ? 15 : avgRt < 5000 ? 10 : 5;

  // domain expiry (20%)
  const expOk = domains.filter(d => d.daysLeft === null || d.daysLeft > 30).length;
  const expScore = total ? (expOk / total) * 20 : 20;

  const score = Math.round(uptimeScore + sslScore + rtScore + expScore);
  return {
    server: serverName,
    score,
    grade: score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F',
    total, up, down,
    avgResponseTime: Math.round(avgRt),
    breakdown: {
      uptime: Math.round(uptimeScore),
      ssl: Math.round(sslScore),
      responseTime: rtScore,
      expiry: Math.round(expScore)
    }
  };
}

function getAllHealthScores() {
  try { empLog('analyst', 'วิเคราะห์ health score', 'ทุก server'); } catch(e){}
  const servers = [...new Set(memoryDomains.map(d => d.pleskServer).filter(Boolean))];
  return servers.map(s => calcServerHealthScore(s)).filter(Boolean).sort((a,b) => b.score - a.score);
}


// ===== TODO / KANBAN TASKS =====
const TASKS_FILE = '/tmp/domainintel-tasks.json';
let memoryTasks = [];

function loadTasks() {
  try { memoryTasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); }
  catch { memoryTasks = []; }
  return memoryTasks;
}
function saveTasks() {
  try { fs.writeFileSync(TASKS_FILE, JSON.stringify(memoryTasks, null, 2)); } catch(e) {}
}


// ===== BULK GSC ADD SYSTEM =====
// เพิ่มโดเมนเข้า GSC แบบ bulk ผ่าน DNS TXT verification
// รองรับ: Cloudflare API + Plesk DNS (via agent) + manual fallback

const dnsPromises = require('dns').promises;

// 1. เพิ่ม site เข้า GSC (sites.add) — ต้องทำก่อนขอ verification token
async function gscAddSite(token, siteUrl) {
  return new Promise(resolve => {
    const apiPath = '/webmasters/v3/sites/' + encodeURIComponent(siteUrl);
    const req = https.request({
      hostname: 'www.googleapis.com', path: apiPath, method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Length': 0 }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200 || res.statusCode === 204, status: res.statusCode, body: d }));
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

// 2. ขอ verification token (DNS TXT method) ผ่าน Site Verification API
async function gscGetVerificationToken(token, domain) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      verificationMethod: 'DNS_TXT',
      site: { type: 'INET_DOMAIN', identifier: domain }
    });
    const req = https.request({
      hostname: 'www.googleapis.com',
      path: '/siteVerification/v1/token',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r.token) { resolve({ ok: true, token: r.token, raw: r }); }
          else {
            // แสดง error จริงจาก Google (เช่น scope ไม่พอ, API ไม่ enable)
            const errMsg = (r.error && r.error.message) ? r.error.message : JSON.stringify(r).slice(0,150);
            resolve({ ok: false, error: errMsg, status: res.statusCode });
          }
        } catch(e) { resolve({ ok: false, error: 'HTTP ' + res.statusCode + ': ' + d.slice(0,100) }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.write(body); req.end();
  });
}

// 3. เรียก GSC ให้ verify (หลังเขียน TXT แล้ว)
async function gscVerifyDomain(token, domain) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      site: { type: 'INET_DOMAIN', identifier: domain }
    });
    const req = https.request({
      hostname: 'www.googleapis.com',
      path: '/siteVerification/v1/webResource?verificationMethod=DNS_TXT',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const ok = res.statusCode === 200;
        let err = '';
        if (!ok) { try { err = (JSON.parse(d).error||{}).message || d.slice(0,100); } catch { err = d.slice(0,100); } }
        resolve({ ok, status: res.statusCode, error: err });
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.write(body); req.end();
  });
}

// 4. ตรวจว่าโดเมนใช้ nameserver ที่ไหน (เพื่อเลือก method)
async function detectDNSProvider(domain) {
  try {
    const ns = await dnsPromises.resolveNs(domain);
    const nsStr = ns.join(',').toLowerCase();
    if (nsStr.includes('cloudflare')) return { provider: 'cloudflare', ns };
    // เช็คว่าเป็น Plesk server เราไหม (NS ชี้มาที่ IP server)
    return { provider: 'other', ns };
  } catch(e) {
    return { provider: 'unknown', ns: [], error: e.message };
  }
}

// 5. เขียน TXT record ผ่าน Cloudflare API
async function cfWriteTXT(domain, txtValue) {
  const cfToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!cfToken) return { ok: false, error: 'no CF token' };

  // หา zone id ก่อน
  const zoneId = await new Promise(resolve => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: '/client/v4/zones?name=' + encodeURIComponent(domain),
      headers: { 'Authorization': 'Bearer ' + cfToken, 'Content-Type': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { const r = JSON.parse(d); resolve(r.result && r.result[0] ? r.result[0].id : null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });

  if (!zoneId) return { ok: false, error: 'zone not found in this CF account' };

  // เขียน TXT record
  return new Promise(resolve => {
    const body = JSON.stringify({ type: 'TXT', name: domain, content: txtValue, ttl: 3600 });
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: '/client/v4/zones/' + zoneId + '/dns_records',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cfToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r.success) { resolve({ ok: true }); return; }
          // ถ้า record มีอยู่แล้ว (81058/81057/81053) = ถือว่าสำเร็จ พร้อม verify ได้เลย
          const errs = r.errors || [];
          const alreadyExists = errs.some(e => [81058, 81057, 81053].includes(e.code) || (e.message||'').toLowerCase().includes('identical record'));
          if (alreadyExists) { resolve({ ok: true, existed: true }); return; }
          resolve({ ok: false, error: JSON.stringify(errs).slice(0,120) });
        }
        catch { resolve({ ok: false, error: d.slice(0,100) }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.write(body); req.end();
  });
}

// 6. เขียน TXT ผ่าน Plesk DNS (via agent) — สำหรับโดเมนที่ NS ชี้ Plesk
async function pleskWriteTXT(domain, txtValue, serverHost) {
  if (!serverHost) return { ok: false, error: 'no server host' };
  // ใช้ plesk bin dns เพิ่ม TXT record
  const cmd = 'plesk bin dns --add ' + domain + ' -txt "' + txtValue + '" -domain ' + domain + ' 2>&1 | head -3; echo "DNS_DONE"';
  const cmdId = queueCommand(serverHost, cmd);
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (agentResults[cmdId]) {
      const res = agentResults[cmdId]; delete agentResults[cmdId];
      const out = (res.output||'').replace(/~/g,'\n').toLowerCase();
      // ถ้ามี record อยู่แล้ว ถือว่าสำเร็จ
      const alreadyExists = out.includes('already exists') || out.includes('duplicate');
      const ok = out.includes('dns_done') && (!out.includes('error') || alreadyExists);
      return { ok, existed: alreadyExists, output: out.slice(0,150) };
    }
  }
  return { ok: false, error: 'timeout' };
}

// ===== MAIN: Bulk Add โดเมนเข้า GSC =====
const bulkGSCProgress = { running: false, total: 0, done: 0, success: 0, failed: 0, results: [], current: '' };

async function bulkAddToGSC(domains) {
  if (bulkGSCProgress.running) return { error: 'กำลังทำงานอยู่' };

  const token = await refreshGSCToken();
  if (!token) return { error: 'GSC token ใช้ไม่ได้ — เช็ค refresh token' };

  bulkGSCProgress.running = true;
  bulkGSCProgress.total = domains.length;
  bulkGSCProgress.done = 0;
  bulkGSCProgress.success = 0;
  bulkGSCProgress.failed = 0;
  bulkGSCProgress.results = [];

  (async () => {
    for (const d of domains) {
      const domain = (typeof d === 'string' ? d : d.domain).toLowerCase().replace(/^https?:\/\//,'').replace(/\/$/,'');
      bulkGSCProgress.current = domain;
      const result = { domain, steps: [], ok: false };

      try {
        // Step 1: เพิ่ม sc-domain property เข้า GSC
        const siteUrl = 'sc-domain:' + domain;
        const addRes = await gscAddSite(token, siteUrl);
        result.steps.push({ step: 'add', ok: addRes.ok });

        // Step 2: ขอ verification token
        const vtok = await gscGetVerificationToken(token, domain);
        if (!vtok.ok) {
          result.error = 'ขอ token ไม่ได้: ' + (vtok.error||'');
          result.steps.push({ step: 'token', ok: false });
          bulkGSCProgress.results.push(result); bulkGSCProgress.failed++; bulkGSCProgress.done++;
          continue;
        }
        result.steps.push({ step: 'token', ok: true });
        const txtValue = vtok.token; // "google-site-verification=xxxx"

        // Step 3: detect DNS provider + เขียน TXT
        const dnsInfo = await detectDNSProvider(domain);
        result.provider = dnsInfo.provider;
        let written = { ok: false };

        if (dnsInfo.provider === 'cloudflare') {
          written = await cfWriteTXT(domain, txtValue);
          result.steps.push({ step: 'txt-cloudflare', ok: written.ok, error: written.error });
        } else {
          // ลองหา Plesk server ของโดเมนนี้
          const domObj = memoryDomains.find(x => x.domain === domain);
          const srv = domObj ? PLESK_SERVERS.find(s => s.name === domObj.pleskServer) : null;
          if (srv) {
            written = await pleskWriteTXT(domain, txtValue, srv.host);
            result.steps.push({ step: 'txt-plesk', ok: written.ok, error: written.error });
          } else {
            // fallback: แสดง TXT ให้ก็อปเอง
            result.manualTXT = txtValue;
            result.steps.push({ step: 'txt-manual', ok: false });
            result.error = 'ต้องเพิ่ม TXT เอง: ' + txtValue;
            bulkGSCProgress.results.push(result); bulkGSCProgress.failed++; bulkGSCProgress.done++;
            continue;
          }
        }

        if (!written.ok) {
          result.error = 'เขียน TXT ไม่ได้: ' + (written.error||'');
          result.manualTXT = txtValue;
          bulkGSCProgress.results.push(result); bulkGSCProgress.failed++; bulkGSCProgress.done++;
          continue;
        }

        // Step 4: รอ DNS propagate แล้ว verify (retry หลายครั้ง)
        // DNS propagation ใช้เวลา ลอง verify 3 ครั้ง ห่างกัน 15 วิ
        let verifyRes = { ok: false };
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise(r => setTimeout(r, attempt === 0 ? 8000 : 15000));
          verifyRes = await gscVerifyDomain(token, domain);
          if (verifyRes.ok) break;
        }
        result.steps.push({ step: 'verify', ok: verifyRes.ok, error: verifyRes.error });

        if (verifyRes.ok) {
          result.ok = true;
          bulkGSCProgress.success++;
          logEvent('gsc', 'เพิ่ม ' + domain + ' เข้า GSC สำเร็จ', { domain });
          try { empLog('onboarder', 'เพิ่มโดเมนเข้า GSC', domain, { domain }); } catch(e){}
        } else {
          // TXT เขียนแล้วแต่ DNS ยังไม่ propagate — แยกเป็นสถานะ pending
          result.pendingVerify = true;
          result.error = 'TXT เขียนแล้ว · รอ DNS propagate (5-10 นาที) แล้วกด "Verify ที่ค้าง"';
          bulkGSCProgress.pendingVerify = (bulkGSCProgress.pendingVerify || 0) + 1;
          bulkGSCProgress.failed++;
        }
      } catch(e) {
        result.error = e.message;
        bulkGSCProgress.failed++;
      }

      bulkGSCProgress.results.push(result);
      bulkGSCProgress.done++;
      // delay กัน rate limit
      await new Promise(r => setTimeout(r, 1500));
    }
    bulkGSCProgress.running = false;
    bulkGSCProgress.current = '';
    smartAlert('info', '📋 Bulk GSC เสร็จ: สำเร็จ ' + bulkGSCProgress.success + ' / ล้มเหลว ' + bulkGSCProgress.failed);
  })().catch(e => { bulkGSCProgress.running = false; console.log('[BulkGSC] error:', e.message); });

  return { ok: true, message: 'เริ่มเพิ่ม ' + domains.length + ' โดเมน' };
}



// ===== ระบบพนักงาน AI 11 คน =====
// เฟสแรก: โครงสร้าง + activity tracking (ยังไม่ต่อ Claude API)
// หลักการ: งานดู/วิเคราะห์ = อัตโนมัติ | งานแก้บนโฮส = ต้องอนุมัติจากเจ้าของ

const EMPLOYEES = [
  { id: 'ceo',          name: 'CEO',            emoji: '👔', dept: 'บริหาร',      role: 'ดูภาพรวมระบบ + สรุป report ส่งเจ้าของ', canActOnHost: false },
  { id: 'manager',      name: 'Manager',        emoji: '📋', dept: 'บริหาร',      role: 'รับเรื่องจาก CEO มาแตกเป็นงานย่อย',     canActOnHost: false },
  { id: 'diagnostician',name: 'Diagnostician',  emoji: '🔬', dept: 'แก้ปัญหา',    role: 'วินิจฉัยปัญหา หาสาเหตุและวิธีแก้',       canActOnHost: false },
  { id: 'engineer',     name: 'Engineer',       emoji: '🔧', dept: 'แก้ปัญหา',    role: 'ลงมือแก้ปัญหาบนระบบ',                  canActOnHost: true },
  { id: 'safety',       name: 'Safety Reviewer',emoji: '🛡️', dept: 'แก้ปัญหา',    role: 'ตรวจผลกระทบก่อนแก้ ป้องกันโฮสเสียหาย',  canActOnHost: false },
  { id: 'janitor',      name: 'Janitor',        emoji: '🧹', dept: 'เฉพาะทาง',    role: 'ทำความสะอาดระบบ ลบ log/cache เก่า',     canActOnHost: true },
  { id: 'security',     name: 'Security Guard', emoji: '👮', dept: 'เฉพาะทาง',    role: 'ตรวจความเสี่ยง + เฝ้า traffic drop',     canActOnHost: false },
  { id: 'seo',          name: 'SEO Strategist', emoji: '📈', dept: 'เฉพาะทาง',    role: 'วิเคราะห์ + เสนอแนวทางพัฒนาโดเมน',       canActOnHost: false },
  { id: 'onboarder',    name: 'Onboarder',      emoji: '📦', dept: 'เฉพาะทาง',    role: 'จัดการโดเมนใหม่ ตั้งค่าเริ่มต้น',         canActOnHost: true },
  { id: 'coordinator',  name: 'Coordinator',    emoji: '🎯', dept: 'สนับสนุน',    role: 'จัดคิวงาน กระจายงาน เก็บสถิติพนักงาน',   canActOnHost: false },
  { id: 'analyst',      name: 'Analyst',        emoji: '📊', dept: 'สนับสนุน',    role: 'วิเคราะห์คุณค่า-ต้นทุน โดเมน/server',     canActOnHost: false }
];

// สถานะพนักงาน (in-memory + persist /tmp)
const EMP_STATE_FILE = '/tmp/domainintel-employees.json';
let employeeState = {};
let employeeActivity = []; // log งานที่พนักงานทำ (ล่าสุด 300)
const MAX_EMP_ACTIVITY = 300;

function loadEmployeeState() {
  try {
    const saved = JSON.parse(fs.readFileSync(EMP_STATE_FILE, 'utf8'));
    employeeState = saved.state || {};
    employeeActivity = saved.activity || [];
  } catch { employeeState = {}; employeeActivity = []; }
  // init ค่าเริ่มต้นให้ครบทุกคน
  EMPLOYEES.forEach(e => {
    if (!employeeState[e.id]) {
      employeeState[e.id] = { status: 'idle', lastTask: null, lastActiveAt: null, tasksToday: 0, tasksTotal: 0 };
    }
  });
}
function saveEmployeeState() {
  try { fs.writeFileSync(EMP_STATE_FILE, JSON.stringify({ state: employeeState, activity: employeeActivity })); } catch(e) {}
}

// บันทึกว่าพนักงานทำงาน
function empLog(empId, action, detail, meta) {
  const emp = EMPLOYEES.find(e => e.id === empId);
  if (!emp) return;
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2,6),
    empId, empName: emp.name, emoji: emp.emoji,
    action, detail: detail || '',
    meta: meta || {},
    at: new Date().toISOString()
  };
  employeeActivity.unshift(entry);
  if (employeeActivity.length > MAX_EMP_ACTIVITY) employeeActivity.pop();

  // อัพเดทสถานะ
  const st = employeeState[empId];
  if (st) {
    st.lastTask = action;
    st.lastActiveAt = entry.at;
    st.tasksToday = (st.tasksToday || 0) + 1;
    st.tasksTotal = (st.tasksTotal || 0) + 1;
  }
  saveEmployeeState();
  return entry;
}

// reset tasksToday ทุกเที่ยงคืน
function resetEmployeeDailyStats() {
  Object.values(employeeState).forEach(st => { st.tasksToday = 0; });
  saveEmployeeState();
}

// ===== APPROVAL QUEUE (งานที่ต้องขออนุมัติจากเจ้าของ) =====
const APPROVAL_FILE = '/tmp/domainintel-approvals.json';
let approvalQueue = [];

function loadApprovals() {
  try { approvalQueue = JSON.parse(fs.readFileSync(APPROVAL_FILE, 'utf8')); }
  catch { approvalQueue = []; }
}
function saveApprovals() {
  try { fs.writeFileSync(APPROVAL_FILE, JSON.stringify(approvalQueue)); } catch(e) {}
}

// พนักงานขออนุมัติ (สำหรับงานแก้บนโฮส)
function requestApproval(empId, title, description, action, meta) {
  const emp = EMPLOYEES.find(e => e.id === empId);
  const req = {
    id: 'apr_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    empId, empName: emp ? emp.name : empId, emoji: emp ? emp.emoji : '🤖',
    title, description: description || '',
    action: action || '', // action key ที่จะทำถ้าอนุมัติ
    meta: meta || {},
    status: 'pending', // pending | approved | rejected
    createdAt: new Date().toISOString(),
    decidedAt: null
  };
  approvalQueue.unshift(req);
  saveApprovals();
  empLog(empId, 'ขออนุมัติ', title, { approvalId: req.id });
  // แจ้งเจ้าของผ่าน Telegram
  try { smartAlert('warning', '🔔 รออนุมัติ: ' + (emp ? emp.name : empId) + ' ขอ "' + title + '"', 'approval:' + req.id); } catch(e) {}
  return req;
}


// ===== เฟส 2: สมอง AI (Claude API) =====
// เรียก Claude ให้พนักงานวิเคราะห์/คิด — เฉพาะงาน "ดู/วิเคราะห์" ปลอดภัย ไม่แตะโฮส
// ต้องตั้ง ANTHROPIC_API_KEY ใน Railway env

async function callClaude(systemPrompt, userPrompt, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: 'ยังไม่ได้ตั้ง ANTHROPIC_API_KEY' };

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001', // ใช้ Haiku ประหยัด เหมาะงานวิเคราะห์
    max_tokens: maxTokens || 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = ''; res.on('data', ch => d += ch);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r.content && r.content[0] && r.content[0].text) {
            resolve({ ok: true, text: r.content[0].text, usage: r.usage });
          } else {
            resolve({ ok: false, error: (r.error && r.error.message) || 'no content' });
          }
        } catch(e) { resolve({ ok: false, error: 'parse error: ' + d.slice(0,100) }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.write(body); req.end();
  });
}

// เก็บผลงานวิเคราะห์ของพนักงาน (รายงานล่าสุด)
const EMP_REPORTS_FILE = '/tmp/domainintel-reports.json';
let employeeReports = {}; // { empId: { text, at, ... } }

function loadReports() {
  try { employeeReports = JSON.parse(fs.readFileSync(EMP_REPORTS_FILE, 'utf8')); }
  catch { employeeReports = {}; }
}
function saveReports() {
  try { fs.writeFileSync(EMP_REPORTS_FILE, JSON.stringify(employeeReports)); } catch(e) {}
}

// รวบรวมข้อมูลระบบให้พนักงานวิเคราะห์
function gatherSystemSnapshot() {
  const up = memoryDomains.filter(d => d.status === 'up').length;
  const down = memoryDomains.filter(d => d.status === 'down').length;
  const total = memoryDomains.length;
  const sslExpiringSoon = memoryDomains.filter(d => d.sslDaysLeft !== null && d.sslDaysLeft <= 14 && d.sslDaysLeft > 0).length;
  const domainExpiringSoon = memoryDomains.filter(d => d.daysLeft !== null && d.daysLeft <= 30 && d.daysLeft > 0).length;
  const inGSC = memoryDomains.filter(d => d.gsc && d.gsc.inGSC).length;

  // top traffic
  const topTraffic = memoryDomains
    .filter(d => d.gsc && d.gsc.d30 && d.gsc.d30.clicks > 0)
    .sort((a,b) => (b.gsc.d30.clicks||0) - (a.gsc.d30.clicks||0))
    .slice(0, 10)
    .map(d => ({ domain: d.domain, clicks: d.gsc.d30.clicks, impressions: d.gsc.d30.impressions }));

  // health scores (ห่อ try-catch กัน throw ทำให้ snapshot พัง)
  let health = [];
  try {
    if (typeof getAllHealthScores === 'function') health = getAllHealthScores() || [];
  } catch(e) { console.log('[Snapshot] health error:', e.message); }

  return {
    timestamp: new Date().toISOString(),
    domains: { total, up, down, inGSC },
    alerts: { sslExpiringSoon, domainExpiringSoon },
    topTraffic,
    serverHealth: health.map(h => ({ server: h.server, score: h.score, grade: h.grade, up: h.up, down: h.down }))
  };
}

// ===== งานวิเคราะห์ของพนักงานแต่ละคน =====
const EMP_BRAINS = {
  ceo: {
    system: 'คุณคือ CEO ของบริษัทจัดการโดเมนและเซิร์ฟเวอร์ มีหน้าที่สรุปภาพรวมให้เจ้าของบริษัทเข้าใจง่ายใน 3-5 บรรทัด ใช้ภาษาไทย กระชับ ชี้จุดที่ควรสนใจ ถ้าทุกอย่างปกติก็บอกว่าปกติ',
    prompt: (snap) => 'สรุปสถานะบริษัทวันนี้ให้เจ้าของฟัง:\n' + JSON.stringify(snap, null, 2)
  },
  analyst: {
    system: 'คุณคือนักวิเคราะห์ข้อมูล วิเคราะห์คุณค่า-ต้นทุนของโดเมนและ server เป็นภาษาไทย ชี้ว่าโดเมนไหนคุ้ม โดเมนไหนควรพิจารณา server ไหนใกล้เต็ม ตอบกระชับเป็นข้อๆ',
    prompt: (snap) => 'วิเคราะห์ข้อมูลนี้ หาจุดที่ควรปรับปรุง:\n' + JSON.stringify(snap, null, 2)
  },
  seo: {
    system: 'คุณคือผู้เชี่ยวชาญ SEO วิเคราะห์โอกาสเพิ่ม traffic ของโดเมน เป็นภาษาไทย เสนอแนวทางที่ทำได้จริง เช่น โดเมนที่ impression สูงแต่ CTR ต่ำควรปรับ title ตอบเป็นข้อๆ',
    prompt: (snap) => 'หาโอกาสพัฒนา SEO จากข้อมูลนี้:\n' + JSON.stringify(snap, null, 2)
  },
  security: {
    system: 'คุณคือเจ้าหน้าที่ความปลอดภัย ประเมินความเสี่ยงของระบบ เป็นภาษาไทย ชี้โดเมนที่เสี่ยง (SSL ใกล้หมด โดเมนใกล้หมดอายุ down) จัดลำดับความเร่งด่วน ตอบกระชับ',
    prompt: (snap) => 'ประเมินความเสี่ยงด้านความปลอดภัยจากข้อมูลนี้:\n' + JSON.stringify(snap, null, 2)
  }
};

async function runEmployeeBrain(empId) {
  const brain = EMP_BRAINS[empId];
  if (!brain) return { ok: false, error: 'พนักงานคนนี้ยังไม่มีสมอง AI' };

  const snap = gatherSystemSnapshot();
  const result = await callClaude(brain.system, brain.prompt(snap), 1024);

  if (result.ok) {
    employeeReports[empId] = {
      text: result.text,
      at: new Date().toISOString(),
      usage: result.usage || null
    };
    saveReports();
    empLog(empId, 'วิเคราะห์ด้วย AI', 'สร้างรายงานใหม่', { aiGenerated: true });
  }
  return result;
}


// ===== เฟส 3: ทะเบียน Action ที่ปลอดภัย =====
// พนักงานเสนอได้เฉพาะที่นี่ — ทุกตัวผ่านการ test แล้วและไม่ทำลายโฮส
const SAFE_ACTIONS = {
  'disk-cleanup': {
    label: 'ทำความสะอาด disk ทุก server',
    desc: 'ลบ log เก่า, cache, session เก่า — ไม่แตะข้อมูลโดเมน',
    emp: 'janitor',
    run: async () => {
      if (typeof runManualDiskCleanup === 'function') {
        const results = await runManualDiskCleanup();
        return { ok: true, detail: 'cleanup ' + results.filter(r=>r.ok).length + '/' + results.length + ' servers' };
      }
      return { ok: false, detail: 'function ไม่พร้อม' };
    }
  },
  'phpfpm-ondemand': {
    label: 'ปรับ PHP-FPM เป็น ondemand',
    desc: 'ลด memory โดยให้ PHP-FPM ทำงานเมื่อมีคนเข้าเท่านั้น',
    emp: 'engineer',
    run: async () => {
      if (typeof applyAllPhpFpmOndemand === 'function') {
        await applyAllPhpFpmOndemand();
        return { ok: true, detail: 'ปรับ PHP-FPM ondemand แล้ว' };
      }
      return { ok: false, detail: 'function ไม่พร้อม' };
    }
  },
  'fix-down-domain': {
    label: 'Auto-heal โดเมนที่ down',
    desc: 'พยายามกู้โดเมนที่ down (unsuspend, restart service)',
    emp: 'engineer',
    run: async (meta) => {
      const domain = meta && meta.domain;
      if (!domain) return { ok: false, detail: 'ไม่ระบุโดเมน' };
      const norm = String(domain).toLowerCase().trim().replace(/^https?:\/\//,'').replace(/\/$/,'');
      const d = memoryDomains.find(x => (x.domain||'').toLowerCase() === norm);
      if (!d) return { ok: false, detail: 'ไม่พบโดเมน "' + domain + '" ในระบบ (อาจถูกลบไปแล้ว)' };
      if (d.status !== 'down') return { ok: true, detail: domain + ' กลับมา up แล้ว ไม่ต้องกู้' };
      if (typeof autoFix === 'function') {
        await autoFix(d, 'down');
        return { ok: true, detail: 'พยายามกู้ ' + domain + ' แล้ว' };
      }
      return { ok: false, detail: 'function ไม่พร้อม' };
    }
  }
};

// รัน action หลังได้รับอนุมัติ
async function executeApprovedAction(approval) {
  const action = SAFE_ACTIONS[approval.action];
  if (!action) {
    empLog(approval.empId, 'รัน action ไม่ได้', 'ไม่รู้จัก action: ' + approval.action);
    return { ok: false, detail: 'ไม่รู้จัก action นี้' };
  }
  try {
    empLog(action.emp, 'เริ่มทำงาน (อนุมัติแล้ว)', action.label, { approvalId: approval.id });
    const result = await action.run(approval.meta || {});
    empLog(action.emp, result.ok ? 'ทำงานสำเร็จ' : 'ทำงานล้มเหลว', result.detail, { approvalId: approval.id });
    logEvent(result.ok ? 'fix' : 'warning', '[' + action.emp + '] ' + action.label + ': ' + result.detail);
    smartAlert('info', '🤖 ' + action.label + ' — ' + (result.ok ? 'สำเร็จ' : 'ล้มเหลว') + '\n' + result.detail);
    return result;
  } catch(e) {
    empLog(action.emp, 'ทำงานผิดพลาด', e.message, { approvalId: approval.id });
    return { ok: false, detail: e.message };
  }
}

// พนักงาน AI เสนองาน (Diagnostician วิเคราะห์แล้วเสนอ)
// เฉพาะเมื่อมี API key — ใช้ Claude ตัดสินใจว่าควรเสนออะไร
async function proposeActionsFromAnalysis() {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: 'ไม่มี API key' };

  const snap = gatherSystemSnapshot();
  // ให้ Diagnostician ดูว่ามีปัญหาอะไรที่ควรเสนอแก้
  const proposals = [];

  // ตรวจ disk เต็มจาก health (เสนอ cleanup)
  const highDisk = (snap.serverHealth||[]).filter(h => h.score < 70);
  if (highDisk.length > 0) {
    proposals.push({ action: 'disk-cleanup', reason: 'มี ' + highDisk.length + ' server สุขภาพต่ำกว่า 70 คะแนน' });
  }

  // ตรวจโดเมน down (เสนอ auto-heal)
  if (snap.domains.down > 0 && snap.domains.down <= 10) {
    const downDomains = memoryDomains.filter(d => d.status === 'down' && !(d.tags||[]).includes('gsc')).slice(0, 5);
    downDomains.forEach(d => {
      proposals.push({ action: 'fix-down-domain', reason: 'โดเมน down', meta: { domain: d.domain } });
    });
  }

  // สร้าง approval request สำหรับแต่ละข้อเสนอ (ไม่ซ้ำกับที่ pending อยู่)
  let created = 0;
  for (const p of proposals) {
    const act = SAFE_ACTIONS[p.action];
    if (!act) continue;
    const dupe = approvalQueue.find(a => a.status === 'pending' && a.action === p.action &&
      JSON.stringify(a.meta||{}) === JSON.stringify(p.meta||{}));
    if (dupe) continue;
    requestApproval(act.emp, act.label, act.desc + ' — เหตุผล: ' + p.reason, p.action, p.meta || {});
    created++;
  }
  if (created > 0) empLog('diagnostician', 'เสนองานแก้ปัญหา', created + ' รายการ รออนุมัติ');
  return { ok: true, created };
}


// ===== งานที่พนักงานกดรันได้เดี๋ยวนี้ (real-time) =====
// ประเภท: 'view' = ดูข้อมูล (รันเลย ไม่เรียก API ฟรี) | 'ai' = วิเคราะห์ (เรียก Claude) | 'host' = แก้โฮส (ขออนุมัติ)
const EMPLOYEE_TASKS = {
  ceo: [
    { id: 'ceo-overview', type: 'view', label: 'ดูภาพรวมระบบ', run: () => {
        const s = gatherSystemSnapshot();
        return { summary: 'โดเมน ' + s.domains.total + ' (up ' + s.domains.up + '/down ' + s.domains.down + ') · SSL ใกล้หมด ' + s.alerts.sslExpiringSoon };
      }},
    { id: 'ceo-report', type: 'ai', label: 'เขียนรายงานสรุป (AI)', run: () => runEmployeeBrain('ceo') }
  ],
  manager: [
    { id: 'mgr-pending', type: 'view', label: 'ดูงานที่ค้างอยู่', run: () => {
        const pending = approvalQueue.filter(a => a.status === 'pending').length;
        const tasks = memoryTasks.filter(t => t.status !== 'done').length;
        return { summary: 'งานรออนุมัติ ' + pending + ' · งานในบอร์ด ' + tasks };
      }}
  ],
  diagnostician: [
    { id: 'diag-scan', type: 'view', label: 'สแกนหาปัญหา', run: () => {
        const down = memoryDomains.filter(d => d.status === 'down' && !(d.tags||[]).includes('gsc')).length;
        const sslSoon = memoryDomains.filter(d => d.sslDaysLeft !== null && d.sslDaysLeft <= 14 && d.sslDaysLeft > 0).length;
        return { summary: 'พบโดเมน down ' + down + ' · SSL ใกล้หมด ' + sslSoon, issues: down + sslSoon };
      }},
    { id: 'diag-propose', type: 'host', label: 'เสนองานแก้ปัญหา', run: () => proposeActionsFromAnalysis() }
  ],
  engineer: [
    { id: 'eng-disk', type: 'host', label: 'ขอทำความสะอาด disk', run: () => {
        const act = SAFE_ACTIONS['disk-cleanup'];
        requestApproval('engineer', act.label, act.desc, 'disk-cleanup', {});
        return { summary: 'ส่งขออนุมัติแล้ว' };
      }},
    { id: 'eng-phpfpm', type: 'host', label: 'ขอปรับ PHP-FPM', run: () => {
        const act = SAFE_ACTIONS['phpfpm-ondemand'];
        requestApproval('engineer', act.label, act.desc, 'phpfpm-ondemand', {});
        return { summary: 'ส่งขออนุมัติแล้ว' };
      }}
  ],
  safety: [
    { id: 'safety-check', type: 'view', label: 'ตรวจความปลอดภัยระบบ', run: () => {
        const health = (typeof getAllHealthScores === 'function') ? getAllHealthScores() : [];
        const low = health.filter(h => h.score < 70).length;
        return { summary: 'Server สุขภาพต่ำกว่า 70: ' + low + '/' + health.length };
      }}
  ],
  janitor: [
    { id: 'jan-status', type: 'view', label: 'ดูสถานะ disk', run: () => {
        return { summary: 'พร้อมทำความสะอาด — กดเสนองานเพื่อ cleanup' };
      }},
    { id: 'jan-cleanup', type: 'host', label: 'ขอทำความสะอาด', run: () => {
        const act = SAFE_ACTIONS['disk-cleanup'];
        requestApproval('janitor', act.label, act.desc, 'disk-cleanup', {});
        return { summary: 'ส่งขออนุมัติแล้ว' };
      }}
  ],
  security: [
    { id: 'sec-risk', type: 'view', label: 'ประเมินความเสี่ยง', run: () => {
        const expiring = memoryDomains.filter(d => d.daysLeft !== null && d.daysLeft <= 30 && d.daysLeft > 0).length;
        const sslSoon = memoryDomains.filter(d => d.sslDaysLeft !== null && d.sslDaysLeft <= 14 && d.sslDaysLeft > 0).length;
        return { summary: 'โดเมนใกล้หมดอายุ ' + expiring + ' · SSL ใกล้หมด ' + sslSoon };
      }},
    { id: 'sec-analyze', type: 'ai', label: 'วิเคราะห์ความเสี่ยง (AI)', run: () => runEmployeeBrain('security') }
  ],
  seo: [
    { id: 'seo-opportunity', type: 'view', label: 'หาโอกาส SEO', run: () => {
        const opp = memoryDomains.filter(d => d.gsc && d.gsc.d30 && d.gsc.d30.impressions >= 100 &&
          d.gsc.d30.clicks > 0 && (d.gsc.d30.clicks / d.gsc.d30.impressions) < 0.02).length;
        return { summary: 'พบ ' + opp + ' โดเมนที่ impression สูงแต่ CTR ต่ำ (โอกาสปรับ)' };
      }},
    { id: 'seo-analyze', type: 'ai', label: 'วิเคราะห์ SEO (AI)', run: () => runEmployeeBrain('seo') }
  ],
  onboarder: [
    { id: 'onb-new', type: 'view', label: 'ดูโดเมนใหม่ที่ยังไม่ตั้งค่า', run: () => {
        const notInGSC = memoryDomains.filter(d => !(d.gsc && d.gsc.inGSC)).length;
        return { summary: 'โดเมนที่ยังไม่อยู่ใน GSC: ' + notInGSC + ' (เพิ่มได้ที่ Traffic & GSC)' };
      }}
  ],
  coordinator: [
    { id: 'coord-stats', type: 'view', label: 'ดูสถิติพนักงาน', run: () => {
        const total = Object.values(employeeState).reduce((s,st)=>s+(st.tasksToday||0),0);
        const busiest = Object.entries(employeeState).sort((a,b)=>(b[1].tasksToday||0)-(a[1].tasksToday||0))[0];
        const busiestName = busiest ? (EMPLOYEES.find(e=>e.id===busiest[0])||{}).name : '-';
        return { summary: 'งานวันนี้รวม ' + total + ' · ขยันสุด: ' + busiestName };
      }}
  ],
  analyst: [
    { id: 'ana-value', type: 'view', label: 'วิเคราะห์คุณค่าโดเมน', run: () => {
        const ghost = memoryDomains.filter(d => d.gsc && d.gsc.inGSC && d.gsc.d30 && d.gsc.d30.clicks === 0).length;
        const hot = memoryDomains.filter(d => d.gsc && d.gsc.d30 && d.gsc.d30.clicks >= 100).length;
        return { summary: 'โดเมนทำเงิน (100+ clicks): ' + hot + ' · โดเมนเงียบ (0 clicks): ' + ghost };
      }},
    { id: 'ana-analyze', type: 'ai', label: 'วิเคราะห์เชิงลึก (AI)', run: () => runEmployeeBrain('analyst') }
  ]
};

// รันงานของพนักงาน
async function runEmployeeTask(empId, taskId) {
  const tasks = EMPLOYEE_TASKS[empId];
  if (!tasks) return { ok: false, error: 'ไม่พบพนักงาน' };
  const task = tasks.find(t => t.id === taskId);
  if (!task) return { ok: false, error: 'ไม่พบงาน' };

  // งาน AI ต้องมี key
  if (task.type === 'ai' && !process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'งานนี้ต้องใช้ AI — ยังไม่ได้ตั้ง ANTHROPIC_API_KEY' };
  }

  try {
    empLog(empId, task.label, task.type === 'view' ? 'ดูข้อมูล' : task.type === 'ai' ? 'วิเคราะห์ด้วย AI' : 'เสนองาน');
    const result = await task.run();
    return { ok: true, type: task.type, label: task.label, result };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}


// ===== ระบบแก้ปัญหาอัตโนมัติ (เฉพาะงานปลอดภัย) =====
// หลักการ: ปัญหาปลอดภัย (disk เต็ม, โดเมน down) → แก้เองเลย
//          ปัญหาเสี่ยง → ขออนุมัติ
let autoFixEnabled = true; // เปิด/ปิดได้
const autoFixHistory = []; // เก็บประวัติการแก้อัตโนมัติ
const MAX_AUTOFIX_HISTORY = 200;

// ตั้งสถานะ "กำลังทำงาน" ให้พนักงาน (ค้างไว้ตามเวลาที่กำหนด)
function setEmployeeWorking(empId, taskLabel, durationMs) {
  const st = employeeState[empId];
  if (!st) return;
  st.status = 'working';
  st.currentTask = taskLabel;
  st.workingSince = new Date().toISOString();
  saveEmployeeState();
  // กลับเป็น idle หลังเสร็จ
  setTimeout(() => {
    if (st.status === 'working' && st.currentTask === taskLabel) {
      st.status = 'idle';
      st.currentTask = null;
      saveEmployeeState();
    }
  }, durationMs || 8000);
}

function logAutoFix(empId, problem, action, result) {
  const emp = EMPLOYEES.find(e => e.id === empId);
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2,6),
    empId, empName: emp ? emp.name : empId, emoji: emp ? emp.emoji : '🤖',
    problem, action, result: result.ok ? 'สำเร็จ' : 'ล้มเหลว', detail: result.detail || '',
    at: new Date().toISOString()
  };
  autoFixHistory.unshift(entry);
  if (autoFixHistory.length > MAX_AUTOFIX_HISTORY) autoFixHistory.pop();
  return entry;
}

// สแกนปัญหา + แก้อัตโนมัติ (เฉพาะปลอดภัย)
async function runAutoFixCycle() {
  if (!autoFixEnabled) return { ok: false, reason: 'auto-fix ปิดอยู่' };

  try {
    const snap = gatherSystemSnapshot();
    const fixed = [];

    // 1. โดเมน down → Engineer auto-heal (ปลอดภัย: ใช้ autoFix เดิม)
    const downDomains = memoryDomains.filter(d =>
      d.status === 'down' && !(d.tags||[]).includes('gsc') && d.pleskServer
    ).slice(0, 10); // ทีละไม่เกิน 10

    if (downDomains.length > 0) {
      setEmployeeWorking('engineer', 'กู้โดเมน down ' + downDomains.length + ' โดเมน', 30000);
      for (const d of downDomains) {
        try {
          if (typeof autoFix === 'function') {
            await autoFix(d, 'down');
            const entry = logAutoFix('engineer', 'โดเมน ' + d.domain + ' down', 'auto-heal', { ok: true, detail: 'พยายามกู้แล้ว' });
            empLog('engineer', 'แก้อัตโนมัติ: กู้โดเมน', d.domain);
            fixed.push(entry);
          }
        } catch(e) {}
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // 2. Server สุขภาพต่ำ (disk อาจเต็ม) → Janitor cleanup อัตโนมัติ
    const lowHealth = (snap.serverHealth||[]).filter(h => h.score < 60);
    if (lowHealth.length > 0 && typeof runManualDiskCleanup === 'function') {
      setEmployeeWorking('janitor', 'ทำความสะอาด ' + lowHealth.length + ' server', 60000);
      try {
        const results = await runManualDiskCleanup();
        const okCount = (results||[]).filter(r => r.ok).length;
        const entry = logAutoFix('janitor', 'มี ' + lowHealth.length + ' server สุขภาพต่ำ', 'disk cleanup', { ok: true, detail: 'cleanup ' + okCount + ' servers' });
        empLog('janitor', 'แก้อัตโนมัติ: ทำความสะอาด', okCount + ' servers');
        fixed.push(entry);
      } catch(e) { console.log('[AutoFix] cleanup error:', e.message); }
    }

    if (fixed.length > 0) {
      logEvent('fix', 'Auto-fix แก้ปัญหา ' + fixed.length + ' รายการ', { count: fixed.length });
      smartAlert('info', '🤖 Auto-fix ทำงาน: แก้ปัญหา ' + fixed.length + ' รายการอัตโนมัติ');
    }
    return { ok: true, fixed: fixed.length, details: fixed };
  } catch(e) {
    console.log('[AutoFix] error:', e.message);
    return { ok: false, error: 'เกิดข้อผิดพลาด: ' + e.message };
  }
}


// ===== ศูนย์บัญชาการ: รวมสถานะทุกอย่าง จัดหมวด เรียงความเร่งด่วน =====
function buildCommandCenter() {
  // 1. ปัญหาเร่งด่วน (เรียงตามความรุนแรง)
  const problems = [];
  memoryDomains.filter(d => d.status === 'down' && !(d.tags||[]).includes('gsc') && d.pleskServer).slice(0,30).forEach(d => {
    problems.push({ severity: 'high', emoji: '🔴', cat: 'โดเมนล่ม', title: d.domain, detail: 'Server: ' + (d.pleskServer||'-'), action: 'fix-down-domain', meta: { domain: d.domain }, canFix: true });
  });
  let health = [];
  try { health = getAllHealthScores() || []; } catch(e) {}
  health.filter(h => h.score < 70).forEach(h => {
    problems.push({ severity: h.score < 50 ? 'high' : 'medium', emoji: '⚠️', cat: 'Server สุขภาพต่ำ', title: h.server + ' (เกรด ' + h.grade + ')', detail: 'คะแนน ' + h.score + '/100 · down ' + h.down + ' · ตอบสนอง ' + h.avgResponseTime + 'ms', action: 'disk-cleanup', meta: {}, canFix: true });
  });
  memoryDomains.filter(d => d.sslDaysLeft !== null && d.sslDaysLeft <= 7 && d.sslDaysLeft > 0).slice(0,20).forEach(d => {
    problems.push({ severity: 'high', emoji: '🔒', cat: 'SSL ใกล้หมด', title: d.domain, detail: 'เหลือ ' + d.sslDaysLeft + ' วัน', action: null, canFix: false });
  });
  memoryDomains.filter(d => d.daysLeft !== null && d.daysLeft <= 7 && d.daysLeft > 0).slice(0,20).forEach(d => {
    problems.push({ severity: 'high', emoji: '📅', cat: 'โดเมนใกล้หมดอายุ', title: d.domain, detail: 'เหลือ ' + d.daysLeft + ' วัน', action: null, canFix: false });
  });
  problems.sort((a,b) => ({high:0,medium:1,low:2}[a.severity]) - ({high:0,medium:1,low:2}[b.severity]));

  // 2. สรุปตัวเลขรวม
  const summary = {
    totalDomains: memoryDomains.length,
    up: memoryDomains.filter(d => d.status === 'up').length,
    down: memoryDomains.filter(d => d.status === 'down' && !(d.tags||[]).includes('gsc') && d.pleskServer).length,
    inGSC: memoryDomains.filter(d => d.gsc && d.gsc.inGSC).length,
    highPriority: problems.filter(p => p.severity === 'high').length,
    pendingApprovals: approvalQueue.filter(a => a.status === 'pending').length
  };

  // 3. สุขภาพ server เรียงจากแย่ไปดี
  const serverHealth = health.slice().sort((a,b) => a.score - b.score);

  // 4. พนักงานที่กำลังทำงาน + งานล่าสุด
  const working = EMPLOYEES.filter(e => (employeeState[e.id]||{}).status === 'working')
    .map(e => ({ name: e.name, emoji: e.emoji, task: employeeState[e.id].currentTask }));

  // 5. CEO report ล่าสุด
  const ceoReport = employeeReports['ceo'] || null;

  // 6. auto-fix ล่าสุด
  const recentFixes = (typeof autoFixHistory !== 'undefined' ? autoFixHistory : []).slice(0, 5);

  return { summary, problems: problems.slice(0, 50), serverHealth, working, ceoReport, recentFixes,
    pendingApprovals: approvalQueue.filter(a => a.status === 'pending').slice(0, 10) };
}


// ===== วินิจฉัย server: ดึงข้อมูลจริง หาสาเหตุ slowness =====
async function diagnoseServer(srv) {
  try {
    const cmd = [
      'echo "=LOAD="',
      'cat /proc/loadavg | cut -d" " -f1-3',
      'echo "=CPU_CORES="',
      'nproc',
      'echo "=RAM="',
      'free -m | grep Mem | tr -s " " | cut -d" " -f2,3,4,7',  // total used free available
      'echo "=SWAP="',
      'free -m | grep Swap | tr -s " " | cut -d" " -f2,3',     // total used
      'echo "=DISK="',
      'df -h / | tail -1 | tr -s " " | cut -d" " -f5',         // use%
      'echo "=PHPFPM_COUNT="',
      'ps aux | grep -c "[p]hp-fpm"',
      'echo "=MYSQL_MEM="',
      'ps aux | grep "[m]ysqld" | awk "{print int(\$6/1024)}" | head -1',  // MySQL RSS in MB
      'echo "=TOP5="',
      'ps aux --sort=-%cpu | awk "NR>1 && NR<=6 {printf \"%s|%s|%s\\n\", \$3, \$4, \$11}"',  // cpu% mem% command
      'echo "=APACHE_CONN="',
      'ss -tn state established 2>/dev/null | grep -c ":80\|:443" || echo 0',
      'echo "=MYSQL_SLOW="',
      'mysql -e "SHOW GLOBAL STATUS LIKE \"Slow_queries\";" 2>/dev/null | tail -1 | awk "{print \$2}" || echo "n/a"',
      'echo "=DONE="'
    ].join('; ');

    const cmdId = queueCommand(srv.host, cmd);
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (agentResults[cmdId]) {
        const res = agentResults[cmdId]; delete agentResults[cmdId];
        const out = (res.output||'').replace(/~/g,'\n');
        return parseDiagnostic(srv.name, out);
      }
    }
    return { server: srv.name, ok: false, error: 'timeout' };
  } catch(e) { return { server: srv.name, ok: false, error: e.message }; }
}

function parseDiagnostic(serverName, out) {
  const section = (name) => {
    const re = new RegExp('=' + name + '=\\s*\\n([\\s\\S]*?)(?:\\n=|$)');
    const m = out.match(re);
    return m ? m[1].trim() : '';
  };

  const load = section('LOAD').split(' ').map(Number);
  const cores = parseInt(section('CPU_CORES')) || 1;
  const ramParts = section('RAM').split(' ').map(Number); // total used free available
  const swapParts = section('SWAP').split(' ').map(Number); // total used
  const disk = parseInt(section('DISK')) || 0;
  const phpfpm = parseInt(section('PHPFPM_COUNT')) || 0;
  const mysqlMem = parseInt(section('MYSQL_MEM')) || 0;
  const apacheConn = parseInt(section('APACHE_CONN')) || 0;
  const slowQueries = section('MYSQL_SLOW');
  const top5 = section('TOP5').split('\n').filter(Boolean).map(line => {
    const [cpu, mem, command] = line.split('|');
    return { cpu: parseFloat(cpu)||0, mem: parseFloat(mem)||0, command: (command||'').split('/').pop().slice(0,30) };
  });

  const load1 = load[0] || 0;
  const ramTotal = ramParts[0] || 1;
  const ramUsed = ramParts[1] || 0;
  const ramAvail = ramParts[3] || 0;
  const swapTotal = swapParts[0] || 0;
  const swapUsed = swapParts[1] || 0;

  const loadPerCore = load1 / cores;
  const ramPct = Math.round(ramUsed / ramTotal * 100);
  const swapPct = swapTotal ? Math.round(swapUsed / swapTotal * 100) : 0;

  // วิเคราะห์หาสาเหตุ
  const issues = [];
  if (loadPerCore > 2) issues.push({ level: 'high', text: 'Load สูงมาก (' + load1.toFixed(1) + ' บน ' + cores + ' core = ' + loadPerCore.toFixed(1) + '/core) — CPU ทำงานหนักเกินไป' });
  else if (loadPerCore > 1) issues.push({ level: 'medium', text: 'Load ค่อนข้างสูง (' + loadPerCore.toFixed(1) + '/core) — เริ่มแน่น' });
  if (ramPct > 90) issues.push({ level: 'high', text: 'RAM เกือบเต็ม (' + ramPct + '%) — เหลือว่าง ' + ramAvail + 'MB' });
  else if (ramPct > 80) issues.push({ level: 'medium', text: 'RAM ใช้เยอะ (' + ramPct + '%)' });
  if (swapPct > 50) issues.push({ level: 'high', text: 'ใช้ Swap หนัก (' + swapPct + '%) — นี่คือสาเหตุหลักที่ทำให้ช้า! RAM ไม่พอเลยต้องใช้ disk แทน' });
  else if (swapUsed > 100) issues.push({ level: 'medium', text: 'เริ่มใช้ Swap (' + swapUsed + 'MB) — RAM ใกล้หมด' });
  if (phpfpm > 100) issues.push({ level: 'high', text: 'PHP-FPM เยอะมาก (' + phpfpm + ' process) — แต่ละตัวกิน RAM, ควรปรับ ondemand' });
  else if (phpfpm > 50) issues.push({ level: 'medium', text: 'PHP-FPM ค่อนข้างเยอะ (' + phpfpm + ' process)' });
  if (disk > 90) issues.push({ level: 'high', text: 'Disk เกือบเต็ม (' + disk + '%) — ควร cleanup' });
  if (mysqlMem > 2048) issues.push({ level: 'medium', text: 'MySQL กิน RAM เยอะ (' + mysqlMem + 'MB)' });

  // แนะนำการแก้ (เฉพาะ safe action ที่มี)
  const recommendations = [];
  if (phpfpm > 50 || ramPct > 80 || swapPct > 30) recommendations.push({ action: 'phpfpm-ondemand', label: 'ปรับ PHP-FPM ondemand (ลด RAM)', reason: 'ลดจำนวน process ที่ค้างกิน RAM' });
  if (disk > 80) recommendations.push({ action: 'disk-cleanup', label: 'ทำความสะอาด disk', reason: 'disk ใกล้เต็ม' });

  return {
    server: serverName, ok: true,
    metrics: { load1, loadPerCore: +loadPerCore.toFixed(2), cores, ramPct, ramUsed, ramTotal, ramAvail, swapPct, swapUsed, swapTotal, disk, phpfpm, mysqlMem, apacheConn, slowQueries, top5 },
    issues, recommendations,
    verdict: issues.some(i => i.level === 'high') ? 'critical' : issues.length ? 'warning' : 'healthy'
  };
}


// ===== ระบบแก้เองอัตโนมัติจากการวินิจฉัย (พร้อมตัวกันพลาด) =====
let autoRemediateEnabled = true;        // เปิด/ปิดได้
const AUTO_FIX_COOLDOWN_MS = 2 * 60 * 60 * 1000; // งานเดียวกัน server เดียวกัน ห้ามซ้ำใน 2 ชม.
const AUTO_FIX_DAILY_CAP = 20;          // เพดานต่อวัน
let autoFixCooldowns = {};              // { 'action:server': timestamp }
let autoFixDailyCount = 0;
let autoFixDayStamp = new Date().toISOString().split('T')[0];

function canAutoFix(action, server) {
  // เช็ควันใหม่ → reset count
  const today = new Date().toISOString().split('T')[0];
  if (today !== autoFixDayStamp) { autoFixDayStamp = today; autoFixDailyCount = 0; }
  if (autoFixDailyCount >= AUTO_FIX_DAILY_CAP) return { ok: false, reason: 'ถึงเพดานต่อวันแล้ว (' + AUTO_FIX_DAILY_CAP + ')' };
  const key = action + ':' + (server || 'all');
  const last = autoFixCooldowns[key];
  if (last && (Date.now() - last) < AUTO_FIX_COOLDOWN_MS) {
    const mins = Math.ceil((AUTO_FIX_COOLDOWN_MS - (Date.now() - last)) / 60000);
    return { ok: false, reason: 'cooldown เหลือ ' + mins + ' นาที' };
  }
  return { ok: true };
}

function markAutoFix(action, server) {
  autoFixCooldowns[action + ':' + (server || 'all')] = Date.now();
  autoFixDailyCount++;
}

// วินิจฉัย server แล้วแก้เองถ้าเจอปัญหาปลอดภัย
async function autoRemediateServer(srv, appliedThisCycle) {
  const diag = await diagnoseServer(srv);
  if (!diag.ok) return { server: srv.name, ok: false, error: diag.error };

  const applied = [];
  // แก้เฉพาะถ้า verdict = critical และมี safe recommendation
  if (diag.verdict === 'critical' && diag.recommendations.length > 0) {
    for (const rec of diag.recommendations) {
      const act = SAFE_ACTIONS[rec.action];
      if (!act) continue;

      // กัน action เดียวกันรันซ้ำในรอบเดียว (cleanup/phpfpm ครอบทุก server อยู่แล้ว)
      if (appliedThisCycle && appliedThisCycle.has(rec.action)) {
        applied.push({ action: rec.action, label: rec.label, result: { ok: true, detail: 'ทำไปแล้วในรอบนี้ (ครอบทุก server)' } });
        continue;
      }

      // เช็คตัวกันพลาด
      const gate = canAutoFix(rec.action, srv.name);
      if (!gate.ok) {
        logAutoFix(act.emp, srv.name + ': ' + rec.reason, rec.label + ' (ข้าม: ' + gate.reason + ')', { ok: false, detail: gate.reason });
        continue;
      }

      // ลงมือแก้
      try {
        setEmployeeWorking(act.emp, rec.label + ' @ ' + srv.name, 45000);
        markAutoFix(rec.action, srv.name);
        if (appliedThisCycle) appliedThisCycle.add(rec.action);
        const result = await act.run({ server: srv.name });
        logAutoFix(act.emp, srv.name + ': ' + rec.reason, rec.label, result);
        empLog(act.emp, 'วินิจฉัยแล้วแก้เอง', srv.name + ' — ' + rec.label);
        applied.push({ action: rec.action, label: rec.label, result });
        smartAlert('warning', '🤖 แก้อัตโนมัติ: ' + srv.name + '\n' + rec.label + ' — ' + (result.ok ? 'สำเร็จ' : 'ล้มเหลว') + '\nสาเหตุ: ' + rec.reason);
      } catch(e) {
        logAutoFix(act.emp, srv.name, rec.label + ' (error)', { ok: false, detail: e.message });
      }
    }
  }
  return { server: srv.name, ok: true, verdict: diag.verdict, applied, metrics: diag.metrics };
}

// วนวินิจฉัย+แก้ทุก server ที่สุขภาพต่ำ
async function runDeepRemediation() {
  if (!autoRemediateEnabled) return { ok: false, reason: 'auto-remediate ปิดอยู่' };
  try {
    let health = [];
    try { health = getAllHealthScores() || []; } catch(e) {}
    // วินิจฉัยเฉพาะ server สุขภาพต่ำกว่า 75 (ไม่ต้องวินิจฉัยทุกตัวทุกครั้ง ประหยัด)
    const targets = health.filter(h => h.score < 75).map(h => h.server);
    const allResults = [];
    const appliedThisCycle = new Set(); // กัน action เดียวกันรันซ้ำในรอบเดียว (เพราะ cleanup/phpfpm ทำทุก server)
    for (const serverName of targets) {
      const srv = PLESK_SERVERS.find(s => s.name === serverName);
      if (!srv) continue;
      const r = await autoRemediateServer(srv, appliedThisCycle);
      allResults.push(r);
      await new Promise(rs => setTimeout(rs, 2000)); // เว้นระยะ
    }
    const totalApplied = allResults.reduce((s,r) => s + (r.applied ? r.applied.length : 0), 0);
    if (totalApplied > 0) logEvent('fix', 'Deep remediation แก้ ' + totalApplied + ' รายการ', { count: totalApplied });
    return { ok: true, diagnosed: targets.length, applied: totalApplied, results: allResults };
  } catch(e) {
    return { ok: false, error: e.message };
  }
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
  setInterval(autoInstallSSL, 12 * 60 * 60 * 1000); // Auto SSL install ทุก 12 ชั่วโมง
  setTimeout(autoInstallSSL, 5 * 60 * 1000); // รัน SSL install ครั้งแรกหลัง 5 นาที
  setInterval(checkBlacklists, 24 * 60 * 60 * 1000); // Blacklist check ทุกวัน
  setInterval(sendWeeklyReport, 7 * 24 * 60 * 60 * 1000); // Weekly report
  setInterval(checkDatabaseBackups, 24 * 60 * 60 * 1000); // Backup check ทุกวัน
  setInterval(checkDomainExpiry, 12 * 60 * 60 * 1000); // Domain expiry ทุก 12 ชั่วโมง
  setInterval(checkGSCTrafficDrop, 24 * 60 * 60 * 1000); // GSC drop check ทุกวัน
  setTimeout(checkGSCTrafficDrop, 30 * 60 * 1000); // รันครั้งแรกหลัง 30 นาที
  setInterval(checkEmailSpam, 6 * 60 * 60 * 1000); // Email check ทุก 6 ชั่วโมง
  // Monthly report - disabled
  setTimeout(checkDomainExpiry, 5 * 60 * 1000); // รันครั้งแรกหลัง 5 นาที
  setTimeout(checkDatabaseBackups, 15 * 60 * 1000); // รันครั้งแรกหลัง 15 นาที
  console.log(`[Auto] เช็คโดเมนทุก ${CHECK_INTERVAL_MS/60000} นาที, Sync Plesk ทุก ${PLESK_SYNC_INTERVAL_MS/3600000} ชั่วโมง`);
  // Auto-start systems
  setInterval(checkAndCleanDisk, 6 * 60 * 60 * 1000); // Disk check ทุก 6 ชั่วโมง
  setTimeout(async () => { await applyAllPhpFpmOndemand(); }, 12 * 60 * 1000); // PHP-FPM ondemand หลัง 12 นาที
  setInterval(applyAllPhpFpmOndemand, 24 * 60 * 60 * 1000); // Re-apply ทุก 24 ชั่วโมง
  setTimeout(async () => { await installAllApacheWatchdogs(); }, 5 * 60 * 1000); // Watchdog หลัง 5 นาที
  setTimeout(async () => { await setupAllCloudflareWhitelists(); }, 8 * 60 * 1000); // CF Whitelist หลัง 8 นาที
  setInterval(setupAllCloudflareWhitelists, 24 * 60 * 60 * 1000);

  setInterval(sendWarningDigest, 30 * 60 * 1000); // Warning digest ทุก 30 นาที
  // Auto-fix งานปลอดภัยทุก 15 นาที (โดเมน down → กู้, disk เต็ม → cleanup)
  setInterval(() => { runAutoFixCycle().catch(()=>{}); }, 15 * 60 * 1000);
  setTimeout(() => { runAutoFixCycle().catch(()=>{}); }, 90 * 1000); // รันครั้งแรกหลัง startup 90 วิ
  // Deep remediation: วินิจฉัยละเอียดแล้วแก้เองทุก 30 นาที (เฉพาะ server สุขภาพต่ำ + งานปลอดภัย + มี cooldown/เพดาน)
  setInterval(() => { runDeepRemediation().catch(()=>{}); }, 30 * 60 * 1000);
  setTimeout(() => { runDeepRemediation().catch(()=>{}); }, 150 * 1000); // ครั้งแรกหลัง startup 2.5 นาที
  // เฟส 3: Diagnostician เสนองานแก้ปัญหาทุก 6 ชม. (ถ้ามี API key) — เข้า approval queue รอเจ้าของอนุมัติ
  if (process.env.ANTHROPIC_API_KEY) {
    setInterval(() => { proposeActionsFromAnalysis().catch(()=>{}); }, 6 * 60 * 60 * 1000);
  }

  // Daily summary ตอนเที่ยงคืน
  const scheduleDailySummary = () => {
    const now = new Date();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    midnight.setDate(midnight.getDate() + 1);
    setTimeout(() => { sendDailySummary(); scheduleDailySummary(); }, midnight - now);
  };
  scheduleDailySummary();

  console.log('[Auto] Proactive Monitor, Smart Status Check, SSL Renewal, Blacklist Monitor เริ่มทำงาน');

  // Auto Sync GSC ทุก 24 ชั่วโมง (ตี 2)
  const scheduleGSCSync = () => {
    const now = new Date();
    const next = new Date();
    next.setHours(2, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const ms = next - now;
    console.log('[GSC] Auto sync ครั้งต่อไป:', next.toLocaleString('th-TH'));
    setTimeout(async () => {
      console.log('[GSC] Auto sync เริ่ม...');
      _gscSites = null;
      let synced = 0;
      for (let i = 0; i < memoryDomains.length; i++) {
        memoryDomains[i] = await syncGSCForDomain(memoryDomains[i]);
        if (memoryDomains[i].gsc && memoryDomains[i].gsc.inGSC) synced++;
        if (i > 0 && i % 20 === 0) await new Promise(r => setTimeout(r, 300));
      }
      await saveToSheets(memoryDomains);
      console.log('[GSC] Auto sync เสร็จ:', synced, 'domains');
      smartAlert('info', '🔄 GSC Auto Sync เสร็จ\n📊 ' + synced + ' โดเมน\n⏱️ ' + new Date().toLocaleString('th-TH'));
      scheduleGSCSync(); // ตั้งรอบถัดไป
    }, ms);
  };
  scheduleGSCSync();
});
