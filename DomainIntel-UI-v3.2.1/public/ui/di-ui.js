/* ==========================================================================
   DomainIntel UI v3.2 — พฤติกรรมของโครงหน้า (shell)
   - โหลดแบบ defer: ทำงานหลัง script เดิมทั้งหมดในหน้า แต่ก่อน DOMContentLoaded
   - ไม่แก้ logic เดิม: ใช้วิธี "ห่อ" ฟังก์ชัน (showPage, updateStats, doLogin, toast ...) แล้วค่อยเติม UI
   - v3.2: โหมด HUD (ไฮเทค) ปิดได้ · v3.1: ศูนย์รวม (หน้าแรก) · เมนูหมวดแบบ accordion + ป้ายสถานะจริง/DEMO · แถบข้อมูลบนทุกหน้า · Action Console
   ========================================================================== */
(function () {
  'use strict';
  var D = window.DIUI = window.DIUI || {};
  var doc = document, root = doc.documentElement;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  function el(tag, cls, html) { var e = doc.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safe(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { if (window.console) console.warn('[DIUI]', e); } }; }
  function shown(e) { return !!e && e.style.display !== 'none' && e.style.display !== ''; }
  var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };

  /* ห่อฟังก์ชัน global — ฟังก์ชันเดิมทำงานก่อนเสมอ */
  function after(name, fn) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__diWrapped) return;
    var w = function () { var r = orig.apply(this, arguments); safe(fn).apply(this, arguments); return r; };
    w.__diWrapped = true; w.__diOrig = orig;
    window[name] = w;
  }

  /* ทะเบียนเครื่องมือ (สร้างโดย build.py ฝังไว้ใน <script id="di-registry">) */
  var REG = { top: [], cats: [], byId: {}, byPage: {}, catOf: {}, audited: '', volatileNote: '' };
  (function loadRegistry() {
    try {
      var n = doc.getElementById('di-registry'); if (!n) return;
      var r = JSON.parse(n.textContent);
      REG.top = r.top || []; REG.cats = r.cats || []; REG.audited = r.audited || ''; REG.volatileNote = r.volatileNote || '';
      var add = function (t, c) { REG.byId[t.id] = t; if (!REG.byPage[t.page]) REG.byPage[t.page] = t; REG.catOf[t.id] = c; };
      REG.top.forEach(function (t) { add(t, null); });
      REG.cats.forEach(function (c) { (c.tools || []).forEach(function (t) { add(t, c); }); });
    } catch (e) { if (window.console) console.warn('[DIUI] registry', e); }
  })();
  D.registry = REG;
  var GROUP_ICON = {};
  REG.cats.forEach(function (c) { GROUP_ICON[c.id] = c.icon; });

  /* ป้ายสถานะ — ใช้ร่วมกันทั้งศูนย์รวม / แถบข้อมูลบนหน้า / palette */
  var STATUS = {
    live:    { key: 'live',    icon: 'ti-circle-check',      label: 'ใช้งานได้จริง',   long: 'เชื่อมข้อมูลจริงจากเซิร์ฟเวอร์ ใช้ได้ทันที' },
    setup:   { key: 'setup',   icon: 'ti-plug',              label: 'ต้องตั้งค่าก่อน', long: 'ทำงานจริง แต่ต้องตั้ง ENV หรือ agent ให้ครบก่อน' },
    ready:   { key: 'live',    icon: 'ti-plug-connected',    label: 'ตั้งค่าแล้ว',      long: 'ตรวจสดแล้ว: เซิร์ฟเวอร์มีค่าที่ต้องใช้ครบ' },
    missing: { key: 'missing', icon: 'ti-plug-connected-x',  label: 'ยังไม่ได้ตั้งค่า', long: 'ตรวจสดแล้ว: เซิร์ฟเวอร์ยังไม่มีค่าที่ต้องใช้' },
    partial: { key: 'partial', icon: 'ti-circle-half-2',     label: 'ใช้ได้บางส่วน',   long: 'ใช้ได้จริง แต่มีข้อมูลบางส่วนเขียนตายตัวในโค้ด' },
    demo:    { key: 'demo',    icon: 'ti-flask',             label: 'DEMO',            long: 'ยังไม่มีระบบหลังบ้าน — หน้าตาอย่างเดียว' }
  };
  /* ผลตรวจการตั้งค่าสด (จาก /api/report → connectivity และ /api/vault/status) */
  var LIVE = { stamp: 0, at: null, map: {} };
  function effStatus(t) {
    if (!t) return STATUS.live;
    if (t.needs && LIVE.map[t.needs] === false) return t.status === 'live' ? STATUS.live : STATUS.missing;
    if (t.needs && LIVE.map[t.needs] === true && t.status === 'setup') return STATUS.ready;
    return STATUS[t.status] || STATUS.live;
  }
  function pillHTML(st, sm) {
    return '<span class="di-pill st-' + st.key + (sm ? ' sm' : '') + '" title="' + esc(st.long) + '"><i class="ti ' + st.icon + '"></i>' + esc(st.label) + '</span>';
  }

  /* ------------------------------------------------------------ 1. SPLASH */
  function hideSplash() {
    var sp = $('#di-splash');
    if (!sp || sp.classList.contains('gone')) return;
    sp.classList.add('gone');
    setTimeout(function () { if (sp.parentNode) sp.parentNode.removeChild(sp); }, 700);
  }

  /* ------------------------------------------------------------ 2. THEME */
  function syncThemeMeta() {
    var m = $('meta[name="theme-color"]');
    if (m) m.setAttribute('content', root.classList.contains('light') ? '#f4f6f9' : '#07080c');
  }
  D.toggleTheme = function (origin) {
    var run = function () {
      if (typeof window.toggleTheme === 'function') window.toggleTheme();
      else { var l = root.classList.toggle('light'); LS.set('di_theme', l ? 'light' : 'dark'); }
      syncThemeMeta();
    };
    if (!doc.startViewTransition || reduced) { run(); return; }
    var x = innerWidth - 40, y = 30;
    if (origin && origin.getBoundingClientRect) { var r = origin.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
    var rad = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    var t = doc.startViewTransition(run);
    t.ready.then(function () {
      root.animate({ clipPath: ['circle(0px at ' + x + 'px ' + y + 'px)', 'circle(' + rad + 'px at ' + x + 'px ' + y + 'px)'] },
        { duration: 560, easing: 'cubic-bezier(.16,1,.3,1)', pseudoElement: '::view-transition-new(root)' });
    }).catch(function () {});
  };

  /* ------------------------------------------------------------ 3. NAV : หมวดแบบ accordion (เปิดทีละหมวด) + PILL */
  function setOpenGroup(id, save) {
    $$('#main-nav .nav-group').forEach(function (g) {
      var open = !!id && g.getAttribute('data-group') === id;
      g.classList.toggle('collapsed', !open);
      g.classList.toggle('open', open);
      var h = g.querySelector('.nav-group-head'); if (h) h.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    if (save !== false) LS.set('di_nav_open', id || '');
    trackPill(440); updateGroupAlerts();
  }
  function initGroups() {
    var want = LS.get('di_nav_open', '');
    if (want && !$('#main-nav .nav-group[data-group="' + want + '"]')) want = '';
    setOpenGroup(want, false);
    syncTips();
  }
  function syncTips() {
    var mini = root.classList.contains('sb-mini');
    $$('#main-nav .nav-item').forEach(function (it) {
      if (mini) it.title = navLabel(it); else it.removeAttribute('title');
    });
    $$('#main-nav .nav-group-head').forEach(function (h) {
      var lb = h.querySelector('.ng-label');
      if (mini && lb) h.title = lb.textContent.trim(); else h.removeAttribute('title');
    });
  }
  function toggleGroup(id) {
    var g = $('#main-nav .nav-group[data-group="' + id + '"]'); if (!g) return;
    setOpenGroup(g.classList.contains('collapsed') ? id : '');
  }
  function expandGroupOf(item) {
    var g = item && item.closest('.nav-group');
    if (g && g.classList.contains('collapsed')) setOpenGroup(g.getAttribute('data-group'));
  }
  var pill = null;
  function ensurePill() {
    var nav = $('#main-nav'); if (!nav) return null;
    if (!pill || !pill.parentNode) { pill = el('div', 'nav-pill'); nav.insertBefore(pill, nav.firstChild); nav.classList.add('has-pill'); }
    return nav;
  }
  function activeItem() {
    var items = $$('#main-nav .nav-item.active');
    var vis = items.filter(function (i) { return !i.closest('.nav-group.collapsed'); });
    return vis.filter(function (i) { return !i.closest('.nav-fav-section'); })[0] || vis[0] || null;
  }
  function placePill(instant) {
    var nav = ensurePill(); if (!nav) return;
    var it = activeItem();
    if (!it || it.offsetParent === null) { pill.classList.remove('show'); return; }
    var top = it.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop;
    if (instant) pill.style.transition = 'none';
    pill.style.transform = 'translateY(' + Math.round(top) + 'px)';
    pill.style.height = it.offsetHeight + 'px';
    pill.classList.add('show');
    if (instant) { void pill.offsetWidth; pill.style.transition = ''; }
  }
  function trackPill(ms) {
    var until = performance.now() + (ms || 400);
    (function loop() { placePill(true); if (performance.now() < until) raf(loop); else placePill(true); })();
  }
  function updateGroupAlerts() {
    $$('#main-nav .nav-group').forEach(function (g) {
      var alert = $$('.nav-badge', g).some(function (b) {
        if (b.classList.contains('muted') || b.id === 'nav-total') return false;
        var t = (b.textContent || '').trim();
        return b.style.display !== 'none' && t && t !== '0';
      });
      g.classList.toggle('has-alert', alert);
    });
    // กระดิ่งบน appbar = งานด่วนจากศูนย์บัญชาการ / ศูนย์ปัญหา
    var n = 0;
    ['nav-command-badge', 'nav-problem-badge'].forEach(function (id) {
      var b = $('#' + id); if (b && b.style.display !== 'none') n = Math.max(n, parseInt(b.textContent, 10) || 0);
    });
    var dot = $('#ab-alerts-dot');
    if (dot) { dot.textContent = n > 99 ? '99+' : (n || ''); dot.classList.toggle('on', n > 0); }
  }

  D.toggleMini = function () {
    var on = root.classList.toggle('sb-mini');
    LS.set('di_sb_mini', on ? '1' : '0');
    syncTips();
    trackPill(380);
  };

  /* ------------------------------------------------------------ 4. PAGE LIFECYCLE */
  var enterAt = 0;
  function pageEls() { return $$('#di-main > [id^="page-"]'); }
  function currentPage() { return pageEls().filter(function (p) { return p.style.display !== 'none'; })[0] || null; }

  function navLabel(it) {
    if (!it) return '';
    var lb = it.querySelector('.nav-label');
    if (lb) return lb.textContent.trim();
    var c = it.cloneNode(true); $$('.nav-badge,.badge,.nav-fav-star', c).forEach(function (x) { x.remove(); });
    return c.textContent.trim();
  }
  function groupOf(it) {
    var g = it && it.closest('.nav-group'); if (!g) return null;
    var h = g.querySelector('.ng-label');
    return { id: g.getAttribute('data-group'), label: h ? h.textContent.trim() : '' };
  }
  function pageTitle(page) {
    var t = page && (page.querySelector('.topbar-title') || page.querySelector('.ph-dyn h2'));
    if (!t) return '';
    var c = t.cloneNode(true); $$('i', c).forEach(function (x) { x.remove(); });
    return c.textContent.replace(/\s+/g, ' ').trim();
  }

  function updateCrumbs(page) {
    var it = activeItem();
    var label = navLabel(it) || pageTitle(page) || 'DomainIntel';
    var g = groupOf(it);
    var gp = $('#ab-crumb-page'), gg = $('#ab-crumb-group');
    if (gp && gp.textContent !== label) { gp.textContent = label; gp.style.animation = 'none'; void gp.offsetWidth; gp.style.animation = ''; }
    if (gg) gg.textContent = g ? g.label : 'DomainIntel';
    doc.title = label + ' · DomainIntel';
    // eyebrow บนหัวหน้า
    if (page && g) {
      var head = page.querySelector(':scope > .topbar > div:first-child, :scope > .ph-dyn > div:first-child');
      if (head && head.querySelector(':scope > .topbar-title, :scope > h2')) {
        var eb = head.querySelector(':scope > .ph-eyebrow');
        if (!eb) { eb = el('div', 'ph-eyebrow'); head.insertBefore(eb, head.firstChild); }
        var tid = it && it.getAttribute('data-tool');
        eb.innerHTML = '<i class="ti ' + (GROUP_ICON[g.id] || 'ti-point') + '"></i>' + esc(g.label) + (tid ? '<span class="hud-code">// MOD.' + esc(tid.toUpperCase()) + '</span>' : '');
      }
    }
  }

  /* หน้าที่สร้างด้วย JS (ISP, Cache, Vault ...) → จัดหัวหน้าให้เหมือนหน้าอื่น */
  function normalizePage(page) {
    if (!page || page.__diNorm) return;
    page.__diNorm = true;
    var first = page.firstElementChild;
    if (!first) return;
    if (first.classList.contains('topbar')) {
      $$(':scope > *', page).forEach(function (ch) {
        if (ch === first || ch.classList.contains('di-hero') || ch.classList.contains('content')) return;
        if (ch.tagName === 'SCRIPT' || ch.tagName === 'STYLE') return;
        ch.style.padding = ''; ch.classList.add('di-body');
      });
      compactActions(first.querySelector('.topbar-right'));
      return;
    }
    var h2 = first.querySelector('h2');
    if (!h2) return;
    page.classList.add('di-page-dyn');
    page.style.padding = ''; page.style.gap = ''; page.style.overflow = '';
    var header;
    if (h2.parentElement === first) {
      // แบบ B: <div><h2/><div sub/></div>
      header = el('div', 'ph-dyn');
      page.insertBefore(header, first);
      header.appendChild(first);
    } else {
      // แบบ A: <div flex><div><h2/><div sub/></div><div actions/></div>
      header = first; header.classList.add('ph-dyn'); header.removeAttribute('style');
      var kids = $$(':scope > *', header);
      if (kids[1]) { kids[1].classList.add('ph-actions'); kids[1].removeAttribute('style'); }
    }
    h2.removeAttribute('style');
    var sub = h2.nextElementSibling;
    if (sub && sub.tagName === 'DIV') sub.classList.add('ph-sub');
    compactActions(header.querySelector('.ph-actions'));
  }

  /* ปุ่มบนหัวหน้าเกิน → รวมเป็นเมนู "เพิ่มเติม" (ย้าย element เดิม: id/onclick อยู่ครบ) */
  function compactActions(bar) {
    if (!bar || bar.__diCompact) return;
    bar.__diCompact = true;
    var btns = $$(':scope > button.btn', bar).filter(function (b) { return b.style.display !== 'none'; });
    var max = innerWidth < 700 ? 1 : 3;
    if (btns.length - max < 2) return;
    var score = function (b) {
      var s = 0;
      if (b.classList.contains('btn-green')) s += 3;
      if (/รีเฟรช|refresh/i.test(b.textContent) || /refresh|^load/i.test(b.getAttribute('onclick') || '')) s += 2;
      return s;
    };
    var ranked = btns.map(function (b, i) { return { b: b, i: i, s: score(b) }; })
      .sort(function (a, c) { return c.s - a.s || a.i - c.i; });
    var keep = ranked.slice(0, max).map(function (x) { return x.b; });
    var move = btns.filter(function (b) { return keep.indexOf(b) < 0; });
    var wrap = el('div', 'di-more');
    var mb = el('button', 'btn di-more-btn', '<i class="ti ti-dots"></i> เพิ่มเติม');
    mb.type = 'button'; mb.setAttribute('aria-haspopup', 'menu'); mb.setAttribute('aria-expanded', 'false');
    var menu = el('div', 'di-menu'); menu.setAttribute('role', 'menu');
    menu.appendChild(el('div', 'di-menu-label', 'คำสั่งเพิ่มเติม'));
    move.forEach(function (b) { b.setAttribute('role', 'menuitem'); menu.appendChild(b); });
    wrap.appendChild(mb); wrap.appendChild(menu);
    var primary = keep.filter(function (b) { return b.classList.contains('btn-green'); })[0];
    if (primary && primary.parentNode === bar) bar.insertBefore(wrap, primary); else bar.appendChild(wrap);
    mb.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = !menu.classList.contains('open');
      closeMenus();
      if (open) {
        menu.classList.add('open'); mb.setAttribute('aria-expanded', 'true');
        menu.style.left = ''; menu.style.right = '';
        var r = menu.getBoundingClientRect();
        if (r.left < 8) { menu.style.left = '0'; menu.style.right = 'auto'; }
      }
    });
    menu.addEventListener('click', function (e) { if (e.target.closest('.btn')) setTimeout(closeMenus, 0); });
  }
  function closeMenus() {
    $$('.di-menu.open').forEach(function (m) { m.classList.remove('open'); var b = m.previousElementSibling; if (b) b.setAttribute('aria-expanded', 'false'); });
  }

  function onNav(pageId) {
    var page = doc.getElementById(pageId); if (!page) return;
    enterAt = performance.now();
    normalizePage(page);
    if (!reduced) { page.classList.remove('di-enter'); void page.offsetWidth; page.classList.add('di-enter'); }
    markStagger(page);
    var main = $('#di-main');
    if (main) { try { main.scrollTo({ top: 0, behavior: 'instant' }); } catch (e) { main.scrollTop = 0; } }
    closeMenus();
    // open*() ใส่ .active ให้เมนูหลัง showPage คืนค่า → รอ 1 tick
    setTimeout(safe(function () {
      var nm = pageId.replace(/^page-/, '');
      // showPage จับคู่เมนูแบบตรงตัวเท่านั้น (เช่น เมนูโดเมนมีคำสั่งต่อท้าย / หน้าที่เปิดด้วย open*()) → หาจากทะเบียนเครื่องมือ
      if (!$$('#main-nav .nav-item.active').length) {
        var t0 = REG.byPage[nm];
        var cand = t0 ? $$('#main-nav .nav-item[data-tool="' + t0.id + '"]')
          : $$('#main-nav .nav-item').filter(function (i) { return (i.getAttribute('onclick') || '').indexOf("showPage('" + nm + "')") === 0; });
        cand.forEach(function (c) { c.classList.add('active'); });
      }
      var it = activeItem() || $$('#main-nav .nav-item.active')[0];
      if (it) expandGroupOf(it);
      placePill(); updateCrumbs(page); countUpIn(page);
      if (it && it.scrollIntoView) { try { it.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
      var tool = toolFor(page, it);
      ensureInfo(page, tool);
      if (pageId !== 'page-hub') decode(page.querySelector(':scope > .topbar .topbar-title, :scope > .ph-dyn h2'), 480);
      if (tool && tool.id !== 'hub') pushRecentTool(tool.id);
      if (pageId === 'page-hub') {
        D.renderHero(); D.renderHub(); refreshLive(false); refreshHist();
        // ตัวเลขงานด่วน/รออนุมัติมาจากศูนย์บัญชาการ → ดึงใหม่ถ้าเก่ากว่า 60 วิ
        if (typeof window.loadCommandCenter === 'function' && Date.now() - (D._ccAt || 0) > 60000 && D._ccAt) { D._ccAt = Date.now(); window.loadCommandCenter(); }
      }
    }), 0);
  }
  function toolFor(page, it) {
    var id = it && !it.closest('.nav-fav-section') && it.getAttribute('data-tool');
    if (!id && it) { var oc = it.getAttribute('onclick'); var m = oc && $('#main-nav .nav-item[data-tool][onclick="' + oc.replace(/"/g, '\\"') + '"]'); if (m) id = m.getAttribute('data-tool'); }
    if (id && REG.byId[id]) return REG.byId[id];
    return REG.byPage[page.id.replace(/^page-/, '')] || null;
  }
  function recentTools() { try { return JSON.parse(LS.get('di_recent_tools', '[]')) || []; } catch (e) { return []; } }
  function pushRecentTool(id) {
    var r = recentTools().filter(function (k) { return k !== id; }); r.unshift(id);
    LS.set('di_recent_tools', JSON.stringify(r.slice(0, 6)));
  }
  /* เปิดเครื่องมือตาม id — กดเมนูเดิม (onclick เดิมทำงานครบ) */
  D.openTool = function (id) {
    var it = $('#main-nav .nav-item[data-tool="' + id + '"]');
    if (it) { it.click(); return; }
    var t = REG.byId[id]; if (t) { try { (new Function(t.onclick))(); } catch (e) { if (window.console) console.warn(e); } }
  };

  /* ------------------------------------------------------------ 4b. แถบ "เครื่องมือนี้ใช้ทำอะไร / ใช้ได้จริงไหม" บนทุกหน้า */
  function infoMin() { try { return JSON.parse(LS.get('di_info_min', '{}')) || {}; } catch (e) { return {}; } }
  function ensureInfo(page, tool) {
    if (!page || page.id === 'page-hub') return;
    var box = page.querySelector(':scope > .di-info');
    if (!tool) { if (box) box.remove(); return; }
    if (!box) {
      box = el('div', 'di-info');
      var head = page.querySelector(':scope > .topbar, :scope > .ph-dyn');
      if (head) head.insertAdjacentElement('afterend', box); else page.insertBefore(box, page.firstChild);
    }
    var min = !!infoMin()[tool.id];
    var sig = tool.id + '|' + LIVE.stamp + '|' + min;
    if (box.__sig === sig) return;
    box.__sig = sig; box.setAttribute('data-tool', tool.id);
    var st = effStatus(tool), cat = REG.catOf[tool.id];
    box.className = 'di-info st-' + st.key + (min ? ' min' : '');
    box.innerHTML = pillHTML(st) +
      '<div class="di-info-main">' +
        '<div class="di-info-desc"><b>ใช้ทำอะไร:</b> ' + esc(tool.desc) + (cat ? ' <span class="di-info-cat">· หมวด ' + esc(cat.label) + '</span>' : '') + '</div>' +
        '<div class="di-info-more">' +
          (st.key === 'missing' ? '<span class="di-info-note warn"><i class="ti ti-alert-triangle"></i>ตรวจสดแล้ว: เซิร์ฟเวอร์ยังไม่มีค่าที่เครื่องมือนี้ต้องใช้ — ปุ่มสั่งงานจะยังไม่ได้ผล</span>' : '') +
          (tool.note ? '<span class="di-info-note"><i class="ti ti-info-circle"></i>' + esc(tool.note) + '</span>' : '') +
          (tool.volatile ? '<span class="di-info-note vol" title="' + esc(REG.volatileNote) + '"><i class="ti ti-database-exclamation"></i>ข้อมูลเริ่มใหม่เมื่อ deploy/รีสตาร์ท</span>' : '') +
        '</div>' +
      '</div>' +
      '<button type="button" class="di-info-x" data-info-toggle="' + esc(tool.id) + '" title="' + (min ? 'แสดงรายละเอียด' : 'ย่อแถบนี้') + '" aria-label="' + (min ? 'แสดงรายละเอียด' : 'ย่อแถบนี้') + '"><i class="ti ' + (min ? 'ti-chevron-down' : 'ti-chevron-up') + '"></i></button>';
  }
  function toggleInfo(id) {
    var m = infoMin(); if (m[id]) delete m[id]; else m[id] = 1;
    LS.set('di_info_min', JSON.stringify(m));
    var p = currentPage(); if (p) ensureInfo(p, REG.byId[id]);
  }

  /* ------------------------------------------------------------ 5. STAGGER + COUNT-UP */
  var STAG = '.metric-card, .settings-section, .table-container, .di-hero, .ov-server-card, .gsc-banner, .di-chart, .kanban-col, .ph-dyn ~ div[style*="border-radius"]';
  function markStagger(root) {
    if (reduced) return;
    $$(STAG, root).slice(0, 24).forEach(function (e, i) { e.style.setProperty('--i', Math.min(i, 14)); e.classList.add('di-stag'); });
  }
  var NUM = /^([^\d\-]{0,2}?)(-?[\d,]+(?:\.\d+)?)(\s?%?|\s?[kKmM]?)$/;
  function parseNum(t) {
    var m = String(t || '').trim().match(NUM); if (!m) return null;
    var raw = m[2], v = parseFloat(raw.replace(/,/g, ''));
    if (!isFinite(v)) return null;
    return { pre: m[1] || '', v: v, dec: (raw.split('.')[1] || '').length, comma: raw.indexOf(',') >= 0, suf: m[3] || '' };
  }
  function fmtNum(n, p) {
    var s = p.comma ? n.toLocaleString('en-US', { minimumFractionDigits: p.dec, maximumFractionDigits: p.dec }) : n.toFixed(p.dec);
    return p.pre + s + p.suf;
  }
  function animateNum(e, fromV, finalText, ms) {
    var p = parseNum(finalText); if (!p) return;
    if (e.__diAnim) cancelAnimationFrame(e.__diAnim);
    if (reduced || Math.abs(p.v - fromV) < 1e-9) { e.__diLast = finalText; return; }
    var t0 = performance.now(), dur = ms || 900;
    var step = function (now) {
      var k = Math.min(1, (now - t0) / dur), ez = 1 - Math.pow(1 - k, 3);
      var cur = fromV + (p.v - fromV) * ez;
      var txt = k >= 1 ? finalText : fmtNum(p.dec ? cur : Math.round(cur), p);
      e.__diLast = txt; e.__diCur = cur;
      if (e.textContent !== txt) e.textContent = txt;
      if (k < 1) e.__diAnim = raf(step); else e.__diAnim = null;
    };
    e.__diAnim = raf(step);
  }
  function countUpIn(page) {
    if (reduced) return;
    $$('.metric-val', page).forEach(function (e) {
      if (e.children.length) return;
      var p = parseNum(e.textContent); if (!p || p.v === 0) return;
      animateNum(e, 0, e.textContent.trim(), 850);
    });
  }
  /* สังเกตการเปลี่ยนตัวเลข/เนื้อหาใหม่ ภายในหน้า */
  function watchMain() {
    var main = $('#di-main'); if (!main || !window.MutationObserver) return;
    var queue = [], scheduled = false;
    var mo = new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) queue.push(recs[i]);
      if (!scheduled) { scheduled = true; raf(flush); }
    });
    function flush() {
      scheduled = false;
      var recs = queue; queue = [];
      var inEnter = performance.now() - enterAt < 1600;
      var page = currentPage();
      var seen = new Set();
      recs.forEach(function (r) {
        var t = r.target.nodeType === 3 ? r.target.parentElement : r.target;
        if (!t || !t.closest) return;
        var mv = t.closest('.metric-val');
        if (mv && !seen.has(mv)) {
          seen.add(mv);
          var txt = (mv.textContent || '').trim();
          if (txt !== mv.__diLast) {
            var p = parseNum(txt);
            if (p && mv.children.length === 0) {
              var from = mv.__diCur != null ? mv.__diCur : (inEnter ? 0 : p.v);
              animateNum(mv, from, txt, 650);
            } else mv.__diLast = txt;
          }
        }
        if (r.type === 'childList' && r.addedNodes.length && inEnter && page && page.contains(t)) {
          r.addedNodes.forEach(function (n) {
            if (n.nodeType !== 1) return;
            var list = (n.matches && n.matches(STAG)) ? [n] : [];
            list = list.concat($$(STAG, n));
            list.slice(0, 20).forEach(function (x, i) { if (!x.classList.contains('di-stag')) { x.style.setProperty('--i', Math.min(i, 12)); x.classList.add('di-stag'); } });
            $$('.metric-val', n).forEach(function (mv2) {
              if (seen.has(mv2) || mv2.children.length) return; seen.add(mv2);
              var p2 = parseNum(mv2.textContent); if (p2 && p2.v) animateNum(mv2, 0, mv2.textContent.trim(), 850);
            });
          });
        }
      });
    }
    mo.observe(main, { childList: true, subtree: true, characterData: true });
  }

  /* ------------------------------------------------------------ 6. FETCH PROGRESS */
  function installProgress() {
    var f = window.fetch; if (!f || f.__diProg) return;
    var bar = $('#di-progress'), fill = bar && bar.firstElementChild;
    var pending = 0, showT = null, trickle = null, w = 0;
    var SKIP = /status$|-status|metrics|poll|heartbeat|auth-status|live/i;
    function show() { if (!bar) return; bar.classList.add('on'); w = 12; fill.style.width = w + '%'; clearInterval(trickle); trickle = setInterval(function () { w = Math.min(88, w + (90 - w) * 0.09); fill.style.width = w + '%'; }, 220); }
    function finish() {
      clearTimeout(showT); showT = null; clearInterval(trickle);
      if (!bar || !bar.classList.contains('on')) return;
      fill.style.width = '100%';
      setTimeout(function () { bar.classList.remove('on'); setTimeout(function () { if (!pending) fill.style.width = '0'; }, 380); }, 220);
    }
    var wrapped = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var track = url.indexOf('/api/') >= 0 && !SKIP.test(url.split('?')[0]);
      if (track) { pending++; if (pending === 1 && !showT) showT = setTimeout(show, 260); }
      var done = function () { if (track) { pending = Math.max(0, pending - 1); if (!pending) finish(); } };
      return f.apply(this, arguments).then(function (r) { done(); return r; }, function (e) { done(); throw e; });
    };
    wrapped.__diProg = true;
    window.fetch = wrapped;
  }

  /* ------------------------------------------------------------ 7. TOAST */
  function installToast() {
    var ICON = { success: 'ti-circle-check', error: 'ti-alert-circle', warning: 'ti-alert-triangle', warn: 'ti-alert-triangle', info: 'ti-info-circle' };
    window.toast = function (msg, type) {
      type = type || 'info';
      var c = $('#toast-container'); if (!c) return;
      var dur = type === 'error' ? 6500 : 4000;
      var t = el('div', 'toast ' + type);
      t.setAttribute('role', type === 'error' ? 'alert' : 'status');
      t.innerHTML = '<div class="t-ic"><i class="ti ' + (ICON[type] || ICON.info) + '"></i></div><div class="t-msg"></div>' +
        '<button type="button" class="t-x" aria-label="ปิด"><i class="ti ti-x"></i></button><div class="t-bar"></div>';
      t.querySelector('.t-msg').innerHTML = msg; // เดิมใช้ innerHTML (ข้อความบางจุดมี <b>)
      t.querySelector('.t-bar').style.animationDuration = dur + 'ms';
      var left = dur, start = Date.now(), timer = null;
      var close = function () { if (t.__closing) return; t.__closing = true; t.classList.add('leaving'); setTimeout(function () { t.remove(); }, 300); };
      var arm = function () { start = Date.now(); timer = setTimeout(close, left); };
      t.addEventListener('mouseenter', function () { clearTimeout(timer); left -= Date.now() - start; });
      t.addEventListener('mouseleave', arm);
      t.querySelector('.t-x').addEventListener('click', close);
      c.appendChild(t);
      while (c.children.length > 5) c.removeChild(c.firstElementChild);
      arm();
    };
  }

  /* ------------------------------------------------------------ 8. COMMAND PALETTE */
  var pal = null, palSel = 0, palItems = [];
  function recent() { try { return JSON.parse(LS.get('di_pal_recent', '[]')) || []; } catch (e) { return []; } }
  function pushRecent(key) { var r = recent().filter(function (k) { return k !== key; }); r.unshift(key); LS.set('di_pal_recent', JSON.stringify(r.slice(0, 5))); }
  function menuEntries() {
    return $$('#main-nav .nav-item').filter(function (it) { return !it.closest('.nav-fav-section'); }).map(function (it) {
      var g = groupOf(it), ic = it.querySelector('i.ti'), t = REG.byId[it.getAttribute('data-tool')];
      var st = t ? effStatus(t) : null;
      return { kind: 'menu', key: it.getAttribute('onclick'), label: navLabel(it), sub: g ? g.label : 'หน้าหลัก', desc: t ? t.desc : '',
        tag: st && st.key !== 'live' ? st : null, icon: ic ? ic.className.replace(/\bti\b\s*/, '').trim() : 'ti-point',
        kw: (it.getAttribute('data-kw') || '') + ' ' + (g ? g.label : '') + ' ' + (t ? t.desc : ''), run: function () { it.click(); } };
    });
  }
  function actionEntries() {
    var A = [
      ['เปิดคอนโซลคำสั่ง (ดูสิ่งที่ส่งไปเซิร์ฟเวอร์)', 'ti-terminal-2', 'console terminal log script คอนโซล สคริปต์ คำสั่ง', function () { D.console.open(); }],
      ['สลับโหมดมืด / สว่าง', 'ti-contrast-2', 'theme dark light ธีม', function () { D.toggleTheme($('#ab-theme')); }],
      ['เปิด/ปิดเอฟเฟกต์ HUD (โหมดเรียบ)', 'ti-sparkles', 'hud fx effect animation ไฮเทค เอฟเฟกต์ โหมดเรียบ', function () { D.fx.toggle(); }],
      ['รีเฟรชข้อมูลตอนนี้', 'ti-refresh', 'refresh reload โหลดใหม่', window.refreshNow || window.loadData],
      ['เพิ่มโดเมนใหม่', 'ti-plus', 'add domain new', window.openAddModal],
      ['เช็คสถานะทุกโดเมน', 'ti-reload', 'check all', window.checkAllNow],
      ['Export รายชื่อโดเมน (CSV)', 'ti-download', 'export csv download', window.exportCSV],
      ['Sync Google Search Console', 'ti-brand-google', 'gsc sync', window.syncGSCAll],
      ['ย่อ / ขยายเมนูด้านข้าง', 'ti-layout-sidebar-left-collapse', 'sidebar collapse mini', D.toggleMini],
      ['ออกจากระบบ', 'ti-logout', 'logout sign out', window.doLogout]
    ];
    return A.filter(function (a) { return typeof a[3] === 'function'; }).map(function (a) {
      return { kind: 'action', key: 'act:' + a[0], label: a[0], sub: 'คำสั่ง', icon: a[1], kw: a[2], run: a[3] };
    });
  }
  function domainEntries(q) {
    if (!q || q.length < 2) return [];
    var list = [];
    try { list = (typeof allDomains !== 'undefined' && Array.isArray(allDomains)) ? allDomains : []; } catch (e) {}
    var COL = { up: 'var(--viz-good)', down: 'var(--viz-crit)', warn: 'var(--viz-warn)' };
    var TXT = { up: 'ออนไลน์', down: 'ล่ม', warn: 'ช้า / มีปัญหา' };
    return list.filter(function (d) { return d && d.domain && d.domain.toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) { return a.domain.toLowerCase().indexOf(q) - b.domain.toLowerCase().indexOf(q) || a.domain.length - b.domain.length; })
      .slice(0, 8).map(function (d) {
        return { kind: 'domain', key: 'dom:' + d.domain, label: d.domain, sub: (TXT[d.status] || 'ไม่ทราบสถานะ') + (d.pleskServer ? ' · ' + d.pleskServer : ''),
          icon: 'ti-world-www', dot: COL[d.status] || 'var(--text3)', mono: true, domain: d.domain,
          run: function () { D.findDomain(d.domain); } };
      });
  }
  /* คำสั่งต่อโดเมน (โผล่เมื่อค้นเจอโดเมน) */
  function domainActions(doms) {
    var d = doms[0]; if (!d) return [];
    return [
      { kind: 'action', key: 'dact:diag', label: 'วินิจฉัย ' + d.domain, sub: 'ตรวจ DNS / Cloudflare / SSL / vhost ของโดเมนนี้', icon: 'ti-stethoscope', kw: '', run: function () { D.diagDomain(d.domain); } },
      { kind: 'action', key: 'dact:open', label: 'เปิด ' + d.domain + ' ในแท็บใหม่', sub: 'เปิดหน้าเว็บจริง', icon: 'ti-external-link', kw: '', run: function () { window.open('https://' + d.domain, '_blank', 'noopener'); } }
    ];
  }
  D.findDomain = function (name) {
    if (typeof window.showPage === 'function') window.showPage('domains');
    var si = $('#search-input'); if (si) { si.value = name; }
    if (typeof window.applyFilters === 'function') window.applyFilters();
  };
  D.diagDomain = function (name) {
    if (typeof window.showPage === 'function') window.showPage('command');
    setTimeout(function () {
      var i = $('#diag-domain-input'); if (!i) return;
      i.value = name;
      i.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
      if (typeof window.runDomainDiag === 'function') window.runDomainDiag();
    }, 350);
  };
  function score(e, q) {
    if (!q) return 1;
    var L = e.label.toLowerCase(), K = (e.kw || '').toLowerCase();
    if (L.indexOf(q) === 0) return 100 - L.length * 0.1;
    if (L.indexOf(q) > 0) return 70 - L.indexOf(q);
    if (K.indexOf(q) >= 0) return 40;
    // subsequence (ภาษาอังกฤษ)
    var j = 0; for (var i = 0; i < L.length && j < q.length; i++) if (L[i] === q[j]) j++;
    return j === q.length ? 15 : 0;
  }
  function hl(label, q) {
    var i = q ? label.toLowerCase().indexOf(q) : -1;
    if (i < 0) return esc(label);
    return esc(label.slice(0, i)) + '<mark>' + esc(label.slice(i, i + q.length)) + '</mark>' + esc(label.slice(i + q.length));
  }
  function buildPalette() {
    pal = el('div', ''); pal.id = 'di-pal'; pal.setAttribute('role', 'dialog'); pal.setAttribute('aria-modal', 'true'); pal.setAttribute('aria-label', 'ค้นหาคำสั่ง');
    pal.innerHTML = '<div class="pal-box"><div class="pal-head"><i class="ti ti-search"></i>' +
      '<input id="di-pal-q" type="text" placeholder="พิมพ์ชื่อเมนู ชื่อโดเมน หรือคำสั่ง…" autocomplete="off" spellcheck="false" aria-label="ค้นหา">' +
      '<kbd>esc</kbd></div><div class="pal-list" id="di-pal-list" role="listbox"></div>' +
      '<div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> เลื่อน</span><span><kbd>↵</kbd> เปิด</span><span><kbd>esc</kbd> ปิด</span><span style="margin-left:auto"><kbd>' + (isMac ? '⌘' : 'Ctrl') + ' K</kbd> เปิดได้ทุกหน้า</span></div></div>';
    doc.body.appendChild(pal);
    var q = $('#di-pal-q', pal);
    q.addEventListener('input', function () { renderPalette(q.value); });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); movePal(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); movePal(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); runPal(palSel); }
      else if (e.key === 'Escape') { e.preventDefault(); D.closePalette(); }
    });
    pal.addEventListener('mousedown', function (e) { if (e.target === pal) D.closePalette(); });
    $('#di-pal-list', pal).addEventListener('click', function (e) { var it = e.target.closest('.pal-item'); if (it) runPal(+it.getAttribute('data-i')); });
    $('#di-pal-list', pal).addEventListener('mousemove', function (e) { var it = e.target.closest('.pal-item'); if (it) setSel(+it.getAttribute('data-i'), false); });
  }
  function renderPalette(raw) {
    var q = String(raw || '').trim().toLowerCase();
    var menus = menuEntries(), acts = actionEntries();
    var sections = [];
    if (!q) {
      var rk = recent(), all = menus.concat(acts);
      var rec = rk.map(function (k) { return all.filter(function (x) { return x.key === k; })[0]; }).filter(Boolean);
      if (rec.length) sections.push(['ล่าสุด', rec]);
      sections.push(['คำสั่งด่วน', acts.slice(0, 4)]);
      var byG = {};
      menus.forEach(function (m) { (byG[m.sub] = byG[m.sub] || []).push(m); });
      Object.keys(byG).forEach(function (g) { sections.push([g || 'เมนู', byG[g]]); });
    } else {
      var rank = function (arr) { return arr.map(function (e) { return { e: e, s: score(e, q) }; }).filter(function (x) { return x.s > 0; }).sort(function (a, b) { return b.s - a.s; }).map(function (x) { return x.e; }); };
      var m = rank(menus).slice(0, 8), a = rank(acts).slice(0, 5), d = domainEntries(q);
      var da = domainActions(d);
      // ถ้าชื่อโดเมนตรงกว่าเมนู ให้โดเมนขึ้นก่อน
      if (d.length && (!m.length || d[0].label.toLowerCase().indexOf(q) === 0)) { sections.push(['โดเมน', d]); if (m.length) sections.push(['เครื่องมือ', m]); }
      else { if (m.length) sections.push(['เครื่องมือ', m]); if (d.length) sections.push(['โดเมน', d]); }
      if (a.length || da.length) sections.push(['คำสั่ง', da.concat(a)]);
    }
    palItems = [];
    var html = '';
    sections.forEach(function (sec) {
      html += '<div class="pal-sec">' + esc(sec[0]) + '</div>';
      sec[1].forEach(function (e) {
        var i = palItems.length; palItems.push(e);
        var sub = e.desc ? (e.sub ? e.sub + ' · ' : '') + e.desc : e.sub;
        html += '<div class="pal-item" role="option" data-i="' + i + '"><span class="pi-ic"><i class="ti ' + esc(e.icon) + '"></i></span>' +
          '<span class="pi-main"><span class="pi-label"' + (e.mono ? ' style="font-family:var(--mono);font-size:13px"' : '') + '>' + hl(e.label, q) +
          (e.tag ? ' <span class="pi-tag st-' + e.tag.key + '">' + esc(e.tag.label) + '</span>' : '') + '</span>' +
          (sub ? '<span class="pi-sub">' + esc(sub) + '</span>' : '') + '</span>' +
          (e.dot ? '<span class="pi-dot" style="background:' + e.dot + '"></span>' : '<span class="pi-hint">' + (e.kind === 'action' ? 'คำสั่ง' : '↵') + '</span>') + '</div>';
      });
    });
    var list = $('#di-pal-list', pal);
    list.innerHTML = palItems.length ? html : '<div class="pal-empty"><i class="ti ti-mood-empty" style="font-size:28px;display:block;margin-bottom:8px"></i>ไม่พบ “' + esc(raw) + '”</div>';
    setSel(0, true);
  }
  function setSel(i, scroll) {
    if (!palItems.length) return;
    palSel = (i + palItems.length) % palItems.length;
    $$('.pal-item', pal).forEach(function (x) { x.classList.toggle('sel', +x.getAttribute('data-i') === palSel); x.setAttribute('aria-selected', +x.getAttribute('data-i') === palSel ? 'true' : 'false'); });
    if (scroll) { var s = $('.pal-item.sel', pal); if (s && s.scrollIntoView) s.scrollIntoView({ block: 'nearest' }); }
  }
  function movePal(d) { setSel(palSel + d, true); }
  function runPal(i) {
    var e = palItems[i]; if (!e) return;
    D.closePalette();
    CON.lastGesture = Date.now(); CON.gKind = e.kind === 'action' ? 'action' : 'nav';
    if (e.kind !== 'domain') pushRecent(e.key);
    setTimeout(safe(e.run), 30);
  }
  D.openPalette = function (initial) {
    if (!pal) buildPalette();
    if (!$('#main-app') || !shown($('#main-app'))) return;
    pal.classList.add('open');
    var q = $('#di-pal-q', pal); q.value = typeof initial === 'string' ? initial : ''; renderPalette(q.value);
    // โฟกัสทันที (ไม่รอ timer) — ตัวอักษรที่พิมพ์ต่อจาก Ctrl K จะไม่หาย
    q.focus();
    try { q.setSelectionRange(q.value.length, q.value.length); } catch (e) {}
  };
  D.closePalette = function () { if (pal) pal.classList.remove('open'); };

  /* ------------------------------------------------------------ 9. HERO (ศูนย์บัญชาการ) */
  var heroPrevPct = 0;
  D.renderHero = safe(function () {
    var hero = $('#di-hero'); if (!hero) return;
    var list = [];
    try { list = (typeof allDomains !== 'undefined' && Array.isArray(allDomains)) ? allDomains : []; } catch (e) {}
    var name = LS.get('di_display_name', '') || 'Captain';
    var h = new Date().getHours();
    var part = h < 5 ? 'สวัสดีตอนดึก' : h < 12 ? 'สวัสดีตอนเช้า' : h < 17 ? 'สวัสดีตอนบ่าย' : h < 20 ? 'สวัสดีตอนเย็น' : 'สวัสดีตอนค่ำ';
    $('#hero-greet').textContent = part + ', ' + name;
    if (!list.length) {
      if (D._statsSeen) {
        $('#hero-title').innerHTML = 'ยังไม่มี<em>โดเมน</em>ในระบบ';
        $('#hero-line').innerHTML = '<span class="hl">กด <b>Sync Plesk</b> ที่หน้า Dashboard หรือ <b>เพิ่มโดเมน</b> เพื่อเริ่มต้น</span>';
        $('#hero-ring-num').textContent = '—';
      }
      return;
    }
    var total = list.length;
    var up = 0, warn = 0, down = 0, ssl = 0;
    list.forEach(function (d) {
      if (d.status === 'up') up++; else if (d.status === 'warn') warn++; else if (d.status === 'down') down++;
      if (d.sslDaysLeft != null && d.sslDaysLeft >= 0 && d.sslDaysLeft <= 30) ssl++;
    });
    var other = Math.max(0, total - up - warn - down);
    var pct = total ? up / total * 100 : 0;
    var title = down > 0 ? 'มี <em>' + down + ' เว็บล่ม</em> รอให้ดูแลอยู่'
      : warn > 0 ? 'ระบบปกติดี · มี <em>' + warn + ' เว็บ</em>ที่ต้องจับตา'
      : 'ทุกเว็บ<em>ทำงานปกติ</em> ✨';
    var ht = $('#hero-title');
    if (ht.innerHTML !== title) { ht.innerHTML = title; if (HUD.titleSig !== title) { HUD.titleSig = title; decode(ht, 700); } }
    ht.classList.toggle('bad', down > 0);
    renderTele();
    var dt = new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    $('#hero-line').innerHTML =
      '<span class="hl"><i class="ti ti-calendar" style="font-size:15px;color:var(--text3)"></i>' + esc(dt) + '</span>' +
      '<span class="hl">ออนไลน์ <b>' + up.toLocaleString() + '</b> จาก <b>' + total.toLocaleString() + '</b> เว็บ</span>' +
      (ssl ? '<span class="hl"><i class="ti ti-certificate" style="font-size:15px;color:var(--amber)"></i>SSL ใกล้หมด <b>' + ssl + '</b></span>' : '');
    var seg = [['up', up, 'var(--viz-good)', 'ออนไลน์'], ['warn', warn, 'var(--viz-warn)', 'ช้า / มีปัญหา'], ['down', down, 'var(--viz-crit)', 'ล่ม'], ['other', other, 'var(--bg5)', 'ยังไม่ได้เช็ค']]
      .filter(function (x) { return x[1] > 0; });
    var st = $('#hero-stack');
    st.innerHTML = seg.map(function (x) { return '<span style="flex-grow:0;background:' + x[2] + '" data-g="' + x[1] + '" title="' + esc(x[3]) + ': ' + x[1] + ' เว็บ (' + (x[1] / total * 100).toFixed(1) + '%)"></span>'; }).join('');
    st.setAttribute('aria-label', seg.map(function (x) { return x[3] + ' ' + x[1]; }).join(', '));
    raf(function () { raf(function () { $$('span', st).forEach(function (sp) { sp.style.flexGrow = sp.getAttribute('data-g'); }); }); });
    $('#hero-legend').innerHTML = seg.map(function (x) { return '<span><i style="background:' + x[2] + '"></i>' + esc(x[3]) + ' <b style="color:var(--text);font-weight:600">' + x[1].toLocaleString() + '</b></span>'; }).join('');
    // วงแหวน (meter): สีตามความรุนแรง
    var ring = $('#hero-ring'), val = $('#hero-ring-val');
    var col = pct >= 95 ? 'var(--viz-good)' : pct >= 80 ? 'var(--viz-warn)' : 'var(--viz-crit)';
    ring.style.setProperty('--ring-c', col);
    var C = 2 * Math.PI * 72;
    raf(function () { val.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(2); });
    var num = $('#hero-ring-num'), from = heroPrevPct, t0 = performance.now(), dur = reduced ? 1 : 1200;
    heroPrevPct = pct;
    (function step(now) {
      var k = Math.min(1, ((now || performance.now()) - t0) / dur), ez = 1 - Math.pow(1 - k, 3);
      var v = from + (pct - from) * ez;
      num.innerHTML = (pct >= 99.95 ? Math.round(v) : v.toFixed(1)) + '<small>%</small>';
      if (k < 1) raf(step);
    })();
  });
  D.focusDiag = function () {
    var i = $('#diag-domain-input'); if (!i) return;
    var pc = $('#page-command');
    if (pc && pc.style.display === 'none' && typeof window.showPage === 'function') window.showPage('command');
    setTimeout(function () {
      i.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
      setTimeout(function () { i.focus(); }, 350);
    }, 60);
  };

  /* ------------------------------------------------------------ 10. HISTORY CHART (แทน drawChart เดิม) */
  var chartSeq = 0, chartData = {};
  function niceMax(v) { if (v <= 5) return 5; var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
  function fmtTime(iso, withDate) {
    var d = new Date(iso); if (isNaN(d)) return '';
    return withDate ? d.toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  }
  function drawChartV3(hist) {
    var n = hist.length, id = 'dic' + (++chartSeq);
    var W = 920, H = 300, pl = 44, pr = 60, pt = 14, pb = 34;
    var S = [['down', 'var(--viz-crit)', 'Down (ล่ม)'], ['blocked', 'var(--viz-alt)', 'โดนบล็อก (ISP)'], ['warn', 'var(--viz-warn)', 'Warn (ช้า)']];
    var maxV = 1; hist.forEach(function (p) { S.forEach(function (k) { if ((p[k[0]] || 0) > maxV) maxV = p[k[0]]; }); });
    var top = niceMax(maxV);
    var x = function (i) { return pl + (n <= 1 ? 0 : i / (n - 1)) * (W - pl - pr); };
    var y = function (v) { return pt + (1 - v / top) * (H - pt - pb); };
    var g = '<g class="grid">', ax = '<g class="axis">';
    for (var t = 0; t <= 4; t++) {
      var v = top * t / 4, yy = y(v).toFixed(1);
      g += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + yy + '" y2="' + yy + '"/>';
      ax += '<text x="' + (pl - 10) + '" y="' + (+yy + 4) + '" text-anchor="end">' + Math.round(v).toLocaleString() + '</text>';
    }
    var ticks = Math.min(5, n);
    for (var j = 0; j < ticks; j++) {
      var ii = Math.round(j * (n - 1) / Math.max(1, ticks - 1));
      ax += '<text x="' + x(ii).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="' + (j === 0 ? 'start' : j === ticks - 1 ? 'end' : 'middle') + '">' + esc(fmtTime(hist[ii].at, j === 0 || j === ticks - 1)) + '</text>';
    }
    g += '</g>'; ax += '</g>';
    var body = '';
    // area เฉพาะ Down (เรื่องหลัก) — wash 10%
    var d0 = hist.map(function (p, i) { return x(i).toFixed(1) + ',' + y(p.down || 0).toFixed(1); });
    body += '<path class="ar" style="fill:var(--viz-crit)" d="M' + x(0).toFixed(1) + ',' + y(0) + ' L' + d0.join(' L') + ' L' + x(n - 1).toFixed(1) + ',' + y(0) + ' Z"/>';
    var ends = [];
    S.forEach(function (k) {
      var pts = hist.map(function (p, i) { return x(i).toFixed(1) + ',' + y(p[k[0]] || 0).toFixed(1); }).join(' ');
      body += '<polyline class="ln" style="stroke:' + k[1] + '" points="' + pts + '"/>';
      var lv = hist[n - 1][k[0]] || 0;
      ends.push({ y: y(lv), v: lv, c: k[1] });
      body += '<circle class="dotm" style="fill:' + k[1] + '" cx="' + x(n - 1).toFixed(1) + '" cy="' + y(lv).toFixed(1) + '" r="4"/>';
    });
    // ป้ายค่าล่าสุด — ถ้าชนกันก็ไม่ใส่ (ใช้ legend + tooltip แทน)
    ends.sort(function (a, b) { return a.y - b.y; });
    var collide = ends.some(function (e, i) { return i && e.y - ends[i - 1].y < 14; });
    if (!collide) ends.forEach(function (e) { body += '<text class="endlbl" x="' + (W - pr + 10) + '" y="' + (e.y + 4).toFixed(1) + '">' + e.v.toLocaleString() + '</text>'; });
    var hover = '<line class="xh" id="' + id + '-xh" x1="0" x2="0" y1="' + pt + '" y2="' + (H - pb) + '" style="opacity:0"/><g id="' + id + '-hd"></g>' +
      '<rect id="' + id + '-hit" x="' + pl + '" y="' + pt + '" width="' + (W - pl - pr) + '" height="' + (H - pt - pb) + '" fill="transparent" style="cursor:crosshair"/>';
    var legend = '<div class="di-chart-legend">' + S.map(function (k) { return '<span><i style="background:' + k[1] + '"></i>' + esc(k[2]) + '</span>'; }).join('') + '</div>';
    var last = hist[n - 1];
    var rows = hist.slice(-48).reverse().map(function (p) { return '<tr><td>' + esc(fmtTime(p.at, true)) + '</td><td>' + (p.down || 0) + '</td><td>' + (p.blocked || 0) + '</td><td>' + (p.warn || 0) + '</td><td>' + (p.total || '') + '</td></tr>'; }).join('');
    chartData[id] = { hist: hist, x: x, y: y, S: S, W: W, pl: pl, pr: pr, n: n };
    setTimeout(function () { bindChart(id); }, 0);
    return '<div class="di-chart" id="' + id + '">' + legend +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="กราฟแนวโน้ม Down / โดนบล็อก / Warn">' + g + ax + body + hover + '</svg>' +
      '<div class="di-tip" id="' + id + '-tip"></div>' +
      '<div class="di-chart-foot"><span>ล่าสุด: Down <b style="color:var(--text)">' + (last.down || 0) + '</b> · โดนบล็อก <b style="color:var(--text)">' + (last.blocked || 0) + '</b> · Warn <b style="color:var(--text)">' + (last.warn || 0) + '</b>' + (last.total ? ' · จาก ' + last.total.toLocaleString() + ' โดเมน' : '') + '</span>' +
      '<span>' + esc(fmtTime(hist[0].at, true)) + ' → ' + esc(fmtTime(last.at, true)) + '</span></div>' +
      '<details style="margin-top:10px"><summary>ดูเป็นตาราง (48 จุดล่าสุด)</summary><div class="table-wrap"><table><thead><tr><th>เวลา</th><th>Down</th><th>โดนบล็อก</th><th>Warn</th><th>ทั้งหมด</th></tr></thead><tbody>' + rows + '</tbody></table></div></details></div>';
  }
  function bindChart(id) {
    var C = chartData[id], box = doc.getElementById(id); if (!C || !box) return;
    var svg = box.querySelector('svg'), hit = doc.getElementById(id + '-hit'), xh = doc.getElementById(id + '-xh'), hd = doc.getElementById(id + '-hd'), tip = doc.getElementById(id + '-tip');
    var show = function (ev) {
      var r = svg.getBoundingClientRect(), sx = (ev.clientX - r.left) * (C.W / r.width);
      var i = Math.round((sx - C.pl) / ((C.W - C.pl - C.pr) / Math.max(1, C.n - 1)));
      i = Math.max(0, Math.min(C.n - 1, i));
      var p = C.hist[i], X = C.x(i);
      xh.setAttribute('x1', X); xh.setAttribute('x2', X); xh.style.opacity = 1;
      hd.innerHTML = C.S.map(function (k) { return '<circle class="dotm" style="fill:' + k[1] + '" cx="' + X.toFixed(1) + '" cy="' + C.y(p[k[0]] || 0).toFixed(1) + '" r="4.5"/>'; }).join('');
      tip.textContent = '';
      var h = el('div', 'tt-h'); h.textContent = fmtTime(p.at, true); tip.appendChild(h);
      C.S.forEach(function (k) { var row = el('div', 'tt-r'); var i2 = el('i'); i2.style.background = k[1]; var b = el('b'); b.textContent = (p[k[0]] || 0).toLocaleString(); var s2 = el('span'); s2.textContent = k[2]; row.appendChild(i2); row.appendChild(b); row.appendChild(s2); tip.appendChild(row); });
      var bx = box.getBoundingClientRect(), px = (X / C.W) * r.width + (r.left - bx.left);
      tip.style.left = Math.min(bx.width - tip.offsetWidth - 8, Math.max(8, px + 14)) + 'px';
      tip.style.top = (r.top - bx.top + 20) + 'px';
      tip.classList.add('on');
    };
    var hide = function () { xh.style.opacity = 0; hd.innerHTML = ''; tip.classList.remove('on'); };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', hide);
  }

  /* ------------------------------------------------------------ 10b. ตรวจการตั้งค่าสดจากเซิร์ฟเวอร์ */
  function apiBase() { try { return (typeof API !== 'undefined' && API) ? API : location.origin; } catch (e) { return location.origin; } }
  function getJSON(path) {
    return fetch(apiBase() + path, { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  var HUBX = { cfpause: null, remediate: null };
  var liveBusy = false, liveAt = 0;
  function refreshLive(force) {
    if (liveBusy || (!force && liveAt && Date.now() - liveAt < 60000)) return;
    if (!shown($('#main-app'))) return;
    liveBusy = true; liveAt = Date.now();
    Promise.all([getJSON('/api/report'), getJSON('/api/vault/status'), getJSON('/api/cfpause/registry'), getJSON('/api/remediate/status')])
      .then(safe(function (r) {
        var rep = r[0] && (r[0].report || r[0]);   // /api/report ตอบ { success, report: { connectivity } }
        var c = rep && rep.connectivity;
        if (c) {
          // หมายเหตุ: cloudflare = มี CLOUDFLARE_API_TOKEN (ตัวแปรหลัก) ในเซิร์ฟเวอร์
          LIVE.map.cloudflare = !!c.cloudflare; LIVE.map.gsc = !!c.gsc; LIVE.map.anthropic = !!c.anthropic;
          LIVE.map.plesk = (+c.pleskServers || 0) > 0;
        }
        if (r[1] && r[1].success) LIVE.map.vault = r[1].persistent !== false;
        HUBX.cfpause = r[2] && r[2].success ? r[2] : null;
        HUBX.remediate = r[3] && r[3].success ? r[3] : null;
        if (c || r[1]) { LIVE.stamp++; LIVE.at = new Date(); }
        applyLiveTags();
        var p = currentPage(); if (p) ensureInfo(p, toolFor(p, activeItem()));
        if (p && p.id === 'page-hub') D.renderHub();
      }))
      .then(function () { liveBusy = false; }, function () { liveBusy = false; });
  }
  function liveWarn(t) {
    if (!t || !t.needs) return '';
    if (t.needs === 'vault' && LIVE.map.vault === false) return 'ตรวจสดแล้ว: ยังไม่ได้ตั้ง VAULT_DIR — ตู้เซฟเก็บไว้ใน /tmp จะหายเมื่อ deploy';
    if (effStatus(t).key === 'missing') return 'ตรวจสดแล้ว: เซิร์ฟเวอร์ยังไม่มีค่าที่เครื่องมือนี้ต้องใช้ — ปุ่มสั่งงานจะยังไม่ได้ผล';
    return '';
  }
  /* ป้ายเล็กบนเมนู: DEMO (ตายตัว) และ "ตั้งค่า" (เฉพาะที่ตรวจสดแล้วว่ายังไม่ได้ตั้ง) — ใช้ data-t ให้ textContent ว่าง (สคริปต์รายการโปรดอ่านชื่อจาก textContent) */
  function applyLiveTags() {
    $$('#main-nav .nav-item[data-tool]').forEach(function (it) {
      var t = REG.byId[it.getAttribute('data-tool')]; if (!t) return;
      var miss = effStatus(t).key === 'missing' || !!(t.needs === 'vault' && LIVE.map.vault === false);
      var tag = it.querySelector('.nav-tag.setup');
      if (miss && !tag) { tag = el('span', 'nav-tag setup'); tag.setAttribute('data-t', 'ตั้งค่า'); tag.title = liveWarn(t); var lb = it.querySelector('.nav-label'); if (lb) lb.insertAdjacentElement('afterend', tag); }
      if (!miss && tag) tag.remove();
    });
  }

  /* ------------------------------------------------------------ 10c. ศูนย์รวม (HUB) */
  function domainsList() { try { return (typeof allDomains !== 'undefined' && Array.isArray(allDomains)) ? allDomains : []; } catch (e) { return []; } }
  function cmdData() { try { return (typeof commandData !== 'undefined' && commandData) ? commandData : null; } catch (e) { return null; } }
  function navBadge(id) {
    var it = $('#main-nav .nav-item[data-tool="' + id + '"]'); if (!it) return '';
    var b = it.querySelector('.nav-badge'); if (!b || b.style.display === 'none') return '';
    var t = (b.textContent || '').trim(); return t && t !== '0' ? t : '';
  }
  function fmtClock(d) { return d ? d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : ''; }
  var hubPend = false;
  D.renderHub = function () {
    if (hubPend) return; hubPend = true;
    raf(safe(function () { hubPend = false; renderHubNow(); }));
  };
  function renderHubNow() {
    var page = $('#page-hub'); if (!page || page.style.display === 'none') return;
    renderHubRecent(); renderHubNowCards(); renderHubLegend(); renderHubCats();
    renderTele(); renderTicker(); renderNodes(); bindNodes();
  }
  function renderHubRecent() {
    var box = $('#hub-recent'); if (!box) return;
    var ids = recentTools().filter(function (id) { return REG.byId[id] && id !== 'hub'; }).slice(0, 5);
    var html;
    if (ids.length) {
      html = '<span class="hr-lbl">ใช้ล่าสุด</span>' + ids.map(function (id) { var t = REG.byId[id]; return '<button type="button" class="hub-chip" data-tool-open="' + esc(id) + '"><i class="ti ' + esc(t.icon) + '"></i>' + esc(t.label) + '</button>'; }).join('');
    } else {
      html = '<span class="hr-lbl">ลองค้นหา</span>' + ['ล่ม', 'cache', 'ย้าย ip', 'wp-admin', 'อนุมัติ', 'keyword'].map(function (q) { return '<button type="button" class="hub-chip ghost" data-pal-q="' + esc(q) + '"><i class="ti ti-search"></i>' + esc(q) + '</button>'; }).join('');
    }
    if (box.__html !== html) { box.__html = html; box.innerHTML = html; }
  }
  function renderHubNowCards() {
    var box = $('#hub-now'); if (!box) return;
    var list = domainsList(), cd = cmdData(), s = cd && cd.summary;
    var have = list.length > 0;
    var down = 0, warn = 0, exp = 0, ssl = 0;
    list.forEach(function (d) {
      if (d.status === 'down') down++; else if (d.status === 'warn') warn++;
      if (d.daysLeft != null && d.daysLeft >= 0 && d.daysLeft <= 30) exp++;
      if (d.sslDaysLeft != null && d.sslDaysLeft >= 0 && d.sslDaysLeft <= 30) ssl++;
    });
    var pz = HUBX.cfpause, rm = HUBX.remediate;
    var cards = [
      { k: 'down', spark: 'down', ic: 'ti-circle-x', lbl: 'เว็บล่มตอนนี้', v: have ? down : null, lv: down > 0 ? 'crit' : 'ok', sub: down > 0 ? 'กดเพื่อดูรายการและสั่งแก้' : 'ไม่มีเว็บล่ม', run: "showPageFiltered('domains','down')" },
      { k: 'warn', spark: 'warn', ic: 'ti-alert-triangle', lbl: 'ช้า / มีปัญหา', v: have ? warn : null, lv: warn > 0 ? 'warn' : 'ok', sub: warn > 0 ? 'ยังเข้าได้ แต่ควรจับตา' : 'ทุกเว็บตอบสนองปกติ', run: "showPageFiltered('domains','warn')" },
      { k: 'exp', ic: 'ti-clock', lbl: 'โดเมนหมดอายุใน 30 วัน', v: have ? exp : null, lv: exp > 0 || ssl > 0 ? 'warn' : 'ok',
        sub: (exp > 0 ? 'ต่ออายุก่อนเว็บดับ' : 'ยังไม่มีโดเมนใกล้หมด') + (ssl ? ' · SSL ใกล้หมด ' + ssl + ' เว็บ' : ''), run: "showPageFiltered('domains','expiring')" },
      { k: 'urgent', ic: 'ti-flame', lbl: 'งานด่วน', v: s ? (+s.highPriority || 0) : null, lv: s && s.highPriority > 0 ? 'crit' : 'ok', sub: s ? (s.highPriority > 0 ? 'ระบบจัดลำดับไว้ในศูนย์บัญชาการ' : 'ไม่มีงานค้าง') : 'กำลังโหลดศูนย์บัญชาการ…', run: "showPage('command')" },
      { k: 'appr', ic: 'ti-checkbox', lbl: 'รออนุมัติ', v: s ? (+s.pendingApprovals || 0) : null, lv: s && s.pendingApprovals > 0 ? 'warn' : 'ok', sub: s && s.pendingApprovals > 0 ? 'คำสั่งแก้รอคุณกดยืนยัน' : 'ไม่มีคำสั่งค้าง', run: "showPage('approvals')" },
      { k: 'cfp', ic: 'ti-cloud-pause', lbl: 'Cloudflare ค้าง Pause', v: pz ? (pz.rows || []).length : null, lv: pz && pz.rows && pz.rows.length ? 'warn' : 'ok',
        sub: pz ? ((pz.rows || []).length ? 'zone ที่ระบบ pause ไว้ยังไม่ถูกปลด' : 'ไม่มี zone ค้าง') + (pz.persistent === false ? ' · บันทึกไว้ใน /tmp' : '') : (LIVE.map.cloudflare === false ? 'ยังไม่ได้ตั้ง Cloudflare token' : 'กำลังตรวจ…'), run: 'openCfCache()' },
      { k: 'fix', ic: 'ti-robot', lbl: 'แก้อัตโนมัติ (Auto-fix)', v: rm ? (rm.enabled ? 'เปิด' : 'ปิด') : null, lv: rm ? (rm.enabled ? 'ok' : 'idle') : 'idle',
        sub: rm ? 'วันนี้แก้ไป ' + (rm.dailyCount || 0) + '/' + (rm.dailyCap || '—') + ' ครั้ง' + (rm.cooldowns && rm.cooldowns.length ? ' · พักเครื่อง ' + rm.cooldowns.length + ' งาน' : '') : 'กำลังตรวจ…', run: "showPage('command')", txt: true }
    ];
    var html = cards.map(function (c, i) {
      var val = c.v == null ? '<span class="hn-v muted">—</span>' : '<span class="hn-v' + (c.txt ? ' txt' : '') + '">' + esc(typeof c.v === 'number' ? c.v.toLocaleString() : c.v) + '</span>';
      var stIc = c.lv === 'crit' ? 'ti-alert-circle' : c.lv === 'warn' ? 'ti-alert-triangle' : c.lv === 'ok' ? 'ti-circle-check' : 'ti-circle-dashed';
      return '<button type="button" class="hn-card lv-' + c.lv + '" data-run="' + esc(c.run) + '" style="--i:' + i + '">' +
        '<span class="hn-top"><span class="hn-ic"><i class="ti ' + c.ic + '"></i></span><span class="hn-lbl">' + esc(c.lbl) + '</span><i class="ti ' + stIc + ' hn-st" aria-hidden="true"></i></span>' +
        val + (c.spark ? sparkSVG(c.spark) : '') + '<span class="hn-sub">' + esc(c.sub) + '</span><i class="ti ti-arrow-up-right hn-go" aria-hidden="true"></i></button>';
    }).join('');
    if (box.__html !== html) {
      var first = !box.__html || box.querySelector('.skel');
      box.__html = html; box.innerHTML = html;
      if (first && !reduced) $$('.hn-card', box).forEach(function (c) { c.classList.add('di-stag'); });
    }
    var sub = $('#hub-now-sub');
    if (sub) {
      var lu = $('#last-updated-text'), t = lu && lu.textContent.trim();
      sub.textContent = 'ดึงจากข้อมูลจริงของเซิร์ฟเวอร์' + (t ? ' · ' + t : '');
    }
  }
  function renderHubLegend() {
    var box = $('#hub-legend'); if (!box || box.__done === LIVE.stamp) return;
    box.__done = LIVE.stamp;
    var aud = '';
    try { aud = new Date(REG.audited + 'T12:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { aud = REG.audited; }
    box.innerHTML =
      '<div class="hl-pills">' +
        [STATUS.live, STATUS.setup, STATUS.partial, STATUS.demo].map(function (st) { return '<span class="hl-item">' + pillHTML(st, true) + '<span>' + esc(st.long) + '</span></span>'; }).join('') +
        '<span class="hl-item"><span class="di-vol-ic"><i class="ti ti-database-exclamation"></i></span><span>ข้อมูลเริ่มใหม่เมื่อ deploy/รีสตาร์ท</span></span>' +
      '</div>' +
      '<div class="hl-audit"><i class="ti ti-file-search"></i>ป้ายสถานะตรวจจากโค้ดจริง (server.js) เมื่อ ' + esc(aud) +
        (LIVE.at ? ' · การตั้งค่า ENV ตรวจสดจากเซิร์ฟเวอร์เมื่อ ' + esc(fmtClock(LIVE.at)) + ' น.' : ' · กำลังตรวจการตั้งค่าสดจากเซิร์ฟเวอร์…') + '</div>';
  }
  function renderHubCats() {
    var box = $('#hub-cats'); if (!box) return;
    var sig = LIVE.stamp + '|' + REG.cats.map(function (c) { return c.tools.map(function (t) { return navBadge(t.id); }).join(','); }).join(';');
    if (box.__sig === sig) return;
    var first = !box.__sig; box.__sig = sig;
    box.innerHTML = REG.cats.map(function (c, i) {
      var cnt = { live: 0, setup: 0, partial: 0, demo: 0, missing: 0 };
      c.tools.forEach(function (t) { var st = effStatus(t); cnt[t.status === 'setup' && st.key === 'live' ? 'live' : st.key]++; });
      var sum = [];
      if (cnt.live) sum.push('<span class="hc-n st-live">' + cnt.live + ' ใช้ได้จริง</span>');
      if (cnt.setup) sum.push('<span class="hc-n st-setup">' + cnt.setup + ' ต้องตั้งค่า</span>');
      if (cnt.missing) sum.push('<span class="hc-n st-missing">' + cnt.missing + ' ยังไม่ได้ตั้งค่า</span>');
      if (cnt.partial) sum.push('<span class="hc-n st-partial">' + cnt.partial + ' บางส่วน</span>');
      if (cnt.demo) sum.push('<span class="hc-n st-demo">' + cnt.demo + ' DEMO</span>');
      var rows = c.tools.map(function (t) {
        var st = effStatus(t), b = navBadge(t.id), w = liveWarn(t);
        return '<button type="button" class="hc-tool" data-tool-open="' + esc(t.id) + '">' +
          '<span class="hc-t-ic"><i class="ti ' + esc(t.icon) + '"></i></span>' +
          '<span class="hc-t-main"><span class="hc-t-name">' + esc(t.label) + (b ? '<span class="hc-t-badge">' + esc(b) + '</span>' : '') +
            (t.volatile ? '<span class="di-vol-ic" title="' + esc(REG.volatileNote) + '"><i class="ti ti-database-exclamation"></i></span>' : '') + pillHTML(st, true) + '</span>' +
          '<span class="hc-t-desc">' + esc(t.desc) + '</span>' +
          (t.note || w ? '<span class="hc-t-note' + (w ? ' warn' : '') + '"><i class="ti ' + (w ? 'ti-alert-triangle' : 'ti-info-circle') + '"></i>' + esc(w || t.note) + '</span>' : '') +
          '</span></button>';
      }).join('');
      return '<article class="hub-cat' + (first && !reduced ? ' di-stag' : '') + '" data-cat="' + esc(c.id) + '" style="--i:' + i + '">' +
        '<header class="hc-head"><span class="hc-ic"><i class="ti ' + esc(c.icon) + '"></i></span><div class="hc-title"><h4>' + esc(c.label) + '</h4><p>' + esc(c.desc) + '</p></div></header>' +
        '<div class="hc-sum">' + c.tools.length + ' เครื่องมือ · ' + sum.join('<i>·</i>') + '</div>' +
        '<div class="hc-tools">' + rows + '</div></article>';
    }).join('');
  }
  function runStr(code) { try { (new Function(code))(); } catch (e) { if (window.console) console.warn('[DIUI] run', e); } }

  /* ------------------------------------------------------------ 10d. ACTION CONSOLE (หน้าต่างสคริปต์)
     แสดง request ที่หน้าเว็บส่งไปเซิร์ฟเวอร์จริง + ผลที่ตอบกลับจริง + ความคืบหน้างานเบื้องหลังแบบสด
     - บันทึกทุกคำสั่งที่ "เปลี่ยนแปลงระบบ" (POST/PUT/PATCH/DELETE) และคำสั่งตรวจที่ผู้ใช้กดเอง (GET บางกลุ่ม)
     - ไม่บันทึกการโหลดข้อมูลปกติ / polling เบื้องหลัง (ยกเว้นเป็นการติดตามงานที่เพิ่งสั่ง)
     - ซ่อนค่าลับอัตโนมัติ: key / password / token / secret / otp / cookie
     ========================================================================== */
  var CON = { entries: [], seq: 0, open: false, auto: LS.get('di_con_auto', '1') !== '0', lastGesture: 0, el: null, unseen: 0 };
  var CON_SKIP = /^\/api\/(login|logout|auth|agent\/(poll|report|heartbeat)|isp-agent\/|heartbeat)/;
  var CON_ACTION_GET = /^\/api\/(check\/|diagnose\/|diagnose-domain\/|deep-nginx\/|nginx-error\/|cfcache\/(status|probe|diagnose)|wpadmin\/status|isp-check|plesk\/status|server-hogs|keywords-history|gsc\/check-dns\/|gsc\/debug|resource-usage\/|agent\/debug)/;
  var CON_POLL = /-(status|progress)$/;
  var SECRET_K = /(^|_|-)(key|pass|passwd|password|passphrase|token|secret|otp|apikey|api_key|auth|authorization|cookie|session|pin)$/i;
  function redact(v, depth) {
    depth = depth || 0;
    if (depth > 6 || v == null) return v;
    if (Array.isArray(v)) return v.map(function (x) { return redact(x, depth + 1); });
    if (typeof v === 'object') {
      var o = {};
      Object.keys(v).forEach(function (k) { o[k] = SECRET_K.test(k) && v[k] !== '' && v[k] != null && typeof v[k] !== 'object' && typeof v[k] !== 'boolean' ? '••••••(ซ่อน)' : redact(v[k], depth + 1); });
      return o;
    }
    return v;
  }
  function redactUrl(p) { return p.replace(/([?&](?:key|token|pass|password|secret|otp)=)[^&]*/gi, '$1••••'); }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '\n… (ตัดเหลือ ' + n.toLocaleString() + ' ตัวอักษร จากทั้งหมด ' + s.length.toLocaleString() + ')' : s; }
  /* JSON → HTML สี (ย่ออาร์เรย์ยาว) */
  function jsonHTML(v, ind, depth) {
    ind = ind || ''; depth = depth || 0;
    var pad = ind + '  ';
    if (v === null) return '<span class="j-n">null</span>';
    if (typeof v === 'boolean') return '<span class="j-b">' + v + '</span>';
    if (typeof v === 'number') return '<span class="j-num">' + v + '</span>';
    if (typeof v === 'string') {
      var s = v.length > 600 ? v.slice(0, 600) + '…' : v;
      return '<span class="j-s">"' + esc(s).replace(/\n/g, '\\n') + '"</span>';
    }
    if (depth > 5) return '<span class="j-n">…</span>';
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      var max = 8, items = v.slice(0, max).map(function (x) { return pad + jsonHTML(x, pad, depth + 1); });
      if (v.length > max) items.push(pad + '<span class="j-more">… อีก ' + (v.length - max).toLocaleString() + ' รายการ</span>');
      return '[\n' + items.join(',\n') + '\n' + ind + ']';
    }
    var ks = Object.keys(v); if (!ks.length) return '{}';
    return '{\n' + ks.map(function (k) { return pad + '<span class="j-k">"' + esc(k) + '"</span>: ' + jsonHTML(v[k], pad, depth + 1); }).join(',\n') + '\n' + ind + '}';
  }
  function shortJSON(v, n) { var s; try { s = JSON.stringify(v); } catch (e) { s = String(v); } return s.length > (n || 160) ? s.slice(0, n || 160) + '…' : s; }
  function tsNow() { return new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function durTxt(ms) { return ms < 1000 ? Math.round(ms) + 'ms' : ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round(ms % 60000 / 1000) + 's'; }

  function buildConsole() {
    if (CON.el) return CON.el;
    var w = el('div', ''); w.id = 'di-con'; w.setAttribute('aria-live', 'polite');
    w.innerHTML =
      '<button type="button" class="con-pill" id="di-con-pill" title="คอนโซลคำสั่ง — ดูสิ่งที่ส่งไปเซิร์ฟเวอร์จริง (กด ` เพื่อเปิด/ปิด)"><i class="ti ti-terminal-2"></i><span class="cp-lbl">คอนโซล</span><span class="cp-run"></span><span class="cp-n" id="di-con-n"></span></button>' +
      '<section class="con-panel" id="di-con-panel" role="dialog" aria-label="คอนโซลคำสั่ง">' +
        '<header class="con-head"><span class="con-dots"><i></i><i></i><i></i></span>' +
          '<div class="con-title"><b>Action Console</b><span>request/response จริงระหว่างหน้าเว็บกับเซิร์ฟเวอร์ · ซ่อน key/รหัสให้อัตโนมัติ</span></div>' +
          '<label class="con-auto" title="เปิดหน้าต่างนี้เองทุกครั้งที่กดสั่งงาน"><input type="checkbox" id="di-con-auto"' + (CON.auto ? ' checked' : '') + '> เด้งเอง</label>' +
          '<button type="button" class="con-btn" data-con="copy" title="คัดลอกทั้งหมด"><i class="ti ti-copy"></i></button>' +
          '<button type="button" class="con-btn" data-con="clear" title="ล้าง"><i class="ti ti-trash"></i></button>' +
          '<button type="button" class="con-btn" data-con="close" title="ย่อ (Esc)"><i class="ti ti-chevron-down"></i></button>' +
        '</header>' +
        '<div class="con-body" id="di-con-body"></div>' +
      '</section>';
    doc.body.appendChild(w);
    CON.el = w;
    $('#di-con-pill', w).addEventListener('click', function () { D.console.toggle(); });
    var cb = $('#di-con-body', w);
    cb.addEventListener('scroll', function () { cb.__userScrolled = cb.scrollHeight - cb.scrollTop - cb.clientHeight > 40; }, { passive: true });
    $('#di-con-auto', w).addEventListener('change', function (e) { CON.auto = e.target.checked; LS.set('di_con_auto', CON.auto ? '1' : '0'); });
    w.addEventListener('click', function (e) {
      var b = e.target.closest('[data-con]'); if (!b) return;
      var a = b.getAttribute('data-con');
      if (a === 'close') D.console.close();
      else if (a === 'clear') { CON.entries = []; saveCon(); renderConAll(); }
      else if (a === 'copy') copyText($('#di-con-body').innerText, b);
      else if (a === 'more') { var pre = b.previousElementSibling; if (pre) { pre.classList.toggle('full'); b.textContent = pre.classList.contains('full') ? 'ย่อ' : 'แสดงทั้งหมด'; } }
    });
    renderConAll();
    return w;
  }
  function copyText(t, btn) {
    var done = function () { if (btn) { btn.innerHTML = '<i class="ti ti-check"></i>'; setTimeout(function () { btn.innerHTML = '<i class="ti ti-copy"></i>'; }, 1400); } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, function () {});
    else { var ta = el('textarea'); ta.value = t; doc.body.appendChild(ta); ta.select(); try { doc.execCommand('copy'); done(); } catch (e) {} ta.remove(); }
  }
  function saveCon() {
    try {
      var keep = CON.entries.slice(-25).map(function (e) { var c = {}; for (var k in e) if (k !== 'node' && k !== 'watch') c[k] = e[k]; return c; });
      var s = JSON.stringify(keep); if (s.length < 400000) LS.set('di_console', s);
    } catch (e) {}
  }
  function loadCon() {
    try {
      var a = JSON.parse(LS.get('di_console', '[]')) || [];
      a.forEach(function (e) { e.restored = true; if (e.state === 'run' || e.state === 'watch') e.state = 'lost'; CON.seq = Math.max(CON.seq, e.id || 0); });
      CON.entries = a;
    } catch (e) { CON.entries = []; }
  }
  function conCounts() {
    var run = CON.entries.some(function (e) { return e.state === 'run' || e.state === 'watch'; });
    var n = $('#di-con-n'), w = CON.el;
    if (n) n.textContent = CON.unseen ? String(CON.unseen) : (CON.entries.length ? String(CON.entries.length) : '');
    if (n) n.classList.toggle('new', CON.unseen > 0);
    if (w) w.classList.toggle('running', run);
  }
  function entryHTML(e) {
    var stc = e.state === 'ok' ? 'ok' : e.state === 'err' ? 'err' : e.state === 'lost' ? 'lost' : 'run';
    var h = '<div class="ce-head"><span class="ce-ts">' + esc(e.ts) + '</span><span class="ce-m m-' + esc(e.method.toLowerCase()) + '">' + esc(e.method) + '</span><span class="ce-path">' + esc(e.path) + '</span>' +
      (e.repeat > 1 ? '<span class="ce-rep" title="คำสั่งเดิมถูกเรียกซ้ำ">×' + e.repeat + '</span>' : '') +
      '<span class="ce-st st-' + stc + '">' + (stc === 'run' ? '<i class="ti ti-loader-2 ce-spin"></i>' + (e.state === 'watch' ? 'กำลังทำงาน' : 'รอผล') : stc === 'lost' ? 'ไม่ทราบผล (รีโหลดหน้า)' : (e.code ? e.code + ' · ' : '') + (stc === 'ok' ? 'สำเร็จ' : 'ไม่สำเร็จ')) + (e.ms != null ? ' · ' + esc(durTxt(e.ms)) : '') + '</span></div>';
    h += '<div class="ce-line c-cmd"><span class="pr">$</span> ' + esc(e.curl) + '</div>';
    if (e.why) h += '<div class="ce-line c-dim"># ' + esc(e.why) + '</div>';
    if (e.script) h += '<div class="ce-line c-dim"># สคริปต์ shell ที่ส่งให้ agent รันบนเซิร์ฟเวอร์ ' + esc(e.scriptOn || '') + ':</div><pre class="ce-code">' + esc(clip(e.script, 4000)) + '</pre>';
    if (e.resp != null) {
      var big = (e.respLines || 0) > 18;
      h += '<pre class="ce-json' + (big ? ' clip' : '') + '">' + e.resp + '</pre>' + (big ? '<button type="button" class="ce-more" data-con="more">แสดงทั้งหมด</button>' : '');
    }
    (e.lines || []).forEach(function (l) { h += '<div class="ce-line c-' + esc(l.c || 'out') + '">' + (l.p ? '<span class="pr">' + esc(l.p) + '</span> ' : '') + esc(l.t) + '</div>'; });
    if (e.prog) {
      var p = e.prog, pct = p.total ? Math.min(100, Math.round(p.done / p.total * 100)) : null;
      h += '<div class="ce-prog">' + (pct != null ? '<span class="ce-bar"><i style="width:' + pct + '%"></i></span><b>' + p.done.toLocaleString() + '/' + p.total.toLocaleString() + '</b>' : '') + '<span>' + esc(p.txt || '') + '</span></div>';
    }
    if (e.out) h += '<div class="ce-line c-dim"># ผลลัพธ์ (output) จากเซิร์ฟเวอร์:</div><pre class="ce-code out">' + esc(clip(e.out, 6000)) + '</pre>';
    if (e.end) h += '<div class="ce-line c-' + (e.state === 'err' ? 'err' : 'ok') + '"><span class="pr">' + (e.state === 'err' ? '✗' : '✓') + '</span> ' + esc(e.end) + '</div>';
    return h;
  }
  function renderEntry(e) {
    var body = $('#di-con-body'); if (!body) return;
    if (!e.node || !e.node.parentNode) {
      e.node = el('div', 'con-entry'); e.node.setAttribute('data-id', e.id);
      var empty = $('.con-empty', body); if (empty) empty.remove();
      body.appendChild(e.node);
    }
    e.node.className = 'con-entry st-' + e.state + (e.restored ? ' restored' : '');
    e.node.innerHTML = entryHTML(e);
    stickBottom(body);
    conCounts();
  }
  function stickBottom(body) {
    if (body.__userScrolled) return;
    body.scrollTop = body.scrollHeight;
  }
  function renderConAll() {
    var body = $('#di-con-body'); if (!body) return;
    body.innerHTML = '';
    if (!CON.entries.length) {
      body.innerHTML = '<div class="con-empty"><div class="ce-line c-dim"># ยังไม่มีคำสั่ง</div><div class="ce-line c-dim"># เมื่อคุณกดปุ่มสั่งงาน เช่น Auto-fix, เช็คสถานะ, ตั้ง Cache, ปลด Pause, ย้าย IP</div><div class="ce-line c-dim"># หน้าต่างนี้จะแสดงคำสั่งที่ส่งไปเซิร์ฟเวอร์จริง ผลที่ตอบกลับ และความคืบหน้าแบบสด</div><div class="ce-line c-cmd"><span class="pr">$</span> <span class="ce-caret"></span></div></div>';
    } else CON.entries.forEach(function (e) { e.node = null; renderEntry(e); });
    conCounts();
  }
  function whyOf(path, method) {
    var W = [
      [/^\/api\/remediate\/run/, 'วินิจฉัยเซิร์ฟเวอร์ที่สุขภาพต่ำแล้วแก้ให้อัตโนมัติ (Deep remediation)'],
      [/^\/api\/remediate\/toggle/, 'เปิด/ปิดระบบแก้อัตโนมัติ'],
      [/^\/api\/autofix\/run/, 'สั่งรอบ Auto-fix ทันที (แก้งานปลอดภัยที่ระบบเจอ)'],
      [/^\/api\/autofix\/toggle/, 'เปิด/ปิด Auto-fix'],
      [/^\/api\/autofix\//, 'สั่ง Auto-fix โดเมนนี้'],
      [/^\/api\/problems\/fix/, 'สั่งแก้ปัญหาจากรายงาน (ทันที หรือส่งขออนุมัติ)'],
      [/^\/api\/approvals\//, 'อนุมัติ/ปฏิเสธคำสั่งที่รออยู่'],
      [/^\/api\/agent\/run\//, 'ส่งคำสั่ง shell ให้ agent บนเซิร์ฟเวอร์'],
      [/^\/api\/cfcache\/apply/, 'ตั้ง/ถอด Cache Rule + เปิดเมฆส้มบน Cloudflare'],
      [/^\/api\/cfcache\/bulk/, 'ตั้ง Cache Rule หลายโดเมน (งานเบื้องหลัง)'],
      [/^\/api\/cfcache\/unpause/, 'ปลด Pause zone บน Cloudflare'],
      [/^\/api\/cfpause\/scan/, 'สแกนหา zone ที่ค้าง Pause ทั้งบัญชี Cloudflare'],
      [/^\/api\/cfpause\/resume/, 'ปลด Pause หลายโดเมนรวดเดียว (งานเบื้องหลัง)'],
      [/^\/api\/cfpause\/sweep/, 'กวาดปลด zone ที่ค้างเกินเวลา'],
      [/^\/api\/cloudflare\//, 'สั่งงาน Cloudflare'],
      [/^\/api\/dns\/(repoint|scan|audit)/, 'ตรวจ/เปลี่ยน A record ใน Cloudflare DNS'],
      [/^\/api\/wpadmin\//, 'ปิด/เปิด wp-admin บนเซิร์ฟเวอร์ผ่าน agent'],
      [/^\/api\/check-all/, 'สั่งเช็คสถานะทุกโดเมนใหม่'],
      [/^\/api\/check\//, 'เช็คสถานะโดเมนนี้ทันที'],
      [/^\/api\/diagnose-domain\//, 'วินิจฉัยโดเมน: DNS, Cloudflare, SSL, vhost'],
      [/^\/api\/diagnose\//, 'วินิจฉัยเซิร์ฟเวอร์'],
      [/^\/api\/(nginx-reload|limit-phpfpm|phpfpm-ondemand|disk-cleanup|install-apache-watchdog)/, 'สั่งงานบนเซิร์ฟเวอร์ (ผ่าน agent)'],
      [/^\/api\/plesk\/sync/, 'ดึงรายชื่อโดเมนจาก Plesk'],
      [/^\/api\/gsc\//, 'สั่งงาน Google Search Console'],
      [/^\/api\/isp-check/, 'เช็คการโดนบล็อกจากค่ายเน็ต'],
      [/^\/api\/domains\/(add|import)/, 'เพิ่มโดเมนเข้าระบบ'],
      [/^\/api\/domains\//, method === 'DELETE' ? 'ลบโดเมนออกจากระบบ' : 'แก้ข้อมูลโดเมน'],
      [/^\/api\/vault\//, 'ตู้เซฟข้อมูลลับ (ข้อมูลเข้ารหัส)'],
      [/^\/api\/config/, 'บันทึกการตั้งค่า'],
      [/^\/api\/test-alert/, 'ส่งข้อความทดสอบไป Telegram'],
      [/^\/api\/employees\//, 'สั่งงานพนักงาน AI'],
      [/^\/api\/ai-analyze/, 'ให้ AI วิเคราะห์ error'],
      [/^\/api\/keywords-history/, 'ดึงอันดับคีย์เวิร์ด (DataForSEO / GSC)'],
      [/^\/api\/botwatch\//, 'Bot Watch — endpoint นี้ยังไม่มีในเซิร์ฟเวอร์ (DEMO)']
    ];
    for (var i = 0; i < W.length; i++) if (W[i][0].test(path)) return W[i][1];
    return '';
  }
  function summarizeArrays(v, depth) {
    depth = depth || 0;
    if (Array.isArray(v)) { var a = v.slice(0, 3).map(function (x) { return summarizeArrays(x, depth + 1); }); if (v.length > 3) a.push('…+' + (v.length - 3) + ' รายการ'); return a; }
    if (v && typeof v === 'object' && depth < 5) { var o = {}; Object.keys(v).forEach(function (k) { o[k] = summarizeArrays(v[k], depth + 1); }); return o; }
    return v;
  }
  function curlOf(method, path, bodyObj, bodyRaw) {
    var s = 'curl' + (method !== 'GET' ? ' -X ' + method : '') + ' ' + redactUrl(path);
    if (bodyObj !== undefined) s += " -H 'Content-Type: application/json' -d '" + shortJSON(summarizeArrays(redact(bodyObj)), 260).replace(/'/g, "\\'") + "'";
    else if (bodyRaw) s += ' ' + bodyRaw;
    return s;
  }
  function progOf(j) {
    if (!j || typeof j !== 'object') return null;
    var o = (j.progress && typeof j.progress === 'object') ? j.progress : j;
    var parts = [];
    var num = function (x) { return typeof x === 'number' && isFinite(x); };
    if (num(o.ok)) parts.push('สำเร็จ ' + o.ok); else if (num(o.success)) parts.push('สำเร็จ ' + o.success);
    if (num(o.failed)) parts.push('ล้มเหลว ' + o.failed);
    if (num(o.changed)) parts.push('เปลี่ยนแล้ว ' + o.changed);
    if (num(o.proxied)) parts.push('เปิดเมฆส้ม ' + o.proxied);
    if (num(o.zones)) parts.push('zones ' + o.zones);
    if (Array.isArray(o.paused)) parts.push('ค้าง pause ' + o.paused.length);
    if (Array.isArray(o.matches)) parts.push('พบ ' + o.matches.length);
    if (o.current) parts.push('กำลังทำ: ' + o.current);
    return { total: num(o.total) ? o.total : 0, done: num(o.done) ? o.done : 0, txt: parts.join(' · '), running: o.running, error: o.error, failures: Array.isArray(o.failures) ? o.failures : null };
  }
  function addLine(e, t, c, p) { (e.lines = e.lines || []).push({ t: t, c: c, p: p }); if (e.lines.length > 80) e.lines.splice(1, e.lines.length - 80); }
  function finishEntry(e, ok, text) {
    e.state = ok ? 'ok' : 'err'; e.end = text; e.watch = null;
    renderEntry(e); saveCon();
  }
  function onPoll(path, j) {
    var e = null, now = Date.now();
    if (/^\/api\/agent\/result\//.test(path)) {
      var id = decodeURIComponent(path.split('/api/agent/result/')[1] || '');
      e = CON.entries.filter(function (x) { return x.watch && x.watch.cmdId && String(x.watch.cmdId) === id; }).pop();
      if (!e) return;
      if (j && j.pending) { if (!e.__pendShown) { e.__pendShown = true; addLine(e, 'รอ agent บนเซิร์ฟเวอร์ดึงคำสั่งไปรัน…', 'dim', '⋯'); renderEntry(e); } return; }
      var outp = j && (j.output || j.stdout || j.result);
      if (outp) e.out = typeof outp === 'string' ? outp : JSON.stringify(outp, null, 2);
      finishEntry(e, !!(j && j.success !== false), 'agent รันเสร็จแล้ว · รวม ' + durTxt(now - e.t0));
      return;
    }
    var base = path.replace(CON_POLL, '');
    e = CON.entries.filter(function (x) {
      return x.watch && !x.watch.cmdId && now - x.t0 < 45 * 60000 && (x.path.indexOf(base) === 0 || base.indexOf(x.path.split('?')[0]) === 0);
    }).pop();
    if (!e) return;
    var p = progOf(j); if (!p) return;
    e.state = 'watch';
    if (p.running) e.watch.seenRun = true;
    var sig = p.done + '|' + p.total + '|' + p.txt;
    if (sig !== e.watch.sig) {
      e.watch.sig = sig;
      if (!e.watch.polls) addLine(e, 'ติดตามงานเบื้องหลังจาก GET ' + path + ' (อัปเดตสด)', 'dim', '▸');
      e.prog = p;
      if (p.failures && p.failures.length > (e.watch.nf || 0)) {
        p.failures.slice(e.watch.nf || 0, (e.watch.nf || 0) + 20).forEach(function (f) {
          addLine(e, (f.domain || f.zone || f.name || '') + ' — ' + (f.error || f.reason || f.msg || shortJSON(f, 120)), 'err', '✗');
        });
        e.watch.nf = p.failures.length;
      }
    }
    e.watch.polls = (e.watch.polls || 0) + 1;
    if (p.running === undefined) { finishEntry(e, !p.error, 'เซิร์ฟเวอร์ทำงานเบื้องหลัง — ผลล่าสุดแสดงบนหน้านี้แล้ว'); return; }
    if (p.running === false && (e.watch.seenRun || e.watch.polls >= 2)) {
      finishEntry(e, !p.error, p.error ? 'งานจบพร้อมข้อผิดพลาด: ' + p.error : 'งานเบื้องหลังเสร็จสิ้น · รวม ' + durTxt(now - e.t0) + (p.txt ? ' · ' + p.txt : ''));
      return;
    }
    renderEntry(e);
  }
  function installConsole() {
    var f = window.fetch; if (!f || f.__diCon) return;
    loadCon();
    // จำว่าการกดล่าสุดเป็น "สั่งงาน" หรือแค่ "เปลี่ยนหน้า" — เด้งคอนโซลเฉพาะตอนสั่งงาน
    ['pointerdown', 'keydown'].forEach(function (ev) {
      doc.addEventListener(ev, function (e) {
        var t = e.target && e.target.closest ? e.target : null;
        CON.lastGesture = Date.now();
        CON.gKind = t && t.closest('#main-nav, .sb-search, #di-pal, .hub-cat, .hub-chip, .hn-card, .hub-q, #di-con, .ab-crumbs, #ab-alerts') ? 'nav' : 'action';
      }, true);
    });
    var wrapped = function (input, init) {
      var p = f.apply(this, arguments);
      try {
        var raw = typeof input === 'string' ? input : (input && input.url) || '';
        if (raw.indexOf('/api/') < 0) return p;
        var u; try { u = new URL(raw, location.href); } catch (er) { return p; }
        var path = u.pathname, full = u.pathname + u.search;
        var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (method === 'GET' && path === '/api/domains') {
          var tL = performance.now();
          p.then(function (r) { if (r.ok) { HUD.lat = performance.now() - tL; HUD.syncAt = Date.now(); hudLat(); } }, function () {});
        }
        if (CON_SKIP.test(path)) return p;
        var isPoll = method === 'GET' && (CON_POLL.test(path) || /^\/api\/agent\/result\//.test(path));
        if (isPoll) {
          if (CON.entries.some(function (x) { return x.watch; })) p.then(function (r) { r.clone().json().then(safe(function (j) { onPoll(path, j); }), function () {}); }, function () {});
          return p;
        }
        var log = method !== 'GET' || CON_ACTION_GET.test(path);
        if (!log) return p;
        var kind = Date.now() - CON.lastGesture < 4000 ? (CON.gKind || 'action') : 'bg';
        var user = kind === 'action';
        var b = init && init.body, bodyObj;
        var sig = method + ' ' + full + ' ' + (typeof b === 'string' ? b.slice(0, 400) : '');
        // คำสั่งเบื้องหลังที่ซ้ำเดิม (เช่น ดึงสถิติเซิร์ฟเวอร์ทุก 60 วิ) → รวมเป็นรายการเดียว นับจำนวนครั้ง
        var e = !user && CON.entries.slice(-20).filter(function (x) { return x.sig === sig && !x.user && x.state !== 'run' && x.state !== 'watch'; }).pop();
        if (e) {
          CON.entries.splice(CON.entries.indexOf(e), 1);
          e.repeat = (e.repeat || 1) + 1; e.ts = tsNow(); e.t0 = Date.now(); e.state = 'run'; e.lines = [];
          e.resp = null; e.out = null; e.end = null; e.prog = null; e.ms = null; e.code = null; e.restored = false;
          if (e.node && e.node.parentNode) e.node.parentNode.appendChild(e.node);
        } else e = { id: ++CON.seq, ts: tsNow(), t0: Date.now(), method: method, path: redactUrl(full), state: 'run', lines: [], user: user, sig: sig };
        if (typeof b === 'string' && b) { try { bodyObj = JSON.parse(b); } catch (er) { bodyObj = undefined; } }
        e.curl = curlOf(method, redactUrl(full), bodyObj, b && typeof b !== 'string' ? (typeof FormData !== 'undefined' && b instanceof FormData ? '-F (ฟอร์ม/ไฟล์)' : '-d (ข้อมูล)') : (typeof b === 'string' && bodyObj === undefined && b ? "-d '" + clip(b, 120) + "'" : ''));
        var why = whyOf(path, method);
        if (kind === 'nav') why = (why ? why + ' · ' : '') + 'หน้าเว็บสั่งเองอัตโนมัติตอนเปิดหน้า';
        else if (kind === 'bg') why = (why ? why + ' · ' : '') + 'สั่งโดยระบบเบื้องหลัง (ไม่ได้กดเอง)';
        e.why = why;
        if (bodyObj && typeof bodyObj.command === 'string' && /^\/api\/agent\/run\//.test(path)) { e.script = bodyObj.command; e.scriptOn = decodeURIComponent(path.split('/api/agent/run/')[1] || ''); }
        addLine(e, 'ส่งคำขอไปเซิร์ฟเวอร์แล้ว — รอผลตอบกลับ…', 'dim', '→');
        CON.entries.push(e); if (CON.entries.length > 60) CON.entries.splice(0, CON.entries.length - 60);
        buildConsole();
        if (user && CON.auto && method !== 'GET') D.console.open(true); else if (!CON.open && user) CON.unseen++;
        renderEntry(e);
        p.then(function (r) {
          e.ms = Date.now() - e.t0; e.code = r.status;
          r.clone().text().then(safe(function (txt) {
            e.lines = e.lines.filter(function (l) { return l.p !== '→'; });
            var j = null; try { j = JSON.parse(txt); } catch (er) {}
            if (j !== null && typeof j === 'object') {
              var rj = redact(j), html = jsonHTML(rj);
              e.resp = html; e.respLines = html.split('\n').length;
              var outp = typeof j.output === 'string' ? j.output : typeof j.stdout === 'string' ? j.stdout : (typeof j.result === 'string' && j.result.indexOf('\n') >= 0 ? j.result : '');
              if (outp) e.out = outp;
              var bad = !r.ok || j.success === false || j.ok === false || !!j.error;
              if (j.cmdId && !j.output) {
                e.watch = { cmdId: j.cmdId }; e.state = 'watch';
                addLine(e, 'agent รับคำสั่งแล้ว (cmdId ' + j.cmdId + ') — จะแสดงผลลัพธ์ทันทีที่เครื่องปลายทางรันเสร็จ', 'dim', '▸');
                renderEntry(e); saveCon();
                setTimeout(function () { if (e.watch && e.watch.cmdId) finishEntry(e, false, 'ยังไม่ได้ผลจาก agent ภายใน 3 นาที — agent อาจออฟไลน์ หรือหน้าเว็บเลิกถามผลแล้ว'); }, 180000);
                return;
              }
              if (!bad && (j.started || /\/(bulk|scan|resume|sweep|repoint|audit|bulk-add|sync-all)$/.test(path))) {
                e.watch = { base: path }; e.state = 'watch';
                addLine(e, 'เซิร์ฟเวอร์เริ่มงานเบื้องหลังแล้ว' + (j.total ? ' (' + j.total + ' รายการ)' : '') + ' — รอหน้าเว็บถามความคืบหน้า', 'ok', '▸');
                renderEntry(e); saveCon();
                setTimeout(function () { if (e.watch && !e.watch.polls) finishEntry(e, true, 'เซิร์ฟเวอร์รับงานแล้วและทำต่อเบื้องหลัง (หน้านี้ไม่มีตัวติดตามความคืบหน้า)'); }, 20000);
                return;
              }
              finishEntry(e, !bad, bad ? ('เซิร์ฟเวอร์ตอบว่าไม่สำเร็จ' + (j.error ? ': ' + String(j.error).slice(0, 200) : j.reason ? ': ' + String(j.reason).slice(0, 200) : '')) : (j.message ? String(j.message).slice(0, 200) : 'เซิร์ฟเวอร์ตอบกลับสำเร็จ') + ' · ' + durTxt(e.ms));
            } else {
              e.out = clip(txt, 6000);
              finishEntry(e, r.ok, (r.ok ? 'ได้ผลตอบกลับ (ข้อความ)' : 'HTTP ' + r.status + (r.status === 404 ? ' — ไม่พบ endpoint นี้บนเซิร์ฟเวอร์' : '')) + ' · ' + durTxt(e.ms));
            }
          }), function () { finishEntry(e, r.ok, 'HTTP ' + r.status + ' · ' + durTxt(e.ms)); });
        }, function (err) {
          e.ms = Date.now() - e.t0;
          finishEntry(e, false, 'ส่งไม่ถึงเซิร์ฟเวอร์: ' + (err && err.message || err));
        });
      } catch (er) { if (window.console) console.warn('[DIUI] console', er); }
      return p;
    };
    wrapped.__diCon = true;
    window.fetch = wrapped;
  }
  D.console = {
    open: function (auto) {
      buildConsole(); CON.open = true; CON.unseen = 0;
      root.classList.add('di-con-open');
      var b = $('#di-con-body'); if (b) { b.__userScrolled = false; b.scrollTop = b.scrollHeight; }
      conCounts();
      if (!auto) { var c = $('#di-con-panel'); if (c) c.focus && c.focus(); }
    },
    close: function () { CON.open = false; root.classList.remove('di-con-open'); conCounts(); },
    toggle: function () { if (CON.open) D.console.close(); else D.console.open(); },
    entries: function () { return CON.entries; }
  };

  /* ------------------------------------------------------------ 10e. HUD — เอฟเฟกต์ไฮเทค (ปิดได้ = โหมดเรียบ)
     ทุกตัวเลขในส่วนนี้มาจากข้อมูลจริง: allDomains, เวลาโหลด /api/domains, /api/history
     ========================================================================== */
  var HUD = { lat: null, syncAt: null, hist: null, histAt: 0, titleSig: '', tickSig: '', nodeSig: '' };
  function fxOn() { return root.classList.contains('fx-hud'); }
  function syncFxBtn() {
    var b = $('#ab-fx'); if (!b) return;
    b.setAttribute('aria-pressed', fxOn() ? 'true' : 'false'); b.classList.toggle('on', fxOn());
    b.title = fxOn() ? 'เอฟเฟกต์ HUD: เปิดอยู่ — กดเพื่อสลับเป็นโหมดเรียบ' : 'โหมดเรียบ — กดเพื่อเปิดเอฟเฟกต์ HUD';
  }
  D.fx = {
    on: fxOn,
    toggle: function () {
      var on = root.classList.toggle('fx-hud');
      LS.set('di_fx', on ? 'on' : 'off');
      syncFxBtn(); trackPill(300);
      HUD.tickSig = ''; HUD.nodeSig = ''; renderTicker(); renderNodes();
      if (typeof window.toast === 'function') window.toast(on ? '✨ เปิดเอฟเฟกต์ HUD แล้ว' : 'โหมดเรียบ — ปิดเอฟเฟกต์ HUD แล้ว (ข้อมูลยังครบทุกอย่าง)', 'info');
    }
  };
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function msTxt(ms) { return ms == null ? '—' : ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's'; }
  function agoTxt(t) { var s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + ' วิที่แล้ว' : s < 3600 ? Math.floor(s / 60) + ' นาทีที่แล้ว' : Math.floor(s / 3600) + ' ชม.ที่แล้ว'; }
  function latLv(ms) { return ms == null ? '' : ms < 500 ? 'good' : ms < 1500 ? 'warn' : 'crit'; }
  function hudTick() {
    var d = new Date(), c = $('#ah-clock');
    if (c) c.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    var s = $('#ht-sync'); if (s && HUD.syncAt) s.textContent = agoTxt(HUD.syncAt);
  }
  function hudLat() {
    var e = $('#ah-lat'); if (e) { e.textContent = msTxt(HUD.lat); e.className = 'lv-' + latLv(HUD.lat); }
    var t = $('#ht-lat'); if (t) { t.innerHTML = esc(msTxt(HUD.lat)); t.className = 'ht-v lv-' + latLv(HUD.lat); }
  }
  /* ข้อความถอดรหัส (ตัวอักษรสุ่ม → ข้อความจริง) — เฉพาะโหมด HUD */
  var GLYPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+<>/=';
  function decode(elm, dur) {
    if (!elm || !fxOn() || reduced) return;
    var nodes = [], w = doc.createTreeWalker(elm, 4, null);
    while (w.nextNode()) if (w.currentNode.nodeValue.trim()) nodes.push(w.currentNode);
    if (!nodes.length) return;
    var fin = nodes.map(function (n) { return n.nodeValue; }), t0 = performance.now(); dur = dur || 560;
    elm.classList.add('hud-decoding');
    (function step(now) {
      var k = Math.min(1, ((now || performance.now()) - t0) / dur);
      nodes.forEach(function (n, i) {
        if (!n.parentNode) return;
        var f = fin[i], cut = Math.floor(f.length * k), s2 = f.slice(0, cut);
        for (var j = cut; j < f.length; j++) s2 += /\s/.test(f[j]) ? f[j] : GLYPH[(Math.random() * GLYPH.length) | 0];
        n.nodeValue = s2;
      });
      if (k < 1) raf(step);
      else { nodes.forEach(function (n, i) { n.nodeValue = fin[i]; }); elm.classList.remove('hud-decoding'); }
    })();
  }
  /* แถบค่าวัดใน hero */
  function renderTele() {
    var box = $('#hud-tele'); if (!box) return;
    var list = domainsList(); if (!list.length) return;
    var nodes = {}, rtSum = 0, rtN = 0, ssl = 0;
    list.forEach(function (d) {
      nodes[d.pleskServer || '-'] = 1;
      if (d.status !== 'down' && d.responseTime > 0) { rtSum += d.responseTime; rtN++; }
      if (d.sslDaysLeft != null && d.sslDaysLeft >= 0 && d.sslDaysLeft <= 30) ssl++;
    });
    var avg = rtN ? rtSum / rtN : null;
    var cells = [
      ['DOMAINS', list.length.toLocaleString(), 'โดเมนที่เฝ้าอยู่', ''],
      ['NODES', Object.keys(nodes).filter(function (k) { return k !== '-'; }).length || '—', 'เซิร์ฟเวอร์', ''],
      ['AVG.RESP', msTxt(avg), 'เวลาตอบเฉลี่ยของเว็บ', 'lv-' + latLv(avg)],
      ['SSL<30D', ssl, 'SSL ใกล้หมดอายุ', ssl ? 'lv-warn' : 'lv-good'],
      ['API.LAT', msTxt(HUD.lat), 'หน้าเว็บ ↔ เซิร์ฟเวอร์', 'lv-' + latLv(HUD.lat), 'ht-lat'],
      ['LAST.SYNC', HUD.syncAt ? agoTxt(HUD.syncAt) : '—', 'ดึงข้อมูลล่าสุด', '', 'ht-sync']
    ];
    var html = cells.map(function (c) {
      return '<div class="ht-cell"><span class="ht-k">' + c[0] + '</span><b class="ht-v ' + c[3] + '"' + (c[4] ? ' id="' + c[4] + '"' : '') + '>' + esc(String(c[1])) + '</b><span class="ht-d">' + esc(c[2]) + '</span></div>';
    }).join('');
    if (box.__html !== html) { box.__html = html; box.innerHTML = html; }
  }
  /* แถบข่าวสถานะโดเมนวิ่ง (LIVE) */
  function hashStr(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function renderTicker() {
    var tr = $('#tk-track'); if (!tr) return;
    var list = domainsList(); if (!list.length) return;
    var down = list.filter(function (d) { return d.status === 'down'; }).slice(0, 12);
    var warn = list.filter(function (d) { return d.status === 'warn'; }).slice(0, 8);
    var up = list.filter(function (d) { return d.status === 'up'; }).sort(function (a, b) { return hashStr(a.domain) - hashStr(b.domain); }).slice(0, Math.max(8, 34 - down.length - warn.length));
    var items = [];
    var mix = up.slice(); // แทรกตัวที่มีปัญหากระจายไปในรายการ
    down.concat(warn).forEach(function (d, i) { mix.splice(Math.min(mix.length, i * 2), 0, d); });
    mix.forEach(function (d) { items.push(d); });
    var sig = items.map(function (d) { return d.domain + d.status + (d.responseTime || 0) + (d.statusCode || ''); }).join('|');
    if (sig === HUD.tickSig) return; HUD.tickSig = sig;
    var G = { up: '▲', warn: '◆', down: '▼' };
    var one = items.map(function (d) {
      var st = d.status === 'up' || d.status === 'warn' || d.status === 'down' ? d.status : 'unk';
      return '<span class="tk-i s-' + st + '" data-dom="' + esc(d.domain) + '"><b>' + (G[st] || '○') + '</b>' + esc(d.domain) +
        (d.statusCode != null ? '<em>' + esc(String(d.statusCode || 'ERR')) + '</em>' : '') +
        '<u>' + (st === 'down' ? esc(String(d.error || 'DOWN').slice(0, 28)) : esc(msTxt(d.responseTime))) + '</u></span>';
    }).join('');
    tr.innerHTML = one + one;
    tr.style.setProperty('--tk-dur', Math.max(40, items.length * 3.2) + 's');
  }
  /* แผนที่โหนด: เรดาร์ (1 จุด = 1 โดเมน, ระยะ = เวลาตอบ) + ตารางสรุปต่อเซิร์ฟเวอร์ */
  function blipR(d, h) {
    var rt = d.responseTime || 0;
    if (d.status === 'down') return 131 + (h % 100) / 100 * 15;
    if (rt <= 500) return 10 + rt / 500 * 27;
    if (rt <= 1000) return 37.5 + (rt - 500) / 500 * 37.5;
    if (rt <= 3000) return 75 + (rt - 1000) / 2000 * 37.5;
    return 112.5 + Math.min(1, (rt - 3000) / 5000) * 15;
  }
  function renderNodes() {
    var box = $('#hud-nodes'); if (!box) return;
    var list = domainsList();
    if (!list.length) { if (D._statsSeen) box.innerHTML = '<div class="hn-empty">ยังไม่มีโดเมนในระบบ</div>'; return; }
    var sig = list.map(function (d) { return d.domain + d.status + (d.responseTime || 0) + (d.pleskServer || ''); }).join('|');
    if (sig === HUD.nodeSig && box.querySelector('svg')) return; HUD.nodeSig = sig;
    var groups = {};
    list.forEach(function (d) { var k = d.pleskServer || 'ไม่ระบุเซิร์ฟเวอร์'; (groups[k] = groups[k] || []).push(d); });
    var names = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b, 'th', { numeric: true }); });
    var S = 360, C = 180, R = 150, n = names.length, span = 360 / n;
    var COL = { up: 'var(--viz-good)', warn: 'var(--viz-warn)', down: 'var(--viz-crit)' };
    var g = '<g class="nm-grid">';
    [37.5, 75, 112.5, 150].forEach(function (r) { g += '<circle cx="' + C + '" cy="' + C + '" r="' + r + '"/>'; });
    g += '<line x1="' + (C - R) + '" y1="' + C + '" x2="' + (C + R) + '" y2="' + C + '"/><line x1="' + C + '" y1="' + (C - R) + '" x2="' + C + '" y2="' + (C + R) + '"/></g>';
    g += '<g class="nm-rl"><text x="' + (C + 3) + '" y="' + (C - 37.5 - 3) + '">0.5s</text><text x="' + (C + 3) + '" y="' + (C - 75 - 3) + '">1s</text><text x="' + (C + 3) + '" y="' + (C - 112.5 - 3) + '">3s</text><text x="' + (C + 3) + '" y="' + (C - 150 - 3) + '">ล่ม</text></g>';
    var sec = '<g class="nm-sec">', lab = '<g class="nm-lab">', dots = '<g class="nm-dots">';
    names.forEach(function (nm, i) {
      var a0 = i * span - 90, rad0 = a0 * Math.PI / 180, mid = (a0 + span / 2) * Math.PI / 180;
      if (n > 1) sec += '<line x1="' + C + '" y1="' + C + '" x2="' + (C + R * Math.cos(rad0)).toFixed(1) + '" y2="' + (C + R * Math.sin(rad0)).toFixed(1) + '"/>';
      var lx = C + (R + 16) * Math.cos(mid), ly = C + (R + 16) * Math.sin(mid);
      lab += '<text x="' + lx.toFixed(1) + '" y="' + (ly + 4).toFixed(1) + '" text-anchor="' + (Math.abs(Math.cos(mid)) < 0.3 ? 'middle' : Math.cos(mid) > 0 ? 'start' : 'end') + '">' + esc(nm) + '</text>';
      groups[nm].forEach(function (d) {
        var h = hashStr(d.domain), ang = (a0 + span * 0.07 + ((h % 1000) / 1000) * span * 0.86) * Math.PI / 180;
        var r = blipR(d, h >>> 10), x = C + r * Math.cos(ang), y = C + r * Math.sin(ang);
        var st = COL[d.status] ? d.status : 'unk';
        dots += '<g class="blip s-' + st + '" data-dom="' + esc(d.domain) + '" data-srv="' + esc(nm) + '" data-rt="' + (d.responseTime || 0) + '" data-st="' + st + '" data-code="' + esc(String(d.statusCode == null ? '' : d.statusCode)) + '">' +
          (st === 'down' ? '<circle class="bp" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4"/>' : '') +
          '<circle class="bd" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (st === 'down' ? 3.8 : 3.2) + '"/>' +
          '<circle class="bh" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="8"/></g>';
      });
    });
    sec += '</g>'; lab += '</g>'; dots += '</g>';
    var radar = '<div class="nm-radar hud-panel"><div class="nm-stage"><div class="nm-sweep" aria-hidden="true"></div>' +
      '<svg viewBox="-24 -8 ' + (S + 48) + ' ' + (S + 16) + '" role="img" aria-label="เรดาร์สถานะโดเมนแยกตามเซิร์ฟเวอร์">' + g + sec + dots + lab + '</svg></div>' +
      '<div class="nm-legend"><span><i style="background:var(--viz-good)"></i>ออนไลน์</span><span><i style="background:var(--viz-warn)"></i>ช้า / มีปัญหา</span><span><i style="background:var(--viz-crit)"></i>ล่ม</span><span class="nm-note">ระยะจากศูนย์กลาง = เวลาตอบสนอง</span></div>' +
      '<div class="di-tip nm-tip"></div></div>';
    // ตารางสรุปต่อเซิร์ฟเวอร์
    var rows = names.map(function (nm) {
      var ds = groups[nm], up = 0, wa = 0, dn = 0, sum = 0, cnt = 0;
      ds.forEach(function (d) { if (d.status === 'up') up++; else if (d.status === 'warn') wa++; else if (d.status === 'down') dn++; if (d.status !== 'down' && d.responseTime > 0) { sum += d.responseTime; cnt++; } });
      var tot = ds.length, pct = tot ? up / tot * 100 : 0, avg = cnt ? sum / cnt : null;
      var lv = dn ? 'crit' : wa ? 'warn' : 'good';
      return '<button type="button" class="nb-row lv-' + lv + '" data-run="showPage(\'server-manager\')">' +
        '<span class="nb-name"><i class="nb-dot"></i><b>' + esc(nm) + '</b><span>' + tot + ' เว็บ</span></span>' +
        '<span class="nb-bar" role="img" aria-label="ออนไลน์ ' + up + ' ช้า ' + wa + ' ล่ม ' + dn + '">' +
          (up ? '<i style="flex-grow:' + up + ';background:var(--viz-good)"></i>' : '') + (wa ? '<i style="flex-grow:' + wa + ';background:var(--viz-warn)"></i>' : '') + (dn ? '<i style="flex-grow:' + dn + ';background:var(--viz-crit)"></i>' : '') + '</span>' +
        '<span class="nb-stats"><span>ออนไลน์ <b>' + up + '</b></span><span>ช้า <b>' + wa + '</b></span><span>ล่ม <b>' + dn + '</b></span></span>' +
        '<span class="nb-met"><span class="k">UPTIME</span><b class="lv-' + (pct >= 95 ? 'good' : pct >= 80 ? 'warn' : 'crit') + '">' + pct.toFixed(1) + '%</b></span>' +
        '<span class="nb-met"><span class="k">AVG</span><b class="lv-' + latLv(avg) + '">' + msTxt(avg) + '</b></span></button>';
    }).join('');
    // การกระจายเวลาตอบสนอง (ตรงกับวงบนเรดาร์)
    var bands = [['< 0.5s', 0, 500], ['0.5–1s', 500, 1000], ['1–3s', 1000, 3000], ['> 3s', 3000, 1e12]].map(function (b) { return { k: b[0], n: 0, lo: b[1], hi: b[2] }; });
    var dn = 0;
    list.forEach(function (d) {
      if (d.status === 'down') { dn++; return; }
      var rt = d.responseTime || 0;
      for (var i = 0; i < bands.length; i++) if (rt >= bands[i].lo && rt < bands[i].hi) { bands[i].n++; break; }
    });
    bands.push({ k: 'ล่ม', n: dn, down: true });
    var mx = Math.max.apply(null, bands.map(function (b) { return b.n; }).concat([1]));
    var dist = '<div class="nb-dist"><div class="nb-dist-h"><span class="ht-k">LATENCY</span><b>การกระจายเวลาตอบสนอง</b><span>ทั้งหมด ' + list.length + ' เว็บ</span></div>' +
      bands.map(function (b) {
        return '<div class="nd-row' + (b.down ? ' nd-down' : '') + '"><span class="nd-k">' + esc(b.k) + '</span><span class="nd-bar"><i style="width:' + (b.n / mx * 100).toFixed(1) + '%"></i></span>' +
          '<span class="nd-v"><b>' + b.n + '</b> · ' + (b.n / list.length * 100).toFixed(0) + '%</span></div>';
      }).join('') + '</div>';
    var board = '<div class="nm-board hud-panel"><div class="nb-head"><span class="ht-k">NODES</span><b>' + names.length + ' เซิร์ฟเวอร์</b><span class="nb-sub">กดแถวเพื่อเปิด Server Manager</span></div>' + rows + dist + '</div>';
    box.innerHTML = radar + board;
  }
  function bindNodes() {
    var box = $('#hud-nodes'); if (!box || box.__bound) return; box.__bound = true;
    var TXT = { up: 'ออนไลน์', warn: 'ช้า / มีปัญหา', down: 'ล่ม', unk: 'ไม่ทราบสถานะ' };
    box.addEventListener('pointerover', function (e) {
      var b = e.target.closest && e.target.closest('.blip'); var tip = $('.nm-tip', box); if (!tip) return;
      if (!b) { tip.classList.remove('on'); return; }
      var st = b.getAttribute('data-st');
      tip.innerHTML = '<div class="tt-h">' + esc(b.getAttribute('data-srv')) + '</div><div class="tt-r" style="font-family:var(--mono);color:var(--text);font-weight:600">' + esc(b.getAttribute('data-dom')) + '</div>' +
        '<div class="tt-r"><i style="background:' + (st === 'up' ? 'var(--viz-good)' : st === 'warn' ? 'var(--viz-warn)' : st === 'down' ? 'var(--viz-crit)' : 'var(--text3)') + ';height:8px;width:8px;border-radius:50%"></i><span>' + TXT[st] + (b.getAttribute('data-code') ? ' · ' + esc(b.getAttribute('data-code')) : '') + (st !== 'down' ? ' · ' + esc(msTxt(+b.getAttribute('data-rt'))) : '') + '</span></div>';
      var r = box.querySelector('.nm-radar').getBoundingClientRect(), br = b.getBoundingClientRect();
      tip.style.left = Math.min(r.width - 190, Math.max(6, br.left - r.left + 14)) + 'px';
      tip.style.top = Math.max(6, br.top - r.top - 10) + 'px';
      tip.classList.add('on');
    });
    box.addEventListener('pointerleave', function () { var tip = $('.nm-tip', box); if (tip) tip.classList.remove('on'); });
    box.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('.blip'); if (b) D.findDomain(b.getAttribute('data-dom')); });
  }
  /* sparkline แนวโน้มบนการ์ด "ต้องดูตอนนี้" (จาก /api/history) */
  function refreshHist() {
    if (Date.now() - HUD.histAt < 300000) return;
    HUD.histAt = Date.now();
    getJSON('/api/history').then(function (j) {
      var h = j && (j.history || (j.data && j.data.history));
      if (Array.isArray(h) && h.length > 2) { HUD.hist = h.slice(-24); D.renderHub(); }
    });
  }
  function sparkSVG(key) {
    var h = HUD.hist; if (!h) return '';
    var vals = h.map(function (p) { return +p[key] || 0; }), max = Math.max.apply(null, vals.concat([1]));
    var pts = vals.map(function (v, i) { return (i / (vals.length - 1) * 100).toFixed(1) + ',' + (26 - v / max * 22).toFixed(1); }).join(' ');
    return '<svg class="hn-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts + '"/></svg>';
  }

  /* ------------------------------------------------------------ 11. LOGIN */
  function initLogin() {
    var pass = $('#login-pass'), eye = $('#lg-eye'), caps = $('#lg-caps');
    if (eye && pass) eye.addEventListener('click', function () {
      var show = pass.type === 'password'; pass.type = show ? 'text' : 'password';
      eye.innerHTML = '<i class="ti ' + (show ? 'ti-eye-off' : 'ti-eye') + '"></i>'; pass.focus();
    });
    if (pass && caps) ['keydown', 'keyup'].forEach(function (ev) {
      pass.addEventListener(ev, function (e) { if (e.getModifierState) caps.classList.toggle('on', e.getModifierState('CapsLock')); });
    });
    var orig = window.doLogin;
    if (typeof orig === 'function' && !orig.__diWrapped) {
      var w = function () {
        var btn = $('#lg-submit'), card = $('#lg-card');
        if (btn) btn.classList.add('is-loading');
        return Promise.resolve(orig.apply(this, arguments)).finally(function () {
          if (btn) btn.classList.remove('is-loading');
          var err = $('#login-error');
          if (card && err && err.style.display === 'block' && !reduced) { card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); }
        });
      };
      w.__diWrapped = true; window.doLogin = w;
    }
  }

  /* ------------------------------------------------------------ 12. BOOT */
  function welcomeOnce() {
    if (LS.get('di_v32_welcome', '') === '1') return;
    LS.set('di_v32_welcome', '1');
    setTimeout(function () {
      if (typeof window.toast === 'function') window.toast('✨ <b>DomainIntel โฉมใหม่</b> — หน้า <b>ศูนย์รวม</b> รวมทุกเครื่องมือพร้อมป้ายบอกว่าใช้ได้จริงไหม · กด <kbd>' + (isMac ? '⌘K' : 'Ctrl K') + '</kbd> ค้นหาได้ทุกหน้า · ปุ่ม <b>คอนโซล</b> มุมขวาล่างโชว์คำสั่งที่ส่งไปเซิร์ฟเวอร์จริง · ปุ่ม ✨ บนขวาเปิด/ปิดเอฟเฟกต์ HUD', 'info');
    }, 1400);
  }
  function onAppShown() {
    var u = $('#logged-user'), av = $('#sb-avatar');
    if (u && av) av.textContent = (u.textContent || 'A').trim().charAt(0).toUpperCase() || 'A';
    buildConsole(); root.classList.add('di-con-on');
    var p = currentPage();
    if (p) onNav(p.id);
    D.renderHero();
    setTimeout(function () { refreshLive(true); }, 900);
    welcomeOnce();
  }

  function boot() {
    installToast();
    installProgress();
    installConsole();
    initLogin();
    initGroups();
    syncThemeMeta();

    if (isMac) $$('kbd').forEach(function (k) { if (k.textContent === 'Ctrl K') k.textContent = '⌘K'; });
    // HUD: ปุ่ม ✨ + นาฬิกา
    syncFxBtn(); hudTick(); setInterval(hudTick, 1000);

    // ห่อฟังก์ชันเดิม
    after('showPage', function (name) { onNav('page-' + name); });
    after('showPageFiltered', function (pg) { onNav('page-' + pg); });
    after('updateStats', function () { D._statsSeen = true; D.renderHero(); D.renderHub(); });
    after('renderCommandCenter', function () { D._ccAt = Date.now(); D.renderHub(); });
    if (typeof window.drawChart === 'function') window.drawChart = drawChartV3;

    // จัดหน้าที่มีอยู่แล้ว (หัว + ปุ่ม) ทันที
    pageEls().forEach(normalizePage);

    // ปุ่ม/คีย์ลัด
    doc.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('[data-open-palette]')) { e.preventDefault(); D.openPalette(); return; }
      var gt = t.closest('[data-group-toggle]'); if (gt) { toggleGroup(gt.getAttribute('data-group-toggle')); return; }
      var to = t.closest('[data-tool-open]'); if (to) { D.openTool(to.getAttribute('data-tool-open')); return; }
      var hr = t.closest('#page-hub [data-run]'); if (hr) { runStr(hr.getAttribute('data-run')); return; }
      var pq = t.closest('[data-pal-q]'); if (pq) { D.openPalette(pq.getAttribute('data-pal-q')); return; }
      var it2 = t.closest('[data-info-toggle]'); if (it2) { toggleInfo(it2.getAttribute('data-info-toggle')); return; }
      if (t.closest('.hub-q')) { e.preventDefault(); var hv = $('#hub-q'); D.openPalette(hv ? hv.value : ''); if (hv) hv.value = ''; return; }
      if (t.closest('#ab-theme')) { D.toggleTheme(t.closest('#ab-theme')); return; }
      if (t.closest('#ab-fx')) { D.fx.toggle(); return; }
      var tk = t.closest('#tk-track [data-dom]'); if (tk) { D.findDomain(tk.getAttribute('data-dom')); return; }
      if (t.closest('#sb-mini-btn')) { D.toggleMini(); return; }
      if (!t.closest('.di-more')) closeMenus();
      if (t.closest('#main-nav .nav-item') && innerWidth <= 900 && typeof window.closeSidebar === 'function') window.closeSidebar();
    });
    var navEl = $('#main-nav');
    if (navEl) navEl.addEventListener('keydown', function (e) {
      var it = e.target.closest && e.target.closest('.nav-item');
      if (it && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); it.click(); }
    });
    doc.addEventListener('keydown', function (e) {
      var k = e.key, typing = /INPUT|TEXTAREA|SELECT/.test((e.target.tagName || '')) || e.target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && (k === 'k' || k === 'K')) { e.preventDefault(); if (pal && pal.classList.contains('open')) D.closePalette(); else D.openPalette(); return; }
      if (k === 'Escape') {
        closeMenus();
        if (pal && pal.classList.contains('open')) D.closePalette();
        else if (CON.open && !$('.modal-overlay.open, .modal-overlay[style*="flex"]')) D.console.close();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (k === '/') { e.preventDefault(); D.openPalette(); }
      else if (k === '`') { e.preventDefault(); D.console.toggle(); }
      else if (k === '[' && innerWidth > 900) { D.toggleMini(); }
    });

    // แสงตามเมาส์บนการ์ด (spotlight)
    if (!reduced && window.matchMedia && matchMedia('(hover: hover)').matches) {
      var spotEl = null, spotEv = null, spotPend = false;
      doc.addEventListener('pointermove', function (e) {
        spotEv = e; if (spotPend) return; spotPend = true;
        raf(function () {
          spotPend = false;
          var c = spotEv.target && spotEv.target.closest && spotEv.target.closest('.metric-card, .settings-section, .ov-server-card, .di-hero, .lg-card');
          if (spotEl && spotEl !== c) spotEl.classList.remove('spot');
          spotEl = c; if (!c) return;
          var r = c.getBoundingClientRect();
          c.style.setProperty('--mx', (spotEv.clientX - r.left) + 'px'); c.style.setProperty('--my', (spotEv.clientY - r.top) + 'px');
          c.classList.add('spot');
        });
      }, { passive: true });
    }

    // appbar เงาเมื่อเลื่อน
    var main = $('#di-main'), bar = $('#appbar');
    if (main && bar) main.addEventListener('scroll', function () { bar.classList.toggle('scrolled', main.scrollTop > 4); }, { passive: true });

    // badge เปลี่ยน → จุดแจ้งเตือนกลุ่ม + กระดิ่ง
    var nav = $('#main-nav');
    if (nav && window.MutationObserver) {
      var pend = false;
      new MutationObserver(function () { if (pend) return; pend = true; raf(function () { pend = false; updateGroupAlerts(); }); })
        .observe(nav, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] });
    }
    updateGroupAlerts();
    window.addEventListener('resize', function () { placePill(true); });

    watchMain();

    // ช่องค้นหากลางบนหน้าศูนย์รวม → ส่งต่อให้ palette (ค้นได้ทั้งโดเมน/เครื่องมือ/คำสั่ง)
    var hq = $('#hub-q');
    if (hq) hq.addEventListener('input', function () { var v = hq.value; hq.value = ''; D.openPalette(v); });

    // splash + รอหน้า login/แอปแสดง
    var lp = $('#login-page'), ma = $('#main-app');
    var check = function () {
      if (shown(lp) || shown(ma)) hideSplash();
      if (shown(ma) && !ma.__diShown) { ma.__diShown = true; setTimeout(safe(onAppShown), 30); }
      if (!shown(ma)) ma.__diShown = false;
      if (shown(lp)) { var pw = $('#login-pass'); if (pw && doc.activeElement !== pw) setTimeout(function () { pw.focus(); }, 120); }
    };
    if (window.MutationObserver) [lp, ma].forEach(function (e) { if (e) new MutationObserver(check).observe(e, { attributes: true, attributeFilter: ['style'] }); });
    check();
    setTimeout(hideSplash, 7000);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', safe(boot)); else safe(boot)();
})();
