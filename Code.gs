/**
 * Grocery Tracker — Google Sheets backend
 *
 * Web app exposing receipt + line-item data over HTTPS. The static
 * dashboard calls doGet() to pull and doPost({op, payload}) to mutate.
 *
 * Tabs:
 *   Meta, Receipts, LineItems, ItemAliases, Categories, FlaggedRows
 *
 * Setup (one-time):
 *   1. Run setup()           — creates all tabs with headers + seeds default categories
 *   2. (optional) Run seed() — populates from SEED_JSON in Seed.gs if present
 *   3. Deploy → New deployment → Web app
 *      Execute as: Me. Who has access: Anyone with the link.
 *   4. Copy the Web app URL into the dashboard's Sync settings.
 *
 * doPost ops:
 *   appendReceipt   — adds Receipt + N LineItems atomically (Receipt OCR ingestion)
 *   flagRow         — flags a row from the dashboard for later review
 *   resolveFlag     — clears a flag
 *   upsertAlias     — learns raw_name → normalized_name + category mapping
 *   upsertCategory  — adds or renames a category in the taxonomy
 *   updateLineItem  — patches an existing line item (used to fix OCR misreads)
 *   deleteReceipt   — removes a receipt and all its line items
 *   ping            — health check; returns version
 */

var VERSION = '1.0.0';

// ----- Schemas (column order is the wire format — do not reorder) ---------

var SCHEMAS = {
  Meta:        ['key', 'value'],
  Receipts:    ['id', 'date', 'store', 'subtotal', 'tax', 'total', 'num_items', 'notes', 'created_at'],
  LineItems:   ['id', 'receipt_id', 'date', 'store', 'raw_name', 'normalized_name', 'category', 'qty', 'unit', 'unit_price', 'line_total', 'created_at'],
  ItemAliases: ['raw_name', 'normalized_name', 'category', 'first_seen_at', 'last_seen_at', 'sightings'],
  Categories:  ['name', 'sort_order', 'color'],
  FlaggedRows: ['id', 'table', 'row_id', 'reason', 'flagged_at', 'resolved_at', 'note']
};

var TAB_ORDER = ['Meta', 'Receipts', 'LineItems', 'ItemAliases', 'Categories', 'FlaggedRows'];

// Numeric columns — coerced to Number on read.
var NUMERIC_FIELDS = {
  subtotal: true, tax: true, total: true, num_items: true,
  qty: true, unit_price: true, line_total: true,
  sort_order: true, sightings: true
};

// Default category taxonomy seeded once at setup.
// Colors are from Mitch's personal palette (Cordovan #9E6B5A,
// Brackish #355850, Warm Stone #7A7169) plus muted neutrals.
var DEFAULT_CATEGORIES = [
  ['Produce',         10, '#7A9E7E'],
  ['Dairy & Eggs',    20, '#F5E6C8'],
  ['Meat & Seafood',  30, '#9E6B5A'],
  ['Pantry',          40, '#C8A97E'],
  ['Frozen',          50, '#A8C5D6'],
  ['Bakery',          60, '#D4A373'],
  ['Beverages',       70, '#5B8E8B'],
  ['Snacks',          80, '#E0A87E'],
  ['Prepared Foods',  90, '#B5896C'],
  ['Household',      100, '#8B8580'],
  ['Personal Care',  110, '#A89B92'],
  ['Other',          900, '#7A7169']
];

// Header styling — uses Cordovan from the Personal Design System.
var HEADER_BG = '#9E6B5A';
var HEADER_FG = '#FDFAF6';

// ----- Setup ---------------------------------------------------------------

/** Create all tabs with headers (idempotent — safe to re-run). */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  TAB_ORDER.forEach(function (tab) {
    var sheet = ss.getSheetByName(tab) || ss.insertSheet(tab);
    var headers = SCHEMAS[tab];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground(HEADER_BG)
      .setFontColor(HEADER_FG);
    // Trim extra columns beyond schema
    var maxCols = sheet.getMaxColumns();
    if (maxCols > headers.length) {
      sheet.deleteColumns(headers.length + 1, maxCols - headers.length);
    }
  });
  // Re-order tabs to canonical order
  TAB_ORDER.forEach(function (tab, i) {
    ss.getSheetByName(tab).activate();
    ss.moveActiveSheet(i + 1);
  });
  // Seed default categories if Categories tab is empty
  var cats = ss.getSheetByName('Categories');
  if (cats.getLastRow() <= 1) {
    cats.getRange(2, 1, DEFAULT_CATEGORIES.length, 3).setValues(DEFAULT_CATEGORIES);
  }
  // Write meta
  var meta = ss.getSheetByName('Meta');
  meta.getRange(2, 1, 2, 2).setValues([
    ['version', VERSION],
    ['initialized_at', new Date().toISOString()]
  ]);
  // Delete the default Sheet1 if it's still hanging around
  var s1 = ss.getSheetByName('Sheet1');
  if (s1 && TAB_ORDER.indexOf('Sheet1') === -1) ss.deleteSheet(s1);
  SpreadsheetApp.getActive().toast('Tabs ready. Deploy → New deployment → Web app.', 'Grocery Tracker', 5);
}

/** Wipe data rows from every tab (keeps headers, re-seeds categories). */
function clearAllData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  TAB_ORDER.forEach(function (tab) {
    var sheet = ss.getSheetByName(tab);
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
    }
  });
  // Re-seed categories
  var cats = ss.getSheetByName('Categories');
  cats.getRange(2, 1, DEFAULT_CATEGORIES.length, 3).setValues(DEFAULT_CATEGORIES);
  SpreadsheetApp.getActive().toast('All data cleared.', 'Grocery Tracker', 3);
}

/** Optional — populate from SEED_JSON in a Seed.gs file (for backfill). */
function seed() {
  if (typeof SEED_JSON === 'undefined' || !SEED_JSON) {
    throw new Error('SEED_JSON is not defined. Add a Seed.gs file with var SEED_JSON = "..."');
  }
  var data = JSON.parse(SEED_JSON);
  if (data.categories) {
    var cats = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Categories');
    cats.getRange(2, 1, cats.getLastRow() - 1, 3).clearContent();
    var rows = data.categories.map(function (c) { return [c.name, c.sort_order, c.color]; });
    if (rows.length) cats.getRange(2, 1, rows.length, 3).setValues(rows);
  }
  (data.receipts || []).forEach(function (r) {
    appendReceipt_({ receipt: r, line_items: r.line_items || [] });
  });
  SpreadsheetApp.getActive().toast('Seeded.', 'Grocery Tracker', 3);
}

// ----- HTTP endpoints ------------------------------------------------------

function doGet(e) {
  try {
    return jsonResponse_({ ok: true, version: VERSION, data: readAll_() });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var lock = LockService.getDocumentLock();
  try {
    lock.waitLock(30000);
    var body = JSON.parse(e.postData.contents || '{}');
    var op = body.op;
    var payload = body.payload || {};
    var result;
    switch (op) {
      case 'appendReceipt':  result = appendReceipt_(payload); break;
      case 'flagRow':        result = flagRow_(payload); break;
      case 'resolveFlag':    result = resolveFlag_(payload); break;
      case 'upsertAlias':    result = upsertAlias_(payload); break;
      case 'upsertCategory': result = upsertCategory_(payload); break;
      case 'updateLineItem': result = updateLineItem_(payload); break;
      case 'deleteReceipt':  result = deleteReceipt_(payload); break;
      case 'ping':           result = { pong: true, version: VERSION }; break;
      default: throw new Error('Unknown op: ' + op);
    }
    return jsonResponse_({ ok: true, op: op, result: result });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ----- Read all ------------------------------------------------------------

function readAll_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = {};
  Object.keys(SCHEMAS).forEach(function (tab) {
    out[tab.toLowerCase()] = readTab_(ss, tab);
  });
  return out;
}

function readTab_(ss, tab) {
  var sh = ss.getSheetByName(tab);
  if (!sh) return [];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var headers = SCHEMAS[tab];
  var values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(function (row) {
    var allBlank = row.every(function (v) { return v === '' || v === null; });
    if (allBlank) return null;
    var obj = {};
    headers.forEach(function (h, i) {
      var v = row[i];
      if (v instanceof Date) {
        // Dates as ISO strings for clean JSON
        v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }
      if (NUMERIC_FIELDS[h] && v !== '' && v !== null && !isNaN(v)) {
        v = Number(v);
      }
      if (v === null) v = '';
      obj[h] = v;
    });
    return obj;
  }).filter(function (r) { return r !== null; });
}

// ----- Mutation ops --------------------------------------------------------

/**
 * payload: {
 *   receipt: { id?, date, store, subtotal?, tax?, total, notes? },
 *   line_items: [ { id?, raw_name, normalized_name, category, qty, unit, unit_price, line_total }, ... ]
 * }
 */
function appendReceipt_(payload) {
  if (!payload.receipt) throw new Error('appendReceipt: missing receipt');
  if (!Array.isArray(payload.line_items)) throw new Error('appendReceipt: line_items must be an array');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var now = new Date().toISOString();
  var r = payload.receipt;
  var receiptId = r.id || newId_('rcpt');

  appendRow_(ss, 'Receipts', [
    receiptId,
    r.date || '',
    r.store || '',
    numOrBlank_(r.subtotal),
    numOrBlank_(r.tax),
    numOrBlank_(r.total),
    payload.line_items.length,
    r.notes || '',
    now
  ]);

  if (payload.line_items.length) {
    var sh = ss.getSheetByName('LineItems');
    var rows = payload.line_items.map(function (li) {
      return [
        li.id || newId_('li'),
        receiptId,
        r.date || '',
        r.store || '',
        li.raw_name || '',
        li.normalized_name || '',
        li.category || 'Other',
        numOrBlank_(li.qty),
        li.unit || '',
        numOrBlank_(li.unit_price),
        numOrBlank_(li.line_total),
        now
      ];
    });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }

  // Learn aliases
  payload.line_items.forEach(function (li) {
    if (li.raw_name && li.normalized_name) {
      upsertAlias_({
        raw_name: li.raw_name,
        normalized_name: li.normalized_name,
        category: li.category || 'Other'
      });
    }
  });

  return { receipt_id: receiptId, line_items_added: payload.line_items.length };
}

function flagRow_(payload) {
  if (!payload.row_id) throw new Error('flagRow: row_id required');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var id = newId_('flag');
  appendRow_(ss, 'FlaggedRows', [
    id,
    payload.table || 'LineItems',
    payload.row_id,
    payload.reason || 'flagged from dashboard',
    new Date().toISOString(),
    '',
    payload.note || ''
  ]);
  return { flag_id: id };
}

function resolveFlag_(payload) {
  if (!payload.flag_id) throw new Error('resolveFlag: flag_id required');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('FlaggedRows');
  var row = findRowByValue_(sh, 1, payload.flag_id);
  if (!row) throw new Error('flag not found: ' + payload.flag_id);
  sh.getRange(row, 6).setValue(new Date().toISOString());
  return { resolved: true };
}

function upsertAlias_(payload) {
  if (!payload.raw_name) throw new Error('upsertAlias: raw_name required');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('ItemAliases');
  var now = new Date().toISOString();
  var key = String(payload.raw_name).trim().toUpperCase();
  var lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    var values = sh.getRange(2, 1, lastRow - 1, 6).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]).trim().toUpperCase() === key) {
        var rowIdx = i + 2;
        var sightings = (Number(values[i][5]) || 0) + 1;
        sh.getRange(rowIdx, 2, 1, 5).setValues([[
          payload.normalized_name || values[i][1],
          payload.category || values[i][2],
          values[i][3] || now,
          now,
          sightings
        ]]);
        return { updated: true, raw_name: payload.raw_name };
      }
    }
  }
  appendRow_(ss, 'ItemAliases', [
    payload.raw_name,
    payload.normalized_name || payload.raw_name,
    payload.category || 'Other',
    now,
    now,
    1
  ]);
  return { inserted: true, raw_name: payload.raw_name };
}

function upsertCategory_(payload) {
  if (!payload.name) throw new Error('upsertCategory: name required');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Categories');
  var lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    var values = sh.getRange(2, 1, lastRow - 1, 3).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]).trim().toLowerCase() === String(payload.name).trim().toLowerCase()) {
        var rowIdx = i + 2;
        if (payload.sort_order != null) sh.getRange(rowIdx, 2).setValue(payload.sort_order);
        if (payload.color) sh.getRange(rowIdx, 3).setValue(payload.color);
        return { updated: true };
      }
    }
  }
  appendRow_(ss, 'Categories', [
    payload.name,
    payload.sort_order != null ? payload.sort_order : 500,
    payload.color || '#7A7169'
  ]);
  return { inserted: true };
}

function updateLineItem_(payload) {
  if (!payload.id) throw new Error('updateLineItem: id required');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('LineItems');
  var row = findRowByValue_(sh, 1, payload.id);
  if (!row) throw new Error('line item not found: ' + payload.id);
  var headers = SCHEMAS.LineItems;
  for (var i = 0; i < headers.length; i++) {
    var k = headers[i];
    if (Object.prototype.hasOwnProperty.call(payload, k) && k !== 'id' && k !== 'created_at') {
      sh.getRange(row, i + 1).setValue(payload[k]);
    }
  }
  return { updated: true, id: payload.id };
}

function deleteReceipt_(payload) {
  if (!payload.receipt_id) throw new Error('deleteReceipt: receipt_id required');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var removed = 0;
  var li = ss.getSheetByName('LineItems');
  var liLast = li.getLastRow();
  if (liLast >= 2) {
    var values = li.getRange(2, 1, liLast - 1, SCHEMAS.LineItems.length).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      if (values[i][1] === payload.receipt_id) {
        li.deleteRow(i + 2);
        removed++;
      }
    }
  }
  var r = ss.getSheetByName('Receipts');
  var rRow = findRowByValue_(r, 1, payload.receipt_id);
  if (rRow) r.deleteRow(rRow);
  return { removed_line_items: removed, removed_receipt: !!rRow };
}

// ----- Helpers -------------------------------------------------------------

function appendRow_(ss, tabName, row) {
  var sh = ss.getSheetByName(tabName);
  if (!sh) throw new Error('Tab not found: ' + tabName);
  sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}

function findRowByValue_(sh, col, value) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  var values = sh.getRange(2, col, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === value) return i + 2;
  }
  return null;
}

function numOrBlank_(v) {
  if (v === undefined || v === null || v === '') return '';
  var n = Number(v);
  return isNaN(n) ? '' : n;
}

function newId_(prefix) {
  var ts = Date.now().toString(36);
  var rnd = Math.floor(Math.random() * 0x10000).toString(36);
  while (rnd.length < 4) rnd = '0' + rnd;
  return prefix + '_' + ts + rnd;
}

// Object.assign polyfill for older Apps Script runtimes
if (typeof Object.assign !== 'function') {
  Object.assign = function (target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (src) Object.keys(src).forEach(function (k) { target[k] = src[k]; });
    }
    return target;
  };
}
