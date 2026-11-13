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
  if (o.length === 4) { o[1] = FIXL[o[1]] || o[1]; o[2] = FIXD[o[2]] || o[2]; o[3] = FIXD[o[3]] || o[3]; }
  const pc = o.join('') + ' ' + (FIXD[inw[0]] || inw[0]) + (FIXL[inw[1]] || inw[1]) + (FIXL[inw[2]] || inw[2]);
  return PC_RE.test(pc) ? pc : '';
}

const PH_RE = /(\+44[\s-]?\(?0?\)?[\s-]?|\b0)\d[\d\s-]{8,11}\d\b/;

// Turns raw OCR text into {name, addr, pc}. Lines AFTER the postcode are ignored
// (they usually hold medication info, which MediRoute never keeps).
const TITLE = /^(mr|mrs|ms|miss|mx|dr|master|prof|rev|sir)\b\.?(\s|$)/i;
const HNUM = /^((flat|apartment|apt|unit)\s+\w+,?\s*)?\d+[A-Za-z]?\b/i;
// ownPc = the pharmacy postcode, so the pharmacy's own address on a label is never mistaken for the customer's.
function parseSticker(text, ownPc) {
  let lines = text.split('\n').map(s => s.replace(/[|_~]/g, ' ').replace(/\s+/g, ' ').trim()).filter(s => s.length > 1);
  lines = lines.filter(l => (l.match(/[A-Za-z0-9]/g) || []).length >= l.replace(/\s/g, '').length * 0.6); // drop OCR garbage
  let phone = '';
  lines = lines.map(l => {
    const m = l.match(PH_RE);
    if (!phone && m) {
      const d = m[0].replace(/[^\d+]/g, '');
      if (/^0\d{10}$/.test(d) || /^\+44\d{10}$/.test(d)) { phone = d; l = l.replace(m[0], ' ').replace(/\b(tel|telephone|phone|mobile|mob)\b\.?:?/i, '').trim(); }
    }
    return l;
  }).filter(l => l.length > 1);
  const found = [];
  lines.forEach((l, i) => {
    const u = l.toUpperCase();
    let m = u.match(PC_RE);
    if (m) { found.push({ i, pc: m[1] + ' ' + m[2] }); return; }
    m = u.replace(/[^A-Z0-9 ]/g, '').match(/([A-Z0-9]{2,4})\s?([A-Z0-9]{3})$/);
    const f = m && fixPostcode(m[1] + m[2]);
    if (f) { found.push({ i, pc: f }); lines[i] = l.replace(/[A-Za-z0-9]{2,4}\s?[A-Za-z0-9]{3}[^A-Za-z0-9]*$/, ' ' + f); }
  });
  const own = (ownPc || '').replace(/\s/g, '').toUpperCase();
  const isOwn = x => own && x.pc.replace(/\s/g, '') === own;
  const pick = found.find(x => !isOwn(x)) || found[0];
  let pc = '', pi = -1;
  if (pick) {
    pc = pick.pc; pi = pick.i;
    const above = found.filter(x => isOwn(x) && x.i < pi).pop(); // pharmacy block printed above the customer
    if (above) { lines = lines.slice(above.i + 1); pi -= above.i + 1; }
  }
  let head = pi >= 0 ? lines.slice(0, pi + 1) : lines.slice(0, 5);
  if (pi >= 0) head[pi] = head[pi].replace(PC_RE, '').replace(/[,\s]+$/, '').trim();
  head = head.map(l => l.replace(/^(patient|name|address|deliver(y)? to)\s*[:\-]\s*/i, '')).filter(Boolean);
  let ni = head.findIndex(l => TITLE.test(l));
  if (ni < 0) {
    if (HNUM.test(head[0] || '')) ni = -1;
    else { const hi = head.findIndex((l, k) => k > 0 && HNUM.test(l)); ni = hi > 0 ? hi - 1 : 0; }
  }
  return { name: ni >= 0 ? head[ni] : '', addr: head.slice(ni + 1).join(', '), pc, phone };
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
if (typeof module !== 'undefined') module.exports = { parseSticker, optimise, fixPostcode, splitAddr };
