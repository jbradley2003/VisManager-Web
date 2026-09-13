/* VisManager Web — review logic.
 *
 * Design notes
 * ------------
 * Files are kept as File objects, which the browser backs with the original
 * on disk rather than holding in memory. Only the file being viewed is
 * decoded, so a folder of several hundred large images costs almost nothing
 * until you look at one. Object URLs are revoked on navigation for the same
 * reason.
 *
 * "Delete" never touches anything. It marks a file for exclusion from the
 * exports and for the delete-list, which is what makes this safe to run on a
 * static page with no special permissions.
 */
'use strict';

const TYPES = {
  tga:['tga'], png:['png'], jpeg:['jpg','jpeg','jpe'], bmp:['bmp','dib'],
  gif:['gif'], webp:['webp'], tiff:['tif','tiff'], ico:['ico'],
  dds:['dds'], pdf:['pdf'], cube:['cube','cub']
};
const EXT2TYPE = {};
for (const [t, exts] of Object.entries(TYPES)) exts.forEach(e => EXT2TYPE[e] = t);
// Rendered by the browser itself; everything else needs help or can't be shown.
const NATIVE = new Set(['png','jpeg','gif','webp','bmp','ico']);

const S = {
  files: [],          // {file, path, folder, name, type}
  folders: [],        // folder paths in order
  byFolder: new Map(),
  state: new Map(),   // path -> true(keep)/false(delete)
  notes: new Map(),   // path -> string ("" = flagged, no text)
  enabled: new Set(Object.keys(TYPES)),
  collapsed: new Set(),
  fi: 0, ii: 0,       // folder index, image index
  zoom: 1, fit: 1, ox: 0, oy: 0,
  url: null, el: null, natural: [0, 0],
  rootName: ''
};

const $ = id => document.getElementById(id);
const extOf = n => (n.lastIndexOf('.') > 0 ? n.slice(n.lastIndexOf('.') + 1) : '').toLowerCase();

/* ── Loading ─────────────────────────────────────────────────────────────── */
function ingest(fileList) {
  const files = [];
  for (const f of fileList) {
    const rel = f.webkitRelativePath || f.name;
    const type = EXT2TYPE[extOf(f.name)];
    if (!type) continue;
    const parts = rel.split('/');
    files.push({
      file: f, path: rel, name: f.name, type,
      folder: parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)'
    });
  }
  if (!files.length) { alert('No supported files found in that folder.'); return; }

  files.sort((a, b) => a.path.localeCompare(b.path, undefined, {numeric: true}));
  S.files = files;
  S.rootName = (files[0].path.split('/')[0]) || 'folder';
  S.state = new Map(files.map(f => [f.path, true]));
  S.notes = new Map();
  S.fi = S.ii = 0;
  rebuild();
  $('dirname').textContent = `${S.rootName} — ${files.length} files`;
  $('bExport').disabled = false;
  show();
}

function rebuild() {
  S.byFolder = new Map();
  for (const f of S.files) {
    if (!S.enabled.has(f.type)) continue;
    if (!S.byFolder.has(f.folder)) S.byFolder.set(f.folder, []);
    S.byFolder.get(f.folder).push(f);
  }
  S.folders = [...S.byFolder.keys()];
  S.fi = Math.min(S.fi, Math.max(0, S.folders.length - 1));
  S.ii = Math.min(S.ii, Math.max(0, (cur() || []).length - 1));
  drawTree(); drawChips(); drawStats();
}

const cur = () => S.byFolder.get(S.folders[S.fi]) || [];
const curFile = () => cur()[S.ii];

/* ── Sidebar ─────────────────────────────────────────────────────────────── */
function drawTree() {
  const tree = $('tree'); tree.innerHTML = '';
  // Group by top-level directory so several dropped folders stay separable.
  const groups = new Map();
  for (const folder of S.folders) {
    const top = folder.split('/')[0];
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(folder);
  }
  const multi = groups.size > 1;
  for (const [top, folders] of groups) {
    if (multi) {
      const open = !S.collapsed.has(top);
      const n = folders.reduce((a, f) => a + S.byFolder.get(f).length, 0);
      const g = document.createElement('div');
      g.className = 'grp';
      g.textContent = `${open ? '▾' : '▸'} ${top}  [${folders.length} folders, ${n} files]`;
      g.onclick = () => { open ? S.collapsed.add(top) : S.collapsed.delete(top); drawTree(); };
      tree.appendChild(g);
      if (!open) continue;
    }
    for (const folder of folders) {
      const list = S.byFolder.get(folder);
      const keep = list.filter(f => S.state.get(f.path)).length;
      const flags = list.filter(f => S.notes.has(f.path)).length;
      const d = document.createElement('div');
      d.className = 'fld' + (S.folders[S.fi] === folder ? ' on' : '');
      d.textContent = `${folder.split('/').pop() || folder}  (${keep}/${list.length} ✓)` +
                      (flags ? `  ⚐${flags}` : '');
      d.title = folder;
      d.onclick = () => { S.fi = S.folders.indexOf(folder); S.ii = 0; show(); };
      tree.appendChild(d);
    }
  }
}

function drawChips() {
  const counts = {};
  for (const f of S.files) counts[f.type] = (counts[f.type] || 0) + 1;
  const box = $('chips'); box.innerHTML = '';
  for (const t of Object.keys(TYPES)) {
    if (!counts[t]) continue;
    const c = document.createElement('span');
    c.className = 'chip' + (S.enabled.has(t) ? '' : ' off');
    c.textContent = `${S.enabled.has(t) ? '☑' : '☐'} ${t.toUpperCase()} ${counts[t]}`;
    c.onclick = () => {
      S.enabled.has(t) ? S.enabled.delete(t) : S.enabled.add(t);
      rebuild(); show();
    };
    box.appendChild(c);
  }
}

function drawStats() {
  let keep = 0, del = 0;
  for (const f of S.files) {
    if (!S.enabled.has(f.type)) continue;
    S.state.get(f.path) ? keep++ : del++;
  }
  $('sKeep').textContent = `✓ ${keep}`;
  $('sDel').textContent = `✗ ${del}`;
  $('sFlag').textContent = S.notes.size ? `⚐ ${S.notes.size}` : '';
  $('sTot').textContent = `of ${keep + del}`;
}

/* ── Viewing ─────────────────────────────────────────────────────────────── */
async function show() {
  drawTree(); drawStats();
  const f = curFile();
  const view = $('view');
  if (S.url) { URL.revokeObjectURL(S.url); S.url = null; }
  view.innerHTML = '';

  if (!f) {
    view.innerHTML = '<div id="placeholder">Nothing to show with the current filters.</div>';
    $('count').textContent = '—'; $('ctx').textContent = '';
    $('fname').textContent = ''; $('finfo').textContent = '';
    $('state').textContent = ''; $('note').textContent = '';
    return;
  }

  const list = cur(), keep = S.state.get(f.path);
  $('count').textContent = `${S.ii + 1} / ${list.length}`;
  $('count').style.color = keep ? 'var(--keep-hi)' : 'var(--del-hi)';
  $('ctx').textContent = `${f.folder}  •  folder ${S.fi + 1} of ${S.folders.length}`;
  $('bar').firstElementChild.style.width = ((S.ii + 1) / list.length * 100) + '%';
  $('fname').textContent = f.name;
  $('viewwrap').style.background = keep ? 'var(--keep-bg)' : 'var(--del-bg)';
  $('state').innerHTML = keep
    ? '<span style="color:var(--keep-hi)">◉ KEEP</span>'
    : '<span style="color:var(--del-hi)">◉ DELETE</span>';
  const note = S.notes.get(f.path);
  $('note').textContent = note ? `⚐ ${note}` : (S.notes.has(f.path) ? '⚐ flagged' : '');
  $('bFlag').className = S.notes.has(f.path) ? 'flag' : '';

  showIsoControls(false);
  try {
    if (NATIVE.has(f.type)) await showImage(f);
    else if (f.type === 'pdf') await showPdf(f);
    else if (f.type === 'tga') await showTga(f);
    else if (f.type === 'cube') await showCube(f);
    else showUnsupported(f);
  } catch (err) {
    showUnsupported(f, String(err && err.message || err));
  }
}

function place(el, w, h) {
  S.el = el; S.natural = [w, h];
  const wrap = $('viewwrap');
  S.fit = Math.min((wrap.clientWidth - 24) / w, (wrap.clientHeight - 24) / h, 1);
  S.zoom = 1; S.ox = 0; S.oy = 0;
  $('view').innerHTML = ''; $('view').appendChild(el);
  applyTransform();
  $('finfo').textContent = `${f_info()} │ ${w} × ${h}`;
}
function f_info() {
  const f = curFile(), list = cur();
  return `${f.folder} │ image ${S.ii + 1}/${list.length} │ ${f.type.toUpperCase()}` +
         ` │ ${(f.file.size / 1024).toFixed(0)} KB`;
}
function applyTransform() {
  if (!S.el) return;
  const s = S.fit * S.zoom;
  const wrap = $('viewwrap');
  const w = S.natural[0] * s, h = S.natural[1] * s;
  const x = (wrap.clientWidth - w) / 2 + S.ox, y = (wrap.clientHeight - h) / 2 + S.oy;
  S.el.style.transform = `translate(${x}px,${y}px) scale(${s})`;
  S.el.style.width = S.natural[0] + 'px';
  S.el.style.height = S.natural[1] + 'px';
  $('zlbl').textContent = Math.abs(S.zoom - 1) < .001 ? 'Fit' : Math.round(s * 100) + '%';
}

function showImage(f) {
  return new Promise((res, rej) => {
    S.url = URL.createObjectURL(f.file);
    const img = new Image();
    img.onload = () => { place(img, img.naturalWidth, img.naturalHeight); res(); };
    img.onerror = () => rej(new Error('the browser could not decode this image'));
    img.src = S.url;
  });
}

async function showPdf(f) {
  if (!window.pdfjsLib) throw new Error('pdf.js did not load');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const buf = await f.file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({data: buf}).promise;
  const page = await doc.getPage(1);
  // 2x for a sharp preview without paying for full print resolution
  const vp = page.getViewport({scale: 2});
  const cv = document.createElement('canvas');
  cv.width = vp.width; cv.height = vp.height;
  await page.render({canvasContext: cv.getContext('2d'), viewport: vp}).promise;
  place(cv, vp.width, vp.height);
  $('finfo').textContent = `${f_info()} │ ${doc.numPages} page(s)`;
}

/* Minimal TGA decoder — browsers have no native support, and the format is
 * simple enough that pulling in a dependency is not worth it. Handles
 * uncompressed and RLE truecolour plus greyscale, which covers what render
 * tools emit. */
async function showTga(f) {
  const buf = new Uint8Array(await f.file.arrayBuffer());
  const idLen = buf[0], cmType = buf[1], imgType = buf[2];
  const w = buf[12] | (buf[13] << 8), h = buf[14] | (buf[15] << 8);
  const bpp = buf[16], desc = buf[17];
  if (cmType !== 0 || ![2, 3, 10, 11].includes(imgType))
    throw new Error(`unsupported TGA variant (type ${imgType})`);
  const bytes = bpp >> 3;
  let p = 18 + idLen;
  const out = new Uint8ClampedArray(w * h * 4);
  const px = [];
  const readPixel = () => {
    let r, g, b, a = 255;
    if (bytes === 1) { r = g = b = buf[p++]; }
    else { b = buf[p++]; g = buf[p++]; r = buf[p++]; if (bytes === 4) a = buf[p++]; }
    return [r, g, b, a];
  };
  if (imgType === 10 || imgType === 11) {           // RLE
    while (px.length < w * h) {
      const header = buf[p++], count = (header & 0x7f) + 1;
      if (header & 0x80) { const v = readPixel(); for (let i = 0; i < count; i++) px.push(v); }
      else for (let i = 0; i < count; i++) px.push(readPixel());
    }
  } else {
    for (let i = 0; i < w * h; i++) px.push(readPixel());
  }
  // Bit 5 of the descriptor sets the origin; bottom-left needs flipping.
  const topDown = (desc & 0x20) !== 0;
  for (let y = 0; y < h; y++) {
    const src = topDown ? y : (h - 1 - y);
    for (let x = 0; x < w; x++) {
      const v = px[src * w + x], o = (y * w + x) * 4;
      out[o] = v[0]; out[o + 1] = v[1]; out[o + 2] = v[2]; out[o + 3] = v[3];
    }
  }
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
  place(cv, w, h);
}

/* ── Cube files ──────────────────────────────────────────────────────────── */
/* Rendered with three.js: isosurfaces from cube.js plus a ball-and-stick
 * molecule. The renderer is created once and reused, because WebGL contexts
 * are a limited resource — browsers drop the oldest after roughly a dozen. */
const C3 = {renderer: null, scene: null, camera: null, root: null,
            grid: null, iso: 0, raf: null, drag: null};

async function showCube(f) {
  const three = await loadThree();
  if (!three) { showUnsupported(f, 'three.js did not load'); return; }

  $('view').innerHTML = '<div id="placeholder">Reading cube…</div>';
  await new Promise(r => setTimeout(r, 0));       // let the message paint
  const text = await f.file.text();
  const full = CubeLib.parseCube(text);
  // Striding keeps the slider interactive on production-sized grids
  const grid = CubeLib.downsample(full, 96);
  C3.grid = grid;
  C3.reduced = grid.reducedBy || 1;
  C3.iso = CubeLib.chooseIsovalue(grid.values);
  buildCubeScene(three, grid);
  $('finfo').textContent =
    `${f_info()} │ grid ${full.dims.join('×')}` +
    (C3.reduced > 1 ? ` (shown at 1/${C3.reduced})` : '') +
    ` │ ${grid.atoms.length} atoms │ iso ±${C3.iso.toFixed(4)}`;
  showIsoControls(true);
}

let THREE_PROMISE = null;
function loadThree() {
  if (!THREE_PROMISE) {
    THREE_PROMISE = import('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js')
      .catch(() => null);
  }
  return THREE_PROMISE;
}

function buildCubeScene(THREE, grid) {
  const wrap = $('viewwrap');
  const w = wrap.clientWidth, h = wrap.clientHeight;

  if (!C3.renderer) {
    C3.renderer = new THREE.WebGLRenderer({antialias: true, alpha: false});
    C3.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  }
  C3.renderer.setSize(w, h, false);
  const canvas = C3.renderer.domElement;
  canvas.style.transform = '';
  $('view').innerHTML = '';
  $('view').appendChild(canvas);
  S.el = null;                       // the 2D pan/zoom path does not apply

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0712);
  C3.scene = scene;

  const root = new THREE.Group();
  scene.add(root);
  C3.root = root;

  // Key / fill / rim, the same rig as the desktop version. A single headlight
  // flattens a rounded lobe into a featureless disc.
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.0); key.position.set(1, 1, 1);
  const fill = new THREE.DirectionalLight(0xffffff, 0.45); fill.position.set(-1, 0.4, 0.6);
  const rim = new THREE.DirectionalLight(0xffffff, 0.3); rim.position.set(0, -1, -0.8);
  scene.add(key, fill, rim);

  addIsoSurfaces(THREE, root, grid, C3.iso);
  addMolecule(THREE, root, grid);

  // Frame the whole grid
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3()).length() || 10;
  const centre = box.getCenter(new THREE.Vector3());
  root.position.sub(centre);                  // orbit about the molecule

  const cam = new THREE.PerspectiveCamera(45, w / h, size / 100, size * 10);
  cam.position.set(0, 0, size * 1.1);
  C3.camera = cam;
  C3.dist = size * 1.1;
  renderCube();
}

function addIsoSurfaces(THREE, root, grid, iso) {
  for (const [level, color] of [[iso, 0xf2d140], [-iso, 0x40bad6]]) {
    const surf = CubeLib.isosurface(grid, level);
    if (!surf.positions.length) continue;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(surf.positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(surf.normals, 3));
    const mat = new THREE.MeshPhongMaterial({
      color, transparent: true, opacity: 0.62, shininess: 40,
      side: THREE.DoubleSide, depthWrite: false   // sane blending of two lobes
    });
    root.add(new THREE.Mesh(geom, mat));
  }
}

function addMolecule(THREE, root, grid) {
  const sphere = new THREE.SphereGeometry(1, 20, 14);
  for (const a of grid.atoms) {
    const m = new THREE.Mesh(sphere, new THREE.MeshPhongMaterial({
      color: CubeLib.colorOf(a.z), shininess: 60}));
    const r = CubeLib.radiusOf(a.z) * 0.32;
    m.scale.setScalar(r);
    m.position.set(a.x, a.y, a.zc);
    root.add(m);
  }
  const bondMat = new THREE.MeshPhongMaterial({color: 0xcccccc, shininess: 40});
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 12);
  for (const [i, j] of CubeLib.inferBonds(grid.atoms)) {
    const a = grid.atoms[i], b = grid.atoms[j];
    const va = new THREE.Vector3(a.x, a.y, a.zc);
    const vb = new THREE.Vector3(b.x, b.y, b.zc);
    const mid = va.clone().add(vb).multiplyScalar(0.5);
    const dir = vb.clone().sub(va);
    const m = new THREE.Mesh(cyl, bondMat);
    m.position.copy(mid);
    m.scale.set(0.09, dir.length(), 0.09);
    // The cylinder runs along +Y by default; aim it down the bond
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    root.add(m);
  }
}

function renderCube() {
  if (C3.renderer && C3.scene && C3.camera) C3.renderer.render(C3.scene, C3.camera);
}

function rebuildIso(newIso) {
  if (!C3.grid) return;
  loadThree().then(THREE => {
    if (!THREE) return;
    C3.iso = newIso;
    // Drop the old surfaces but keep the molecule
    for (const child of [...C3.root.children]) {
      if (child.isMesh && child.material.transparent) {
        child.geometry.dispose(); child.material.dispose();
        C3.root.remove(child);
      }
    }
    addIsoSurfaces(THREE, C3.root, C3.grid, newIso);
    $('isoLbl').textContent = '±' + (newIso >= 0.001
      ? newIso.toFixed(4) : newIso.toExponential(2));
    renderCube();
  });
}

function showIsoControls(on) {
  $('isobar').style.display = on ? 'flex' : 'none';
  if (on && C3.grid) {
    const peak = Math.max(Math.abs(C3.grid.range[0]), Math.abs(C3.grid.range[1]));
    const sl = $('isoSlide');
    sl.min = 0; sl.max = 1000;
    sl.value = Math.round(C3.iso / (peak * 0.9) * 1000);
    $('isoLbl').textContent = '±' + C3.iso.toFixed(4);
  }
}

function showUnsupported(f, why) {
  const reason = why || (f.type === 'cube'
    ? 'Cube files need the desktop app for 3D rendering.'
    : 'No in-browser renderer for this format.');
  $('view').innerHTML =
    `<div id="placeholder"><b>${f.type.toUpperCase()}</b>${f.name}<br><br>
     <span style="color:var(--del-hi)">${reason}</span><br><br>
     You can still mark it Keep or Delete.</div>`;
  S.el = null;
  $('finfo').textContent = f_info();
}

/* ── Navigation and marking ──────────────────────────────────────────────── */
function nextImage() {
  const list = cur();
  if (S.ii < list.length - 1) S.ii++;
  else { S.fi = (S.fi + 1) % Math.max(1, S.folders.length); S.ii = 0; }
  show();
}
function prevImage() {
  if (S.ii > 0) S.ii--;
  else {
    S.fi = (S.fi - 1 + S.folders.length) % Math.max(1, S.folders.length);
    S.ii = Math.max(0, cur().length - 1);
  }
  show();
}
function stepFolder(d) {
  if (!S.folders.length) return;
  S.fi = (S.fi + d + S.folders.length) % S.folders.length; S.ii = 0; show();
}
function mark(keep) {
  const f = curFile(); if (!f) return;
  S.state.set(f.path, keep); show(); nextImage();
}
function toggleFlag() {
  const f = curFile(); if (!f) return;
  S.notes.has(f.path) ? S.notes.delete(f.path) : S.notes.set(f.path, '');
  show();
}
function bulk(fn) {
  for (const f of cur()) S.state.set(f.path, fn(S.state.get(f.path)));
  show();
}

/* ── Export ──────────────────────────────────────────────────────────────── */
function notesReport() {
  const lines = ['VisManager Web — flagged files report', '='.repeat(60),
    `Generated : ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    `Root      : ${S.rootName}`, `Flagged   : ${S.notes.size} file(s)`, ''];
  const byFolder = new Map();
  for (const path of S.notes.keys()) {
    const folder = path.split('/').slice(0, -1).join('/') || '(root)';
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(path);
  }
  for (const [folder, paths] of byFolder) {
    lines.push(`[${folder}]`, '-'.repeat(60));
    for (const p of paths.sort()) {
      const st = S.state.has(p) ? (S.state.get(p) ? 'KEEP' : 'DELETE') : 'not in view';
      lines.push(`  ${p.split('/').pop()}  (${st})`);
      const note = S.notes.get(p);
      lines.push(...(note ? note.split('\n').map(l => '      ' + l)
                          : ['      (flagged, no note)']), '');
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function deleteList() {
  const doomed = S.files.filter(f => S.state.get(f.path) === false);
  return ['# Files marked for deletion in VisManager Web.',
    '# Review before running. From the parent of the folder you loaded:',
    '#',
    '#   macOS / Linux:   xargs -d "\\n" rm -v < delete-list.txt',
    '#   Windows (PS):    Get-Content delete-list.txt | Where-Object {$_ -notmatch "^#"} | Remove-Item',
    '#', ''].concat(doomed.map(f => f.path)).join('\n') + '\n';
}

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function runExport() {
  const kept = S.files.filter(f => S.state.get(f.path));
  const prog = $('xProg'), status = $('xStatus');
  prog.style.display = 'block'; prog.value = 0;
  const steps = [$('xZip').checked, $('xPdf').checked,
                 $('xNotes').checked, $('xList').checked].filter(Boolean).length;
  let done = 0;
  const tick = msg => { status.textContent = msg; prog.value = (done / steps) * 100; };

  if ($('xNotes').checked) {
    tick('notes report…');
    download('vismanager-notes.txt', new Blob([notesReport()], {type: 'text/plain'}));
    done++;
  }
  if ($('xList').checked) {
    tick('delete list…');
    download('delete-list.txt', new Blob([deleteList()], {type: 'text/plain'}));
    done++;
  }
  if ($('xZip').checked) {
    tick(`zipping ${kept.length} files…`);
    const zip = new JSZip();
    for (const f of kept) zip.file(f.path, f.file);
    const blob = await zip.generateAsync({type: 'blob', compression: 'STORE'},
      m => { status.textContent = `zipping… ${m.percent.toFixed(0)}%`; });
    download('kept-files.zip', blob);
    done++;
  }
  if ($('xPdf').checked) {
    const images = kept.filter(f => NATIVE.has(f.type) || f.type === 'tga');
    if (!images.length) { status.textContent = 'no raster images to put in a PDF'; }
    else {
      const {PDFDocument} = PDFLib;
      const pdf = await PDFDocument.create();
      for (let i = 0; i < images.length; i++) {
        const f = images[i];
        status.textContent = `PDF ${i + 1}/${images.length} — ${f.name}`;
        prog.value = ((done + i / images.length) / steps) * 100;
        // Everything is normalised through a canvas so one code path covers
        // TGA and the formats pdf-lib cannot embed directly.
        const png = await toPngBytes(f);
        if (!png) continue;
        const img = await pdf.embedPng(png);
        const page = pdf.addPage([img.width, img.height]);
        page.drawImage(img, {x: 0, y: 0, width: img.width, height: img.height});
      }
      download('kept-images.pdf', new Blob([await pdf.save()], {type: 'application/pdf'}));
      done++;
    }
  }
  prog.value = 100;
  status.textContent = 'Done.';
}

async function toPngBytes(f) {
  let cv;
  if (f.type === 'tga') {
    await showTgaOffscreen(f).then(c => cv = c).catch(() => cv = null);
  } else {
    const bitmap = await createImageBitmap(f.file).catch(() => null);
    if (!bitmap) return null;
    cv = document.createElement('canvas');
    cv.width = bitmap.width; cv.height = bitmap.height;
    cv.getContext('2d').drawImage(bitmap, 0, 0);
  }
  if (!cv) return null;
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
async function showTgaOffscreen(f) {
  const keep = $('view').innerHTML;
  await showTga(f);
  const cv = $('view').querySelector('canvas');
  const clone = document.createElement('canvas');
  clone.width = cv.width; clone.height = cv.height;
  clone.getContext('2d').drawImage(cv, 0, 0);
  $('view').innerHTML = keep;
  return clone;
}

/* ── Wiring ──────────────────────────────────────────────────────────────── */
$('bOpen').onclick = () => $('picker').click();
$('picker').onchange = e => ingest(e.target.files);
$('bKeep').onclick = () => mark(true);
$('bDel').onclick = () => mark(false);
$('bPI').onclick = prevImage;
$('bNI').onclick = nextImage;
$('bPF').onclick = () => stepFolder(-1);
$('bNF').onclick = () => stepFolder(1);
$('bFlag').onclick = toggleFlag;
$('bKeepAll').onclick = () => bulk(() => true);
$('bDelAll').onclick = () => bulk(() => false);
$('bInvert').onclick = () => bulk(v => !v);
$('bHelp').onclick = () => $('dHelp').showModal();
$('helpClose').onclick = () => $('dHelp').close();

$('bNote').onclick = () => {
  const f = curFile(); if (!f) return;
  $('noteFor').textContent = f.path;
  $('noteText').value = S.notes.get(f.path) || '';
  $('dNote').showModal();
  $('noteText').focus();
};
$('noteSave').onclick = () => {
  const f = curFile(), text = $('noteText').value.trim();
  text ? S.notes.set(f.path, text) : S.notes.delete(f.path);
  $('dNote').close(); show();
};
$('noteDel').onclick = () => { S.notes.delete(curFile().path); $('dNote').close(); show(); };
$('noteCancel').onclick = () => $('dNote').close();

$('bExport').onclick = () => {
  const kept = S.files.filter(f => S.state.get(f.path)).length;
  const del = S.files.length - kept;
  $('xSummary').textContent =
    `${kept} kept, ${del} marked for deletion, ${S.notes.size} flagged.`;
  $('xStatus').textContent = ''; $('xProg').style.display = 'none';
  $('dExport').showModal();
};
$('xCancel').onclick = () => $('dExport').close();
$('xGo').onclick = () => runExport();

/* Isosurface controls */
$('isoUp').onclick = () => rebuildIso(C3.iso * 1.35);
$('isoDown').onclick = () => rebuildIso(C3.iso / 1.35);
let isoTimer = null;
$('isoSlide').oninput = e => {
  if (!C3.grid) return;
  const peak = Math.max(Math.abs(C3.grid.range[0]), Math.abs(C3.grid.range[1]));
  const target = Math.max(peak * 1e-4, (+e.target.value / 1000) * peak * 0.9);
  $('isoLbl').textContent = '±' + target.toFixed(4);
  // Re-extraction costs hundreds of milliseconds, so wait for the drag to
  // settle rather than rebuilding on every step.
  clearTimeout(isoTimer);
  isoTimer = setTimeout(() => rebuildIso(target), 180);
};
$('isoReset').onclick = () => {
  if (!C3.root) return;
  C3.root.rotation.set(0, 0, 0);
  renderCube();
};

/* Zoom and pan */
$('zIn').onclick = () => { S.zoom *= 1.25; applyTransform(); };
$('zOut').onclick = () => { S.zoom /= 1.25; applyTransform(); };
$('zFit').onclick = () => { S.zoom = 1; S.ox = S.oy = 0; applyTransform(); };
$('z1').onclick = () => { S.zoom = 1 / S.fit; S.ox = S.oy = 0; applyTransform(); };
$('viewwrap').addEventListener('wheel', e => {
  if (C3.grid && !S.el) {
    e.preventDefault();
    C3.dist *= e.deltaY < 0 ? 1 / 1.12 : 1.12;
    C3.camera.position.setZ(C3.dist);
    renderCube();
    return;
  }
  if (!S.el) return;
  e.preventDefault();
  S.zoom *= e.deltaY < 0 ? 1.12 : 1 / 1.12;
  applyTransform();
}, {passive: false});
let panning = null;
$('view').addEventListener('pointerdown', e => {
  if (C3.grid && !S.el) {          // orbit the 3D scene instead of panning
    C3.drag = {x: e.clientX, y: e.clientY};
    $('view').setPointerCapture(e.pointerId);
    return;
  }
  if (!S.el) return;
  panning = {x: e.clientX, y: e.clientY, ox: S.ox, oy: S.oy};
  $('view').classList.add('drag'); $('view').setPointerCapture(e.pointerId);
});
$('view').addEventListener('pointermove', e => {
  if (C3.drag && C3.root) {
    const dx = e.clientX - C3.drag.x, dy = e.clientY - C3.drag.y;
    C3.drag = {x: e.clientX, y: e.clientY};
    C3.root.rotation.y += dx * 0.01;
    C3.root.rotation.x += dy * 0.01;
    renderCube();
    return;
  }
  if (!panning) return;
  S.ox = panning.ox + (e.clientX - panning.x);
  S.oy = panning.oy + (e.clientY - panning.y);
  applyTransform();
});
$('view').addEventListener('pointerup', () => {
  panning = null; C3.drag = null; $('view').classList.remove('drag');
});
window.addEventListener('resize', () => { if (S.el) { const [w, h] = S.natural; const wrap = $('viewwrap');
  S.fit = Math.min((wrap.clientWidth - 24) / w, (wrap.clientHeight - 24) / h, 1); applyTransform(); } });

/* Keyboard — ignored while a dialog or text field has focus */
document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]')) return;
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase();
  const map = {
    k: () => mark(true), d: () => mark(false),
    ' ': () => { const f = curFile(); if (f) { S.state.set(f.path, !S.state.get(f.path)); show(); } },
    arrowright: nextImage, arrowleft: prevImage,
    '.': () => stepFolder(1), ',': () => stepFolder(-1),
    n: () => $('bNote').click(), f: toggleFlag,
    '=': () => $('zIn').click(), '+': () => $('zIn').click(),
    '-': () => $('zOut').click(), '0': () => $('zFit').click(),
  };
  const fn = map[k === ' ' ? ' ' : k];
  if (fn) { e.preventDefault(); fn(); }
});

/* Folder drag-and-drop. Directories arrive as entries, not files, so the tree
 * has to be walked explicitly. */
const dropEl = $('drop');
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); if (++dragDepth === 1) dropEl.classList.add('on'); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; dropEl.classList.remove('on'); } });
window.addEventListener('drop', async e => {
  e.preventDefault(); dragDepth = 0; dropEl.classList.remove('on');
  const items = [...(e.dataTransfer.items || [])];
  const entries = items.map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) { ingest(e.dataTransfer.files); return; }
  const out = [];
  await Promise.all(entries.map(en => walk(en, '', out)));
  ingest(out);
});
function walk(entry, prefix, out) {
  return new Promise(resolve => {
    if (entry.isFile) {
      entry.file(f => {
        // Preserve the relative path the same way webkitdirectory does
        Object.defineProperty(f, 'webkitRelativePath',
          {value: prefix + entry.name, configurable: true});
        out.push(f); resolve();
      }, resolve);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readMore = () => reader.readEntries(async batch => {
        if (!batch.length) return resolve();
        await Promise.all(batch.map(c => walk(c, prefix + entry.name + '/', out)));
        readMore();                       // readEntries returns at most 100
      }, resolve);
      readMore();
    } else resolve();
  });
}
