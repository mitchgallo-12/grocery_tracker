/* ==========================================================================
   Grocery Tracker — app.js
   Vanilla JS dashboard. Pulls from Apps Script web app, renders views,
   POSTs flag/edit ops back. Single-user, read-mostly.
   ========================================================================== */

(function () {
  'use strict';

  // ----- State --------------------------------------------------------------
  var state = {
    data: null,            // last pulled data shape from the web app
    view: 'dashboard',
    syncUrl: null,         // Apps Script /exec URL (from localStorage)
    lastPulledAt: null,
    pulling: false,
    pricingMode: 'unit',   // 'unit' (per-unit) | 'package' (per-package)
    expandedItems: {}      // { normalized_name: true } — which item rows are expanded
  };

  var LS_URL = 'grocery_tracker_sync_url';
  var LS_PRICING = 'grocery_tracker_pricing_mode';
  var LS_LAST_PULL = 'grocery_tracker_last_pull';

  // Chart.js instances we create — keep references so we can destroy on re-render
  var charts = {};

  // ----- DOM helpers --------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') e.className = attrs[k];
        else if (k === 'html') e.innerHTML = attrs[k];
        else if (k === 'text') e.textContent = attrs[k];
        else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') {
          e.addEventListener(k.substring(2).toLowerCase(), attrs[k]);
        } else if (k === 'dataset') {
          for (var dk in attrs[k]) e.dataset[dk] = attrs[k][dk];
        } else if (attrs[k] != null) {
          e.setAttribute(k, attrs[k]);
        }
      }
    }
    if (children != null) {
      if (!Array.isArray(children)) children = [children];
      children.forEach(function (c) {
        if (c == null || c === false) return;
        if (typeof c === 'string' || typeof c === 'number') e.appendChild(document.createTextNode(c));
        else e.appendChild(c);
      });
    }
    return e;
  }

  function clearNode(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function destroyCharts() {
    Object.keys(charts).forEach(function (k) {
      try { charts[k].destroy(); } catch (_) {}
      delete charts[k];
    });
  }

  // ----- Formatting ---------------------------------------------------------
  function fmtUSD(n, opts) {
    if (n == null || n === '' || isNaN(Number(n))) return '—';
    var num = Number(n);
    var minF = (opts && opts.minF != null) ? opts.minF : 2;
    var maxF = (opts && opts.maxF != null) ? opts.maxF : 2;
    return '$' + num.toLocaleString(undefined, { minimumFractionDigits: minF, maximumFractionDigits: maxF });
  }
  function fmtNum(n, digits) {
    if (n == null || n === '' || isNaN(Number(n))) return '—';
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits == null ? 2 : digits });
  }
  function fmtPct(n, digits) {
    if (n == null || isNaN(Number(n))) return '—';
    return (Number(n) * 100).toFixed(digits == null ? 1 : digits) + '%';
  }
  function fmtDate(d) {
    if (!d) return '—';
    var dt = (d instanceof Date) ? d : parseDate(d);
    if (!dt) return String(d);
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtRelative(dStr) {
    if (!dStr) return '—';
    var dt = new Date(dStr);
    if (isNaN(dt.getTime())) return '—';
    var diff = (Date.now() - dt.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }
  function parseDate(s) {
    if (!s) return null;
    if (s instanceof Date) return s;
    // Accept YYYY-MM-DD or full ISO
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  // Sun = 0, Sat = 6 — return the Sunday at the start of the given date's week
  function weekStart(d) {
    var dt = parseDate(d);
    if (!dt) return null;
    var day = dt.getDay();
    var s = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - day);
    return s;
  }
  function weekKey(d) {
    var s = weekStart(d);
    if (!s) return '—';
    var y = s.getFullYear();
    var m = String(s.getMonth() + 1).padStart(2, '0');
    var day = String(s.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  function weekLabel(key) {
    var dt = parseDate(key);
    if (!dt) return key;
    var end = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 6);
    var sameMonth = dt.getMonth() === end.getMonth();
    var fmt = function (d, withYear) {
      var opts = { month: 'short', day: 'numeric' };
      if (withYear) opts.year = '2-digit';
      return d.toLocaleDateString(undefined, opts);
    };
    return sameMonth
      ? fmt(dt) + '–' + end.getDate()
      : fmt(dt) + '–' + fmt(end);
  }

  // ----- Sync / API ---------------------------------------------------------
  function loadSettings() {
    state.syncUrl = localStorage.getItem(LS_URL) || null;
    state.pricingMode = localStorage.getItem(LS_PRICING) || 'unit';
    state.lastPulledAt = localStorage.getItem(LS_LAST_PULL) || null;
  }
  function saveSyncUrl(url) {
    state.syncUrl = url;
    if (url) localStorage.setItem(LS_URL, url);
    else localStorage.removeItem(LS_URL);
  }
  function savePricingMode(m) {
    state.pricingMode = m;
    localStorage.setItem(LS_PRICING, m);
  }

  function pull() {
    if (!state.syncUrl) {
      openSyncModal();
      return Promise.resolve(null);
    }
    state.pulling = true;
    renderSyncStatus();
    return fetch(state.syncUrl, { method: 'GET', redirect: 'follow' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (text) {
        var json;
        try { json = JSON.parse(text); }
        catch (e) {
          throw new Error('Got HTML/non-JSON. Make sure the deployment is set to "Anyone with link".');
        }
        if (!json.ok) throw new Error(json.error || 'Pull failed');
        state.data = json.data;
        state.lastPulledAt = new Date().toISOString();
        localStorage.setItem(LS_LAST_PULL, state.lastPulledAt);
        toast('Pulled ' + (state.data.receipts || []).length + ' receipts.', 'success');
      })
      .catch(function (err) {
        toast('Pull failed: ' + err.message, 'error');
      })
      .then(function () {
        state.pulling = false;
        renderSyncStatus();
        renderView();
      });
  }

  function postOp(op, payload) {
    if (!state.syncUrl) {
      toast('Configure Sync first', 'error');
      return Promise.reject(new Error('no sync url'));
    }
    // Apps Script doesn't preflight text/plain bodies — keeps CORS simple.
    return fetch(state.syncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ op: op, payload: payload }),
      redirect: 'follow'
    })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var j;
        try { j = JSON.parse(t); }
        catch (e) { throw new Error('non-JSON response'); }
        if (!j.ok) throw new Error(j.error || 'op failed');
        return j.result;
      });
  }

  // ----- Modal --------------------------------------------------------------
  function openModal(node) {
    var root = $('#modal-root');
    clearNode(root);
    var backdrop = el('div', { class: 'modal-backdrop', onClick: function (e) {
      if (e.target === backdrop) closeModal();
    } });
    backdrop.appendChild(node);
    root.appendChild(backdrop);
  }
  function closeModal() {
    var root = $('#modal-root');
    clearNode(root);
  }

  function openSyncModal() {
    var input = el('input', { type: 'url', placeholder: 'https://script.google.com/macros/s/AKfy.../exec', value: state.syncUrl || '' });
    var modal = el('div', { class: 'modal' }, [
      el('h2', null, 'Sync settings'),
      el('div', { class: 'modal-sub' }, 'Paste the Web app URL from your Apps Script deployment. The browser remembers it locally — you only do this once per device.'),
      el('label', null, 'Apps Script /exec URL'),
      input,
      el('div', { class: 'modal-actions' }, [
        el('button', { onClick: closeModal }, 'Cancel'),
        el('button', { class: 'btn-primary', onClick: function () {
          var v = (input.value || '').trim();
          saveSyncUrl(v || null);
          closeModal();
          renderSyncStatus();
          if (v) pull();
        } }, 'Save')
      ])
    ]);
    openModal(modal);
    setTimeout(function () { input.focus(); }, 50);
  }

  // ----- Toast --------------------------------------------------------------
  function toast(msg, kind) {
    var root = $('#toast-root');
    var t = el('div', { class: 'toast' + (kind ? ' ' + kind : '') }, msg);
    root.appendChild(t);
    setTimeout(function () { try { root.removeChild(t); } catch (_) {} }, 3500);
  }

  // ----- Computations -------------------------------------------------------

  // All line items joined with their receipt's date/store (already denormalized
  // in the LineItems schema, but we double-check from receipts when missing).
  function getLineItems() {
    var d = state.data || {};
    var receipts = d.receipts || [];
    var byId = {};
    receipts.forEach(function (r) { byId[r.id] = r; });
    return (d.lineitems || []).map(function (li) {
      var rec = byId[li.receipt_id] || {};
      return {
        id: li.id,
        receipt_id: li.receipt_id,
        date: li.date || rec.date || '',
        store: li.store || rec.store || '',
        raw_name: li.raw_name || '',
        normalized_name: li.normalized_name || li.raw_name || '',
        category: li.category || 'Other',
        qty: Number(li.qty) || 0,
        unit: li.unit || '',
        unit_price: Number(li.unit_price) || 0,
        line_total: Number(li.line_total) || 0
      };
    });
  }

  // Returns price-per-line — based on pricing mode.
  // 'unit' = unit_price (price per oz/lb/ea/etc.)
  // 'package' = line_total / qty (price per package as bought)
  function priceFor(li) {
    if (state.pricingMode === 'unit') {
      if (li.unit_price) return li.unit_price;
      if (li.qty > 0) return li.line_total / li.qty;
      return li.line_total;
    } else {
      if (li.qty > 0) return li.line_total / li.qty;
      return li.line_total;
    }
  }

  // Group line items by Sun-Sat week → { weekKey: { total, count, items[] } }
  function aggregateByWeek(items) {
    var by = {};
    items.forEach(function (li) {
      var k = weekKey(li.date);
      if (!by[k]) by[k] = { total: 0, count: 0, items: [] };
      by[k].total += li.line_total;
      by[k].count += 1;
      by[k].items.push(li);
    });
    return by;
  }

  // Sorted list of weeks (oldest → newest) covering the data range
  function weekRange(items) {
    if (!items.length) return [];
    var dates = items.map(function (i) { return parseDate(i.date); }).filter(Boolean).sort(function (a, b) { return a - b; });
    if (!dates.length) return [];
    var start = weekStart(dates[0]);
    var end = weekStart(dates[dates.length - 1]);
    var keys = [];
    var cur = new Date(start);
    while (cur <= end) {
      keys.push(weekKey(cur));
      cur.setDate(cur.getDate() + 7);
    }
    return keys;
  }

  // Group by store → { store: { total, trips, items[], topCategories } }
  function aggregateByStore(items, receipts) {
    var by = {};
    items.forEach(function (li) {
      var s = li.store || 'Unknown';
      if (!by[s]) by[s] = { store: s, total: 0, items: [], categories: {} };
      by[s].total += li.line_total;
      by[s].items.push(li);
      by[s].categories[li.category] = (by[s].categories[li.category] || 0) + li.line_total;
    });
    receipts.forEach(function (r) {
      var s = r.store || 'Unknown';
      if (!by[s]) by[s] = { store: s, total: 0, items: [], categories: {} };
      by[s].trips = (by[s].trips || 0) + 1;
    });
    return by;
  }

  // Group by category → { category: total }
  function aggregateByCategory(items) {
    var by = {};
    items.forEach(function (li) {
      var c = li.category || 'Other';
      by[c] = (by[c] || 0) + li.line_total;
    });
    return by;
  }

  // Group by normalized item → { normalized_name: { name, count, totalSpent, prices[], stores{}, lastDate, avgPrice } }
  function aggregateByItem(items) {
    var by = {};
    items.forEach(function (li) {
      var n = li.normalized_name || li.raw_name || '(unnamed)';
      if (!by[n]) by[n] = {
        name: n,
        count: 0,
        totalSpent: 0,
        prices: [],
        stores: {},
        lastDate: null,
        category: li.category
      };
      var entry = by[n];
      entry.count += 1;
      entry.totalSpent += li.line_total;
      var p = priceFor(li);
      entry.prices.push({ date: li.date, store: li.store, price: p, qty: li.qty, unit: li.unit, line_total: li.line_total });
      entry.stores[li.store] = (entry.stores[li.store] || 0) + 1;
      var d = parseDate(li.date);
      if (d && (!entry.lastDate || d > entry.lastDate)) entry.lastDate = d;
    });
    Object.keys(by).forEach(function (k) {
      var e = by[k];
      e.avgPrice = e.prices.reduce(function (s, p) { return s + p.price; }, 0) / e.prices.length;
      e.minPrice = e.prices.reduce(function (m, p) { return p.price < m ? p.price : m; }, e.prices[0].price);
      e.maxPrice = e.prices.reduce(function (m, p) { return p.price > m ? p.price : m; }, e.prices[0].price);
      e.priceRange = e.maxPrice - e.minPrice;
      e.volatility = e.avgPrice > 0 ? e.priceRange / e.avgPrice : 0;
      e.storeCount = Object.keys(e.stores).length;
    });
    return by;
  }

  // ----- Sync status (sidebar) ---------------------------------------------
  function renderSyncStatus() {
    var status = $('#sync-status');
    var last = $('#sync-last');
    var btn = $('#pull-btn');
    if (!state.syncUrl) {
      status.textContent = 'Not configured';
      last.textContent = 'Click sync settings →';
    } else if (state.pulling) {
      status.textContent = 'Pulling…';
      last.textContent = '';
    } else {
      status.textContent = 'Connected';
      last.textContent = 'Last pull: ' + (state.lastPulledAt ? fmtRelative(state.lastPulledAt) : 'never');
    }
    btn.disabled = state.pulling;
  }

  // ----- Views --------------------------------------------------------------
  function setView(view) {
    state.view = view;
    $$('.nav-link').forEach(function (n) { n.classList.toggle('active', n.dataset.view === view); });
    renderView();
  }

  function renderView() {
    destroyCharts();
    var main = $('#main');
    clearNode(main);

    if (!state.data) {
      main.appendChild(renderEmptyShell());
      return;
    }

    switch (state.view) {
      case 'dashboard':  main.appendChild(renderDashboard()); break;
      case 'stores':     main.appendChild(renderStores()); break;
      case 'categories': main.appendChild(renderCategories()); break;
      case 'items':      main.appendChild(renderItems()); break;
      case 'receipts':   main.appendChild(renderReceipts()); break;
      case 'sync':       openSyncModal(); main.appendChild(renderDashboard()); break;
      default:           main.appendChild(renderDashboard());
    }
  }

  function renderEmptyShell() {
    var configured = !!state.syncUrl;
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty-title' }, configured ? 'No data yet' : 'Welcome'),
      el('div', { class: 'empty-body' }, configured
        ? 'Drop a receipt photo into your Claude chat to ingest your first trip. Then click Pull.'
        : 'Configure sync to point at your Apps Script web-app URL to start tracking your weekly groceries.'),
      el('div', { style: 'margin-top:18px;' }, [
        el('button', { class: 'btn-primary', onClick: openSyncModal }, configured ? 'Edit sync settings' : 'Configure sync')
      ])
    ]);
  }

  // ----- Dashboard view -----------------------------------------------------
  function renderDashboard() {
    var items = getLineItems();
    var receipts = state.data.receipts || [];
    var weeks = aggregateByWeek(items);
    var weekKeys = weekRange(items);
    var thisWeek = weekKey(new Date());
    var lastWeek = weekKeys[weekKeys.indexOf(thisWeek) - 1] || weekKeys[weekKeys.length - 2];

    var thisTotal = (weeks[thisWeek] || { total: 0 }).total;
    var lastTotal = (weeks[lastWeek] || { total: 0 }).total;
    var delta = lastTotal > 0 ? (thisTotal - lastTotal) / lastTotal : null;

    var allTimeTotal = items.reduce(function (s, i) { return s + i.line_total; }, 0);
    var avgPerWeek = weekKeys.length > 0 ? allTimeTotal / weekKeys.length : 0;

    var wrap = el('div', null, [
      // Header
      el('div', { class: 'view-header' }, [
        el('div', null, [
          el('div', { class: 'view-eyebrow' }, 'Overview'),
          el('div', { class: 'view-title' }, 'Dashboard'),
          el('div', { class: 'view-sub' }, 'Weekly grocery spend across ' + Object.keys(aggregateByStore(items, receipts)).length + ' stores. Sun–Sat weeks. Toggle pricing to compare per-unit vs. per-package.')
        ]),
        el('div', { class: 'view-controls' }, pricingToggle())
      ]),

      // KPI strip
      el('div', { class: 'kpi-row' }, [
        kpi('This week', fmtUSD(thisTotal), thisWeek === '—' ? '' : weekLabel(thisWeek)),
        kpi('vs. last week', delta == null ? '—' : (delta >= 0 ? '+' : '') + (delta * 100).toFixed(0) + '%',
            'last week ' + fmtUSD(lastTotal), delta == null ? null : (delta >= 0 ? 'up' : 'down')),
        kpi('Avg per week', fmtUSD(avgPerWeek), weekKeys.length + ' weeks tracked'),
        kpi('Items tracked', String(items.length), receipts.length + ' receipts')
      ]),

      // Trend
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('div', { class: 'card-title' }, 'Weekly spend'),
          el('div', { class: 'card-sub' }, 'Sun–Sat')
        ]),
        el('div', { class: 'chart-wrap tall', id: 'trend-wrap' })
      ]),

      // Two-up: category donut + store breakdown
      el('div', { class: 'grid-2' }, [
        el('div', { class: 'card' }, [
          el('div', { class: 'card-header' }, [
            el('div', { class: 'card-title' }, 'By category'),
            el('div', { class: 'card-sub' }, 'all time')
          ]),
          el('div', { class: 'chart-wrap', id: 'cat-wrap' })
        ]),
        el('div', { class: 'card' }, [
          el('div', { class: 'card-header' }, [
            el('div', { class: 'card-title' }, 'By store'),
            el('div', { class: 'card-sub' }, 'all time')
          ]),
          renderStoreList(aggregateByStore(items, receipts))
        ])
      ]),

      // Cross-store volatility
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('div', null, [
            el('div', { class: 'card-title' }, 'Cross-store volatility'),
            el('div', { class: 'card-sub' }, 'items bought at 2+ stores, ranked by price spread')
          ])
        ]),
        renderVolatilityTable(items)
      ]),

      // Frequently-bought
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('div', null, [
            el('div', { class: 'card-title' }, 'Frequently bought'),
            el('div', { class: 'card-sub' }, 'top items by purchase count')
          ])
        ]),
        renderFrequentTable(items)
      ])
    ]);

    // After the DOM is in place, mount the charts
    setTimeout(function () {
      mountTrendChart(weekKeys, weeks);
      mountCategoryChart(aggregateByCategory(items));
    }, 0);

    return wrap;
  }

  function pricingToggle() {
    return el('div', { class: 'toggle' }, [
      el('button', { class: state.pricingMode === 'unit' ? 'on' : '', onClick: function () {
        savePricingMode('unit'); renderView();
      } }, 'Per unit'),
      el('button', { class: state.pricingMode === 'package' ? 'on' : '', onClick: function () {
        savePricingMode('package'); renderView();
      } }, 'Per package')
    ]);
  }

  function kpi(label, value, foot, dir) {
    var classes = 'kpi-foot' + (dir ? ' ' + dir : '');
    return el('div', { class: 'kpi-card' }, [
      el('div', { class: 'kpi-label' }, label),
      el('div', { class: 'kpi-value' }, value),
      foot ? el('div', { class: classes }, foot) : null
    ]);
  }

  function renderStoreList(byStore) {
    var stores = Object.keys(byStore).map(function (k) { return byStore[k]; })
      .sort(function (a, b) { return b.total - a.total; });
    if (!stores.length) {
      return el('div', { class: 'empty-body' }, 'No store data yet.');
    }
    var max = stores[0].total || 1;
    return el('div', null, stores.map(function (s) {
      var pct = (s.total / max) * 100;
      return el('div', { style: 'margin-bottom:14px;' }, [
        el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:4px;' }, [
          el('div', { style: 'font-family:var(--serif);font-size:18px;color:var(--brackish);font-weight:500;' }, s.store),
          el('div', { style: 'font-variant-numeric:tabular-nums;' }, fmtUSD(s.total))
        ]),
        el('div', { style: 'height:4px;background:var(--rule-soft);position:relative;' }, [
          el('div', { style: 'position:absolute;left:0;top:0;height:100%;width:' + pct + '%;background:var(--cordovan);' })
        ]),
        el('div', { style: 'font-size:11px;color:var(--warm-stone);margin-top:4px;letter-spacing:0.04em;' },
          (s.trips || 0) + ' trips · ' + s.items.length + ' items')
      ]);
    }));
  }

  // Build the detail (purchase history) row that appears under an expanded item.
  // Sorted by date descending. Min/max prices highlighted.
  function buildPurchaseDetail(item, colspan) {
    var rows = item.prices.slice().sort(function (a, b) {
      var da = parseDate(a.date), db = parseDate(b.date);
      return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
    });
    var minP = item.minPrice, maxP = item.maxPrice;

    var inner = el('table', { class: 'inner-data' }, [
      el('thead', null, el('tr', null, [
        el('th', null, 'Date'),
        el('th', null, 'Store'),
        el('th', { class: 'num' }, 'Qty'),
        el('th', { class: 'num' }, 'Unit price'),
        el('th', { class: 'num' }, 'Line total'),
        el('th', null, '')
      ])),
      el('tbody', null, rows.map(function (p) {
        var price = Number(p.price) || 0;
        var isMin = Math.abs(price - minP) < 0.001;
        var isMax = Math.abs(price - maxP) < 0.001 && minP !== maxP;
        var marker = isMax
          ? el('span', { class: 'pill danger' }, 'high')
          : isMin
            ? el('span', { class: 'pill brackish' }, 'low')
            : null;
        var cls = isMax ? 'price-high' : (isMin ? 'price-low' : '');
        return el('tr', null, [
          el('td', null, fmtDate(p.date)),
          el('td', null, p.store || '—'),
          el('td', { class: 'num' }, fmtNum(p.qty, 2) + (p.unit ? ' ' + p.unit : '')),
          el('td', { class: 'num ' + cls }, fmtUSD(price, { maxF: 3 })),
          el('td', { class: 'num' }, fmtUSD(p.line_total)),
          el('td', null, marker)
        ]);
      }))
    ]);

    return el('tr', { class: 'expand-detail' }, [
      el('td', { colspan: String(colspan) }, [
        el('div', { class: 'detail-wrap' }, [
          el('div', { class: 'detail-meta' },
            rows.length + ' purchases · ' + Object.keys(item.stores).join(', ')),
          inner
        ])
      ])
    ]);
  }

  // Make a <tr> click-to-expand. Returns an array [mainRow, detailRowOrNull]
  // so the caller can append both into <tbody>. State persists via state.expandedItems.
  // `rerender` defaults to renderView, but the items view passes its own
  // renderTable so its search input doesn't get torn down on each click.
  function expandableRow(item, colspan, mainCells, rerender) {
    var key = item.name;
    var isOpen = !!state.expandedItems[key];
    var caret = el('span', { class: 'caret' + (isOpen ? ' open' : '') }, '▸');
    // Inject caret into the first cell
    if (mainCells.length && mainCells[0].nodeName === 'TD') {
      mainCells[0].insertBefore(caret, mainCells[0].firstChild);
    }
    var main = el('tr', {
      class: 'expandable' + (isOpen ? ' open' : ''),
      onClick: function () {
        if (state.expandedItems[key]) delete state.expandedItems[key];
        else state.expandedItems[key] = true;
        (rerender || renderView)();
      }
    });
    mainCells.forEach(function (c) { main.appendChild(c); });
    return [main, isOpen ? buildPurchaseDetail(item, colspan) : null];
  }

  function renderVolatilityTable(items) {
    var byItem = aggregateByItem(items);
    var rows = Object.keys(byItem).map(function (k) { return byItem[k]; })
      .filter(function (e) { return e.storeCount >= 2; })
      .sort(function (a, b) { return b.volatility - a.volatility; })
      .slice(0, 12);

    if (!rows.length) {
      return el('div', { class: 'empty-body' }, 'No cross-store items yet — buy the same item at two different stores to see volatility data.');
    }

    var unitLabel = state.pricingMode === 'unit' ? 'per unit' : 'per package';
    var COLS = 6;
    var table = el('table', { class: 'data expandable-table' });
    table.appendChild(el('thead', null, el('tr', null, [
      el('th', null, 'Item'),
      el('th', null, 'Stores'),
      el('th', { class: 'num' }, 'Min ' + unitLabel),
      el('th', { class: 'num' }, 'Max ' + unitLabel),
      el('th', { class: 'num' }, 'Range'),
      el('th', { class: 'num' }, 'Volatility')
    ])));
    var tbody = el('tbody');
    rows.forEach(function (e) {
      var pair = expandableRow(e, COLS, [
        el('td', null, [
          el('div', null, e.name),
          el('div', { class: 'cell-meta' }, e.category)
        ]),
        el('td', null, Object.keys(e.stores).join(', ')),
        el('td', { class: 'num' }, fmtUSD(e.minPrice, { maxF: 3 })),
        el('td', { class: 'num' }, fmtUSD(e.maxPrice, { maxF: 3 })),
        el('td', { class: 'num' }, fmtUSD(e.priceRange, { maxF: 3 })),
        el('td', { class: 'num' }, fmtPct(e.volatility, 0))
      ]);
      tbody.appendChild(pair[0]);
      if (pair[1]) tbody.appendChild(pair[1]);
    });
    table.appendChild(tbody);
    return table;
  }

  function renderFrequentTable(items) {
    var byItem = aggregateByItem(items);
    var rows = Object.keys(byItem).map(function (k) { return byItem[k]; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, 12);

    if (!rows.length) {
      return el('div', { class: 'empty-body' }, 'No items yet.');
    }

    var unitLabel = state.pricingMode === 'unit' ? 'avg per unit' : 'avg per package';
    var COLS = 5;
    var table = el('table', { class: 'data expandable-table' });
    table.appendChild(el('thead', null, el('tr', null, [
      el('th', null, 'Item'),
      el('th', { class: 'num' }, 'Times bought'),
      el('th', { class: 'num' }, unitLabel),
      el('th', { class: 'num' }, 'Total spent'),
      el('th', null, 'Trend')
    ])));
    var tbody = el('tbody');
    rows.forEach(function (e) {
      var last = e.prices[e.prices.length - 1].price;
      var trendCls = 'delta-flat', trendText = 'flat';
      if (last > e.avgPrice * 1.05) { trendCls = 'delta-up';   trendText = '↑ ' + fmtPct((last - e.avgPrice) / e.avgPrice, 0); }
      else if (last < e.avgPrice * 0.95) { trendCls = 'delta-down'; trendText = '↓ ' + fmtPct((e.avgPrice - last) / e.avgPrice, 0); }
      var pair = expandableRow(e, COLS, [
        el('td', null, [
          el('div', null, e.name),
          el('div', { class: 'cell-meta' }, e.category + ' · ' + e.storeCount + ' store' + (e.storeCount === 1 ? '' : 's'))
        ]),
        el('td', { class: 'num' }, String(e.count)),
        el('td', { class: 'num' }, fmtUSD(e.avgPrice, { maxF: 3 })),
        el('td', { class: 'num' }, fmtUSD(e.totalSpent)),
        el('td', null, el('span', { class: trendCls }, trendText))
      ]);
      tbody.appendChild(pair[0]);
      if (pair[1]) tbody.appendChild(pair[1]);
    });
    table.appendChild(tbody);
    return table;
  }

  // ----- Charts -------------------------------------------------------------
  var COLORS = {
    cordovan:   '#9E6B5A',
    brackish:   '#355850',
    warmStone:  '#7A7169',
    warmIvory:  '#F5EFE6',
    rule:       '#E8DFD2'
  };
  var CATEGORY_PALETTE = [
    '#9E6B5A', '#355850', '#7A9E7E', '#C8A97E', '#A8C5D6', '#D4A373',
    '#5B8E8B', '#E0A87E', '#B5896C', '#8B8580', '#A89B92', '#7A7169'
  ];

  function mountTrendChart(weekKeys, weeks) {
    var canvas = $('#trend-wrap');
    if (!canvas) return;
    canvas.innerHTML = '';
    var c = document.createElement('canvas');
    canvas.appendChild(c);
    if (!weekKeys.length) {
      canvas.innerHTML = '<div class="empty-body" style="padding:60px 0;">No weeks yet.</div>';
      return;
    }
    var labels = weekKeys.map(weekLabel);
    var data = weekKeys.map(function (k) { return weeks[k] ? weeks[k].total : 0; });
    charts.trend = new Chart(c.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          borderColor: COLORS.cordovan,
          backgroundColor: 'rgba(158,107,90,0.08)',
          fill: true,
          tension: 0.25,
          pointRadius: 3,
          pointBackgroundColor: COLORS.cordovan,
          pointBorderColor: COLORS.cordovan,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: {
          callbacks: { label: function (ctx) { return fmtUSD(ctx.parsed.y); } }
        } },
        scales: {
          x: { grid: { display: false }, ticks: { color: COLORS.warmStone, font: { family: 'DM Sans', size: 10 } } },
          y: { grid: { color: COLORS.rule }, ticks: { color: COLORS.warmStone, font: { family: 'DM Sans', size: 10 },
            callback: function (v) { return '$' + Number(v).toLocaleString(); } } }
        }
      }
    });
  }

  function mountCategoryChart(byCat) {
    var wrap = $('#cat-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    var c = document.createElement('canvas');
    wrap.appendChild(c);
    var keys = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; });
    if (!keys.length) {
      wrap.innerHTML = '<div class="empty-body" style="padding:60px 0;">No category data yet.</div>';
      return;
    }
    var values = keys.map(function (k) { return byCat[k]; });
    charts.cat = new Chart(c.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: keys,
        datasets: [{
          data: values,
          backgroundColor: keys.map(function (_, i) { return CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]; }),
          borderColor: COLORS.warmIvory,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: {
            color: COLORS.warmStone,
            font: { family: 'DM Sans', size: 10 },
            boxWidth: 10, boxHeight: 10
          } },
          tooltip: {
            callbacks: { label: function (ctx) { return ctx.label + ': ' + fmtUSD(ctx.parsed); } }
          }
        }
      }
    });
  }

  // ----- Stores view --------------------------------------------------------
  function renderStores() {
    var items = getLineItems();
    var receipts = state.data.receipts || [];
    var byStore = aggregateByStore(items, receipts);
    var stores = Object.keys(byStore).map(function (k) { return byStore[k]; }).sort(function (a, b) { return b.total - a.total; });

    var wrap = el('div', null, [
      el('div', { class: 'view-header' }, [
        el('div', null, [
          el('div', { class: 'view-eyebrow' }, 'Overview'),
          el('div', { class: 'view-title' }, 'Stores'),
          el('div', { class: 'view-sub' }, 'Per-store deep dive — what you buy where, and how often.')
        ])
      ])
    ]);

    if (!stores.length) {
      wrap.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'empty-title' }, 'No stores yet'),
        el('div', { class: 'empty-body' }, 'Upload a receipt to start tracking.')
      ]));
      return wrap;
    }

    stores.forEach(function (s) {
      var topCats = Object.keys(s.categories).map(function (k) { return { name: k, total: s.categories[k] }; })
        .sort(function (a, b) { return b.total - a.total; }).slice(0, 5);
      // Top items at this store
      var byItem = {};
      s.items.forEach(function (li) {
        var n = li.normalized_name || li.raw_name;
        if (!byItem[n]) byItem[n] = { name: n, count: 0, total: 0, prices: [] };
        byItem[n].count += 1;
        byItem[n].total += li.line_total;
        byItem[n].prices.push(priceFor(li));
      });
      var topItems = Object.keys(byItem).map(function (k) { return byItem[k]; })
        .sort(function (a, b) { return b.count - a.count; }).slice(0, 8);

      wrap.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('div', null, [
            el('div', { class: 'card-title' }, s.store),
            el('div', { class: 'card-sub' }, fmtUSD(s.total) + ' across ' + (s.trips || 0) + ' trips · ' + s.items.length + ' items')
          ])
        ]),
        el('div', { class: 'grid-2' }, [
          el('div', null, [
            el('div', { class: 'kpi-label' }, 'Top categories'),
            el('table', { class: 'data', style: 'margin-top:8px;' }, [
              el('tbody', null, topCats.map(function (c) {
                return el('tr', null, [
                  el('td', null, c.name),
                  el('td', { class: 'num' }, fmtUSD(c.total))
                ]);
              }))
            ])
          ]),
          el('div', null, [
            el('div', { class: 'kpi-label' }, 'Top items'),
            el('table', { class: 'data', style: 'margin-top:8px;' }, [
              el('tbody', null, topItems.map(function (i) {
                var avg = i.prices.reduce(function (s, p) { return s + p; }, 0) / i.prices.length;
                return el('tr', null, [
                  el('td', null, i.name),
                  el('td', { class: 'num' }, i.count + 'x'),
                  el('td', { class: 'num' }, fmtUSD(avg, { maxF: 3 }))
                ]);
              }))
            ])
          ])
        ])
      ]));
    });

    return wrap;
  }

  // ----- Categories view ----------------------------------------------------
  function renderCategories() {
    var items = getLineItems();
    var byCat = {};
    items.forEach(function (li) {
      var c = li.category || 'Other';
      if (!byCat[c]) byCat[c] = { name: c, total: 0, count: 0, items: [] };
      byCat[c].total += li.line_total;
      byCat[c].count += 1;
      byCat[c].items.push(li);
    });
    var rows = Object.keys(byCat).map(function (k) { return byCat[k]; }).sort(function (a, b) { return b.total - a.total; });

    var wrap = el('div', null, [
      el('div', { class: 'view-header' }, [
        el('div', null, [
          el('div', { class: 'view-eyebrow' }, 'Overview'),
          el('div', { class: 'view-title' }, 'Categories'),
          el('div', { class: 'view-sub' }, 'Spending by category. Categories are learned from your receipts and stored in the Sheet — edit there to retag.')
        ])
      ])
    ]);
    if (!rows.length) {
      wrap.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'empty-title' }, 'No categories yet'),
        el('div', { class: 'empty-body' }, 'Upload a receipt to populate.')
      ]));
      return wrap;
    }
    rows.forEach(function (c) {
      // Top items in this category
      var byItem = {};
      c.items.forEach(function (li) {
        var n = li.normalized_name || li.raw_name;
        if (!byItem[n]) byItem[n] = { name: n, count: 0, total: 0 };
        byItem[n].count += 1;
        byItem[n].total += li.line_total;
      });
      var topItems = Object.keys(byItem).map(function (k) { return byItem[k]; })
        .sort(function (a, b) { return b.total - a.total; }).slice(0, 8);

      wrap.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('div', null, [
            el('div', { class: 'card-title' }, c.name),
            el('div', { class: 'card-sub' }, fmtUSD(c.total) + ' · ' + c.count + ' line items')
          ])
        ]),
        el('table', { class: 'data' }, [
          el('thead', null, el('tr', null, [
            el('th', null, 'Item'), el('th', { class: 'num' }, 'Count'), el('th', { class: 'num' }, 'Total')
          ])),
          el('tbody', null, topItems.map(function (i) {
            return el('tr', null, [
              el('td', null, i.name),
              el('td', { class: 'num' }, String(i.count)),
              el('td', { class: 'num' }, fmtUSD(i.total))
            ]);
          }))
        ])
      ]));
    });
    return wrap;
  }

  // ----- Items view ---------------------------------------------------------
  function renderItems() {
    var items = getLineItems();
    var byItem = aggregateByItem(items);
    var allRows = Object.keys(byItem).map(function (k) { return byItem[k]; })
      .sort(function (a, b) { return b.totalSpent - a.totalSpent; });

    var searchInput = el('input', { type: 'text', placeholder: 'Search items…', style: 'width:240px;' });
    var tableWrap = el('div');

    function renderTable() {
      clearNode(tableWrap);
      var q = (searchInput.value || '').toLowerCase().trim();
      var filtered = !q ? allRows : allRows.filter(function (r) {
        return r.name.toLowerCase().indexOf(q) >= 0 || (r.category || '').toLowerCase().indexOf(q) >= 0;
      });
      if (!filtered.length) {
        tableWrap.appendChild(el('div', { class: 'empty-body', style: 'padding:30px 0;' }, 'No items match.'));
        return;
      }
      var unitLabel = state.pricingMode === 'unit' ? 'per unit' : 'per package';
      var COLS = 9;
      var table = el('table', { class: 'data expandable-table' });
      table.appendChild(el('thead', null, el('tr', null, [
        el('th', null, 'Item'),
        el('th', null, 'Category'),
        el('th', { class: 'num' }, 'Count'),
        el('th', { class: 'num' }, 'Total spent'),
        el('th', { class: 'num' }, 'Avg ' + unitLabel),
        el('th', { class: 'num' }, 'Min'),
        el('th', { class: 'num' }, 'Max'),
        el('th', null, 'Stores'),
        el('th', null, 'Last bought')
      ])));
      var tbody = el('tbody');
      filtered.forEach(function (e) {
        var pair = expandableRow(e, COLS, [
          el('td', null, e.name),
          el('td', null, el('span', { class: 'pill' }, e.category)),
          el('td', { class: 'num' }, String(e.count)),
          el('td', { class: 'num' }, fmtUSD(e.totalSpent)),
          el('td', { class: 'num' }, fmtUSD(e.avgPrice, { maxF: 3 })),
          el('td', { class: 'num' }, fmtUSD(e.minPrice, { maxF: 3 })),
          el('td', { class: 'num' }, fmtUSD(e.maxPrice, { maxF: 3 })),
          el('td', null, Object.keys(e.stores).join(', ')),
          el('td', null, e.lastDate ? fmtDate(e.lastDate) : '—')
        ], renderTable);
        tbody.appendChild(pair[0]);
        if (pair[1]) tbody.appendChild(pair[1]);
      });
      table.appendChild(tbody);
      tableWrap.appendChild(table);
    }
    searchInput.addEventListener('input', renderTable);

    var wrap = el('div', null, [
      el('div', { class: 'view-header' }, [
        el('div', null, [
          el('div', { class: 'view-eyebrow' }, 'Detail'),
          el('div', { class: 'view-title' }, 'Items'),
          el('div', { class: 'view-sub' }, 'Every distinct item you\'ve bought, normalized across stores. Search to find a specific SKU.')
        ]),
        el('div', { class: 'view-controls' }, [searchInput, pricingToggle()])
      ]),
      el('div', { class: 'card' }, [tableWrap])
    ]);
    setTimeout(renderTable, 0);
    return wrap;
  }

  // ----- Receipts view ------------------------------------------------------
  function renderReceipts() {
    var receipts = (state.data.receipts || []).slice().sort(function (a, b) {
      return parseDate(b.date) - parseDate(a.date);
    });
    var allItems = state.data.lineitems || [];
    var byReceipt = {};
    allItems.forEach(function (li) {
      if (!byReceipt[li.receipt_id]) byReceipt[li.receipt_id] = [];
      byReceipt[li.receipt_id].push(li);
    });
    var flagsByRow = {};
    (state.data.flaggedrows || []).forEach(function (f) {
      if (!f.resolved_at) flagsByRow[f.row_id] = f;
    });

    var wrap = el('div', null, [
      el('div', { class: 'view-header' }, [
        el('div', null, [
          el('div', { class: 'view-eyebrow' }, 'Detail'),
          el('div', { class: 'view-title' }, 'Receipts'),
          el('div', { class: 'view-sub' }, 'Most recent first. Click flag on any line to mark for review — it writes back to the FlaggedRows tab in your Sheet.')
        ])
      ])
    ]);
    if (!receipts.length) {
      wrap.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'empty-title' }, 'No receipts yet'),
        el('div', { class: 'empty-body' }, 'Drop a receipt photo into your Claude chat to ingest your first trip.')
      ]));
      return wrap;
    }
    receipts.forEach(function (r) {
      var lis = (byReceipt[r.id] || []).slice();
      var card = el('div', { class: 'receipt-card' }, [
        el('div', { class: 'receipt-head' }, [
          el('div', null, [
            el('div', { class: 'receipt-store' }, r.store || 'Unknown store'),
            el('div', { class: 'receipt-date' }, fmtDate(r.date) + (r.notes ? ' · ' + r.notes : ''))
          ]),
          el('div', { class: 'receipt-total' }, fmtUSD(r.total))
        ]),
        el('table', { class: 'data' }, [
          el('thead', null, el('tr', null, [
            el('th', null, 'Item'),
            el('th', null, 'Category'),
            el('th', { class: 'num' }, 'Qty'),
            el('th', { class: 'num' }, 'Unit $'),
            el('th', { class: 'num' }, 'Line $'),
            el('th', null, '')
          ])),
          el('tbody', null, lis.map(function (li) {
            var flagged = !!flagsByRow[li.id];
            var flagBtn = el('button', { class: 'flag-btn' + (flagged ? ' flagged' : ''), onClick: function () {
              if (flagged) return;
              flagBtn.disabled = true;
              postOp('flagRow', { table: 'LineItems', row_id: li.id, reason: 'flagged from dashboard' })
                .then(function () {
                  flagBtn.classList.add('flagged');
                  flagBtn.textContent = 'flagged';
                  toast('Flagged for review.', 'success');
                })
                .catch(function (err) {
                  flagBtn.disabled = false;
                  toast('Flag failed: ' + err.message, 'error');
                });
            } }, flagged ? 'flagged' : 'flag');
            return el('tr', null, [
              el('td', null, [
                el('div', null, li.normalized_name || li.raw_name),
                el('div', { style: 'font-size:10px;color:var(--warm-stone);letter-spacing:0.04em;' }, li.raw_name && li.normalized_name && li.raw_name !== li.normalized_name ? li.raw_name : '')
              ]),
              el('td', null, el('span', { class: 'pill' }, li.category || 'Other')),
              el('td', { class: 'num' }, fmtNum(li.qty, 2) + (li.unit ? ' ' + li.unit : '')),
              el('td', { class: 'num' }, fmtUSD(li.unit_price, { maxF: 3 })),
              el('td', { class: 'num' }, fmtUSD(li.line_total)),
              el('td', null, flagBtn)
            ]);
          }))
        ])
      ]);
      wrap.appendChild(card);
    });
    return wrap;
  }

  // ----- Boot ---------------------------------------------------------------
  function init() {
    loadSettings();
    // Sidebar wiring
    $$('.nav-link').forEach(function (n) {
      n.addEventListener('click', function () {
        if (n.dataset.view === 'sync') openSyncModal();
        else setView(n.dataset.view);
      });
    });
    $('#pull-btn').addEventListener('click', function () { pull(); });

    setView('dashboard');
    renderSyncStatus();

    if (state.syncUrl) {
      pull();
    } else {
      // First run — encourage sync setup
      renderView();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
