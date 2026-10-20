// The script the host runs INSIDE each page, in an ISOLATED WORLD (Page.addScriptToEvaluateOnNewDocument with a
// worldName), never in the page's own JS world: a hostile page cannot see `window.__kb`, patch the helpers, or spoof
// snapshot output. The DOM is shared, so it can read and hit-test everything the page renders.
//
// It builds a compact text snapshot with stable ref ids and answers action queries (describe / hit-test / focus).
// SECURITY: password, card-number, cvc, one-time-code and ssn fields are NEVER read; their value is reported as
// "(secret)". Output is bounded inside the page (maxChars / node cap) so a huge DOM can never produce a huge CDP
// message that stalls the daemon's event loop while it is parsed.
export const WORLD_NAME = 'kora-blob';

export const PAGE_JS = String.raw`(() => {
if (window.__kb) return window.__kb;
// DOM-quiet detector: SPAs hydrate/re-render after load; refs taken mid-hydration go stale.
if (!window.__kbMutInit) { window.__kbMutInit = 1; window.__kbMut = performance.now();
  const o = new MutationObserver(() => { window.__kbMut = performance.now(); });
  const go = () => o.observe(document.documentElement, { subtree: true, childList: true });
  document.documentElement ? go() : document.addEventListener('DOMContentLoaded', go); }
const ids = new WeakMap(), byId = new Map(), meta = new Map(); let next = 1; let prefix = ''; const xids = new WeakMap(), xById = new Map(); let xnext = 1;
const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','CANVAS','LINK','META','HEAD']);
const BLOCK = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DIV','DL','DT','DD','FIELDSET','FIGURE','FIGCAPTION','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TR','UL','CAPTION','DETAILS','SUMMARY','BODY']);
const ROLES = new Set(['button','link','checkbox','radio','tab','menuitem','switch','combobox','option','textbox','searchbox','slider','menuitemcheckbox','menuitemradio']);
const isSecret = (el) => { if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false; const t = (el.type||'').toLowerCase(); const ac = (el.autocomplete||'').toLowerCase(); return t === 'password' || /cc-(number|csc|exp)|one-time-code|current-password|new-password/.test(ac) || /card.?(num|number)|cvv|cvc|ssn/i.test((el.name||'')+(el.id||'')); };
const vis = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false; if (el.getAttribute('aria-hidden') === 'true' && !el.matches('input,button,a,select,textarea')) return false; if (el.hidden) return false; return true; };
const txt = (s, n=80) => { s = (s||'').replace(/\s+/g,' ').trim(); return s.length > n ? s.slice(0,n-1)+'…' : s; };
const labelOf = (el) => { const a = el.getAttribute('aria-label'); if (a) return a; if (el.labels && el.labels.length) return el.labels[0].innerText; const lb = el.getAttribute('aria-labelledby'); if (lb) { const t = lb.split(/\s+/).map(i => document.getElementById(i)?.innerText||'').join(' '); if (t.trim()) return t; } return ''; };
const roleOf = (el) => { const r = el.getAttribute('role'); if (r && ROLES.has(r)) return r; const t = el.tagName;
  if (t === 'A' && el.hasAttribute('href')) return 'link'; if (t === 'BUTTON') return 'button'; if (t === 'SELECT') return 'select'; if (t === 'TEXTAREA') return 'textbox'; if (t === 'SUMMARY') return 'button';
  if (t === 'INPUT') { const ty = (el.type||'text').toLowerCase(); if (ty === 'hidden') return null; if (['submit','button','reset','image'].includes(ty)) return 'button'; if (ty === 'checkbox') return 'checkbox'; if (ty === 'radio') return 'radio'; if (ty === 'password') return 'password'; if (ty === 'search') return 'searchbox'; return 'textbox'; }
  if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox';
  if (el.hasAttribute('onclick') || (el.tabIndex >= 0 && getComputedStyle(el).cursor === 'pointer')) return 'button'; return null; };
const refOf = (el) => { let id = ids.get(el); if (!id) { id = prefix + 'e' + (next++); ids.set(el, id); byId.set(id, new WeakRef(el)); } return id; };
const shortHref = (el) => { const h = el.getAttribute('href') || ''; return h.length > 70 ? h.slice(0,70)+'…' : h; };
/* Same-site links print nothing (the agent clicks the ref); links that leave the site print their host so it can tell. */
const offsite = (el) => { try { const u = new URL(el.href, location.href); if (u.host !== location.host) return ' →' + u.host + (u.pathname.length > 1 ? u.pathname.slice(0, 24) : ''); } catch {} return ''; };
const NOISE = /^\(?(opens? in a new (window|tab)|external link)\)?$/i;
function walk(root, ctx) {
  for (const n of root.childNodes) {
    if (ctx.n++ > 25000) { ctx.cut = true; return; }
    if (n.nodeType === 3) { const t = n.nodeValue.replace(/\s+/g,' '); if (t.trim() && !NOISE.test(t.trim())) ctx.add(t); continue; }
    if (n.nodeType !== 1) continue;
    const el = n, tag = el.tagName; if (SKIP.has(tag.toUpperCase())) continue;
    if (!vis(el)) continue;
    if (ctx.vp) { const r = el.getBoundingClientRect(); if (r.height > 0 && (r.bottom < -50 || r.top > innerHeight + 50) && getComputedStyle(el).position !== 'fixed') continue; }
    const role = roleOf(el);
    if (role) {
      const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0 && role !== 'checkbox' && role !== 'radio') continue;
      const id = refOf(el); let name = txt(labelOf(el) || (role === 'button' && el.tagName === 'INPUT' ? el.value : '') || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.querySelector?.('img[alt]')?.alt || el.name || '', 60);
      let extra = '';
      if (role === 'link') { extra = ctx.links ? ' →' + shortHref(el) : offsite(el); }
      else if (role === 'password' || isSecret(el)) { extra = ' (secret: value hidden from you; ask the user to take over and type it)'; }
      else if (role === 'select') { const o = [...el.options].slice(0,14).map(o => (o.selected ? '*' : '') + txt(o.label || o.text, 30)); extra = ' opts=[' + o.join('|') + ']'; }
      else if (role === 'checkbox' || role === 'radio') extra = el.checked ? ' [checked]' : '';
      else if (role === 'textbox' || role === 'searchbox' || role === 'combobox') { const v = el.value ?? el.innerText; if (v) extra = ' ="' + txt(v, 40) + '"'; const ph = el.getAttribute('placeholder'); if (!name && ph) name = ph; }
      if (el.disabled) extra += ' (disabled)'; if (el.getAttribute('aria-expanded')) extra += ' expanded=' + el.getAttribute('aria-expanded'); if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current')) extra += ' (current)';
      meta.set(id, { role, name });
      ctx.add(' [' + id + ' ' + (role === 'password' ? 'secret-field' : role) + ' "' + name + '"' + extra + '] ');
      continue;
    }
    if (tag === 'IMG') { const a = txt(el.alt, 50); if (a) ctx.add(' [img "' + a + '"] '); continue; }
    if (tag === 'IFRAME' || tag === 'FRAME') { try { const d = el.contentDocument; if (d && d.body) { ctx.nl(); ctx.add('[iframe]'); walk(d.body, ctx); ctx.nl(); continue; } } catch {} if (ctx.noX) { ctx.nl(); ctx.add('[iframe (cross-origin, not expanded)]'); ctx.nl(); continue; } let xid = xids.get(el); if (!xid) { xid = 'x' + (xnext++); xids.set(el, xid); xById.set(xid, new WeakRef(el)); } ctx.nl(); ctx.add('[iframe ' + xid + ' (cross-origin) ' + txt(el.src || el.getAttribute('src') || '', 60) + ']'); ctx.nl(); if (ctx.xf.length < 12) ctx.xf.push({ id: xid, src: el.src || '', title: txt(el.title || '', 40) }); continue; }
    const blk = BLOCK.has(tag); const hm = /^H([1-6])$/.exec(tag);
    if (blk) ctx.nl(); if (hm) ctx.add('#'.repeat(+hm[1]) + ' '); if (tag === 'LI') ctx.add('- ');
    if (el.shadowRoot) walk(el.shadowRoot, ctx);
    walk(el, ctx);
    if (tag === 'TD' || tag === 'TH') ctx.add(' | ');
    if (blk) ctx.nl();
    if (ctx.cut) return;
  }
}
/* Repetitive lists (30 near-identical product / result rows) cost thousands of tokens for no extra information. Runs of
   >= 12 consecutive lines of the same shape keep their first 8 lines. Refs of kept lines are unchanged and the omitted
   ones stay valid (they were allocated), so nothing shifts; snapshot{full_lists:true} or browser_extract shows all. */
const shape = (l) => l.replace(/\[(?:f\d+)?e\d+/g, '[e').replace(/"[^"]*"/g, '"_"').replace(/→\S*/g, '→').replace(/[A-Za-z\u00C0-\uFFFF]+/g, 'w').replace(/\d+/g, '#').replace(/\s+/g, ' ');
function collapse(lines) {
  const out = []; let i = 0;
  while (i < lines.length) {
    const sh = shape(lines[i]); let j = i + 1;
    while (j < lines.length && shape(lines[j]) === sh) j++;
    if (j - i >= 12 && sh.length > 3) { for (let k = i; k < i + 8; k++) out.push(lines[k]); out.push('… ' + (j - i - 8) + ' more similar rows omitted (browser_extract kind=table|links, scrolling, or browser_snapshot full_lists=true shows them)'); }
    else for (let k = i; k < j; k++) out.push(lines[k]);
    i = j;
  }
  return out;
}
function snapshot(opts) {
  opts = opts || {}; const limit = (opts.maxChars || 12000) + 2000;
  if (opts.base && next <= opts.base) next = opts.base + 1; /* ids keep counting across navigations: an old page's ref can never hit a new element */
  const lines = []; let cur = ''; let size = 0;
  const ctx = { n: 0, cut: false, xf: [], noX: !!opts.noX, links: !!opts.links, vp: !!opts.viewportOnly, add: (s) => { cur += s; }, nl: () => { const t = cur.replace(/[ \t]+/g,' ').replace(/ \| $/,'').trim(); if (t) { lines.push(t); size += t.length + 1; if (size > limit) ctx.cut = true; } cur = ''; if (ctx.cut) ctx.n = 1e9; } };
  walk(document.body || document.documentElement, ctx); ctx.nl();
  const dedup = []; for (const l of lines) if (l !== dedup[dedup.length-1]) dedup.push(l);
  const out = opts.fullLists ? dedup : collapse(dedup);
  return { title: document.title, url: location.href, scrollY: Math.round(scrollY), scrollH: document.documentElement.scrollHeight, vh: innerHeight, text: out.join('\n'), cut: ctx.cut, next, xf: ctx.xf, collapsed: dedup.length - out.length };
}
const resolve = (id) => { const el = byId.get(id)?.deref(); if (el && el.isConnected) return el; const m = meta.get(id); if (!m) return null;
  snapshot({}); /* re-walk: SPA re-rendered, find the same role+name element under a new id */ for (const [i, mm] of meta) if (i !== id && mm.role === m.role && mm.name === m.name) { const e = byId.get(i)?.deref(); if (e && e.isConnected) return e; } return null; };
function describe(el) {
  const form = el.form || el.closest?.('form'); const tag = el.tagName;
  const ty = (el.type || '').toLowerCase();
  const label = txt((el.innerText || (isSecret(el) || tag==="INPUT" && !["submit","button","image"].includes(ty) ? "" : el.value) || el.getAttribute('aria-label') || el.title || ''), 80);
  const isSubmit = (tag === 'BUTTON' && (!ty || ty === 'submit') && !!form) || (tag === 'INPUT' && (ty === 'submit' || ty === 'image'));
  let secretInForm = false, cardInForm = false; if (form) for (const f of form.elements) { if (isSecret(f)) secretInForm = true; if (/cc-/.test(f.autocomplete||'') ) cardInForm = true; }
  const textual = tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox','radio','button','submit','reset','image','file','range','color'].includes(ty));
  return { tag, type: ty, label, isSubmit, form: form ? { action: form.action, method: (form.method||'get').toLowerCase(), nFields: form.elements.length, secretInForm, cardInForm } : null,
    href: el.href || null, download: el.hasAttribute?.('download') || false, secret: isSecret(el), disabled: !!el.disabled, editable: !!(el.isContentEditable || textual) };
}
function describeActive() { const a = document.activeElement; if (!a || a === document.body || !(a.form || a.closest?.('form'))) return null; const d = describe(a); d.isSubmit = true; d.label = a.name || a.placeholder || ''; return d; }
function frameOffset(win) { let ox = 0, oy = 0; try { while (win && win !== win.top && win.frameElement) { const fr = win.frameElement.getBoundingClientRect(); ox += fr.left + win.frameElement.clientLeft; oy += fr.top + win.frameElement.clientTop; win = win.parent; } } catch {} return { ox, oy }; }
function center(el) { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); const r = el.getBoundingClientRect(); const fo = frameOffset(el.ownerDocument.defaultView); const x = r.left + r.width/2, y = r.top + r.height/2;
  const hit = document.elementFromPoint(x, y); const ok = hit && (hit === el || el.contains(hit) || hit.contains(el));
  return { x: x + fo.ox, y: y + fo.oy, ok, covered: ok ? null : (hit ? hit.tagName + ' ' + txt(hit.innerText || hit.getAttribute('aria-label') || '', 40) : 'nothing') }; }
function focusEl(el, clear) { el.focus(); if (clear) { if ('select' in el && el.tagName !== 'SELECT') el.select(); else { const s = getSelection(); s.selectAllChildren(el); } } return document.activeElement === el; }
function selectOpt(el, want) { const o = [...el.options].find(o => o.value === want || o.text.trim() === want || o.label === want) || [...el.options].find(o => o.text.toLowerCase().includes(String(want).toLowerCase())); if (!o) return { ok: false, opts: [...el.options].map(o => o.text.trim()).slice(0, 30) }; el.value = o.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, chose: o.text.trim() }; }
function secretFocused() { const a = document.activeElement; return !!(a && isSecret(a)) || [...document.querySelectorAll('input[type=password]')].some(i => i.value && vis(i)); }
function table(el, max) { const rows = []; let size = 0; for (const tr of el.querySelectorAll('tr')) { const r = [...tr.children].map(c => txt(c.innerText, 120)); rows.push(r); size += r.join(' | ').length + 1; if (size > max) break; } return rows; }
function links(el, max) { const out = []; let size = 0; for (const a of el.querySelectorAll('a[href]')) { const s = txt(a.innerText, 60) + ' → ' + a.href; out.push(s); size += s.length + 1; if (out.length >= 100 || size > max) break; } return out; }
function pageText(el, max) { const t = (el.innerText || ''); return t.length > max * 2 ? t.slice(0, max * 2) : t; }
function frameBox(xid) { const el = xById.get(xid)?.deref(); if (!el || !el.isConnected) return null; el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); const r = el.getBoundingClientRect(); return { x: r.left + el.clientLeft, y: r.top + el.clientTop, w: el.clientWidth, h: el.clientHeight }; }
function xframeEl(xid) { const el = xById.get(xid)?.deref(); return el && el.isConnected ? el : null; }
function setPrefix(p) { prefix = p; }
function activeXframe() { const a = document.activeElement; if (!a || a.tagName !== 'IFRAME') return null; try { if (a.contentDocument) return null; } catch {} let x = xids.get(a); if (!x) { x = 'x' + (xnext++); xids.set(a, x); xById.set(x, new WeakRef(a)); } return x; }
return (window.__kb = { activeXframe, frameBox, xframeEl, setPrefix, snapshot, resolve, describe, describeActive, center, focusEl, selectOpt, secretFocused, table, links, pageText, refOf, txt });
})()`;
