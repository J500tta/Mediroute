const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today = () => new Date().toISOString().slice(0, 10);
const navUrl = (to, from) => cfg.nav === 'apple'
  ? `https://maps.apple.com/?${from ? `saddr=${from.lat},${from.lng}&` : ''}daddr=${to.lat},${to.lng}&dirflg=d`
  : `https://waze.com/ul?ll=${to.lat},${to.lng}&navigate=yes`;
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
  if (v === 'settings') { $('#sAddr').value = cfg.addr; $('#sPc').value = cfg.pc; $('#bNav').textContent = 'Navigation app: ' + (cfg.nav === 'apple' ? 'Apple Maps' : 'Waze'); $('#bEx').textContent = 'Exact house lookup: ' + (cfg.exact === false ? 'OFF' : 'ON'); }
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
    const seq = optimise(D, out.length, closed).map(i => out[i - 1]);
    const path = [start, ...seq, ...(closed ? [cfg.ll] : [])];
    const rt = (await osrm('/route/v1/driving/' + coords(path) + '?overview=full&geometries=geojson')).routes[0];
    day.order = seq.map(x => x.id);
    day.plan = { mode, closed, start, dist: rt.distance, dur: rt.duration, geo: rt.geometry };
    save(); show('list');
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
async function prep(file, bw) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(2, 2200 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const x = c.getContext('2d'); x.drawImage(bmp, 0, 0, c.width, c.height);
  const im = x.getImageData(0, 0, c.width, c.height), d = im.data, h = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) { const g = (d[i] * .3 + d[i + 1] * .59 + d[i + 2] * .11) | 0; d[i] = d[i + 1] = d[i + 2] = g; h[g]++; }
  if (bw) { // Otsu threshold
    const N = d.length / 4; let sum = 0, sB = 0, wB = 0, best = 0, th = 128;
    for (let t = 0; t < 256; t++) sum += t * h[t];
    for (let t = 0; t < 256; t++) {
      wB += h[t]; if (!wB) continue; const wF = N - wB; if (!wF) break;
      sB += t * h[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
      if (v > best) { best = v; th = t; }
    }
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = d[i] > th ? 255 : 0;
  }
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
    let p = { name: '', addr: '', pc: '' };
    for (const bw of [true, false]) { // try sharpened black-and-white first, then plain grey
      p = parseSticker((await wk.recognize(await prep(f, bw))).data.text);
      if (p.pc) break;
    }
    await wk.terminate();
    fillForm(p.name, p.addr, p.pc);
    $('#ocrMsg').textContent = p.pc ? 'Check the details below, fix anything wrong, then save.' : 'No postcode found. Type it in below, or retake the photo.';
  } catch (err) { fail(err); } finally { busy(0); }
};
function fillForm(n, a, p) { $('#form').hidden = false; $('#fName').value = n; $('#fAddr').value = a; $('#fPc').value = p; }
$('#bManual').onclick = () => fillForm('', '', '');
$('#bSave').onclick = async () => {
  const pc = $('#fPc').value.trim().toUpperCase(), name = $('#fName').value.trim() || 'Delivery', addr = $('#fAddr').value.trim();
  if (!pc) return alert('Enter a postcode.');
  busy('Checking postcode…');
  try {
    const c = await geoPc(pc);
    let ex = null;
    if (addr && cfg.exact !== false) { busy('Finding the house…'); ex = await geoExact(addr, pc, c); }
    const ll = ex || c;
    day.items.push({ id: Date.now() + Math.random().toString(36).slice(2, 6), name, addr, pc, lat: ll.lat, lng: ll.lng, ex: !!ex, s: 'todo' });
    scanned++; save();
    $('#form').hidden = true; $('#scanCount').textContent = scanned + ' added this session. Scan the next bag.';
    $('#ocrMsg').textContent = 'Saved. Take the next photo.';
  } catch (e) { fail(e); } finally { busy(0); }
};
function openScan(add) {
  addMode = add; scanned = 0; $('#form').hidden = true; $('#scanCount').textContent = '';
  $('#ocrMsg').textContent = 'Fill the frame with the name, address and postcode. The photo is read on your phone and then discarded.';
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
  $('#sum').textContent = `${mins(p.dur)} · ${km(p.dist)} · ${todoOrdered().length} stops left` + (p.closed ? ' · returns to pharmacy' : ' · ends at last stop');
  setTimeout(() => { map.invalidateSize(); map.fitBounds(line.getBounds(), { padding: [20, 20] }); }, 60);
}
const todoOrdered = () => day.order.map(id => day.items.find(x => x.id === id)).filter(x => x && x.s === 'todo');
function render() {
  const it = day.items, d = it.filter(x => x.s === 'done').length, o = it.filter(x => x.s === 'todo').length;
  $('#nT').textContent = it.length; $('#nD').textContent = d; $('#nO').textContent = o;
  const ord = todoOrdered();
  const nx = ord[0] || it.find(x => x.s === 'todo');
  const num = x => day.order.indexOf(x.id) + 1;
  $('#order').hidden = !ord.length;
  $('#order').innerHTML = ord.length ? `<details open><summary>Route order: ${ord.length} stops left</summary><p class="note">Write these numbers on the bags. They stay the same until you plan again.</p>${ord.map(x => `<div class="ol"><span class="n">${num(x)}</span><div><b>${esc(x.name)}</b><br>${esc(x.addr)}, ${esc(x.pc)}</div></div>`).join('')}</details>` : '';
  $('#next').hidden = !nx;
  if (nx) $('#next').innerHTML = `<h3>${ord[0] ? 'Stop ' + num(nx) : 'Next'}: ${esc(nx.name)}</h3><p>${esc(nx.addr)}, ${esc(nx.pc)}</p><a class="btn teal" href="${navUrl(nx)}">NAVIGATE</a><div class="row"><button class="teal" data-a="done" data-id="${nx.id}">DELIVERED</button><button class="ghost" data-a="fail" data-id="${nx.id}">UNSUCCESSFUL</button></div>`;
  const rank = x => x.s === 'todo' ? (ord.includes(x) ? ord.indexOf(x) : 500) : 1000;
  const L2 = [...it].sort((a, b) => rank(a) - rank(b));
  $('#list').innerHTML = L2.length ? L2.map(x => {
    const i = ord.indexOf(x), chip = x.s === 'todo' ? '<span class="chip">Awaiting delivery</span>' : x.s === 'done' ? '<span class="chip done">Completed</span>' : '<span class="chip fail">Delivery unsuccessful</span>';
    const btns = x.s === 'todo'
      ? `<div class="row"><button class="sm teal" data-a="done" data-id="${x.id}">Delivered</button><button class="sm ghost" data-a="fail" data-id="${x.id}">Unsuccessful</button></div><div class="row"><a class="btn sm ghost" href="${navUrl(x)}">Navigate</a><button class="sm ghost" data-a="del" data-id="${x.id}">Remove</button></div>`
      : `<div class="row"><button class="sm ghost" data-a="undo" data-id="${x.id}">Undo</button></div>`;
    return `<div class="card ${x.s === 'todo' ? '' : 'done'}"><h3>${i >= 0 ? `<span class="n">${num(x)}</span>` : ''}${esc(x.name)}</h3><p>${esc(x.addr)}</p><p>${esc(x.pc)}</p>${x.ex ? '' : '<p class="note">Approximate location (postcode only)</p>'}${chip}${btns}</div>`;
  }).join('') : '<p class="note">No deliveries yet. Press Scan medication on the home screen.</p>';
}
$('#next').onclick = $('#list').onclick = e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const x = day.items.find(i => i.id === b.dataset.id), a = b.dataset.a;
  if (a === 'done') x.s = 'done'; else if (a === 'fail') x.s = 'fail'; else if (a === 'undo') x.s = 'todo';
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
render(); show('home');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
