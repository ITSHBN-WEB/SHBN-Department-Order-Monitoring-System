/* Push to DOMS: loaded onto the portal page by the bookmark. Reads the Purchase Order on screen, shows a small popup
 * (category, brand, remark), then sends it to DOMS. Nothing is left on the page after it closes, and nothing is installed.
 * The bookmark loads this file as  .../push.js?k=<token>  - the token says which DOMS account the PO is pushed into. */
(function () {
  'use strict';
  var HOST_ID = 'doms-push-host';
  var old = document.getElementById(HOST_ID);
  if (old) old.remove();                                           // clicking the bookmark again starts fresh

  var me = document.currentScript;
  if (!me || !me.src) { var all = document.getElementsByTagName('script'); for (var i = all.length - 1; i >= 0; i--) { if (/push\.js/.test(all[i].src)) { me = all[i]; break; } } }
  if (!me) { alert('Push to DOMS: could not start. Please use the bookmark from the DOMS Bookmark tab.'); return; }
  var src = new URL(me.src);
  var APP = src.origin, TOKEN = src.searchParams.get('k') || '';

  /* ---------- 1. read the portal page ---------- */
  var txt = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };
  var inputs = Array.prototype.slice.call(document.querySelectorAll('input, textarea'));

  // the smallest element whose whole text is the label, e.g. "PO No :"
  function labelEl(re) {
    var best = null, bestLen = 1e9;
    var els = document.querySelectorAll('td, th, label, span, b, strong, div, font, p, h4, h5');
    for (var i = 0; i < els.length; i++) {
      var t = txt(els[i].textContent);
      if (t.length < 40 && t.length < bestLen && re.test(t)) { best = els[i]; bestLen = t.length; }
    }
    return best;
  }
  // value of the n-th input box that comes after the label (0 = the box right next to it)
  function valueAfter(re, n) {
    var el = labelEl(re);
    if (!el) return null;
    var found = [];
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      if (el.contains(inp)) continue;
      if (el.compareDocumentPosition(inp) & Node.DOCUMENT_POSITION_FOLLOWING) { found.push(inp); if (found.length > n) break; }
    }
    return found[n] ? txt(found[n].value) : null;
  }
  // "Posted By / Date" may be one box or two (name, date): use the first of the next 3 boxes that holds a date
  function firstDate(re) {
    for (var n = 0; n < 3; n++) {
      var v = valueAfter(re, n), m = v && /(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4})/.exec(v);
      if (m) return isoDate(m[1]);
    }
    return '';
  }
  function isoDate(v) {
    v = txt(v);
    var m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
    if (m) return m[1];
    m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/.exec(v);
    return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : '';
  }

  var po = {
    po_no: valueAfter(/^PO No\s*:?$/i, 0),
    date_received: isoDate(valueAfter(/^PO Date\s*:?$/i, 0)),                        // portal "PO Date"  -> DATE RECEIVED PO
    supplier: valueAfter(/^Supplier\s*:?$/i, 1),                                      // the box after the supplier code
    reference: valueAfter(/^Reference\s*:?$/i, 0),
    date_verified: firstDate(/^Posted By\s*\/\s*Date\s*:?$/i),           // portal "Posted By / Date" (date only) -> DATE VERIFIED PO
    amount: valueAfter(/^Grand Total\s*[:(]?\s*RM\s*\)?\s*:?$/i, 0)                            // portal "Grand Total : RM" -> PO AMOUNT (RM)
  };
  var missing = [];
  if (!po.po_no) missing.push('PO No');
  if (!po.supplier) missing.push('Supplier');
  if (!po.amount || !(Number(String(po.amount).replace(/,/g, '')) > 0)) missing.push('Grand Total');

  /* ---------- 2. popup (shadow DOM, so the portal's styles cannot change it) ---------- */
  var host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    '*{box-sizing:border-box;font-family:Segoe UI,Arial,sans-serif}' +
    '.bd{position:fixed;inset:0;background:rgba(10,15,25,.55);display:flex;align-items:flex-start;justify-content:center;padding:6vh 14px;overflow:auto}' +
    '.card{width:min(440px,100%);background:#fff;color:#1c2430;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.4);overflow:hidden}' +
    '.hd{background:#0f766e;color:#fff;padding:14px 18px;display:flex;justify-content:space-between;align-items:center}' +
    '.hd b{font-size:16px;letter-spacing:.2px}.hd small{opacity:.85;font-size:12px}' +
    '.bodyp{padding:16px 18px 6px}' +
    'dl{margin:0 0 12px;display:grid;grid-template-columns:130px 1fr;gap:5px 10px;font-size:13px}' +
    'dt{color:#5b6675}dd{margin:0;font-weight:600;overflow-wrap:anywhere}' +
    'label{display:block;font-size:12px;font-weight:600;color:#3a4553;margin:11px 0 4px}label i{font-weight:400;color:#7b8794}' +
    'select,input{width:100%;padding:9px 10px;border:1px solid #b9c2cf;border-radius:8px;font-size:14px;background:#fff;color:#1c2430}' +
    'input.up{text-transform:uppercase}select:focus,input:focus{outline:2px solid #14b8a6;border-color:#14b8a6}' +
    '.msg{margin:12px 0 0;padding:9px 11px;border-radius:8px;font-size:13px;line-height:1.4}' +
    '.err{background:#fde8e8;color:#9b1c1c}.ok{background:#dcf5e7;color:#14532d}.warn{background:#fff3d6;color:#7a4b00}.info{background:#e8eef7;color:#33425b}' +
    '.ft{display:flex;gap:10px;justify-content:flex-end;padding:14px 18px 16px}' +
    'button{border:0;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer}' +
    '.pri{background:#0f766e;color:#fff}.pri:disabled{background:#9bb9b5;cursor:not-allowed}.sec{background:#e6eaf0;color:#27313f}' +
    '</style>' +
    '<div class="bd"><div class="card" role="dialog" aria-modal="true" aria-label="Push to DOMS">' +
    '<div class="hd"><div><b>Push to DOMS</b><br><small>Purchase Order from the portal</small></div></div>' +
    '<div class="bodyp"><dl id="d"></dl><div id="st"></div><div id="form"></div></div>' +
    '<div class="ft"><button class="sec" id="cancel" type="button">Cancel</button><button class="pri" id="send" type="button" disabled>Send to DOMS</button></div>' +
    '</div></div>';
  document.documentElement.appendChild(host);

  var $ = function (id) { return root.getElementById ? root.getElementById(id) : root.querySelector('#' + id); };
  function money(v) { var n = Number(String(v).replace(/,/g, '')); return isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v || ''); }
  function dmy(s) { return s ? s.split('-').reverse().join('/') : '-'; }
  function say(cls, text) { var st = $('st'); st.innerHTML = ''; if (!text) return; var d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; st.appendChild(d); }
  function close() { document.removeEventListener('keydown', onKey, true); host.remove(); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey, true);
  $('cancel').onclick = close;

  var dl = $('d');
  [['PO No', po.po_no || 'not found'], ['Supplier', po.supplier || 'not found'], ['Date Received PO', dmy(po.date_received)], ['Date Verified PO', dmy(po.date_verified)], ['PO Amount (RM)', po.amount ? money(po.amount) : 'not found']]
    .forEach(function (r) { var a = document.createElement('dt'), b = document.createElement('dd'); a.textContent = r[0]; b.textContent = r[1]; dl.appendChild(a); dl.appendChild(b); });

  if (missing.length) {
    say('err', 'Could not read ' + missing.join(', ') + ' from this page. Open a Purchase Order detail page (View PO Detail) and try again.');
    return;
  }

  // a PO that has not been verified on the portal yet (blank Posted By / Date) cannot be pushed
  if (!po.date_verified) {
    say('err', 'PO ' + po.po_no + ' has not been verified yet (Posted By / Date is blank). Verify it on the portal first, then push it.');
    $('cancel').textContent = 'Close';
    return;
  }

  /* ---------- 3. ask DOMS: category list + "already recorded?" ---------- */
  say('info', 'Checking DOMS…');
  fetch(APP + '/api/po-push?k=' + encodeURIComponent(TOKEN) + '&po=' + encodeURIComponent(po.po_no), { cache: 'no-store' })
    .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
    .then(function (res) {
      if (res.status !== 200) { say('err', res.body && res.body.error ? res.body.error : 'DOMS did not accept the request.'); return; }
      showForm(res.body);
    })
    .catch(function () { say('err', 'Could not reach DOMS. Check your connection and try again.'); });

  function showForm(info) {
    var dup = info.duplicate;
    var f = $('form');
    var groups = {};
    info.categories.forEach(function (c) { (groups[c.report] = groups[c.report] || []).push(c); });
    var sel = document.createElement('select'); sel.id = 'cat';
    var ph = document.createElement('option'); ph.value = ''; ph.textContent = 'Select category…'; sel.appendChild(ph);
    Object.keys(groups).forEach(function (g) {
      var og = document.createElement('optgroup'); og.label = g;
      groups[g].forEach(function (c) { var o = document.createElement('option'); o.value = c.id; o.textContent = c.name; og.appendChild(o); });
      sel.appendChild(og);
    });
    var brand = document.createElement('input'); brand.id = 'brand'; brand.className = 'up'; brand.maxLength = 60; brand.placeholder = 'e.g. LIFE';
    var ref = txt(po.reference), dash = ref.lastIndexOf('-');
    if (dash > -1 && dash < ref.length - 1) brand.value = ref.slice(dash + 1).toUpperCase();      // "SPO000002009598-LIFE" -> LIFE (you can change it)
    var remark = document.createElement('input'); remark.id = 'remark'; remark.className = 'up'; remark.maxLength = 120; remark.placeholder = 'e.g. URGENT';
    function add(label, el, optional) { var l = document.createElement('label'); l.textContent = label + ' '; if (optional) { var i = document.createElement('i'); i.textContent = '(optional)'; l.appendChild(i); } f.appendChild(l); f.appendChild(el); }
    add('Category', sel); add('Product / Brand', brand); add('Remark', remark, true);

    var send = $('send');
    if (dup) {
      var when = new Date(dup.ts);
      say('err', 'PO ' + dup.po_no + ' is already recorded in DOMS (' + dup.category + (dup.brand ? ' - ' + dup.brand : '') + ', sent ' + when.toLocaleDateString('en-GB') + ' ' + when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '). It cannot be sent again.');
      sel.disabled = brand.disabled = remark.disabled = true;
      return;
    }
    say('', '');
    send.disabled = false;
    sel.focus();
    send.onclick = function () {
      if (!sel.value) { say('err', 'Please select a category.'); sel.focus(); return; }
      send.disabled = true; send.textContent = 'Sending…'; say('', '');
      fetch(APP + '/api/po-push', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },                       // "simple" request: no browser pre-check the portal could block
        body: JSON.stringify({ k: TOKEN, po: po, poCategoryId: Number(sel.value), brand: brand.value, remark: remark.value })
      })
        .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
        .then(function (res) {
          var b = res.body || {};
          if (res.status === 201) {
            say('ok', 'Sent to DOMS (' + b.category + '). Open PO Summary Report in DOMS to preview, save the entry and print.');
            sel.disabled = brand.disabled = remark.disabled = true;
            send.style.display = 'none'; $('cancel').textContent = 'Close';
          } else {
            say('err', b.error || 'DOMS could not save this PO.');
            if (res.status !== 409) { send.disabled = false; send.textContent = 'Send to DOMS'; } else { send.textContent = 'Send to DOMS'; }
          }
        })
        .catch(function () { say('err', 'Could not reach DOMS. Nothing was saved - please try again.'); send.disabled = false; send.textContent = 'Send to DOMS'; });
    };
  }
})();
