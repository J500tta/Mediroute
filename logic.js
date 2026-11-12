// MediRoute logic: sticker text parsing and route ordering. No patient data is stored here.
const PC_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

// Turns raw OCR text into {name, addr, pc}. Lines AFTER the postcode are ignored
// (they usually hold medication info, which MediRoute never keeps).
function parseSticker(text) {
  const lines = text.split('\n').map(s => s.replace(/[|_~]/g, ' ').replace(/\s+/g, ' ').trim()).filter(s => s.length > 1);
  let pc = '', pi = -1;
  lines.forEach((l, i) => {
    const m = l.toUpperCase().match(PC_RE);
    if (m && pi < 0) { pc = m[1] + ' ' + m[2]; pi = i; }
  });
  const head = pi >= 0 ? lines.slice(0, pi + 1) : lines.slice(0, 4);
  if (pi >= 0) head[pi] = head[pi].replace(PC_RE, '').replace(/[,\s]+$/, '').trim();
  const clean = head.filter(Boolean);
  return { name: clean[0] || '', addr: clean.slice(1).join(', '), pc };
}

// D[i][j] = travel time from node i to node j. Node 0 = start, nodes 1..n = stops.
// closed=true returns to node 0 at the end; closed=false ends at the last stop.
// Nearest-neighbour start, then 2-opt + or-opt improvement until no gain.
function optimise(D, n, closed) {
  const cost = r => {
    let c = D[0][r[0]];
    for (let i = 0; i < r.length - 1; i++) c += D[r[i]][r[i + 1]];
    return closed ? c + D[r[r.length - 1]][0] : c;
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
if (typeof module !== 'undefined') module.exports = { parseSticker, optimise };
