/* Truman Admin — dashboard app (no frameworks, no build step) */
(function () {
  'use strict';

  // ---------------------------------------------------------------- state & helpers
  var S = { me: null, perms: [], statuses: {}, permissions: [], presets: {}, system: {}, counts: {} };
  var app = document.getElementById('app');
  var TZ = 'Africa/Cairo';

  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(sel, el) { return (el || document).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  function can(p) { return S.perms.indexOf(p) >= 0; }
  function isOwner() { return S.me && S.me.role === 'owner'; }
  function money(c, cur) { return (cur || S.system.currency || 'EGP') + ' ' + (Number(c || 0) / 100).toLocaleString('en-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function moneyShort(c) { var v = Number(c || 0) / 100; return 'EGP ' + (v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e4 ? Math.round(v / 1e3) + 'k' : v.toLocaleString('en-EG', { maximumFractionDigits: 0 })); }
  var dFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
  var dtFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  var isoFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  function fdate(t) { return t ? dFmt.format(new Date(t)) : ''; }
  function fdt(t) { return t ? dtFmt.format(new Date(t)) : ''; }
  function isoDay(t) { return isoFmt.format(new Date(t)); }
  function ago(t) {
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago';
  }
  function toCents(v) { var n = parseFloat(String(v).replace(/[^0-9.]/g, '')); return isFinite(n) ? Math.round(n * 100) : NaN; }
  function fromCents(c) { return c == null ? '' : (c / 100).toFixed(2).replace(/\.00$/, ''); }
  function chip(st) { return '<span class="chip ' + h(st) + '">' + h(S.statuses[st] || st) + '</span>'; }
  function debounce(fn, ms) { var t; return function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); }; }

  var ICON = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    orders: '<path d="M6 2h12l2 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6z"/><path d="M4 6h16M9 10h6"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 8M22 21a6 6 0 0 0-4-5.6"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.7 4.4V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    download: '<path d="M12 3v12m0 0-4-4m4 4 4-4M4 21h16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    print: '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    back: '<path d="m15 18-6-6 6-6"/>'
  };
  function icon(n) { return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[n] + '</svg>'; }

  // ---------------------------------------------------------------- API
  function api(method, path, body) {
    var opts = { method: method, headers: { 'X-Admin': '1' }, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/api/admin' + path, opts).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'Unexpected response from the server.' }; }).then(function (j) {
        if (!r.ok) {
          var e = new Error(j.error || ('Error ' + r.status)); e.status = r.status; e.code = j.code;
          if (e.code === 'signin' && S.me) { S.me = null; boot(); }
          else if (e.code === 'totp' && S.me) { S.me = null; screenTotp(); }
          else if (e.code === 'password' && S.me) { S.me.must_change_pw = true; screenPassword(true); }
          throw e;
        }
        return j;
      });
    }, function () { throw new Error('Cannot reach the server. Check your connection.'); });
  }

  var toastT;
  function toast(msg, bad) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.className = 'on' + (bad ? ' bad' : '');
    clearTimeout(toastT); toastT = setTimeout(function () { t.className = ''; }, bad ? 5000 : 2600);
  }
  function fail(e) { if (e && e.code !== 'signin' && e.code !== 'totp' && e.code !== 'password') toast(e.message || String(e), true); }

  // ---------------------------------------------------------------- modal
  function modal(o) {
    var root = document.getElementById('modal-root');
    var back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = '<div class="modal' + (o.wide ? ' wide' : '') + '" role="dialog" aria-modal="true" aria-labelledby="mh">' +
      '<div class="modal-h"><h2 id="mh">' + h(o.title) + '</h2><button class="x" aria-label="Close">×</button></div>' +
      '<div class="modal-b">' + (o.body || '') + '<div class="err" data-err></div></div>' +
      '<div class="modal-f"></div></div>';
    var foot = $('.modal-f', back);
    var m = { el: back, close: function () { back.remove(); document.removeEventListener('keydown', onKey); },
              error: function (msg) { $('[data-err]', back).textContent = msg || ''; } };
    (o.actions || [{ label: 'Close', cls: '' }]).forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'btn ' + (a.cls || ''); b.textContent = a.label; b.type = 'button';
      b.onclick = function () {
        if (!a.onClick) return m.close();
        m.error('');
        var r = a.onClick(m, b);
        if (r && r.then) { b.disabled = true; r.then(function (keep) { b.disabled = false; if (keep !== true) m.close(); },
                                                 function (e) { b.disabled = false; m.error(e.message || String(e)); }); }
      };
      foot.appendChild(b);
    });
    function onKey(e) { if (e.key === 'Escape') m.close(); }
    document.addEventListener('keydown', onKey);
    $('.x', back).onclick = m.close;
    back.addEventListener('mousedown', function (e) { if (e.target === back) m.close(); });
    root.appendChild(back);
    if (o.onMount) o.onMount(m, back);
    var first = $('input:not([type=checkbox]),select,textarea', back); if (first) first.focus();
    return m;
  }
  function confirmBox(title, text, label, cls) {
    return new Promise(function (resolve) {
      modal({ title: title, body: '<p>' + text + '</p>', actions: [
        { label: 'Cancel', onClick: function (m) { m.close(); resolve(false); } },
        { label: label || 'Confirm', cls: cls || 'primary', onClick: function (m) { m.close(); resolve(true); } }] });
    });
  }
  function val(root, name) { var el = $('[name="' + name + '"]', root); return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; }

  // ---------------------------------------------------------------- sign-in screens
  function authShell(inner) {
    app.innerHTML = '<div class="auth"><form class="auth-card" novalidate><span class="brand-word">TRUMAN<i>.</i></span>' + inner + '</form></div>';
    return $('form', app);
  }
  function screenLogin(msg) {
    var f = authShell('<h1>Sign in</h1><p class="lead">Truman shop administration</p>' +
      '<div class="field"><label for="em">Email</label><input class="input" id="em" name="email" type="email" autocomplete="username" required></div>' +
      '<div class="field"><label for="pw">Password</label><input class="input" id="pw" name="password" type="password" autocomplete="current-password" required></div>' +
      '<div class="err">' + h(msg || '') + '</div><button class="btn primary" type="submit">Sign in</button>');
    $('#em', f).focus();
    f.onsubmit = function (e) {
      e.preventDefault();
      var btn = $('button', f); btn.disabled = true;
      api('POST', '/login', { email: val(f, 'email'), password: val(f, 'password') }).then(function (r) {
        if (r.need_totp) screenTotp(); else boot();
      }).catch(function (err) { btn.disabled = false; $('.err', f).textContent = err.message; });
    };
  }
  function screenTotp() {
    var f = authShell('<h1>Two-step sign-in</h1><p class="lead">Enter the 6-digit code from your authenticator app.</p>' +
      '<div class="field"><input class="input code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" aria-label="Authenticator code"></div>' +
      '<div class="err"></div><button class="btn primary" type="submit">Continue</button>' +
      '<p class="small muted" style="margin:14px 0 0">Lost your phone? Ask the owner to reset two-step sign-in for your account.</p>' +
      '<button type="button" class="btn ghost sm" data-cancel style="margin-top:6px">Use a different account</button>');
    var inp = $('input', f); inp.focus();
    inp.oninput = function () { inp.value = inp.value.replace(/\D/g, '').slice(0, 6); if (inp.value.length === 6) f.requestSubmit(); };
    $('[data-cancel]', f).onclick = function () { api('POST', '/logout').finally(function () { screenLogin(); }); };
    f.onsubmit = function (e) {
      e.preventDefault();
      api('POST', '/login/totp', { code: inp.value }).then(boot).catch(function (err) {
        $('.err', f).textContent = err.message; inp.value = ''; inp.focus();
        if (err.code === 'signin') setTimeout(function () { screenLogin(err.message); }, 1200);
      });
    };
  }
  function screenPassword(forced) {
    var f = authShell('<h1>Choose a new password</h1><p class="lead">' + (forced ? 'Before you continue, replace the temporary password you were given.' : '') + '</p>' +
      '<div class="field"><label>Current (temporary) password</label><input class="input" name="current" type="password" autocomplete="current-password"></div>' +
      '<div class="field"><label>New password</label><input class="input" name="password" type="password" autocomplete="new-password"><div class="hint">At least 10 characters. A short sentence works well.</div></div>' +
      '<div class="field"><label>Repeat new password</label><input class="input" name="again" type="password" autocomplete="new-password"></div>' +
      '<div class="err"></div><button class="btn primary" type="submit">Save and continue</button>' +
      '<button type="button" class="btn ghost sm" data-out style="margin-top:8px">Sign out</button>');
    $('[data-out]', f).onclick = logout;
    f.onsubmit = function (e) {
      e.preventDefault();
      if (val(f, 'password') !== val(f, 'again')) { $('.err', f).textContent = 'The two new passwords do not match.'; return; }
      api('POST', '/me/password', { current: val(f, 'current'), password: val(f, 'password') })
        .then(function () { toast('Password changed'); boot(); })
        .catch(function (err) { $('.err', f).textContent = err.message; });
    };
  }
  function logout() { api('POST', '/logout').catch(function () {}).then(function () { S.me = null; location.hash = ''; screenLogin(); }); }

  // ---------------------------------------------------------------- shell + router
  var NAV = [
    { id: 'overview', label: 'Overview', icon: 'home', show: function () { return true; } },
    { id: 'orders', label: 'Orders', icon: 'orders', show: function () { return can('orders.view'); }, count: 'action' },
    { id: 'products', label: 'Products & stock', icon: 'box', show: function () { return can('products.edit') || can('stock.edit'); }, count: 'low' },
    { id: 'enquiries', label: 'Enquiries', icon: 'mail', show: function () { return can('enquiries.view'); }, count: 'enq' },
    { id: 'reports', label: 'Reports', icon: 'chart', show: function () { return can('reports.view'); } },
    { sep: true },
    { id: 'staff', label: 'Staff', icon: 'users', show: function () { return can('users.manage'); } },
    { id: 'activity', label: 'Activity log', icon: 'list', show: function () { return can('audit.view'); } },
    { id: 'settings', label: 'Settings', icon: 'gear', show: function () { return can('settings.edit'); } },
    { id: 'account', label: 'My account', icon: 'user', show: function () { return true; } }
  ];
  function shell() {
    if ($('.shell', app)) return;
    app.innerHTML =
      '<div class="topbar"><button data-menu aria-label="Menu">' + icon('menu') + '</button><span class="brand-word">TRUMAN<i>.</i></span><span style="width:26px"></span></div>' +
      '<div class="shell"><aside class="side"><div class="brand"><span class="brand-word">TRUMAN<i>.</i></span><small>Shop admin</small></div>' +
      '<nav class="nav"></nav><div class="me"><b></b><button data-logout>Sign out</button></div></aside>' +
      '<main class="main" id="view"></main></div>';
    $('[data-logout]', app).onclick = logout;
    $('[data-menu]', app).onclick = function () { $('.side', app).classList.toggle('open'); };
    $('.side', app).addEventListener('click', function (e) { if (e.target.closest('a')) $('.side', app).classList.remove('open'); });
    $('.me b', app).textContent = (S.me.name || S.me.email) + (isOwner() ? ' · Owner' : '');
    $('.me b', app).title = S.me.email;
    renderNav();
  }
  function renderNav() {
    var cur = (location.hash.replace(/^#\//, '').split(/[\/?]/)[0]) || 'overview';
    if (cur === 'order') cur = 'orders';
    var nav = $('.nav', app); if (!nav) return;
    nav.innerHTML = NAV.filter(function (n) { return n.sep || n.show(); }).map(function (n) {
      if (n.sep) return '<div class="sep"></div>';
      var c = n.count && S.counts[n.count] ? '<span class="count">' + S.counts[n.count] + '</span>' : '';
      return '<a href="#/' + n.id + '" class="' + (cur === n.id ? 'on' : '') + '">' + icon(n.icon) + '<span>' + h(n.label) + '</span>' + c + '</a>';
    }).join('');
  }
  function refreshCounts() {
    return api('GET', '/overview').then(function (o) {
      var sc = o.status_counts || {};
      S.counts.action = (sc.paid || 0) + (sc.processing || 0);
      S.counts.low = (o.low_stock || []).length;
      S.counts.enq = o.new_enquiries || 0;
      renderNav();
      return o;
    });
  }

  function route() {
    if (!S.me) return;
    shell();
    renderNav();
    var parts = location.hash.replace(/^#\//, '').split('?')[0].split('/');
    var page = parts[0] || 'overview';
    var view = document.getElementById('view');
    view.innerHTML = '<div class="empty">Loading…</div>';
    window.scrollTo(0, 0);
    var fn = VIEWS[page] || VIEWS.overview;
    var item = NAV.filter(function (n) { return n.id === page; })[0];
    if (item && !item.show()) fn = VIEWS.overview;
    Promise.resolve(fn(view, parts.slice(1).map(decodeURIComponent))).catch(function (e) {
      if (e && (e.code === 'signin' || e.code === 'totp' || e.code === 'password')) return;
      view.innerHTML = '<div class="banner bad">' + h(e.message || e) + '</div>';
    });
  }
  window.addEventListener('hashchange', route);

  function head(title, sub, actions) {
    return '<div class="page-head"><div><h1>' + h(title) + '</h1>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>' +
           (actions ? '<div class="row">' + actions + '</div>' : '') + '</div>';
  }
  function systemBanners() {
    var out = '';
    if (S.system.storage_warning) out += '<div class="banner bad"><b>Data will be lost on the next deploy.</b>&nbsp;' + h(S.system.storage_warning) + '</div>';
    if (!S.system.payments_live) out += '<div class="banner warn"><b>Demo mode.</b>&nbsp;Paymob keys are not set, so the shop takes test orders and no money moves.</div>';
    if (!S.system.mail) out += '<div class="banner info"><b>Email is not set up.</b>&nbsp;Order and customer emails are only written to the server log until SMTP is configured.</div>';
    if (isOwner() && !S.me.totp_enabled) out += '<div class="banner info">Protect the owner account: <a href="#/account">turn on two-step sign-in</a>.</div>';
    return out;
  }

  // ---------------------------------------------------------------- charts
  function barChart(points, valueKey) {
    var W = 720, H = 180, pad = { l: 46, r: 6, t: 8, b: 22 };
    var max = Math.max.apply(null, points.map(function (p) { return p[valueKey]; }).concat([1]));
    var step = niceStep(max), top = Math.ceil(max / step) * step || 1;
    var bw = (W - pad.l - pad.r) / points.length;
    var out = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Sales by day">';
    for (var g = 0; g <= top; g += step) {
      var y = pad.t + (H - pad.t - pad.b) * (1 - g / top);
      out += '<line class="grid" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + y + '" y2="' + y + '"/>' +
             '<text class="axis" x="' + (pad.l - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + h(moneyShort(g).replace('EGP ', '')) + '</text>';
    }
    points.forEach(function (p, i) {
      var v = p[valueKey], bh = (H - pad.t - pad.b) * (v / top), x = pad.l + i * bw + bw * 0.15;
      out += '<rect class="bar" x="' + x + '" y="' + (H - pad.b - bh) + '" width="' + (bw * 0.7) + '" height="' + Math.max(bh, v ? 1 : 0) + '" rx="2"><title>' +
             h(fdate(Date.parse(p.d + 'T12:00:00Z')) + ': ' + money(v) + (p.orders != null ? ' · ' + p.orders + ' orders' : '')) + '</title></rect>';
      var every = Math.ceil(points.length / 8);
      if (points.length <= 31 && (i % every === 0 || (i === points.length - 1 && i % every >= every / 2)))
        out += '<text class="axis" x="' + (x + bw * 0.35) + '" y="' + (H - 6) + '" text-anchor="middle">' + h(p.d.slice(8) + '/' + p.d.slice(5, 7)) + '</text>';
    });
    return out + '</svg>';
  }
  function niceStep(max) { var raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw || 1))), n = raw / mag; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag; }
  function barList(rows, fmt) {
    var max = Math.max.apply(null, rows.map(function (r) { return r[1]; }).concat([1]));
    return '<div class="bars-list">' + rows.map(function (r) {
      return '<div class="r"><span>' + h(r[0]) + '</span><b>' + h(fmt ? fmt(r[1]) : r[1]) + '</b><div class="track"><div class="fill" style="width:' + (100 * r[1] / max).toFixed(1) + '%"></div></div></div>';
    }).join('') + '</div>';
  }

  // ================================================================= VIEWS
  var VIEWS = {};

  // ---- Overview ------------------------------------------------------------
  VIEWS.overview = function (v) {
    return refreshCounts().then(function (o) {
      var sc = o.status_counts || {};
      var html = head('Good ' + greeting() + ', ' + (S.me.name || '').split(' ')[0], fdate(Date.now())) + systemBanners();
      if (o.sales) {
        html += '<div class="grid g4" style="margin-bottom:16px">' +
          kpi('Today', money(o.sales.today.revenue_cents), o.sales.today.orders + ' paid order' + (o.sales.today.orders === 1 ? '' : 's')) +
          kpi('Last 7 days', money(o.sales.week.revenue_cents), o.sales.week.orders + ' orders') +
          kpi('Last 30 days', money(o.sales.month.revenue_cents), o.sales.month.orders + ' orders') +
          kpi('Average order (30 d)', money(o.sales.month.orders ? o.sales.month.revenue_cents / o.sales.month.orders : 0), 'net of refunds') + '</div>';
      }
      if (sc) {
        html += '<div class="grid g4" style="margin-bottom:16px">' +
          kpi('To prepare', sc.paid || 0, 'paid, not started', '#/orders?status=paid', (sc.paid || 0) > 0) +
          kpi('Preparing', sc.processing || 0, 'ready to ship', '#/orders?status=processing') +
          kpi('Out for delivery', sc.shipped || 0, 'shipped, not delivered', '#/orders?status=shipped') +
          (o.new_enquiries != null ? kpi('New enquiries', o.new_enquiries, 'from the contact form', '#/enquiries', o.new_enquiries > 0)
                                   : kpi('Delivered', sc.delivered || 0, 'all time', '#/orders?status=delivered')) + '</div>';
      }
      html += '<div class="split">';
      html += '<div class="stack">';
      if (o.sales) html += '<div class="card"><div class="card-h"><h2>Sales, last 30 days</h2>' + (o.demo_mode ? '<span class="tag demo">includes test orders</span>' : '') + '</div><div class="card-b">' + barChart(o.sales.by_day, 'c') + '</div></div>';
      if (o.recent) {
        html += '<div class="card"><div class="card-h"><h2>Waiting to be sent</h2><a href="#/orders?status=action" class="small">All orders →</a></div>' +
          (o.recent.length ? '<div class="table-wrap"><table class="t"><tbody>' + o.recent.map(orderRow).join('') + '</tbody></table></div>'
                           : '<div class="empty">Nothing waiting. Paid orders appear here until they are shipped.</div>') + '</div>';
      }
      html += '</div><div class="stack">';
      if (o.low_stock) {
        html += '<div class="card"><div class="card-h"><h2>Low stock</h2><a href="#/products" class="small">Products →</a></div>' +
          (o.low_stock.length ? '<table class="t"><tbody>' + o.low_stock.map(function (p) {
            return '<tr class="click" data-go="#/products?q=' + encodeURIComponent(p.sku) + '"><td><span class="sku">' + h(p.sku) + '</span><div class="small">' + h(p.name_en) + '</div></td><td class="num"><b' + (p.stock_qty <= 0 ? ' style="color:var(--red)"' : '') + '>' + p.stock_qty + '</b> left</td></tr>';
          }).join('') + '</tbody></table>' : '<div class="empty small">All tracked products are above their low-stock level.</div>') + '</div>';
      }
      html += '<div class="card"><div class="card-h"><h2>System</h2></div><div class="card-b"><dl class="kv">' +
        '<dt>Payments</dt><dd>' + (S.system.payments_live ? '<span class="chip delivered">Live (Paymob)</span>' : '<span class="chip paid">Demo mode</span>') + '</dd>' +
        '<dt>Email</dt><dd>' + (S.system.mail ? '<span class="chip delivered">Working</span>' : '<span class="chip">Not set up</span>') + '</dd>' +
        '<dt>Database</dt><dd>' + h(S.system.db === 'mysql' ? 'MySQL' : 'SQLite') + '</dd></dl></div></div>';
      html += '</div></div>';
      v.innerHTML = html;
      wireRows(v);
    });
  };
  function greeting() { var hr = +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date()); return hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening'; }
  function kpi(label, value, sub, href, attn) {
    return '<div class="card kpi' + (href ? ' link' : '') + (attn ? ' attn' : '') + '"' + (href ? ' data-go="' + h(href) + '" tabindex="0" role="link"' : '') + '>' +
      '<div class="lbl">' + h(label) + '</div><div class="val">' + h(value) + '</div>' + (sub ? '<div class="sub">' + h(sub) + '</div>' : '') + '</div>';
  }
  function wireRows(root) {
    $$('[data-go]', root).forEach(function (el) {
      el.addEventListener('click', function (e) { if (e.target.closest('a,button,input')) return; location.hash = el.getAttribute('data-go'); });
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') location.hash = el.getAttribute('data-go'); });
    });
  }
  function orderRow(o) {
    return '<tr class="click" data-go="#/order/' + h(o.ref) + '"><td><span class="mono">' + h(o.ref) + '</span>' + (o.demo ? ' <span class="tag demo">demo</span>' : '') +
      (o.amount_mismatch ? ' <span class="tag warn">check amount</span>' : '') + '<div class="small muted">' + h(fdt(o.created_at)) + '</div></td>' +
      '<td>' + h(o.name) + '<div class="small muted">' + h(o.city || o.phone || '') + '</div></td>' +
      '<td>' + chip(o.status) + '</td><td class="num">' + h(money(o.total_cents)) + (o.refunded_cents ? '<div class="small" style="color:var(--red)">−' + h(money(o.refunded_cents)) + '</div>' : '') + '</td></tr>';
  }

  // ---- Orders list ------------------------------------------------------------
  function hashQuery() { var q = location.hash.split('?')[1] || ''; return new URLSearchParams(q); }
  VIEWS.orders = function (v) {
    var q = hashQuery();
    var st = { status: q.get('status') || 'all', q: q.get('q') || '', from: q.get('from') || '', to: q.get('to') || '', page: +q.get('page') || 1 };
    var TABS = [['all', 'All'], ['action', 'To send'], ['shipped', 'Shipped'], ['delivered', 'Delivered'], ['unpaid', 'Unpaid'], ['closed', 'Closed']];
    v.innerHTML = head('Orders', 'Newest first. Times are Cairo time.',
        can('orders.export') ? '<button class="btn" data-export>' + icon('download') + 'Export to Excel</button>' : '') +
      '<div class="toolbar"><div class="tabs">' + TABS.map(function (t) { return '<button data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
      '<label class="search">' + icon('search') + '<input class="input" type="search" placeholder="Name, phone, email or order no." aria-label="Search orders"></label>' +
      '<input class="input" type="date" data-from aria-label="From date"><span class="muted">to</span><input class="input" type="date" data-to aria-label="To date"></div>' +
      '<div class="card" data-list><div class="empty">Loading…</div></div>';
    var input = $('.search input', v); input.value = st.q;
    $('[data-from]', v).value = st.from; $('[data-to]', v).value = st.to;
    function sync() { $$('[data-tab]', v).forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === st.status || (st.status === 'paid' || st.status === 'processing' ? b.getAttribute('data-tab') === 'action' : false)); }); }
    function params() {
      var p = new URLSearchParams();
      if (st.status !== 'all') p.set('status', st.status);
      if (st.q) p.set('q', st.q); if (st.from) p.set('from', st.from); if (st.to) p.set('to', st.to);
      return p;
    }
    function load() {
      sync();
      var p = params(); p.set('page', st.page);
      history.replaceState(null, '', '#/orders' + (params().toString() ? '?' + params().toString() : ''));
      return api('GET', '/orders?' + p.toString()).then(function (r) {
        var list = $('[data-list]', v);
        if (!r.orders.length) { list.innerHTML = '<div class="empty">No orders match.</div>'; return; }
        var pages = Math.ceil(r.total / r.per);
        list.innerHTML = '<div class="table-wrap"><table class="t"><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>' +
          r.orders.map(orderRow).join('') + '</tbody></table></div>' +
          '<div class="pager"><span>' + r.total + ' order' + (r.total === 1 ? '' : 's') + '</span><span class="row">' +
          (st.page > 1 ? '<button class="btn sm" data-p="-1">Previous</button>' : '') + (pages > 1 ? 'Page ' + st.page + ' of ' + pages : '') +
          (st.page < pages ? '<button class="btn sm" data-p="1">Next</button>' : '') + '</span></div>';
        wireRows(list);
        $$('[data-p]', list).forEach(function (b) { b.onclick = function () { st.page += +b.getAttribute('data-p'); load().catch(fail); }; });
      });
    }
    $$('[data-tab]', v).forEach(function (b) { b.onclick = function () { st.status = b.getAttribute('data-tab'); st.page = 1; load().catch(fail); }; });
    input.oninput = debounce(function () { st.q = input.value.trim(); st.page = 1; load().catch(fail); }, 300);
    $('[data-from]', v).onchange = function (e) { st.from = e.target.value; st.page = 1; load().catch(fail); };
    $('[data-to]', v).onchange = function (e) { st.to = e.target.value; st.page = 1; load().catch(fail); };
    var ex = $('[data-export]', v);
    if (ex) ex.onclick = function () { location.href = '/api/admin/export/orders.csv?' + params().toString(); };
    return load();
  };

  // ---- Order detail -------------------------------------------------------------------
  VIEWS.order = function (v, args) {
    var ref = args[0];
    return api('GET', '/orders/' + encodeURIComponent(ref)).then(function (r) {
      var o = r.order, moves = r.moves;
      var html = '<a href="#/orders" class="small">' + '← All orders</a>' +
        head('Order ' + o.ref, chip(o.status) + ' &nbsp;placed ' + h(fdt(o.created_at)) + (o.demo ? ' &nbsp;<span class="tag demo">demo order</span>' : ''),
          '<button class="btn" data-print>' + icon('print') + 'Packing slip</button>');
      if (o.amount_mismatch) html += '<div class="banner bad"><b>Check the amount.</b>&nbsp;Paymob captured ' + h(money(o.paid_amount_cents)) + ' but the order total is ' + h(money(o.total_cents)) + '. Check before shipping.</div>';
      if (o.status === 'paid') html += '<div class="banner warn">Paid and waiting. Mark it <b>Preparing</b> when you start, then <b>Shipped</b> with the courier details.</div>';

      html += '<div class="split"><div class="stack">';
      // items
      html += '<div class="card"><div class="card-h"><h2>Items</h2></div><div class="table-wrap"><table class="t"><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead><tbody>' +
        o.items.map(function (i) { return '<tr><td>' + h(i.name_en) + '<div class="sku">' + h(i.sku) + '</div></td><td class="num">' + i.qty + '</td><td class="num">' + h(money(i.unit_price_cents)) + '</td><td class="num">' + h(money(i.line_total_cents)) + '</td></tr>'; }).join('') +
        '</tbody></table></div><div class="card-b"><div class="totals"><div><span>Subtotal</span><span>' + h(money(o.subtotal_cents)) + '</span></div>' +
        '<div><span>Delivery</span><span>' + (o.shipping_cents ? h(money(o.shipping_cents)) : 'Free') + '</span></div>' +
        '<div class="grand"><span>Total</span><span>' + h(money(o.total_cents)) + '</span></div>' +
        (o.refunded_cents ? '<div style="color:var(--red)"><span>Refunded</span><span>−' + h(money(o.refunded_cents)) + '</span></div>' : '') + '</div></div></div>';
      // actions
      var ORDER_FLOW = ['paid', 'processing', 'shipped', 'delivered'];
      var isBack = function (m) { return ORDER_FLOW.indexOf(m) >= 0 && ORDER_FLOW.indexOf(m) < ORDER_FLOW.indexOf(o.status); };
      var actionBtns = moves.filter(function (m) { return !isBack(m); }).map(function (m) {
        var cls = m === 'cancelled' || m === 'refunded' ? 'danger' : (m === nextStep(o.status) ? 'primary' : '');
        return '<button class="btn ' + cls + '" data-move="' + m + '">' + h(moveLabel(m)) + '</button>';
      }).join('');
      var backBtns = moves.filter(isBack).map(function (m) {
        return '<button class="btn ghost sm" data-move="' + m + '">Back to ' + h(S.statuses[m]) + '</button>';
      }).join('');
      var extra = '';
      if (r.can_simulate) extra += '<button class="btn amber" data-sim>Simulate payment (demo)</button>';
      if (can('orders.update') && o.paid_at) extra += '<button class="btn" data-resend>Re-send confirmation email</button>';
      if (can('orders.cancel') && o.stock_applied && (o.status === 'cancelled' || o.status === 'refunded')) extra += '<button class="btn" data-restock>Return items to stock</button>';
      if (actionBtns || extra) html += '<div class="card"><div class="card-h"><h2>Update order</h2></div><div class="card-b"><div class="actions">' + actionBtns + extra + '</div>' +
        (backBtns ? '<div class="row small muted" style="margin-top:10px">Clicked by mistake? ' + backBtns + '</div>' : '') + '</div></div>';
      // timeline
      html += '<div class="card"><div class="card-h"><h2>History</h2></div><div class="card-b">' +
        (can('orders.update') ? '<form class="row" data-note style="margin-bottom:16px"><input class="input" name="text" placeholder="Add an internal note (customers never see these)" style="flex:1"><button class="btn">Add note</button></form>' : '') +
        '<ul class="timeline">' + o.events.slice().reverse().map(function (e) {
          var t = e.type === 'status' && e.to_status ? 'Status → ' + (S.statuses[e.to_status] || e.to_status) : ({ note: 'Note', payment: 'Payment', refund: 'Refund', email: 'Email', stock: 'Stock', created: 'Order placed', edit: 'Details changed', warning: 'Warning', import: 'Imported' }[e.type] || e.type);
          return '<li class="' + h(e.type) + '"><b>' + h(t) + '</b>' + (e.message ? '<div>' + h(e.message) + '</div>' : '') + '<div class="when">' + h(fdt(e.at)) + ' · <span class="who">' + h(e.actor) + '</span></div></li>';
        }).join('') + '</ul></div></div>';
      html += '</div><div class="stack">';
      // customer
      html += '<div class="card"><div class="card-h"><h2>Customer</h2>' + (can('orders.update') ? '<button class="btn sm" data-edit>Edit</button>' : '') + '</div><div class="card-b"><dl class="kv">' +
        '<dt>Name</dt><dd>' + h(o.first_name + ' ' + o.last_name) + '</dd>' +
        '<dt>Phone</dt><dd><a href="tel:' + h(o.phone) + '">' + h(o.phone) + '</a>' + (o.phone ? ' · <a href="https://wa.me/' + h(waNumber(o.phone)) + '" target="_blank" rel="noopener">WhatsApp</a>' : '') + '</dd>' +
        '<dt>Email</dt><dd><a href="mailto:' + h(o.email) + '?subject=' + encodeURIComponent('Your Truman order ' + o.ref) + '">' + h(o.email) + '</a></dd>' +
        '<dt>Address</dt><dd>' + h(o.street || '—') + '</dd><dt>City</dt><dd>' + h(o.city || '—') + '</dd>' +
        '<dt>Language</dt><dd>' + (o.lang === 'ar' ? 'Arabic' : 'English') + '</dd></dl></div></div>';
      // delivery
      html += '<div class="card"><div class="card-h"><h2>Delivery</h2></div><div class="card-b"><dl class="kv">' +
        '<dt>Courier</dt><dd>' + h(o.courier || '—') + '</dd><dt>Tracking</dt><dd class="mono">' + h(o.tracking_no || '—') + '</dd></dl></div></div>';
      // payment
      html += '<div class="card"><div class="card-h"><h2>Payment</h2></div><div class="card-b"><dl class="kv">' +
        '<dt>Paid</dt><dd>' + (o.paid_at ? h(fdt(o.paid_at)) : '<span class="muted">Not paid</span>') + '</dd>' +
        '<dt>Method</dt><dd>' + h(o.pay_method || '—') + (o.card_last4 ? ' ·· ' + h(String(o.card_last4).slice(-4)) : '') + '</dd>' +
        '<dt>Amount</dt><dd>' + (o.paid_amount_cents != null ? h(money(o.paid_amount_cents)) : '—') + '</dd>' +
        '<dt>Paymob txn</dt><dd class="mono">' + h(o.paymob_txn_id || '—') + '</dd>' +
        '<dt>Paymob order</dt><dd class="mono">' + h(o.paymob_order_id || '—') + '</dd></dl>' +
        (o.paid_at && !o.demo ? '<p class="small muted" style="margin:12px 0 0">Refunds are made in the Paymob dashboard. Paymob tells this site automatically when one is done.</p>' : '') + '</div></div>';
      html += '</div></div>';
      v.innerHTML = html;

      $('[data-print]', v).onclick = function () { printSlip(o); };
      $$('[data-move]', v).forEach(function (b) { b.onclick = function () { moveDialog(o, b.getAttribute('data-move')); }; });
      var sim = $('[data-sim]', v); if (sim) sim.onclick = function () { api('POST', '/orders/' + o.ref + '/simulate-payment').then(function () { toast('Marked as paid (demo)'); route(); }).catch(fail); };
      var rs = $('[data-resend]', v); if (rs) rs.onclick = function () { api('POST', '/orders/' + o.ref + '/resend').then(function (x) { toast(x.sent ? 'Confirmation sent to customer' : 'Email is not set up, nothing sent', !x.sent); route(); }).catch(fail); };
      var rk = $('[data-restock]', v); if (rk) rk.onclick = function () {
        confirmBox('Return items to stock?', 'This adds the ' + o.items.reduce(function (a, i) { return a + i.qty; }, 0) + ' item(s) in this order back to stock.', 'Return to stock').then(function (yes) {
          if (yes) api('POST', '/orders/' + o.ref + '/restock').then(function () { toast('Items returned to stock'); route(); }).catch(fail);
        });
      };
      var nf = $('[data-note]', v); if (nf) nf.onsubmit = function (e) {
        e.preventDefault(); var t = val(nf, 'text').trim(); if (!t) return;
        api('POST', '/orders/' + o.ref + '/note', { text: t }).then(function () { toast('Note added'); route(); }).catch(fail);
      };
      var ed = $('[data-edit]', v); if (ed) ed.onclick = function () { editOrderDialog(o); };
    });
  };
  function nextStep(s) { return { paid: 'processing', processing: 'shipped', shipped: 'delivered' }[s]; }
  function moveLabel(m) { return { processing: 'Mark preparing', shipped: 'Mark shipped', delivered: 'Mark delivered', cancelled: 'Cancel order', refunded: 'Record refund' }[m] || ('Set ' + S.statuses[m]); }
  function waNumber(p) { var d = String(p).replace(/\D/g, ''); if (d.indexOf('20') === 0) return d; if (d.indexOf('0') === 0) return '2' + d; return '20' + d; }

  function moveDialog(o, to) {
    var paid = !!o.paid_at;
    var body = '';
    if (to === 'shipped') body += '<div class="grid g2"><div class="field"><label>Courier</label><input class="input" name="courier" list="couriers" value="' + h(o.courier || '') + '" placeholder="e.g. Bosta, Aramex, own fleet"><datalist id="couriers"><option>Bosta</option><option>Aramex</option><option>Mylerz</option><option>R2S</option><option>Own delivery</option></datalist></div>' +
                                '<div class="field"><label>Tracking number</label><input class="input" name="tracking_no" value="' + h(o.tracking_no || '') + '"></div></div>';
    if (to === 'refunded') body += '<div class="banner warn">This only <b>records</b> the refund here. Make the actual refund in the Paymob dashboard first. Paymob will also tell this site on its own.</div>' +
                                 '<div class="field"><label>Amount refunded (EGP)</label><input class="input" name="amount" inputmode="decimal" value="' + h(fromCents(o.total_cents - o.refunded_cents)) + '"><div class="hint">Less than the full amount records a partial refund and keeps the current status.</div></div>';
    if (to === 'cancelled' && paid) body += '<div class="banner warn">This order is paid. Cancelling does not return the money. Refund it in the Paymob dashboard as well.</div>';
    if ((to === 'cancelled' || to === 'refunded') && o.stock_applied && can('orders.cancel'))
      body += '<label class="check"><input type="checkbox" name="restock" checked><span>Return the items to stock<small class="muted" style="display:block">Untick if the goods were already delivered and are not coming back.</small></span></label>';
    body += '<div class="field" style="margin-top:8px"><label>Note (optional, internal)</label><input class="input" name="note"></div>';
    var notifiable = ['processing', 'shipped', 'delivered', 'refunded'].indexOf(to) >= 0 || (to === 'cancelled' && paid);
    if (notifiable) body += '<label class="check"><input type="checkbox" name="notify" checked><span>Email the customer about this (' + (o.lang === 'ar' ? 'in Arabic' : 'in English') + ')</span></label>';
    modal({ title: moveLabel(to) + ' — ' + o.ref, body: body, actions: [
      { label: 'Cancel' },
      { label: moveLabel(to), cls: to === 'cancelled' || to === 'refunded' ? 'danger' : 'primary', onClick: function (m) {
        var payload = { status: to, note: val(m.el, 'note'), notify: notifiable ? val(m.el, 'notify') : false, restock: !!val(m.el, 'restock') };
        if (to === 'shipped') { payload.courier = val(m.el, 'courier'); payload.tracking_no = val(m.el, 'tracking_no'); }
        if (to === 'refunded') { var c = toCents(val(m.el, 'amount')); if (!(c > 0)) return Promise.reject(new Error('Enter the amount refunded.')); payload.refund_cents = c; }
        return api('POST', '/orders/' + o.ref + '/status', payload).then(function (r) {
          toast(r.partial ? 'Partial refund recorded' : 'Order updated' + (r.emailed ? ' and customer emailed' : ''));
          (r.warnings || []).forEach(function (w) { toast(w, true); });
          refreshCounts().catch(function () {}); route();
        });
      } }] });
  }
  function editOrderDialog(o) {
    modal({ title: 'Edit customer details', body:
      '<div class="field"><label>Phone</label><input class="input" name="phone" value="' + h(o.phone || '') + '"></div>' +
      '<div class="field"><label>Address</label><input class="input" name="street" value="' + h(o.street || '') + '"></div>' +
      '<div class="field"><label>City</label><input class="input" name="city" value="' + h(o.city || '') + '"></div>' +
      '<p class="small muted">Changes are recorded in the order history.</p>',
      actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: function (m) {
        return api('POST', '/orders/' + o.ref + '/details', { phone: val(m.el, 'phone'), street: val(m.el, 'street'), city: val(m.el, 'city') }).then(function () { toast('Saved'); route(); });
      } }] });
  }
  function printSlip(o) {
    var root = document.getElementById('print-root');
    root.innerHTML = '<h1>TRUMAN.</h1><p>Truman Electronics · 174 Tahrir St., Babellouk, Cairo · Hotline 19903</p>' +
      '<h2 style="margin-top:18px">Packing slip — ' + h(o.ref) + '</h2>' +
      '<p><b>' + h(o.first_name + ' ' + o.last_name) + '</b><br>' + h(o.phone) + '<br>' + h(o.street || '') + '<br>' + h(o.city || '') + '</p>' +
      '<p>Order date: ' + h(fdate(o.created_at)) + (o.paid_at ? ' · Paid: ' + h(fdate(o.paid_at)) : ' · NOT PAID') + '</p>' +
      '<table><thead><tr><th>SKU</th><th>Product</th><th class="r">Qty</th><th>✓</th></tr></thead><tbody>' +
      o.items.map(function (i) { return '<tr><td>' + h(i.sku) + '</td><td>' + h(i.name_en) + '<br>' + h(i.name_ar || '') + '</td><td class="r">' + i.qty + '</td><td>☐</td></tr>'; }).join('') +
      '</tbody></table><p style="margin-top:18px">Total: ' + h(money(o.total_cents)) + (o.courier ? ' · Courier: ' + h(o.courier) : '') + (o.tracking_no ? ' · Tracking: ' + h(o.tracking_no) : '') + '</p>' +
      '<p style="margin-top:30px">Packed by: ____________________ &nbsp;&nbsp; Date: ______________</p>';
    window.print();
  }

  // ---- Products & stock -------------------------------------------------------------
  VIEWS.products = function (v) {
    var q = hashQuery();
    var st = { q: q.get('q') || '', cat: 'all', low: false };
    return api('GET', '/products').then(function (r) {
      var cats = r.categories;
      v.innerHTML = head('Products & stock', 'Prices and availability here are what the shop shows. Changes go live within seconds.',
          can('products.edit') ? '<button class="btn primary" data-add>' + icon('plus') + 'Add product</button>' : '') +
        '<div class="toolbar"><label class="search">' + icon('search') + '<input class="input" type="search" placeholder="Search SKU or name" aria-label="Search products"></label>' +
        '<select class="input" data-cat style="width:auto"><option value="all">All categories</option>' + cats.map(function (c) { return '<option>' + h(c) + '</option>'; }).join('') + '</select>' +
        '<label class="check"><input type="checkbox" data-low><span>Low or out of stock only</span></label></div>' +
        '<div class="card" data-list></div>';
      var input = $('.search input', v); input.value = st.q;
      function draw() {
        var list = r.products.filter(function (p) {
          if (st.cat !== 'all' && p.category !== st.cat) return false;
          if (st.low && !(p.stock_qty != null && p.stock_qty <= p.low_stock_at)) return false;
          if (st.q) { var s = st.q.toLowerCase(); return p.sku.toLowerCase().indexOf(s) >= 0 || (p.name_en || '').toLowerCase().indexOf(s) >= 0 || (p.name_ar || '').indexOf(st.q) >= 0; }
          return true;
        });
        $('[data-list]', v).innerHTML = list.length ? '<div class="table-wrap"><table class="t"><thead><tr><th></th><th>Product</th><th>Category</th><th class="num">Price</th><th class="num">Stock</th><th class="num">Sold 30 d</th><th>Shop</th></tr></thead><tbody>' +
          list.map(function (p) {
            var stock = p.stock_qty == null ? '<span class="faint" title="Stock is not counted for this product">not tracked</span>'
              : '<b' + (p.stock_qty <= 0 ? ' style="color:var(--red)"' : '') + '>' + p.stock_qty + '</b>' + (p.stock_qty > 0 && p.stock_qty <= p.low_stock_at ? ' <span class="tag low">low</span>' : '');
            return '<tr class="click" data-sku="' + h(p.sku) + '"><td><div class="thumb" style="background-image:url(\'/' + h(p.image) + '\')"></div></td>' +
              '<td><span class="sku">' + h(p.sku) + '</span><div>' + h(p.name_en) + '</div></td><td class="muted">' + h(p.category) + '</td>' +
              '<td class="num">' + h(money(p.price_cents)) + '</td><td class="num">' + stock +
              (can('stock.edit') ? ' <button class="btn sm" data-adj="' + h(p.sku) + '">Adjust</button>' : '') + '</td>' +
              '<td class="num">' + (p.sold_30d || 0) + '</td><td>' + (p.active ? (p.stock_qty != null && p.stock_qty <= 0 ? '<span class="tag off">sold out</span>' : '<span class="chip delivered">On sale</span>') : '<span class="tag off">hidden</span>') + '</td></tr>';
          }).join('') + '</tbody></table></div><div class="pager"><span>' + list.length + ' of ' + r.products.length + ' products</span></div>'
          : '<div class="empty">No products match.</div>';
        $$('tr[data-sku]', v).forEach(function (tr) {
          tr.onclick = function (e) {
            if (e.target.closest('[data-adj]')) return;
            productDialog(r.products.filter(function (p) { return p.sku === tr.getAttribute('data-sku'); })[0], cats);
          };
        });
        $$('[data-adj]', v).forEach(function (b) { b.onclick = function () { stockDialog(r.products.filter(function (p) { return p.sku === b.getAttribute('data-adj'); })[0]); }; });
      }
      input.oninput = debounce(function () { st.q = input.value.trim(); draw(); }, 150);
      $('[data-cat]', v).onchange = function (e) { st.cat = e.target.value; draw(); };
      $('[data-low]', v).onchange = function (e) { st.low = e.target.checked; draw(); };
      var add = $('[data-add]', v); if (add) add.onclick = function () { newProductDialog(cats); };
      draw();
    });
  };

  function stockDialog(p) {
    var body = '<p><span class="sku">' + h(p.sku) + '</span> ' + h(p.name_en) + '</p>';
    if (p.stock_qty == null) body += '<div class="banner info">Stock is not tracked for this product yet. Entering a count turns tracking on: the shop will stop selling it at zero.</div>';
    else body += '<p>In stock now: <b>' + p.stock_qty + '</b></p>';
    body += '<div class="tabs" style="margin-bottom:12px"><button data-mode="add" class="on">Receive / remove</button><button data-mode="set">Set exact count</button></div>' +
      '<div class="field"><label data-qlabel>Quantity to add (use a minus sign to remove)</label><input class="input" name="qty" inputmode="numeric" placeholder="e.g. 10 or -2"></div>' +
      '<div class="field"><label>Reason (optional)</label><input class="input" name="note" placeholder="e.g. delivery from factory, damaged unit, stock count"></div>' +
      '<details><summary class="small">Recent stock history</summary><div data-moves class="small muted" style="margin-top:8px">Loading…</div></details>';
    var mode = 'add';
    modal({ title: 'Adjust stock', body: body, onMount: function (m) {
      $$('[data-mode]', m.el).forEach(function (b) {
        b.onclick = function () { mode = b.getAttribute('data-mode'); $$('[data-mode]', m.el).forEach(function (x) { x.classList.toggle('on', x === b); });
          $('[data-qlabel]', m.el).textContent = mode === 'set' ? 'Exact number on the shelf' : 'Quantity to add (use a minus sign to remove)'; };
      });
      api('GET', '/products/' + encodeURIComponent(p.sku) + '/moves').then(function (r) {
        $('[data-moves]', m.el).innerHTML = r.moves.length ? '<table class="t"><tbody>' + r.moves.map(function (x) {
          return '<tr><td>' + h(fdt(x.at)) + '</td><td class="num">' + (x.delta > 0 ? '+' : '') + x.delta + '</td><td class="num">→ ' + x.qty_after + '</td><td>' + h(x.reason) + (x.order_ref ? ' <span class="mono">' + h(x.order_ref) + '</span>' : '') + (x.note ? ' · ' + h(x.note) : '') + '<div class="faint">' + h(x.actor || '') + '</div></td></tr>';
        }).join('') + '</tbody></table>' : 'No stock changes yet.';
      }).catch(function () {});
    }, actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: function (m) {
      var qty = parseInt(val(m.el, 'qty'), 10);
      if (!isFinite(qty)) return Promise.reject(new Error('Enter a whole number.'));
      var go = function () {
        return api('POST', '/products/' + encodeURIComponent(p.sku) + '/stock', { mode: mode, qty: qty, note: val(m.el, 'note') })
          .then(function (r) { toast(p.sku + ': stock now ' + r.after); refreshCounts().catch(function () {}); route(); });
      };
      if (p.stock_qty == null) return api('PUT', '/products/' + encodeURIComponent(p.sku), { track_stock: true }).then(go);
      return go();
    } }] });
  }

  function productForm(p, cats) {
    var pe = can('products.edit'), se = can('stock.edit');
    var dis = pe ? '' : ' disabled';
    return '<div class="img-pick field"><div class="thumb" data-thumb style="background-image:url(\'/' + h(p.image || 'assets/logo.png') + '\')"></div><div>' +
      (pe && p.sku ? '<label class="btn sm" style="cursor:pointer">Change photo<input type="file" accept="image/jpeg,image/png,image/webp" data-file hidden></label><div class="hint">JPG, PNG or WebP. It is resized automatically.</div>' : '') + '</div></div>' +
      (p.sku ? '' : '<div class="field"><label>SKU (product code)</label><input class="input" name="sku" placeholder="e.g. TM-G300"><div class="hint">Letters, numbers and dashes. Cannot be changed later.</div></div>') +
      '<div class="grid g2"><div class="field"><label>Name (English)</label><input class="input" name="name_en" value="' + h(p.name_en || '') + '"' + dis + '></div>' +
      '<div class="field"><label>Name (Arabic)</label><input class="input" name="name_ar" dir="rtl" value="' + h(p.name_ar || '') + '"' + dis + '></div></div>' +
      '<div class="grid g2"><div class="field"><label>Price (EGP, including VAT)</label><input class="input" name="price" inputmode="decimal" value="' + h(fromCents(p.price_cents)) + '"' + dis + '></div>' +
      '<div class="field"><label>Category</label><input class="input" name="category" list="cats" value="' + h(p.category || '') + '"' + dis + '><datalist id="cats">' + cats.map(function (c) { return '<option>' + h(c) + '</option>'; }).join('') + '</datalist></div></div>' +
      '<div class="field"><label>Description (English)</label><textarea class="input" name="desc_en"' + dis + '>' + h(p.desc_en || '') + '</textarea></div>' +
      '<div class="field"><label>Description (Arabic)</label><textarea class="input" name="desc_ar" dir="rtl"' + dis + '>' + h(p.desc_ar || '') + '</textarea></div>' +
      '<div class="field"><label>Key specs (one per line, up to 12)</label><textarea class="input" name="specs"' + dis + '>' + h((p.specs || []).join('\n')) + '</textarea></div>' +
      (p.sku ? '<div class="grid g2">' +
        '<div><label class="check"><input type="checkbox" name="active"' + (p.active ? ' checked' : '') + dis + '><span><b>Show in the shop</b><small class="muted" style="display:block">Untick to hide it without deleting.</small></span></label>' +
        '<div class="field" style="margin-top:6px"><label>Display order</label><input class="input" name="sort_order" inputmode="numeric" value="' + h(p.sort_order) + '"' + dis + '></div></div>' +
        '<div>' + (se ? '<label class="check"><input type="checkbox" name="track"' + (p.stock_qty != null ? ' checked' : '') + '><span><b>Count stock</b><small class="muted" style="display:block">The shop stops selling at zero. Use "Adjust" in the list to change the count.</small></span></label>' +
        '<div class="field" style="margin-top:6px"><label>Warn me when stock is at or below</label><input class="input" name="low_stock_at" inputmode="numeric" value="' + h(p.low_stock_at) + '"></div>' : '') + '</div></div>' : '');
  }
  function productDialog(p, cats) {
    var pending = null;
    modal({ title: p.sku + ' — ' + p.name_en, wide: true, body: productForm(p, cats), onMount: function (m) {
      var f = $('[data-file]', m.el);
      if (f) f.onchange = function () {
        var file = f.files[0]; if (!file) return;
        resizeImage(file, 1200).then(function (dataUrl) {
          pending = dataUrl; $('[data-thumb]', m.el).style.backgroundImage = 'url(' + dataUrl + ')';
        }).catch(function (e) { m.error(e.message); });
      };
    }, actions: [{ label: 'Cancel' }, { label: 'Save changes', cls: 'primary', onClick: function (m) {
      var body = {};
      if (can('products.edit')) {
        var price = toCents(val(m.el, 'price'));
        if (!(price >= 0)) return Promise.reject(new Error('Enter a valid price.'));
        body = { name_en: val(m.el, 'name_en'), name_ar: val(m.el, 'name_ar'), price_cents: price, category: val(m.el, 'category'),
                 desc_en: val(m.el, 'desc_en'), desc_ar: val(m.el, 'desc_ar'), specs: val(m.el, 'specs').split('\n'),
                 active: val(m.el, 'active'), sort_order: parseInt(val(m.el, 'sort_order'), 10) || 0 };
      }
      if (can('stock.edit')) { body.track_stock = val(m.el, 'track'); body.low_stock_at = parseInt(val(m.el, 'low_stock_at'), 10); if (!isFinite(body.low_stock_at)) delete body.low_stock_at; }
      var priceChanged = body.price_cents != null && body.price_cents !== p.price_cents;
      var save = function () {
        return api('PUT', '/products/' + encodeURIComponent(p.sku), body).then(function () {
          return pending ? api('POST', '/products/' + encodeURIComponent(p.sku) + '/image', { data: pending }) : null;
        }).then(function () { toast('Saved' + (priceChanged ? ' — new price is live' : '')); route(); });
      };
      return save();
    } }] });
  }
  function newProductDialog(cats) {
    modal({ title: 'Add product', wide: true, body: productForm({ active: 0, specs: [] }, cats) +
      '<p class="small muted">New products start hidden so you can add a photo first. Open it from the list to add the photo and tick "Show in the shop".</p>',
      actions: [{ label: 'Cancel' }, { label: 'Create product', cls: 'primary', onClick: function (m) {
        var price = toCents(val(m.el, 'price'));
        if (!(price >= 0)) return Promise.reject(new Error('Enter a valid price.'));
        return api('POST', '/products', { sku: val(m.el, 'sku').trim(), name_en: val(m.el, 'name_en'), name_ar: val(m.el, 'name_ar'), price_cents: price,
          category: val(m.el, 'category'), desc_en: val(m.el, 'desc_en'), desc_ar: val(m.el, 'desc_ar'), specs: val(m.el, 'specs').split('\n') })
          .then(function (r) { toast('Product ' + r.sku + ' created (hidden)'); location.hash = '#/products?q=' + encodeURIComponent(r.sku); });
      } }] });
  }
  function resizeImage(file, max) {
    return new Promise(function (resolve, reject) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return reject(new Error('Choose a JPG, PNG or WebP image.'));
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var s = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var out = c.toDataURL('image/webp', 0.85);
        if (out.indexOf('data:image/webp') !== 0) out = c.toDataURL('image/jpeg', 0.88);
        resolve(out);
      };
      img.onerror = function () { reject(new Error('That image could not be read.')); };
      img.src = url;
    });
  }

  // ---- Enquiries ---------------------------------------------------------------------
  VIEWS.enquiries = function (v) {
    var st = 'new';
    v.innerHTML = head('Enquiries', 'Messages from the website contact form.') +
      '<div class="toolbar"><div class="tabs"><button data-t="new" class="on">New</button><button data-t="handled">Handled</button><button data-t="all">All</button></div></div><div class="card" data-list></div>';
    function load() {
      $$('[data-t]', v).forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-t') === st); });
      return api('GET', '/enquiries?status=' + st).then(function (r) {
        var list = $('[data-list]', v);
        list.innerHTML = r.enquiries.length ? r.enquiries.map(function (e) {
          return '<div class="enq"><div class="row" style="justify-content:space-between"><div><b>' + h(e.name) + '</b> · <a href="mailto:' + h(e.email) + '?subject=' + encodeURIComponent('Re: ' + e.topic) + '">' + h(e.email) + '</a>' +
            ' <span class="tag ' + (e.status === 'new' ? 'low' : 'off') + '">' + h(e.topic) + '</span></div><span class="small faint" title="' + h(fdt(e.created_at)) + '">' + h(ago(e.created_at)) + '</span></div>' +
            '<div class="msg">' + h(e.message) + '</div><div class="row">' +
            '<a class="btn sm" href="mailto:' + h(e.email) + '?subject=' + encodeURIComponent('Re: ' + e.topic) + '">Reply by email</a>' +
            (e.status === 'new' ? '<button class="btn sm primary" data-done="' + e.id + '">Mark handled</button>' : '<button class="btn sm" data-undo="' + e.id + '">Mark as new</button><span class="small faint">by ' + h(e.handled_by || '') + ', ' + h(fdt(e.handled_at)) + '</span>') + '</div></div>';
        }).join('') : '<div class="empty">' + (st === 'new' ? 'No new enquiries.' : 'Nothing here.') + '</div>';
        $$('[data-done]', list).forEach(function (b) { b.onclick = function () { api('POST', '/enquiries/' + b.getAttribute('data-done'), { status: 'handled' }).then(function () { refreshCounts().catch(function () {}); load(); }).catch(fail); }; });
        $$('[data-undo]', list).forEach(function (b) { b.onclick = function () { api('POST', '/enquiries/' + b.getAttribute('data-undo'), { status: 'new' }).then(function () { refreshCounts().catch(function () {}); load(); }).catch(fail); }; });
      });
    }
    $$('[data-t]', v).forEach(function (b) { b.onclick = function () { st = b.getAttribute('data-t'); load().catch(fail); }; });
    return load();
  };

  // ---- Reports -------------------------------------------------------------------------
  VIEWS.reports = function (v) {
    var today = isoDay(Date.now());
    var st = { from: isoDay(Date.now() - 29 * 864e5), to: today };
    v.innerHTML = head('Reports', 'Based on paid orders, by payment date (Cairo time).',
        can('orders.export') ? '<button class="btn" data-export>' + icon('download') + 'Export these orders</button>' : '') +
      '<div class="toolbar"><div class="tabs"><button data-r="7">7 days</button><button data-r="30" class="on">30 days</button><button data-r="90">90 days</button><button data-r="month">This month</button><button data-r="year">This year</button></div>' +
      '<input class="input" type="date" data-from><span class="muted">to</span><input class="input" type="date" data-to></div><div data-body></div>';
    function load() {
      $('[data-from]', v).value = st.from; $('[data-to]', v).value = st.to;
      return api('GET', '/reports?from=' + st.from + '&to=' + st.to).then(function (r) {
        var t = r.totals;
        $('[data-body]', v).innerHTML = (r.demo_included ? '<div class="banner warn">Demo mode: these figures include test orders.</div>' : '') +
          '<div class="grid g4" style="margin-bottom:16px">' + kpi('Net sales', money(t.net_cents), 'after ' + money(t.refunds_cents) + ' refunds') + kpi('Paid orders', t.orders, t.checkouts_started + ' checkouts started') +
          kpi('Average order', money(t.average_cents), 'net') + kpi('Checkout conversion', Math.round(t.conversion * 100) + '%', 'paid ÷ started') + '</div>' +
          '<div class="card" style="margin-bottom:16px"><div class="card-h"><h2>Net sales by day</h2><span class="small muted">' + h(fdate(Date.parse(r.from + 'T12:00:00Z'))) + ' – ' + h(fdate(Date.parse(r.to + 'T12:00:00Z'))) + '</span></div><div class="card-b">' +
          (r.by_day.length <= 120 ? barChart(r.by_day.map(function (d) { return { d: d.d, c: d.cents, orders: d.orders }; }), 'c') : '<p class="muted">Choose 120 days or fewer to see the daily chart.</p>') + '</div></div>' +
          '<div class="split"><div class="card"><div class="card-h"><h2>Best sellers</h2></div>' + (r.top_products.length ? '<div class="table-wrap"><table class="t"><thead><tr><th>Product</th><th class="num">Units</th><th class="num">Sales</th></tr></thead><tbody>' +
            r.top_products.map(function (p) { return '<tr><td><span class="sku">' + h(p.sku) + '</span><div>' + h(p.name) + '</div></td><td class="num">' + p.qty + '</td><td class="num">' + h(money(p.cents)) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<div class="empty">No sales in this period.</div>') + '</div>' +
          '<div class="stack"><div class="card"><div class="card-h"><h2>Payment methods</h2></div><div class="card-b">' + (r.by_method.length ? barList(r.by_method) : '<p class="muted">—</p>') + '</div></div>' +
          '<div class="card"><div class="card-h"><h2>Top cities</h2></div><div class="card-b">' + (r.by_city.length ? barList(r.by_city) : '<p class="muted">—</p>') + '</div></div></div></div>';
      });
    }
    $$('[data-r]', v).forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-r'), now = Date.now();
        $$('[data-r]', v).forEach(function (x) { x.classList.toggle('on', x === b); });
        st.to = today;
        if (k === 'month') st.from = today.slice(0, 8) + '01'; else if (k === 'year') st.from = today.slice(0, 5) + '01-01';
        else st.from = isoDay(now - (parseInt(k, 10) - 1) * 864e5);
        load().catch(fail);
      };
    });
    $('[data-from]', v).onchange = function (e) { st.from = e.target.value; $$('[data-r]', v).forEach(function (x) { x.classList.remove('on'); }); load().catch(fail); };
    $('[data-to]', v).onchange = function (e) { st.to = e.target.value; $$('[data-r]', v).forEach(function (x) { x.classList.remove('on'); }); load().catch(fail); };
    var ex = $('[data-export]', v); if (ex) ex.onclick = function () { location.href = '/api/admin/export/orders.csv?from=' + st.from + '&to=' + st.to; };
    return load();
  };

  // ---- Staff -----------------------------------------------------------------------------
  VIEWS.staff = function (v) {
    return api('GET', '/users').then(function (r) {
      v.innerHTML = head('Staff', 'Give each person their own login with only the access they need.', '<button class="btn primary" data-add>' + icon('plus') + 'Add staff member</button>') +
        '<div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>Person</th><th>Access</th><th>Two-step</th><th>Last sign-in</th><th></th></tr></thead><tbody>' +
        r.users.map(function (u) {
          var access = u.role === 'owner' ? '<b>Owner</b> · everything' : (u.perms.length ? u.perms.map(function (p) { return permShort(p); }).join(', ') : '<span class="faint">No access</span>');
          return '<tr><td><b>' + h(u.name || '') + '</b>' + (u.active ? '' : ' <span class="tag off">disabled</span>') + (u.locked ? ' <span class="tag warn">locked</span>' : '') +
            '<div class="small muted">' + h(u.email) + '</div></td><td class="small" style="max-width:340px">' + access + '</td>' +
            '<td>' + (u.totp_enabled ? '<span class="chip delivered">On</span>' : '<span class="chip">Off</span>') + '</td>' +
            '<td class="small">' + (u.last_login_at ? h(fdt(u.last_login_at)) : '<span class="faint">' + (u.must_change_pw ? 'not yet' : 'never') + '</span>') + '</td>' +
            '<td class="right">' + (u.role === 'owner' ? '' : '<button class="btn sm" data-edit="' + u.id + '">Manage</button>') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
      $('[data-add]', v).onclick = function () { staffDialog(null); };
      $$('[data-edit]', v).forEach(function (b) { b.onclick = function () { staffDialog(r.users.filter(function (u) { return u.id === +b.getAttribute('data-edit'); })[0]); }; });
    });
  };
  function permShort(p) { return { 'orders.view': 'see orders', 'orders.update': 'update orders', 'orders.cancel': 'cancel/refund', 'orders.export': 'export', 'products.edit': 'products & prices', 'stock.edit': 'stock', 'enquiries.view': 'enquiries', 'reports.view': 'reports', 'settings.edit': 'settings' }[p] || p; }
  function permsBlock(selected) {
    return '<div class="field"><label>Access</label><div class="presets"><span class="small muted" style="align-self:center">Quick pick:</span>' +
      Object.keys(S.presets).map(function (k) { return '<button type="button" class="btn sm" data-preset="' + k + '">' + h(k.charAt(0).toUpperCase() + k.slice(1)) + '</button>'; }).join('') + '</div>' +
      '<div class="perm-list">' + S.permissions.map(function (p) {
        return '<label class="check"><input type="checkbox" name="perm" value="' + h(p[0]) + '"' + (selected.indexOf(p[0]) >= 0 ? ' checked' : '') + '><span>' + h(p[1]) + '</span></label>';
      }).join('') + '</div><div class="hint">Only the owner can manage staff and see the activity log.</div></div>';
  }
  function wirePresets(m) {
    $$('[data-preset]', m.el).forEach(function (b) {
      b.onclick = function () { var set = S.presets[b.getAttribute('data-preset')]; $$('input[name=perm]', m.el).forEach(function (c) { c.checked = set.indexOf(c.value) >= 0; }); };
    });
  }
  function checkedPerms(m) { return $$('input[name=perm]', m.el).filter(function (c) { return c.checked; }).map(function (c) { return c.value; }); }
  function showTempPassword(email, pw) {
    modal({ title: 'Temporary password', body: '<p>Give this to <b>' + h(email) + '</b> in person or by phone. They must choose their own password the first time they sign in.</p>' +
      '<div class="secret" style="font-size:18px;text-align:center">' + h(pw) + '</div><p class="small muted">Sign-in page: <span class="mono">' + h(location.origin) + '/admin</span>. This password is shown once and is not saved anywhere.</p>',
      actions: [{ label: 'Copy', onClick: function () { navigator.clipboard && navigator.clipboard.writeText(pw); toast('Copied'); return Promise.resolve(true); } }, { label: 'Done', cls: 'primary' }] });
  }
  function staffDialog(u) {
    if (!u) {
      return modal({ title: 'Add staff member', body:
        '<div class="grid g2"><div class="field"><label>Name</label><input class="input" name="name"></div><div class="field"><label>Work email</label><input class="input" name="email" type="email"></div></div>' + permsBlock([]),
        onMount: wirePresets, actions: [{ label: 'Cancel' }, { label: 'Create account', cls: 'primary', onClick: function (m) {
          var email = val(m.el, 'email');
          return api('POST', '/users', { name: val(m.el, 'name'), email: email, perms: checkedPerms(m) }).then(function (r) { route(); showTempPassword(email, r.temp_password); });
        } }] });
    }
    modal({ title: u.name || u.email, body: '<p class="muted small">' + h(u.email) + '</p>' +
      '<div class="field"><label>Name</label><input class="input" name="name" value="' + h(u.name || '') + '"></div>' + permsBlock(u.perms) +
      '<label class="check"><input type="checkbox" name="active"' + (u.active ? ' checked' : '') + '><span><b>Account active</b><small class="muted" style="display:block">Untick to block sign-in immediately (keeps their history).</small></span></label>' +
      '<div class="row" style="margin-top:12px"><button type="button" class="btn sm" data-pw>Reset password</button>' + (u.totp_enabled ? '<button type="button" class="btn sm" data-2fa>Reset two-step sign-in</button>' : '') + (u.locked ? '<button type="button" class="btn sm" data-unlock>Unlock</button>' : '') + '</div>',
      onMount: function (m) {
        wirePresets(m);
        $('[data-pw]', m.el).onclick = function () {
          confirmBox('Reset password?', 'They will be signed out and need a new temporary password from you.', 'Reset password', 'danger').then(function (y) {
            if (y) api('POST', '/users/' + u.id + '/reset-password').then(function (r) { m.close(); showTempPassword(u.email, r.temp_password); route(); }).catch(fail);
          });
        };
        var t = $('[data-2fa]', m.el); if (t) t.onclick = function () { api('POST', '/users/' + u.id + '/reset-2fa').then(function () { toast('Two-step sign-in reset'); m.close(); route(); }).catch(fail); };
        var ul = $('[data-unlock]', m.el); if (ul) ul.onclick = function () { api('PUT', '/users/' + u.id, { unlock: true }).then(function () { toast('Unlocked'); m.close(); route(); }).catch(fail); };
      },
      actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: function (m) {
        return api('PUT', '/users/' + u.id, { name: val(m.el, 'name'), perms: checkedPerms(m), active: val(m.el, 'active') }).then(function () { toast('Saved — changes apply immediately'); route(); });
      } }] });
  }

  // ---- Activity log ----------------------------------------------------------------------
  VIEWS.activity = function (v) {
    var page = 1;
    v.innerHTML = head('Activity log', 'Who did what in this dashboard. Kept permanently.') + '<div class="card" data-list></div>';
    function load() {
      return api('GET', '/audit?page=' + page).then(function (r) {
        $('[data-list]', v).innerHTML = (r.entries.length ? '<div class="table-wrap"><table class="t"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Item</th><th>Details</th></tr></thead><tbody>' +
          r.entries.map(function (e) { return '<tr><td class="nowrap small">' + h(fdt(e.at)) + '</td><td class="small">' + h(e.user_email || 'system') + '</td><td><span class="mono">' + h(e.action) + '</span></td><td class="mono">' + h(e.target || '') + '</td><td class="small muted" style="max-width:380px;word-break:break-word">' + h(e.detail || '') + '</td></tr>'; }).join('') +
          '</tbody></table></div>' : '<div class="empty">No activity yet.</div>') +
          '<div class="pager"><span>Page ' + page + '</span><span class="row">' + (page > 1 ? '<button class="btn sm" data-p="-1">Newer</button>' : '') + (r.entries.length === 100 ? '<button class="btn sm" data-p="1">Older</button>' : '') + '</span></div>';
        $$('[data-p]', v).forEach(function (b) { b.onclick = function () { page += +b.getAttribute('data-p'); load().catch(fail); }; });
      });
    }
    return load();
  };

  // ---- Settings -----------------------------------------------------------------------------
  VIEWS.settings = function (v) {
    return api('GET', '/settings').then(function (r) {
      var s = r.settings, y = r.system;
      v.innerHTML = head('Settings') + '<div class="split"><form class="card" data-form><div class="card-h"><h2>Delivery & checkout</h2></div><div class="card-b">' +
        '<div class="grid g2"><div class="field"><label>Delivery fee (EGP)</label><input class="input" name="fee" inputmode="decimal" value="' + h(fromCents(s.shipping_flat_cents)) + '"></div>' +
        '<div class="field"><label>Free delivery for orders over (EGP)</label><input class="input" name="free" inputmode="decimal" value="' + h(s.shipping_free_over_cents == null ? '' : fromCents(s.shipping_free_over_cents)) + '" placeholder="Leave empty for never"></div></div>' +
        '<div class="grid g2"><div class="field"><label>Cancel unpaid orders after (hours)</label><input class="input" name="expiry" inputmode="numeric" value="' + h(s.unpaid_expiry_hours) + '"></div>' +
        '<div class="field"><label>Most units of one product per order</label><input class="input" name="maxq" inputmode="numeric" value="' + h(s.checkout_max_qty) + '"></div></div>' +
        '<div class="row end"><button class="btn primary">Save settings</button></div></div></form>' +
        '<div class="card"><div class="card-h"><h2>Connections</h2></div><div class="card-b"><dl class="kv">' +
        '<dt>Payments</dt><dd>' + (y.payments_live ? '<span class="chip delivered">Live</span> ' + y.paymob_integrations + ' Paymob method(s)' : '<span class="chip paid">Demo mode</span>') + '</dd>' +
        '<dt>Site address</dt><dd class="mono">' + h(y.site_url) + '</dd>' +
        '<dt>Email</dt><dd>' + (y.mail_ready ? '<span class="chip delivered">Set up</span> ' + h(y.mail_transport) + (y.mail_host ? ' · ' + h(y.mail_host) : '') : '<span class="chip">Not set up</span>') + '</dd>' +
        (y.mail_ready ? '<dt>Sends from</dt><dd>' + h(y.mail_from) + '</dd><dt>Order alerts to</dt><dd>' + h((y.order_notify_to || []).join(', ') || '— (set ORDER_NOTIFY_TO)') + '</dd>' : '') +
        '<dt>Database</dt><dd>' + (y.db === 'mysql' ? 'MySQL' : 'SQLite') + '</dd><dt>Node.js</dt><dd>' + h(y.node) + '</dd></dl>' +
        '<p class="small muted">These come from the environment variables in cPanel → Setup Node.js App. Change them there and restart the app.</p>' +
        (y.mail_ready ? '<button class="btn" data-test>Send me a test email</button>' : '') + '</div></div></div>';
      $('[data-form]', v).onsubmit = function (e) {
        e.preventDefault();
        var f = e.target, fee = toCents(val(f, 'fee')), free = val(f, 'free').trim();
        if (!(fee >= 0)) return toast('Enter a valid delivery fee', true);
        api('PUT', '/settings', { shipping_flat_cents: fee, shipping_free_over_cents: free === '' ? null : toCents(free),
          unpaid_expiry_hours: parseInt(val(f, 'expiry'), 10), checkout_max_qty: parseInt(val(f, 'maxq'), 10) })
          .then(function () { toast('Settings saved — the shop uses them now'); route(); }).catch(fail);
      };
      var t = $('[data-test]', v); if (t) t.onclick = function () { t.disabled = true; api('POST', '/test-email').then(function (r) { toast('Test email sent to ' + r.to); }).catch(fail).then(function () { t.disabled = false; }); };
    });
  };

  // ---- My account ---------------------------------------------------------------------------
  VIEWS.account = function (v) {
    v.innerHTML = head('My account', h(S.me.email)) + '<div class="grid g2">' +
      '<form class="card" data-pw><div class="card-h"><h2>Change password</h2></div><div class="card-b">' +
      '<div class="field"><label>Current password</label><input class="input" type="password" name="current" autocomplete="current-password"></div>' +
      '<div class="field"><label>New password</label><input class="input" type="password" name="password" autocomplete="new-password"><div class="hint">At least 10 characters. Changing it signs you out on other devices.</div></div>' +
      '<div class="field"><label>Repeat new password</label><input class="input" type="password" name="again" autocomplete="new-password"></div>' +
      '<div class="row end"><button class="btn primary">Change password</button></div></div></form>' +
      '<div class="card"><div class="card-h"><h2>Two-step sign-in</h2>' + (S.me.totp_enabled ? '<span class="chip delivered">On</span>' : '<span class="chip">Off</span>') + '</div><div class="card-b" data-totp></div></div></div>';
    var f = $('[data-pw]', v);
    f.onsubmit = function (e) {
      e.preventDefault();
      if (val(f, 'password') !== val(f, 'again')) return toast('The two new passwords do not match', true);
      api('POST', '/me/password', { current: val(f, 'current'), password: val(f, 'password') }).then(function () { toast('Password changed'); f.reset(); }).catch(fail);
    };
    var box = $('[data-totp]', v);
    if (S.me.totp_enabled) {
      box.innerHTML = '<p>Signing in needs your password <b>and</b> a code from your authenticator app.</p><div class="field"><label>Password (to turn it off)</label><input class="input" type="password" name="pw"></div><button class="btn danger" data-off>Turn off two-step sign-in</button>';
      $('[data-off]', box).onclick = function () { api('POST', '/me/totp/disable', { password: $('input', box).value }).then(function () { toast('Two-step sign-in turned off'); return boot(); }).catch(fail); };
    } else {
      box.innerHTML = '<p>Adds a 6-digit code from your phone when you sign in, so a stolen password is not enough. Use Google Authenticator, Microsoft Authenticator or similar.</p><button class="btn primary" data-on>Set it up</button>';
      $('[data-on]', box).onclick = function () {
        api('POST', '/me/totp/setup').then(function (r) {
          var qr = '';
          try { var q = window.qrcode(0, 'M'); q.addData(r.otpauth); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch (e) {}
          box.innerHTML = '<ol style="padding-left:18px;margin:0 0 12px"><li>Open your authenticator app and add an account.</li><li>Scan this code, or type the key below.</li><li>Enter the 6-digit code the app shows.</li></ol>' +
            (qr ? '<div class="qr">' + qr + '</div>' : '') + '<div class="secret">' + h(r.secret.replace(/(.{4})/g, '$1 ').trim()) + '</div>' +
            '<div class="field" style="margin-top:12px"><label>Code from the app</label><input class="input code" inputmode="numeric" maxlength="6" name="code"></div><button class="btn primary" data-confirm>Turn on</button>';
          $('[data-confirm]', box).onclick = function () {
            api('POST', '/me/totp/enable', { code: $('input[name=code]', box).value }).then(function () { toast('Two-step sign-in is on'); return boot(); }).catch(fail);
          };
        }).catch(fail);
      };
    }
  };

  // ---------------------------------------------------------------- boot
  function boot() {
    return api('GET', '/me').then(function (r) {
      S.me = r.user; S.perms = r.user.perms; S.statuses = r.statuses; S.permissions = r.permissions; S.presets = r.presets; S.system = r.system;
      if (S.me.must_change_pw) { screenPassword(true); return; }
      app.innerHTML = '';
      route();
      refreshCounts().catch(function () {});
    }).catch(function (e) {
      S.me = null;
      if (e.code === 'totp') screenTotp();
      else if (e.status === 503) app.innerHTML = '<div class="auth"><div class="auth-card"><span class="brand-word">TRUMAN<i>.</i></span><h1>Starting up…</h1><p class="lead">The database is not available yet. This page will retry.</p></div></div>', setTimeout(boot, 10000);
      else screenLogin(e.code === 'signin' ? '' : e.message);
    });
  }
  setInterval(function () { if (S.me && !document.hidden) refreshCounts().catch(function () {}); }, 60000);
  boot();
})();
