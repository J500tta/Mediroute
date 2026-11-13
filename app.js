const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today = () => new Date().toISOString().slice(0, 10);
const navUrl = (to, from) => cfg.nav === 'apple'
  ? `https://maps.apple.com/?${from ? `saddr=${from.lat},${from.lng}&` : ''}daddr=${to.lat},${to.lng}&dirflg=d`
  : `waze://?ll=${to.lat},${to.lng}&navigate=yes`;
const OSRM = 'https://router.project-osrm.org';

// ---- Storage (this phone only). Deliveries are wiped each new day. ----
let cfg = JSON.parse(localStorage.getItem('mr.cfg') || 'null') ||
  { addr: 'Bridge Street Pharmacy, 19B Bridge Street, Loughborough', pc: 'LE11 1NQ' };
let day = JSON.parse(localStorage.getItem('mr.day') || 'null');
if (!day || day.d !== today()) day = { d: today(), items: [], order: [], plan: null };
const save = () => {
  localStorage.setItem('mr.cfg', JSON.stringify(cfg));
  localStorage.setItem('mr.day', JSON.stringify(day));
  render();
};

// ---- Helpers ----
let addMode = false, scanned = 0;
const busy = m => { const b = $('#busy'); b.hidden = !m; b.textContent = m || ''; };
const show = v => {
  document.querySelectorAll('main>section').forEach(s => s.hidden = s.id !== 'v-' + v);
  if (v === 'list') drawMap();
  if (v === 'settings') { $('#sAddr').value = cfg.addr; $('#sPc').value = cfg.pc; $('#bPin').textContent = 'Passcode: ' + (cfg.pin ? 'ON' : 'OFF') + ' (tap to change)'; $('#bNav').textContent = 'Navigation app: ' + (cfg.nav === 'apple' ? 'Apple Maps' : 'Waze'); $('#bEx').textContent = 'Address search and exact house lookup: ' + (cfg.exact === false ? 'OFF' : 'ON'); }
  window.scrollTo(0, 0);
};
const mins = s => s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.round(s % 3600 / 60) + ' min' : Math.round(s / 60) + ' min';
const km = m => (m / 1609.34).toFixed(1) + ' miles';
const fail = e => alert(e.message || e);

async function geoPc(pc) {
  const r = await fetch('https://api.postcodes.io/postcodes/' + encodeURIComponent(pc.replace(/\s/g, '')));
  if (!r.ok) throw new Error('Postcode "' + pc + '" was not found. Check it and try again.');
  const j = (await r.json()).result;
  return { lat: j.latitude, lng: j.longitude };
}
const distM = (a, b) => { const r = x => x * Math.PI / 180, h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
// Finds the exact house on OpenStreetMap (Nominatim). Rejected if it lands >1.5 km from the postcode.
async function geoExact(addr, pc, c) {
  for (const q of [addr + ', ' + pc, addr + ', Loughborough, UK']) {
    try {
      const j = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=' + encodeURIComponent(q))).json();
      if (j[0]) { const p = { lat: +j[0].lat, lng: +j[0].lon }; if (distM(p, c) < 1500) return p; }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1100));
  }
  return null;
}
async function ensurePharm() {
  if (!cfg.ll || cfg.llPc !== cfg.pc) { cfg.ll = await geoPc(cfg.pc); cfg.llPc = cfg.pc; save(); }
}
const gps = () => new Promise((ok, no) => navigator.geolocation
  ? navigator.geolocation.getCurrentPosition(p => ok({ lat: p.coords.latitude, lng: p.coords.longitude }),
    () => no(new Error('Could not get your location. Allow Location for MediRoute in iPhone Settings > Privacy > Location Services.')),
    { enableHighAccuracy: true, timeout: 15000 })
  : no(new Error('This device has no GPS support.')));

async function osrm(path) {
  const r = await fetch(OSRM + path);
  const j = await r.json();
  if (j.code !== 'Ok') throw new Error('The free routing service could not plan this route. Try again in a minute.');
  return j;
}
const coords = pts => pts.map(p => p.lng + ',' + p.lat).join(';');

// ---- Route planning ----
async function plan(mode) {
  const out = day.items.filter(x => x.s === 'todo' && x.lat != null);
  if (!out.length) return alert('There are no outstanding deliveries to plan.');
  busy(mode === 'full' ? 'Planning route…' : 'Finding your location…');
  try {
    await ensurePharm();
    const closed = mode === 'full';
    const start = closed ? cfg.ll : await gps();
    busy('Planning route…');
    const j = await osrm('/table/v1/driving/' + coords([start, ...out]) + '?annotations=duration');
    const D = j.durations.map(r => r.map(v => v == null ? 1e9 : v));
    const grp = [[], [], []]; // urgent/fridge, normal, skipped
    out.forEach((x, i) => grp[x.skip ? 2 : x.urgent || x.cold ? 0 : 1].push(i + 1));
    const order = []; let from = 0;
    grp.forEach((idxs, g) => {
      if (!idxs.length) return;
      const pts = [from, ...idxs], M = pts.map(a => pts.map(b => D[a][b]));
      const ret = [0, ...idxs.map(a => D[a][0])], last = grp.slice(g + 1).every(a => !a.length);
      const r = optimise(M, idxs.length, closed && last, ret).map(k => idxs[k - 1]);
      order.push(...r); from = r[r.length - 1];
    });
    const seq = order.map(i => out[i - 1]);
    const path = [start, ...seq, ...(closed ? [cfg.ll] : [])];
    const rt = (await osrm('/route/v1/driving/' + coords(path) + '?overview=full&geometries=geojson')).routes[0];
    day.order = seq.map(x => x.id);
    day.plan = { mode, closed, start, dist: rt.distance, dur: rt.duration, geo: rt.geometry };
    save(); show('list'); trackMiles();
  } catch (e) { fail(e); } finally { busy(0); }
}
async function backToPharmacy() {
  busy('Finding your location…');
  try {
    await ensurePharm();
    const p = await gps();
    location.href = navUrl(cfg.ll, p);
  } catch (e) { fail(e); } finally { busy(0); }
}

// ---- Scanner (on-device OCR with Tesseract.js) ----
function loadTess() {
  return window.Tesseract ? Promise.resolve() : new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = ok; s.onerror = () => no(new Error('Could not load the text reader. Check your internet connection (needed the first time only).'));
    document.head.appendChild(s);
  });
}
// Enlarges, greys and (optionally) black-and-white thresholds the photo so text is crisper.
async function prep(file, mode) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(2, 2200 / Math.max(bmp.width, bmp.height));
  const W = Math.round(bmp.width * k), H = Math.round(bmp.height * k);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'); x.drawImage(bmp, 0, 0, W, H);
  const im = x.getImageData(0, 0, W, H), d = im.data, g = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = (d[i] * .3 + d[i + 1] * .59 + d[i + 2] * .11) | 0;
  let out = g;
  if (mode === 'adapt') { // local-average threshold: copes with shadows and glare
    const S = new Float64Array((W + 1) * (H + 1)), r = Math.max(15, W >> 5);
    for (let y = 0; y < H; y++) { let row = 0; for (let u = 0; u < W; u++) { row += g[y * W + u]; S[(y + 1) * (W + 1) + u + 1] = S[y * (W + 1) + u + 1] + row; } }
    out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let u = 0; u < W; u++) {
      const x0 = Math.max(0, u - r), x1 = Math.min(W - 1, u + r), y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sm = S[(y1 + 1) * (W + 1) + x1 + 1] - S[y0 * (W + 1) + x1 + 1] - S[(y1 + 1) * (W + 1) + x0] + S[y0 * (W + 1) + x0];
      out[y * W + u] = g[y * W + u] * n < sm * 0.9 ? 0 : 255;
    }
  } else if (mode === 'otsu') {
    const h = new Array(256).fill(0); g.forEach(v => h[v]++);
    const N = g.length; let sum = 0, sB = 0, wB = 0, best = 0, th = 128;
    for (let t = 0; t < 256; t++) sum += t * h[t];
    for (let t = 0; t < 256; t++) {
      wB += h[t]; if (!wB) continue; const wF = N - wB; if (!wF) break;
      sB += t * h[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
      if (v > best) { best = v; th = t; }
    }
    out = g.map(v => v > th ? 255 : 0);
  }
  for (let i = 0, j = 0; i < d.length; i += 4, j++) d[i] = d[i + 1] = d[i + 2] = out[j];
  x.putImageData(im, 0, 0); return c;
}
$('#cam').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  busy('Reading sticker on your phone…');
  try {
    await loadTess();
    const wk = await Tesseract.createWorker('eng');
    await wk.setParameters({ tessedit_pageseg_mode: '6' });
    let p = { name: '', addr: '', pc: '' }, best = -1;
    const modes = ['adapt', 'otsu', 'grey']; // three ways of cleaning the photo; the best reading wins
    for (const mode of modes) {
      busy('Reading sticker (' + (modes.indexOf(mode) + 1) + ' of 3)…');
      const t = parseSticker((await wk.recognize(await prep(f, mode))).data.text);
      const sc = (t.pc ? 10 : 0) + (t.phone ? 2 : 0) + (t.name ? 1 : 0) + (t.addr ? 2 : 0);
      if (sc > best) { best = sc; p = t; }
      if (t.pc && t.name && t.addr) break;
    }
    await wk.terminate();
    fillForm(p.name, p.addr, p.pc, p.phone);
    $('#ocrMsg').textContent = p.pc ? 'Is this right? Tap CONFIRM & ADD, or tap any box to amend it first.' : 'No postcode found. Type it in below, or retake the photo.';
  } catch (err) { fail(err); } finally { busy(0); }
};
function fillForm(n, a, p, ph = '') { $('#form').hidden = false; $('#fName').value = n; $('#fAddr').value = a; $('#fPc').value = p; $('#fFlag').value = '0'; $('#fNote').value = ''; $('#fPhone').value = ph; picked = null; $('#sugg').innerHTML = ''; }
$('#bManual').onclick = () => fillForm('', '', '');
$('#bSave').onclick = async () => {
  const pc = $('#fPc').value.trim().toUpperCase(), name = $('#fName').value.trim() || 'Delivery', addr = $('#fAddr').value.trim();
  if (!pc) return alert('Enter a postcode.');
  busy('Checking postcode…');
  try {
    const fl = +$('#fFlag').value, urgent = !!(fl & 1), cold = !!(fl & 2), note = $('#fNote').value.trim(), phone = $('#fPhone').value.trim();
    const key = (addr + pc).toLowerCase().replace(/[^a-z0-9]/g, '');
    const dup = day.items.find(i => i.s === 'todo' && i.key === key);
    if (dup) { // same address: one stop, more bags
      dup.bags = (dup.bags || 1) + 1; dup.urgent = dup.urgent || urgent; dup.cold = dup.cold || cold; if (phone && !dup.phone) dup.phone = phone;
      if (note) dup.note = (dup.note ? dup.note + '; ' : '') + note;
      scanned++; save(); $('#form').hidden = true; $('#scanCount').textContent = 'Added to an existing stop (' + dup.bags + ' bags).'; return;
    }
    const c = await geoPc(pc);
    let ex = null;
    if (picked && picked.house && picked.addr === addr && distM(picked, c) < 1500) ex = { lat: picked.lat, lng: picked.lng };
    else if (addr && cfg.exact !== false) { busy('Finding the house…'); ex = await geoExact(addr, pc, c); }
    const ll = ex || c;
    day.items.push({ id: Date.now() + Math.random().toString(36).slice(2, 6), name, addr, pc, lat: ll.lat, lng: ll.lng, ex: !!ex, key, bags: 1, urgent, cold, note, phone, s: 'todo' });
    scanned++; save();
    $('#form').hidden = true; $('#scanCount').textContent = scanned + ' added this session. Scan the next bag.';
    $('#ocrMsg').textContent = 'Saved. Take the next photo.';
  } catch (e) { fail(e); } finally { busy(0); }
};
function openScan(add) {
  addMode = add; scanned = 0; $('#form').hidden = true; $('#scanCount').textContent = '';
  $('#ocrMsg').textContent = 'Hold the phone straight above the sticker and fill the frame. The photo is read on your phone and then discarded.';
  show('scan');
}
$('#bDone').onclick = () => {
  if (addMode && scanned && day.plan && confirm('Recalculate your route from where you are now?')) plan('continue');
  else show('list');
};

// ---- List + map ----
let map, layer;
function drawMap() {
  const p = day.plan;
  $('#mapbox').hidden = !p;
  if (!p) return;
  if (!map) {
    map = L.map('map');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
    layer = L.layerGroup().addTo(map);
  }
  layer.clearLayers();
  const line = L.geoJSON(p.geo, { style: { color: '#0FB5A6', weight: 5 } }).addTo(layer);
  const pin = (ll, t, c) => L.marker([ll.lat, ll.lng], { icon: L.divIcon({ className: '', html: `<div class="pin" style="background:${c}">${t}</div>`, iconSize: [28, 28] }) }).addTo(layer);
  pin(p.start, p.closed ? 'P' : '●', '#0B1F3A');
  todoOrdered().forEach(x => pin(x, day.order.indexOf(x.id) + 1, '#0FB5A6'));
  $('#sum').textContent = `${mins(p.dur)} · ${km(p.dist)} · ${todoOrdered().length} stops left` + (p.closed ? ' · returns to pharmacy' : ' · ends at last stop') + (p.stale ? ' · order changed by hand; time and line are from the last plan' : '');
  setTimeout(() => { map.invalidateSize(); map.fitBounds(line.getBounds(), { padding: [20, 20] }); }, 60);
}
const todoOrdered = () => day.order.map(id => day.items.find(x => x.id === id)).filter(x => x && x.s === 'todo');
function render() {
  const it = day.items, d = it.filter(x => x.s === 'done').length, o = it.filter(x => x.s === 'todo').length;
  $('#nT').textContent = it.length; $('#nD').textContent = d; $('#nO').textContent = o;
  const ord = todoOrdered();
  const nx = ord.find(x => !x.skip) || it.find(x => x.s === 'todo' && !x.skip) || ord[0] || it.find(x => x.s === 'todo');
  const num = x => day.order.indexOf(x.id) + 1;
  $('#order').hidden = !ord.length;
  $('#order').innerHTML = ord.length ? `<details open><summary>Route order: ${ord.length} stops left</summary><p class="note">Write these numbers on the bags. They stay the same until you plan again.</p>${ord.map(x => `<div class="ol"><span class="n">${num(x)}</span><div><b>${esc(x.name)}</b><br>${esc(x.addr)}, ${esc(x.pc)}</div></div>`).join('')}</details>` : '';
  $('#next').hidden = !nx;
  if (nx) $('#next').innerHTML = `<h3>${num(nx) > 0 ? 'Stop ' + num(nx) : 'Next'}: ${esc(nx.name)}</h3><p>${esc(nx.addr)}, ${esc(nx.pc)}</p><a class="btn teal" href="${navUrl(nx)}">NAVIGATE</a><div class="row"><button class="teal" data-a="done" data-id="${nx.id}">DELIVERED</button><button class="ghost" data-a="fail" data-id="${nx.id}">UNSUCCESSFUL</button></div>`;
  const rank = x => x.s === 'todo' ? (ord.includes(x) ? ord.indexOf(x) : 500) : 1000;
  const L2 = [...it].sort((a, b) => rank(a) - rank(b));
  $('#list').innerHTML = L2.length ? L2.map(x => {
    const i = ord.indexOf(x), chip = x.s === 'todo' ? '<span class="chip">Awaiting delivery</span>' : x.s === 'done' ? '<span class="chip done">Completed</span>' : '<span class="chip fail">Delivery unsuccessful</span>';
    const btns = x.s === 'todo'
      ? `<div class="row"><button class="sm teal" data-a="done" data-id="${x.id}">Delivered</button><button class="sm ghost" data-a="fail" data-id="${x.id}">Unsuccessful</button></div><div class="row"><a class="btn sm ghost" href="${navUrl(x)}">Navigate</a><button class="sm ghost" data-a="del" data-id="${x.id}">Remove</button></div><div class="row"><button class="sm ghost" data-a="skip" data-id="${x.id}">${x.skip ? 'Unskip' : 'Skip for now'}</button><button class="sm ghost" data-a="up" data-id="${x.id}">▲</button><button class="sm ghost" data-a="down" data-id="${x.id}">▼</button></div>`
      : `<div class="row"><button class="sm ghost" data-a="undo" data-id="${x.id}">Undo</button></div>`;
    return `<div class="card ${x.s === 'todo' ? '' : 'done'}"><h3>${i >= 0 ? `<span class="n">${num(x)}</span>` : ''}${esc(x.name)}</h3><p>${esc(x.addr)}</p><p>${esc(x.pc)}</p>${x.ex ? '' : '<p class="note">Approximate location (postcode only)</p>'}${chip} ${flags(x)}${x.phone ? `<p><a href="tel:${esc(x.phone)}">${esc(x.phone)}</a></p>` : ''}${x.note ? `<p><i>${esc(x.note)}</i></p>` : ''}${btns}</div>`;
  }).join('') : '<p class="note">No deliveries yet. Press Scan medication on the home screen.</p>';
}
$('#next').onclick = $('#list').onclick = e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const x = day.items.find(i => i.id === b.dataset.id), a = b.dataset.a;
  if (a === 'done') x.s = 'done'; else if (a === 'fail') x.s = 'fail'; else if (a === 'undo') x.s = 'todo';
  else if (a === 'skip') x.skip = !x.skip;
  else if (a === 'up' || a === 'down') move(x, a === 'up' ? -1 : 1);
  else if (a === 'del' && confirm('Remove this delivery?')) day.items = day.items.filter(i => i !== x);
  save(); if (day.plan) drawMap();
};

// ---- Buttons ----
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => show(b.dataset.go));
$('#bScan').onclick = () => openScan(false);
$('#bAdd').onclick = () => openScan(true);
$('#bPlan').onclick = $('#bPlan2').onclick = () => plan('full');
$('#bCont').onclick = $('#bCont2').onclick = () => plan('continue');
$('#bBack').onclick = backToPharmacy;
$('#bCfg').onclick = () => { cfg.addr = $('#sAddr').value.trim(); cfg.pc = $('#sPc').value.trim().toUpperCase(); cfg.ll = null; save(); ensurePharm().then(() => alert('Pharmacy saved.')).catch(fail); };
$('#bWipe').onclick = () => { if (confirm('Delete all deliveries from this phone?')) { day = { d: today(), items: [], order: [], plan: null }; save(); show('home'); } };

$('#bNav').onclick = () => { cfg.nav = cfg.nav === 'apple' ? 'waze' : 'apple'; save(); show('settings'); };
$('#bEx').onclick = () => { cfg.exact = cfg.exact === false; save(); show('settings'); };
const wake = async () => { try { if (navigator.wakeLock && document.visibilityState === 'visible') await navigator.wakeLock.request('screen'); } catch (e) {} };
wake(); document.addEventListener('visibilitychange', wake); // keeps the screen on while you work
const flags = x => (x.bags > 1 ? `<span class="chip">${x.bags} bags</span> ` : '') + (x.urgent ? '<span class="chip fail">Urgent</span> ' : '') + (x.cold ? '<span class="chip cold">Fridge</span> ' : '') + (x.skip ? '<span class="chip skip">Skipped</span>' : '');
function move(x, dir) { // nudge a stop earlier or later by hand
  const t = todoOrdered(), y = t[t.indexOf(x) + dir];
  if (!y || t.indexOf(x) < 0) return;
  const i = day.order.indexOf(x.id), j = day.order.indexOf(y.id);
  [day.order[i], day.order[j]] = [day.order[j], day.order[i]];
  if (day.plan) day.plan.stale = true;
}
// Mileage: adds up GPS distance only while the app is open. Stores distance only, never places.
let tracking = false, lastFix = null;
function trackMiles() {
  if (tracking || !navigator.geolocation) return; tracking = true;
  navigator.geolocation.watchPosition(p => {
    if (p.coords.accuracy > 50) return;
    const c = { lat: p.coords.latitude, lng: p.coords.longitude };
    if (!lastFix) { lastFix = c; return; }
    const d = distM(lastFix, c);
    if (d >= 3000) lastFix = c;
    else if (d > 30) {
      lastFix = c; day.miles = (day.miles || 0) + d;
      localStorage.setItem('mr.day', JSON.stringify(day));
      const lg = JSON.parse(localStorage.getItem('mr.log') || '{}'); lg[day.d] = Math.round(day.miles); localStorage.setItem('mr.log', JSON.stringify(lg));
    }
  }, () => {}, { enableHighAccuracy: true });
}
function sumText(names) {
  const it = day.items, c = s => it.filter(x => x.s === s).length, bad = it.filter(x => x.s === 'fail');
  return `MediRoute round ${day.d}\nDelivered: ${c('done')}\nUnsuccessful: ${c('fail')}\nOutstanding: ${c('todo')}\nMiles driven today: ${((day.miles || 0) / 1609.34).toFixed(1)}`
    + (bad.length ? '\n\nTake back to pharmacy:\n' + bad.map(x => `- Stop ${day.order.indexOf(x.id) + 1 || '?'}, ${names ? x.name + ', ' : ''}${x.pc}`).join('\n') : '');
}
$('#bSum').onclick = () => {
  const lg = JSON.parse(localStorage.getItem('mr.log') || '{}');
  $('#sumBody').innerHTML = `<pre style="white-space:pre-wrap;font:inherit">${esc(sumText(false))}</pre><h3>Mileage log</h3>` +
    (Object.keys(lg).sort().reverse().slice(0, 14).map(d => `<p>${esc(d)}: ${(lg[d] / 1609.34).toFixed(1)} miles</p>`).join('') || '<p class="note">Nothing logged yet.</p>') +
    '<p class="note">Miles count only while MediRoute is open on screen. Distances only; no addresses are logged.</p>';
  show('sum');
};
$('#bCopy').onclick = async () => { const t = sumText(confirm('Include customer names? Cancel leaves them out.')); try { await navigator.clipboard.writeText(t); alert('Copied.'); } catch (e) { alert(t); } };
// Passcode: a casual lock, not encryption. Your iPhone passcode is the real protection.
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('mr:' + s)))].map(b => b.toString(16).padStart(2, '0')).join('');
function lock() { if (cfg.pin) { $('#lock').hidden = false; $('#pin').value = ''; } }
$('#bUnlock').onclick = async () => { if (await sha($('#pin').value) === cfg.pin) $('#lock').hidden = true; else { $('#pin').value = ''; alert('Wrong passcode.'); } };
$('#bPin').onclick = async () => {
  const p = prompt('New passcode, 4 or more digits. Leave empty to remove it.'); if (p === null) return;
  if (p && !/^\d{4,}$/.test(p)) return alert('Use 4 or more digits.');
  cfg.pin = p ? await sha(p) : null; save(); show('settings');
};
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); else if (hiddenAt && Date.now() - hiddenAt > 180000) lock(); });
if (day.plan) trackMiles();
lock();
// Address suggestions (Photon, free, OpenStreetMap data). Respects the Settings switch.
let picked = null, sg = [], sT;
$('#fAddr').addEventListener('input', () => {
  clearTimeout(sT); const q = $('#fAddr').value.trim();
  if (q.length < 4 || cfg.exact === false) { $('#sugg').innerHTML = ''; return; }
  sT = setTimeout(async () => {
    try {
      const l = cfg.ll || { lat: 52.77, lng: -1.2 }, a = splitAddr(q);
      const get = async t => (await (await fetch(`https://photon.komoot.io/api/?limit=8&lang=en&lat=${l.lat}&lon=${l.lng}&q=${encodeURIComponent(t)}`)).json()).features.filter(f => f.properties.countrycode === 'GB');
      const [byNum, byStreet] = await Promise.all([a.num ? get(a.street + ' ' + a.num) : [], get(a.street)]);
      const seen = new Set(); sg = [];
      const add = (f, house) => {
        const p = f.properties, st = p.street || p.name;
        if (!st || (!p.street && p.osm_key !== 'highway')) return;
        const line = a.pre + (a.num ? a.num + ' ' : '') + st + ((p.city || p.district || p.county) ? ', ' + (p.city || p.district || p.county) : '');
        if (seen.has(line.toLowerCase())) return; seen.add(line.toLowerCase());
        sg.push({ line, pc: house ? p.postcode || '' : '', lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], house });
      };
      byNum.filter(f => (f.properties.housenumber || '').toLowerCase() === a.num.toLowerCase()).forEach(f => add(f, true));
      byStreet.forEach(f => add(f, false));
      $('#sugg').innerHTML = sg.slice(0, 6).map((s, i) => `<button class="sg" data-i="${i}">${esc(s.line)}${s.pc ? ' · ' + esc(s.pc) : ''}</button>`).join('');
    } catch (e) { $('#sugg').innerHTML = ''; }
  }, 450);
});
$('#sugg').onclick = e => {
  const b = e.target.closest('[data-i]'); if (!b) return;
  const s = sg[+b.dataset.i];
  $('#fAddr').value = s.line; if (s.pc) $('#fPc').value = s.pc.toUpperCase();
  picked = { addr: s.line, lat: s.lat, lng: s.lng, house: s.house }; $('#sugg').innerHTML = '';
};
$('#bLive').onclick = () => { $('#live').hidden = !$('#live').hidden; if (!$('#live').hidden) $('#raw').focus(); };
$('#bRead').onclick = () => {
  const p = parseSticker($('#raw').value);
  fillForm(p.name, p.addr, p.pc, p.phone); $('#raw').value = ''; $('#live').hidden = true;
  $('#ocrMsg').textContent = p.pc ? 'Is this right? Tap CONFIRM & ADD, or tap any box to amend it first.' : 'No postcode found. Type it in below, or scan again.';
};
render(); show('home');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
