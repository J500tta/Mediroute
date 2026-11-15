// MediRoute logic: sticker text parsing and route ordering. No patient data is stored here.
const PC_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

// OCR mixes up look-alike characters (O/0, I/1, S/5...). This repairs them by position.
const FIXD = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
const FIXL = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '6': 'G', '2': 'Z' };
function fixPostcode(raw) {
  const t = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t.length < 5 || t.length > 7) return '';
  const inw = t.slice(-3), o = t.slice(0, -3).split('');
  o[0] = FIXL[o[0]] || o[0];
  if (o.length === 2) o[1] = FIXD[o[1]] || o[1];
  if (o.length === 3 && /[A-Z]/.test(o[1])) o[2] = FIXD[o[2]] || o[2]; // LES -> LE5
  if (o.length === 4) { o[1] = FIXL[o[1]] || o[1]; o[2] = FIXD[o[2]] || o[2]; o[3] = FIXD[o[3]] || o[3]; }
  const pc = o.join('') + ' ' + (FIXD[inw[0]] || inw[0]) + (FIXL[inw[1]] || inw[1]) + (FIXL[inw[2]] || inw[2]);
  return PC_RE.test(pc) ? pc : '';
}

const PH_RE = /(\+44[\s-]?\(?0?\)?[\s-]?|\b0)\d[\d\s-]{8,11}\d\b/;

// Turns raw OCR text into {name, addr, pc}. Lines AFTER the postcode are ignored
// (they usually hold medication info, which MediRoute never keeps).
// Built around the Bridge Street Pharmacy delivery sticker:
//   [Title] Name / *** DELIVERY SERVICE *** / house + street / town / postcode / delivery note / date / pharmacy footer
const FOOT = /pharmacy|keep out of reach|\bchkd\b|\bdisp\b/i;
const DATE = /^\W*\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\W*$/;
const SKIP = /delivery\s*service|very\s+service|\bservice\b.*[*+=]|[*].*\bservice\b/i;
const TITLE_ANY = /\b(mr|mrs|ms|miss|mx|dr|master|prof|rev|sir)\b\.?\s/i;
const HNUM = /^((flat|apartment|apt|unit)\s+\w+,?\s*)?\d+[A-Za-z]?\b/i;
const trimJ = s => s.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9.)!?]+$/, '');
// Removes stray 1-2 letter marks the reader picks up from sticker edges, but keeps real ones (St, Rd, Flat B, to, go...).
const ABBR = new Set(['st', 'rd', 'ln', 'dr', 'ct', 'pl', 'sq', 'av']);
const WORDS = new Set(['a', 'i', 'go', 'to', 'by', 'if', 'in', 'no', 'ok', 'on', 'or', 'so', 'up', 'do', 'be', 'at', 'as', 'it', 'is', 'my', 'me', 'we', 'he']);
const junk = w => w.length <= 2 && !/\d/.test(w);
function tidy(l) {
  const t = l.trim().split(' ');
  while (t.length > 1) {
    const w = t[t.length - 1].replace(/\W/g, '').toLowerCase(), prev = t[t.length - 2].replace(/\W/g, '');
    if (junk(w) && !ABBR.has(w) && !(w.length === 1 && /^(flat|unit|apt|apartment|room)$/i.test(prev))) t.pop(); else break;
  }
  while (t.length > 1 && junk(t[0].replace(/\W/g, '')) && !WORDS.has(t[0].replace(/\W/g, '').toLowerCase())) t.shift();
  return trimJ(t.join(' '));
}
const alnum = l => (l.match(/[A-Za-z0-9]/g) || []).length;
// ownPc = the pharmacy postcode, so the pharmacy's own details are never mistaken for the customer's.
function parseSticker(text, ownPc) {
  let lines = text.split('\n').map(s => s.replace(/[|_~]/g, ' ').replace(/\s+/g, ' ').trim()).filter(s => s.length > 1);
  lines = lines.filter(l => alnum(l) >= l.replace(/\s/g, '').length * 0.6 && !SKIP.test(l)); // drop OCR garbage and the DELIVERY SERVICE line
  const fi = lines.findIndex(l => FOOT.test(l) || DATE.test(l)); // footer starts here: its phone number is the pharmacy's
  let phone = '';
  lines = lines.map((l, i) => {
    if (phone || (fi > 0 && i >= fi)) return l;
    const m = l.match(PH_RE);
    if (m) {
      const d = m[0].replace(/[^\d+]/g, '');
      if (/^0\d{10}$/.test(d) || /^\+44\d{10}$/.test(d)) { phone = d; l = l.replace(m[0], ' ').replace(/\b(tel|telephone|phone|mobile|mob)\b\.?:?/i, '').trim(); }
    }
    return l;
  }).filter(l => l.length > 1);
  const found = [];
  lines.forEach((l, i) => {
    const u = l.toUpperCase(), m = u.match(PC_RE);
    if (m) { found.push({ i, pc: m[1] + ' ' + m[2] }); return; }
    const c0 = u.replace(/[^A-Z0-9 ]/g, '').trim();
    for (const c of [c0, c0.replace(/(\s+[A-Z0-9]{1,2})+$/, '')]) { // second try ignores stray marks after the postcode
      // repair only when the WHOLE line looks like a postcode with a digit in it (so "1 Fictional Close" is never mistaken for one)
      const mm = c.match(/^([A-Z0-9]{2,4})\s?([A-Z0-9]{3})$/), f = mm && /\d/.test(c) && fixPostcode(mm[1] + mm[2]);
      if (f) { found.push({ i, pc: f }); lines[i] = f; return; }
    }
  });
  const own = (ownPc || '').replace(/\s/g, '').toUpperCase();
  const isOwn = x => own && x.pc.replace(/\s/g, '') === own;
  const pick = found.find(x => !isOwn(x)) || found[0];
  let pc = '', pi = -1, note = '';
  if (pick) {
    pc = pick.pc; pi = pick.i;
    const end = lines.findIndex((l, i) => i > pi && (FOOT.test(l) || DATE.test(l)));
    if (end >= 0) note = lines.slice(pi + 1, end).filter(l => !PC_RE.test(l.toUpperCase())).slice(0, 1).map(tidy).filter(l => l.length > 2).join('; ').slice(0, 80); // e.g. "give to neighbour"
    const above = found.filter(x => isOwn(x) && x.i < pi).pop(); // pharmacy block printed above the customer
    if (above) { lines = lines.slice(above.i + 1); pi -= above.i + 1; }
  }
  let head = pi >= 0 ? lines.slice(0, pi + 1) : lines.slice(0, 5);
  if (pi >= 0) head[pi] = head[pi].replace(PC_RE, '');
  head = head.map(l => trimJ(l.replace(/^(patient|name|address|deliver(y)? to)\s*[:\-]\s*/i, ''))).filter(l => alnum(l) >= 3 || /^\d+[A-Za-z]?$/.test(l));
  let ni = head.findIndex(l => TITLE_ANY.test(l));
  if (ni < 0) {
    if (HNUM.test(head[0] || '')) ni = -1;
    else { const hi = head.findIndex((l, k) => k > 0 && HNUM.test(l)); ni = hi > 0 ? hi - 1 : 0; }
  }
  let name = ni >= 0 ? head[ni] : '';
  const tm = name.match(TITLE_ANY); if (tm) name = name.slice(tm.index);
  name = name.replace(/\s+\d+$/, '');
  return { name, addr: head.slice(ni + 1).map(tidy).filter(l => alnum(l) >= 3 || /^\d+[A-Za-z]?$/.test(l)).join(', '), pc, phone, note };
}

// Several readings of one sticker -> majority vote per field. strong = name, address and postcode each agreed twice.
function consensus(rs) {
  const out = { strong: true };
  ['name', 'addr', 'pc', 'phone', 'note'].forEach(f => {
    const m = new Map();
    rs.forEach(r => { const v = r[f]; if (!v) return; const k = v.toLowerCase().replace(/[^a-z0-9]/g, ''); const e = m.get(k) || { n: 0, v }; e.n++; m.set(k, e); });
    let b = null; m.forEach(e => { if (!b || e.n > b.n) b = e; });
    out[f] = b ? b.v : '';
    if (['name', 'addr', 'pc'].includes(f) && (!b || b.n < 2)) out.strong = false;
  });
  return out;
}

// D[i][j] = travel time from node i to node j. Node 0 = start, nodes 1..n = stops.
// closed=true returns to node 0 at the end; closed=false ends at the last stop.
// Nearest-neighbour start, then 2-opt + or-opt improvement until no gain.
function optimise(D, n, closed, ret) {
  const cost = r => {
    let c = D[0][r[0]];
    for (let i = 0; i < r.length - 1; i++) c += D[r[i]][r[i + 1]];
    return closed ? c + (ret ? ret[r[r.length - 1]] : D[r[r.length - 1]][0]) : c;
  };
  const left = [...Array(n).keys()].map(i => i + 1);
  let r = [], cur = 0;
  while (left.length) {
    let b = 0;
    left.forEach((x, i) => { if (D[cur][x] < D[cur][left[b]]) b = i; });
    cur = left.splice(b, 1)[0]; r.push(cur);
  }
  let best = cost(r), imp = true;
  while (imp) {
    imp = false;
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
      const t = [...r.slice(0, i), ...r.slice(i, j + 1).reverse(), ...r.slice(j + 1)];
      const c = cost(t);
      if (c < best - 1e-6) { r = t; best = c; imp = true; }
    }
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const t = [...r]; const [x] = t.splice(i, 1); t.splice(k, 0, x);
      const c = cost(t);
      if (c < best - 1e-6) { r = t; best = c; imp = true; }
    }
  }
  return r;
}
function splitAddr(q) {
  let pre = '', s = q.trim();
  const f = s.match(/^((?:flat|apartment|apt|unit)\s+\w+,?\s*)/i);
  if (f) { pre = f[1].trim().replace(/,$/, '') + ', '; s = s.slice(f[0].length); }
  let m = s.match(/^(\d+[A-Za-z]?(?:\s?-\s?\d+[A-Za-z]?)?),?\s+(.+)$/);
  if (m) return { pre, num: m[1], street: m[2] };
  m = s.match(/^(.+?)[\s,]+(\d+[A-Za-z]?)$/);
  if (m) return { pre, num: m[2], street: m[1] };
  return { pre, num: '', street: s };
}
if (typeof module !== 'undefined') module.exports = { parseSticker, optimise, fixPostcode, splitAddr, consensus };
