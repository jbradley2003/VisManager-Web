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

/* Storage that cannot throw.
 *
 * localStorage is unavailable in several ordinary situations — Safari private
 * browsing, blocked cookies, a file:// page — and it throws on ACCESS, not
 * just on write. An unguarded read at the top of this file takes the whole
 * app down with it, which is indistinguishable from a broken build. */
const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v; }
    catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch (e) { return false; }
  },
  json(key, fallback) {
    try { return JSON.parse(this.get(key) || 'null') ?? fallback; }
    catch (e) { return fallback; }
  },
};

/* Bumped on every change. Shown next to the title and logged on load, so a
 * stale deploy or a cached page is obvious rather than being mistaken for the
 * bug it was supposed to fix. */
const BUILD = '1.42.0';

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
  openFolders: new Set(),   // folders expanded to show their files
  treeRows: [],             // flat list of what is on screen, for arrow keys
  treeCursor: -1,
  fi: 0, ii: 0,       // folder index, image index
  showToken: 0,       // bumped per display; stale async work checks it
  cubeLocks: new Map(),  // path -> pinned isovalue, camera and appearance
  loadMode: localStorage.getItem('vm.loadMode') || 'lazy',
  navMode: store.get('vm.navMode') || 'continuous',
  // Advancing after a mark suits a first pass; staying put suits comparing
  // a file with its neighbours.
  autoAdvance: store.get('vm.autoAdvance', 'on') !== 'off',
  zoom: 1, fit: 1, ox: 0, oy: 0, rot: 0, mirror: false,
  url: null, el: null, natural: [0, 0],
  rootName: ''
};

const $ = id => document.getElementById(id);
const extOf = n => (n.lastIndexOf('.') > 0 ? n.slice(n.lastIndexOf('.') + 1) : '').toLowerCase();

/* ── Loading ─────────────────────────────────────────────────────────────── */
/**
 * Merge a new selection into the session, or start fresh.
 *
 * Previously every load replaced everything, so adding a second directory
 * silently discarded the marks and notes made on the first.
 */
function ingest(fileList, mode) {
  if (S.files.length && !mode) {
    pendingFiles = fileList;
    $('addSummary').textContent =
      `${S.files.length} file(s) are already open, with ` +
      `${[...S.state.values()].filter(v => !v).length} marked for deletion and ` +
      `${S.notes.size} flagged.`;
    $('dAdd').showModal();
    return;
  }
  ingestNow(fileList, mode === 'add');
}

let pendingFiles = null;

function ingestNow(fileList, append) {
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

  if (append) {
    // Keep existing marks and notes; only add paths we have not seen.
    const known = new Set(S.files.map(f => f.path));
    const added = files.filter(f => !known.has(f.path));
    S.files = S.files.concat(added).sort(
      (a, b) => a.path.localeCompare(b.path, undefined, {numeric: true}));
    for (const f of added) if (!S.state.has(f.path)) S.state.set(f.path, true);
    S.rootName += ' + ' + ((files[0].path.split('/')[0]) || 'folder');
  } else {
    S.files = files;
    S.rootName = (files[0].path.split('/')[0]) || 'folder';
    S.state = new Map(files.map(f => [f.path, true]));
    S.notes = new Map();
    S.fi = S.ii = 0;
  }
  rebuild();
  $('dirname').textContent = `${S.rootName} — ${S.files.length} files`;
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
  S.treeRows = [];
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
      g.onclick = () => toggleGroup(top);
      tree.appendChild(g);
      S.treeRows.push({el: g, kind: 'group', top});
      if (!open) continue;
    }
    for (const folder of folders) {
      const list = S.byFolder.get(folder);
      const keep = list.filter(f => S.state.get(f.path)).length;
      const flags = list.filter(f => S.notes.has(f.path)).length;
      const open = S.openFolders.has(folder);
      const d = document.createElement('div');
      d.className = 'fld' + (S.folders[S.fi] === folder ? ' on' : '');
      d.innerHTML =
        `<span class="tw">${open ? '\u25be' : '\u25b8'}</span>` +
        `${folder.split('/').pop() || folder}  (${keep}/${list.length} \u2713)` +
        (flags ? `  \u2690${flags}` : '');
      d.title = folder;
      d.onclick = e => {
        // The twisty expands; the rest of the row selects the folder.
        if (e.target.classList.contains('tw')) {
          open ? S.openFolders.delete(folder) : S.openFolders.add(folder);
          drawTree();
          return;
        }
        S.fi = S.folders.indexOf(folder); S.ii = 0; show();
      };
      d.oncontextmenu = e => { e.preventDefault(); removeFolder(folder); };
      tree.appendChild(d);
      S.treeRows.push({el: d, kind: 'folder', folder});

      if (open) {
        list.forEach((f, idx) => {
          const row = document.createElement('div');
          const isCur = S.folders[S.fi] === folder && S.ii === idx;
          row.className = 'fileRow' + (isCur ? ' on' : '');
          const keptFile = S.state.get(f.path);
          row.innerHTML =
            `<span class="mk ${keptFile ? 'k' : 'x'}">${keptFile ? '\u2713' : '\u2717'}</span>` +
            `${f.name}` + (S.notes.has(f.path) ? ' <span class="fl">\u2690</span>' : '');
          row.title = f.path;
          row.onclick = () => {
            S.fi = S.folders.indexOf(folder); S.ii = idx; show();
          };
          row.oncontextmenu = e => {
            e.preventDefault();
            if (confirm(`Remove "${f.name}" from the review?`)) removeFile(f.path);
          };
          tree.appendChild(row);
          S.treeRows.push({el: row, kind: 'file', folder, idx, path: f.path});
        });
      }
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
/**
 * True while `token` is still the display the user is looking at.
 *
 * Reading and decoding happen asynchronously, and a slow file can finish long
 * after the user has moved on — a 370 MB cube in particular. Without this
 * check the late result overwrites whatever is on screen, so the viewer jumps
 * back to the cube even though another file is selected.
 */
function stillCurrent(token) {
  return token === S.showToken;
}

async function show() {
  const token = ++S.showToken;
  if (S.loadMode === 'folder' && S.folders[S.fi] !== lastPrefetched) {
    lastPrefetched = S.folders[S.fi];
    prefetchFolder();
  }
  drawTree(); drawStats();
  const f = curFile();
  const view = $('view');
  // Do NOT clear the view here. Emptying it before the next file has decoded
  // leaves the background exposed for a frame or two, which reads as a flash
  // on every navigation. place() swaps the new element in atomically, and the
  // old object URL is released after the swap.
  const staleUrl = S.url;
  S.url = null;

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
  // The isosurface strip shares the viewer's tint so the two read as one
  // area, rather than the strip looking like part of the control panel.
  const tint = keep ? 'var(--keep-bg)' : 'var(--del-bg)';
  $('viewwrap').style.background = tint;
  $('isodock').style.background = tint;
  $('state').innerHTML = keep
    ? '<span style="color:var(--keep-hi)">◉ KEEP</span>'
    : '<span style="color:var(--del-hi)">◉ DELETE</span>';
  const note = S.notes.get(f.path);
  $('note').textContent = note ? `⚐ ${note}` : (S.notes.has(f.path) ? '⚐ flagged' : '');
  $('bFlag').className = S.notes.has(f.path) ? 'flag' : '';
  if (typeof setBtnIcon === 'function') if (window.setBtnIcon) window.setBtnIcon('bFlag', 'flag');

  // C3.grid doubles as the "a cube is on screen" flag: every rotate, flip and
  // zoom handler branches on it. It used to persist after navigating away, so
  // once any cube had been opened those controls drove an invisible camera
  // instead of the image. Clear it here; showCube sets it again.
  // Decoding a PDF page or extracting a cube surface takes a few hundred
  // milliseconds. Showing nothing for that long reads as a stall, so put a
  // marker up immediately; swapIn() replaces it when the content is ready.
  showBusy(f);
  C3.grid = null;
  showIsoControls(false);
  $('cubePanel').classList.remove('on');
  { const fr = $('imgframe'); if (fr) fr.style.display = 'none'; }
  layoutOverlays();
  try {
    S.pendingRevoke = staleUrl;
    if (NATIVE.has(f.type)) await showImage(f, token);
    else if (f.type === 'pdf') await showPdf(f, token);
    else if (f.type === 'tga') await showTga(f, token);
    else if (f.type === 'cube') await showCube(f, token);
    else showUnsupported(f);
  } catch (err) {
    showUnsupported(f, String(err && err.message || err));
  }
  if (S.pendingRevoke) {            // nothing swapped in; release anyway
    URL.revokeObjectURL(S.pendingRevoke);
    S.pendingRevoke = null;
  }
}

function place(el, w, h) {
  S.el = el; S.natural = [w, h];
  // Position before the element is visible, so it never appears unplaced
  el.style.position = 'absolute';
  el.style.left = '0px';
  el.style.top = '0px';
  const wrap = $('viewwrap');
  S.zoom = 1; S.ox = 0; S.oy = 0; S.rot = 0; S.mirror = false;
  S.fit = computeFit();
  applyTransform();                 // place it while still detached
  swapIn(el);
  $('finfo').textContent = `${f_info()} │ ${w} × ${h}`;
}
let lastPrefetched = null;
let busyTimer = null;
function showBusy(f) {
  clearTimeout(busyTimer);
  // Only announce slow formats, and only if they are actually slow — a small
  // PNG decodes faster than the message would be readable.
  if (!f || !['pdf', 'cube'].includes(f.type)) return;
  busyTimer = setTimeout(() => {
    const el = document.createElement('div');
    el.id = 'placeholder';
    el.innerHTML = `<b>${f.type.toUpperCase()}</b>${f.name}<br><br>` +
      `<span class="hint">${f.type === 'cube'
        ? 'Reading grid and extracting the isosurface…'
        : 'Rendering page…'}</span>`;
    $('view').replaceChildren(el);
  }, 90);
}

/** Replace the view contents in one step, so nothing blanks in between. */
function swapIn(el) {
  clearTimeout(busyTimer);
  const view = $('view');
  view.replaceChildren(el);
  if (S.pendingRevoke) {
    URL.revokeObjectURL(S.pendingRevoke);
    S.pendingRevoke = null;
  }
}

function f_info() {
  const f = curFile(), list = cur();
  return `${f.folder} │ image ${S.ii + 1}/${list.length} │ ${f.type.toUpperCase()}` +
         ` │ ${(f.file.size / 1024).toFixed(0)} KB`;
}
function computeFit() {
  const wrap = $('stagebox');
  const swap = S.rot % 2 === 1;              // a quarter turn swaps the footprint
  const W = swap ? S.natural[1] : S.natural[0];
  const H = swap ? S.natural[0] : S.natural[1];
  return Math.min((wrap.clientWidth - 24) / W, (wrap.clientHeight - 24) / H, 1);
}

/**
 * Keep the image inside the stage.
 *
 * When it is smaller than the stage it stays centred and cannot be dragged at
 * all; when it is larger, the pan is limited so an edge can never come inside
 * the frame. Without this the picture could be flung off into the surround,
 * which is what made navigation feel loose.
 */
function clampPan(dispW, dispH, stageW, stageH) {
  const limitX = Math.max(0, (dispW - stageW) / 2);
  const limitY = Math.max(0, (dispH - stageH) / 2);
  S.ox = Math.max(-limitX, Math.min(limitX, S.ox));
  S.oy = Math.max(-limitY, Math.min(limitY, S.oy));
}

function applyTransform() {
  if (!S.el) return;
  const s = S.fit * S.zoom;
  const wrap = $('stagebox');
  const W = S.natural[0], H = S.natural[1];

  // Transform about the element's own centre and place that centre where it
  // belongs. The previous version mixed transform-origin 0 0 with centre-based
  // translations and then divided the scale back out, which left the content
  // offset by roughly half a canvas.
  const swap = S.rot % 2 === 1;
  const dispW = (swap ? H : W) * s, dispH = (swap ? W : H) * s;
  clampPan(dispW, dispH, wrap.clientWidth, wrap.clientHeight);

  const cx = wrap.clientWidth / 2 + S.ox;
  const cy = wrap.clientHeight / 2 + S.oy;

  S.el.style.width = W + 'px';
  S.el.style.height = H + 'px';
  S.el.style.transformOrigin = '50% 50%';
  S.el.style.transform =
    `translate(${cx - W / 2}px, ${cy - H / 2}px) ` +
    `rotate(${S.rot * 90}deg) ` +
    `scale(${S.mirror ? -s : s}, ${s})`;

  // Track the image bounds with the outline element
  const fr = $('imgframe');
  if (fr) {
    fr.style.display = 'block';
    fr.style.left = (cx - dispW / 2) + 'px';
    fr.style.top = (cy - dispH / 2) + 'px';
    fr.style.width = dispW + 'px';
    fr.style.height = dispH + 'px';
  }

  $('zlbl').textContent = Math.abs(S.zoom - 1) < .001 ? 'Fit' : Math.round(s * 100) + '%';
  const bits = [];
  if (S.rot) bits.push(S.rot * 90 + '°');
  if (S.mirror) bits.push('⇄');
  $('rotLbl').textContent = bits.length ? bits.join(' ') : '—';
}

function showImage(f, token) {
  return new Promise((res, rej) => {
    S.url = URL.createObjectURL(f.file);
    const img = new Image();
    img.onload = () => {
      if (!stillCurrent(token)) return res();   // user has moved on
      place(img, img.naturalWidth, img.naturalHeight);
      res();
    };
    img.onerror = () => rej(new Error('the browser could not decode this image'));
    img.src = S.url;
  });
}

/**
 * Choose a render scale for a PDF page that a canvas can actually allocate.
 *
 * A fixed 2x fails on large pages: a 12900 x 12990 pt page asks for a
 * 25800 x 25980 canvas — 670 megapixels, about 2.5 GB. Browsers cap canvases
 * at roughly 16384 px per side and ~268 MP in total, and over the limit they
 * allocate nothing and throw nothing, so the page renders white.
 *
 * The target is enough resolution to fill the stage at 2x for sharpness on a
 * retina display, then clamped to what is actually allocatable.
 */
const PDF_MAX_DIM = 8192;        // comfortably inside every browser's limit
const PDF_MAX_AREA = 32e6;       // 32 MP keeps memory reasonable

function pdfPreviewScale(pageW, pageH, stageW, stageH) {
  if (!(pageW > 0 && pageH > 0)) return 1;
  const wanted = Math.min(
    2,                                          // never upscale beyond 2x
    Math.max((stageW * 2) / pageW, (stageH * 2) / pageH)
  );
  const capped = Math.min(
    wanted,
    PDF_MAX_DIM / pageW,
    PDF_MAX_DIM / pageH,
    Math.sqrt(PDF_MAX_AREA / (pageW * pageH))
  );
  return Math.max(0.02, capped);               // always render something
}

async function showPdf(f, token) {
  if (!window.pdfjsLib) throw new Error('pdf.js did not load');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const buf = await f.file.arrayBuffer();
  if (!stillCurrent(token)) return;
  const doc = await pdfjsLib.getDocument({data: buf}).promise;
  const page = await doc.getPage(1);
  if (!stillCurrent(token)) return;
  const base = page.getViewport({scale: 1});
  const stage = $('stagebox');
  const scale = pdfPreviewScale(base.width, base.height,
                                Math.max(320, stage.clientWidth),
                                Math.max(320, stage.clientHeight));
  const vp = page.getViewport({scale});
  const cv = document.createElement('canvas');
  cv.width = vp.width; cv.height = vp.height;
  await page.render({canvasContext: cv.getContext('2d'), viewport: vp}).promise;
  if (!stillCurrent(token)) return;
  place(cv, vp.width, vp.height);
  $('finfo').textContent = `${f_info()} │ ${doc.numPages} page(s) │ ` +
    `${Math.round(base.width)} × ${Math.round(base.height)} pt` +
    (scale < 1 ? ` │ shown at ${(scale * 100).toFixed(0)}%` : '');
}

/* Minimal TGA decoder — browsers have no native support, and the format is
 * simple enough that pulling in a dependency is not worth it. Handles
 * uncompressed and RLE truecolour plus greyscale, which covers what render
 * tools emit. */
async function showTga(f, token) {
  const buf = new Uint8Array(await f.file.arrayBuffer());
  if (token !== undefined && !stillCurrent(token)) return;
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
            grid: null, iso: 0, raf: null, drag: null,
            // Look settings, kept across files so a chosen style sticks
            opacity: 0.85, pos: 0xf2e120, neg: 0x2fd0e0, bg: 0x0b0712,
            flat: false, showAtoms: true, showBonds: true,
            elementColors: {},          // {atomicNumber: 0xrrggbb}
            atomScale: 1.0, showH: true, showPos: true, showNeg: true,
            smooth: 0, bondTol: 0.45,
            locks: {},               // {path: {iso, rot, dist, pan}}
            // Graphics settings
            quality: 'high', brightness: 1.0, tone: true,
            sphereSeg: [20, 14], cylSeg: 12, pixelCap: 2, aa: true,
            homeDist: 0,
            surfaces: [], atomMeshes: [], bondMeshes: []};

const hex = n => '#' + n.toString(16).padStart(6, '0');
const unhex = s2 => parseInt(s2.slice(1), 16);

async function showCube(f, token) {
  const three = await loadThree();
  if (token !== undefined && !stillCurrent(token)) return;
  if (!three) {
    // Report the real reason. Swallowing it left only "did not load", which
    // gives no clue whether the CDN is blocked, offline, or something else.
    showUnsupported(f, '3D library could not be loaded: ' +
      (C3.threeError || 'unknown error') +
      '. Check the browser console and any content blockers.');
    return;
  }

  await new Promise(r => setTimeout(r, 0));       // let the message paint
  const grid = await loadGrid(f, token);
  if (!grid) return;                     // stale, or the read failed
  if (token !== undefined && !stillCurrent(token)) return;
  C3.grid = grid;
  C3.reduced = grid.reducedBy || 1;
  const full = {dims: grid.dims.map(d => d * (grid.reducedBy || 1))};
  const lock = S.cubeLocks.get(f.path);
  C3.iso = lock ? lock.iso : CubeLib.chooseIsovalue(grid.values);

  // Reveal the controls and settle the layout BEFORE building the scene.
  // Showing them afterwards changes the stage height, leaving the canvas sized
  // to the old dimensions — the image then stays stretched until something
  // else triggers a resize, which is why dragging the panel "fixed" it.
  showIsoControls(true);
  layoutOverlays();

  buildCubeScene(three, grid);
  $('finfo').textContent =
    `${f_info()} │ grid ${full.dims.join('×')}` +
    (C3.reduced > 1 ? ` (shown at 1/${C3.reduced})` : '') +
    ` │ ${grid.atoms.length} atoms │ iso ±${C3.iso.toFixed(4)}`;
  refreshLockBtn();
}

let THREE_PROMISE = null;
function loadThree() {
  if (!THREE_PROMISE) {
    THREE_PROMISE = import(
      'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js')
      .catch(err => {
        C3.threeError = err && err.message ? err.message : String(err);
        console.error('three.js failed to load:', err);
        return null;
      });
  }
  return THREE_PROMISE;
}

function buildCubeScene(THREE, grid) {
  C3.THREE = THREE;
  const wrap = $('stagebox');
  // A zero-sized stage yields a zero-sized renderer and a NaN aspect ratio,
  // so the scene renders nothing at all. Fall back rather than draw blank.
  const w = Math.max(64, wrap.clientWidth), h = Math.max(64, wrap.clientHeight);

  if (!C3.renderer || C3.rendererAA !== C3.aa) {
    // Antialiasing is fixed at context creation, so changing it means a new
    // renderer. Dispose the old one first — WebGL contexts are limited and
    // browsers drop the oldest after roughly a dozen.
    if (C3.renderer) {
      C3.renderer.dispose();
      C3.renderer.domElement.remove();
    }
    C3.renderer = new THREE.WebGLRenderer({antialias: C3.aa,
                                           alpha: !!C3.alpha});
    C3.rendererAA = C3.aa;
  }
  C3.renderer.setPixelRatio(Math.min(devicePixelRatio, C3.pixelCap));
  // ACES tone mapping keeps bright highlights on the lobes from clipping flat
  C3.renderer.toneMapping = C3.tone ? THREE.ACESFilmicToneMapping
                                    : THREE.NoToneMapping;
  C3.renderer.toneMappingExposure = 1.0;
  // updateStyle MUST be true. With setPixelRatio(2) on a Retina display the
  // drawing buffer is 2x the CSS size; skipping the style update leaves the
  // canvas with no CSS dimensions, so the browser falls back to the buffer
  // size and the scene renders double-size anchored at the top-left. That is
  // the "not centred on Mac" bug — it is invisible at devicePixelRatio 1.
  C3.renderer.setSize(w, h, true);
  const canvas = C3.renderer.domElement;
  canvas.style.transform = '';
  canvas.style.left = '0px';
  canvas.style.top = '0px';
  swapIn(canvas);
  S.el = null;                       // the 2D pan/zoom path does not apply

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(C3.bg);
  C3.scene = scene;

  const root = new THREE.Group();
  scene.add(root);
  C3.root = root;

  // Key / fill / rim, the same rig as the desktop version. A single headlight
  // flattens a rounded lobe into a featureless disc.
  // three.js r155 switched lights to physical units: internally the renderer
  // uses `scaleFactor = useLegacyLights ? Math.PI : 1`, and useLegacyLights
  // now defaults to false. Intensities written for the old behaviour come out
  // about 3.14x too dim, which is why atoms looked darker than they should.
  // Scaling by PI restores the intended brightness without relying on the
  // deprecated legacy flag.
  const L = Math.PI * C3.brightness;
  scene.add(new THREE.AmbientLight(0xffffff, 0.35 * L));
  const key = new THREE.DirectionalLight(0xffffff, 1.0 * L); key.position.set(1, 1, 1);
  const fill = new THREE.DirectionalLight(0xffffff, 0.45 * L); fill.position.set(-1, 0.4, 0.6);
  const rim = new THREE.DirectionalLight(0xffffff, 0.3 * L); rim.position.set(0, -1, -0.8);
  scene.add(key, fill, rim);
  C3.lights = {ambient: scene.children[0], key, fill, rim};

  addIsoSurfaces(THREE, root, grid, C3.iso);
  addMolecule(THREE, root, grid);

  frameScene(THREE, w, h);
  const f = curFile();
  // Restore a pinned view, if this file has one
  if (f && S.cubeLocks.has(f.path)) applyCubeLock(S.cubeLocks.get(f.path));
  renderCube();
}

/**
 * Fit the camera to the bounding sphere of molecule plus isosurface.
 *
 * Framing on the grid box leaves the subject small in a sea of empty space,
 * because a cube's grid is usually much larger than the orbital inside it.
 * The sphere radius and the vertical field of view give the exact distance
 * at which the content fills the view.
 */
function frameScene(THREE, w, h) {
  const root = C3.root;
  C3.panX = 0; C3.panY = 0;
  root.position.set(0, 0, 0);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  root.position.sub(sphere.center);           // orbit about the content
  C3.centerOffset = sphere.center.clone();

  const fov = 45;
  const fitH = sphere.radius / Math.sin((fov / 2) * Math.PI / 180);
  const fitW = fitH / Math.min(1, w / h);     // respect a narrow window
  const dist = Math.max(fitH, fitW) * 1.15;   // a little breathing room

  const cam = C3.camera || new THREE.PerspectiveCamera(fov, w / h, 0.01, 1e5);
  cam.fov = fov;
  cam.aspect = w / h;
  cam.near = Math.max(dist / 1000, 0.01);
  cam.far = dist * 10;
  cam.position.set(0, 0, dist);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  C3.camera = cam;
  C3.dist = dist;
  C3.homeDist = dist;
  C3.contentRadius = sphere.radius;
}

function addIsoSurfaces(THREE, root, grid, iso) {
  C3.surfaces = [];
  const levels = [[iso, C3.pos], [-iso, C3.neg]];

  for (let li = 0; li < levels.length; li++) {
    const [level, color] = levels[li];
    const surf = CubeLib.isosurface(grid, level);
    if (!surf.positions.length) { C3.surfaces.push(null); continue; }

    let built = CubeLib.weld(surf.positions, surf.normals);
    if (C3.smooth > 0) built = CubeLib.smoothMesh(built, C3.smooth);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(built.positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(built.normals, 3));
    geom.setIndex(new THREE.BufferAttribute(built.indices, 1));

    // Two passes per lobe: inside faces first, then outside.
    //
    // A single DoubleSide mesh with depthWrite off leaves the blend order to
    // three.js, which sorts transparent objects by bounding-sphere centre.
    // Two orbital lobes share almost the same centre, so that sort flips as
    // the camera moves and the colours appear to swap. Drawing back faces
    // before front faces makes each lobe self-consistent, and explicit
    // renderOrder fixes the order between lobes instead of leaving it to a
    // distance comparison that cannot separate them.
    const mkMat = side => new THREE.MeshPhongMaterial({
      color, transparent: true, opacity: C3.opacity, shininess: 55,
      specular: 0x333333, side, depthWrite: false, flatShading: C3.flat,
    });

    const back = new THREE.Mesh(geom, mkMat(THREE.BackSide));
    const front = new THREE.Mesh(geom, mkMat(THREE.FrontSide));
    back.renderOrder = 10 + li * 2;
    front.renderOrder = 11 + li * 2;
    root.add(back, front);
    C3.surfaces.push({back, front, geom});
  }
}

function addMolecule(THREE, root, grid) {
  C3.atomMeshes = []; C3.bondMeshes = [];
  const sphere = new THREE.SphereGeometry(1, C3.sphereSeg[0], C3.sphereSeg[1]);
  for (const a of grid.atoms) {
    const m = new THREE.Mesh(sphere, new THREE.MeshPhongMaterial({
      color: C3.elementColors[a.z] ?? CubeLib.colorOf(a.z), shininess: 60}));
    m.userData.z = a.z;
    m.visible = C3.showAtoms && (a.z !== 1 || C3.showH);
    C3.atomMeshes.push(m);
    // Hydrogen's covalent radius (0.31 A) is less than half carbon's, which
    // renders it as a speck next to everything else. Molecular viewers draw
    // it proportionally larger; a floor keeps it visible without distorting
    // the heavier atoms.
    const r = Math.max(CubeLib.radiusOf(a.z), a.z === 1 ? 0.52 : 0)
              * 0.42 * C3.atomScale;
    m.scale.setScalar(r);
    m.position.set(a.x, a.y, a.zc);
    root.add(m);
  }
  // Thinner and darker than the atoms, so bonds read as structure rather
  // than competing with the orbital surface.
  const bondMat = new THREE.MeshPhongMaterial({color: 0x6e6e78, shininess: 25});
  const cyl = new THREE.CylinderGeometry(1, 1, 1, C3.cylSeg);
  for (const [i, j] of CubeLib.inferBonds(grid.atoms, C3.bondTol)) {
    const a = grid.atoms[i], b = grid.atoms[j];
    const va = new THREE.Vector3(a.x, a.y, a.zc);
    const vb = new THREE.Vector3(b.x, b.y, b.zc);
    const mid = va.clone().add(vb).multiplyScalar(0.5);
    const dir = vb.clone().sub(va);
    const m = new THREE.Mesh(cyl, bondMat);
    m.visible = C3.showBonds && C3.showAtoms;
    C3.bondMeshes.push(m);
    m.position.copy(mid);
    const br = 0.075 * C3.atomScale;
    m.scale.set(br, dir.length(), br);
    // The cylinder runs along +Y by default; aim it down the bond
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    root.add(m);
  }
}

/**
 * Orbit about the screen axes.
 *
 * Adding to root.rotation.x/y accumulates Euler angles in the object's own
 * frame, so once the model has been turned, a horizontal drag no longer spins
 * it horizontally — it drifts and can gimbal-lock. Rotating about the world
 * axes keeps the drag aligned with the screen whatever the current pose.
 */
function orbitScene(dx, dy) {
  if (!C3.root || !C3.THREE) return;
  const T = C3.THREE;
  const speed = 0.008;
  C3.root.rotateOnWorldAxis(new T.Vector3(0, 1, 0), dx * speed);
  C3.root.rotateOnWorldAxis(new T.Vector3(1, 0, 0), dy * speed);
}

/**
 * Slide the model in the plane of the screen.
 *
 * Scaled by the distance so a drag moves the model the same number of pixels
 * regardless of how far the camera has been dollied.
 */
function panScene(dx, dy) {
  if (!C3.root || !C3.camera) return;
  const stage = $('stagebox');
  const fov = C3.camera.fov * Math.PI / 180;
  const viewH = 2 * Math.tan(fov / 2) * C3.dist;
  const perPixel = viewH / Math.max(1, stage.clientHeight);
  C3.panX = (C3.panX || 0) + dx * perPixel;
  C3.panY = (C3.panY || 0) - dy * perPixel;
  const c = C3.centerOffset;
  C3.root.position.x = (c ? -c.x : 0) + C3.panX;
  C3.root.position.y = (c ? -c.y : 0) + C3.panY;
}

/**
 * Draw the 3D scene on the next animation frame.
 *
 * A WebGL canvas is created with preserveDrawingBuffer false, so what it shows
 * is whatever was rendered in the frame the browser last composited. Rendering
 * straight from an event handler can miss that window, and the change does not
 * appear until something else forces another frame — which is why adjusting
 * the isovalue seemed to do nothing until the model was moved. Dragging hid
 * the bug because it renders continuously.
 *
 * Export paths call renderer.render directly, because they need the pixels
 * synchronously rather than on the next frame.
 */
let renderQueued = false;
function renderCube() {
  if (!(C3.renderer && C3.scene && C3.camera)) return;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (C3.renderer && C3.scene && C3.camera) {
      C3.renderer.render(C3.scene, C3.camera);
    }
  });
}

function rebuildIso(newIso) {
  if (!C3.grid) return;
  loadThree().then(THREE => {
    if (!THREE) return;
    C3.iso = newIso;
    // Drop the old surfaces but keep the molecule
    for (const pair of C3.surfaces) {
      if (!pair) continue;
      for (const mesh of [pair.back, pair.front]) {
        mesh.material.dispose();
        C3.root.remove(mesh);
      }
      pair.geom.dispose();          // shared by both passes
    }
    addIsoSurfaces(THREE, C3.root, C3.grid, newIso);
    restyle();               // colours and visibility apply to the new meshes
    $('isoLbl').textContent = isoLabel(newIso);
    $('cpIsoVal').textContent = isoLabel(newIso);
    updateLockIfActive();
    renderCube();
  });
}

const GFX_PRESETS = {
  low:    {sphereSeg: [10, 7],  cylSeg: 6,  pixelCap: 1, aa: false, tone: false},
  medium: {sphereSeg: [16, 11], cylSeg: 8,  pixelCap: 1.5, aa: true, tone: true},
  high:   {sphereSeg: [20, 14], cylSeg: 12, pixelCap: 2, aa: true, tone: true},
  ultra:  {sphereSeg: [32, 22], cylSeg: 20, pixelCap: 3, aa: true, tone: true},
};

function applyGraphics(preset) {
  if (preset && GFX_PRESETS[preset]) {
    Object.assign(C3, GFX_PRESETS[preset], {quality: preset});
  }
  if (!C3.grid) return;
  // Antialiasing and pixel ratio need the renderer rebuilt; geometry detail
  // needs the molecule rebuilt. Doing the whole scene keeps it simple and is
  // fast enough because the isosurface is not re-extracted.
  loadThree().then(THREE => {
    if (!THREE) return;
    const wrap = $('viewwrap');
    const rot = C3.root ? C3.root.rotation.clone() : null;
    buildCubeScene(THREE, C3.grid);
    if (rot && C3.root) C3.root.rotation.copy(rot);
    renderCube();
  });
}

function setBrightness(v) {
  C3.brightness = v;
  if (!C3.lights) return;
  const L = Math.PI * v;
  C3.lights.ambient.intensity = 0.35 * L;
  C3.lights.key.intensity = 1.0 * L;
  C3.lights.fill.intensity = 0.45 * L;
  C3.lights.rim.intensity = 0.3 * L;
  renderCube();
}

function restyle() {
  for (let i = 0; i < C3.surfaces.length; i++) {
    const pair = C3.surfaces[i];
    if (!pair) continue;
    const show = i === 0 ? C3.showPos : C3.showNeg;
    for (const mesh of [pair.back, pair.front]) {
      mesh.visible = show;
      const m = mesh.material;
      m.color.setHex(i === 0 ? C3.pos : C3.neg);
      m.opacity = C3.opacity;
      m.flatShading = C3.flat;
      m.needsUpdate = true;
    }
  }
  for (const m of C3.atomMeshes) {
    m.visible = C3.showAtoms && (m.userData.z !== 1 || C3.showH);
    m.material.color.setHex(C3.elementColors[m.userData.z] ??
                            CubeLib.colorOf(m.userData.z));
  }
  for (const m of C3.bondMeshes) m.visible = C3.showBonds && C3.showAtoms;
  if (C3.scene) C3.scene.background.setHex(C3.bg);
  renderCube();
}

function buildElementSwatches() {
  const box = $('cpElements');
  box.innerHTML = '';
  if (!C3.grid) return;
  const present = [...new Set(C3.grid.atoms.map(a => a.z))].sort((a, b) => a - b);
  for (const z of present) {
    const cell = document.createElement('div');
    cell.className = 'cp-el';
    const label = document.createElement('b');
    label.textContent = CubeLib.symbolOf(z);
    const input = document.createElement('input');
    input.type = 'color';
    input.value = hex(C3.elementColors[z] ?? CubeLib.colorOf(z));
    input.oninput = () => { C3.elementColors[z] = unhex(input.value); restyle(); };
    cell.append(label, input);
    box.appendChild(cell);
  }
}

function syncPanel() {
  if (!C3.grid) return;
  const peak = Math.max(Math.abs(C3.grid.range[0]), Math.abs(C3.grid.range[1]));
  $('cpIso').value = isoToSlider(C3.iso, peak);
  $('cpIsoVal').textContent = isoLabel(C3.iso);
  $('cpOp').value = Math.round(C3.opacity * 100);
  $('cpOpVal').textContent = Math.round(C3.opacity * 100) + '%';
  $('cpPos').value = hex(C3.pos);
  $('cpNeg').value = hex(C3.neg);
  $('cpBg').value = hex(C3.bg);
  $('cpFlat').checked = C3.flat;
  $('cpAtoms').checked = C3.showAtoms;
  $('cpBonds').checked = C3.showBonds;
  $('cpPosOn').checked = C3.showPos;
  $('cpNegOn').checked = C3.showNeg;
  $('cpH').checked = C3.showH;
  $('cpBright').value = Math.round(C3.brightness * 100);
  $('cpBrightVal').textContent = Math.round(C3.brightness * 100) + '%';
  gqNote();
  $('cpSmooth').value = C3.smooth;
  $('cpSmoothVal').textContent = C3.smooth ? C3.smooth + ' passes' : 'off';
  $('cpTol').value = Math.round(C3.bondTol * 100);
  $('cpTolVal').textContent = '+' + C3.bondTol.toFixed(2) + ' A';
  $('cpScale').value = Math.round(C3.atomScale * 100);
  $('cpScaleVal').textContent = Math.round(C3.atomScale * 100) + '%';
  buildElementSwatches();
}

/* Cube amplitudes span orders of magnitude, so a linear slider spends most
 * of its travel in a range where nothing changes. Map the slider
 * geometrically between 0.05% and 90% of the peak instead, and show the
 * value as a percentage of the peak so it means the same thing across files
 * with completely different amplitudes. */
const ISO_MIN_FRAC = 0.0005, ISO_MAX_FRAC = 0.9;
function sliderToIso(v, peak) {
  const t = v / 1000;
  const frac = ISO_MIN_FRAC * Math.pow(ISO_MAX_FRAC / ISO_MIN_FRAC, t);
  return frac * peak;
}
function isoToSlider(iso, peak) {
  const frac = Math.min(ISO_MAX_FRAC, Math.max(ISO_MIN_FRAC, iso / peak));
  return Math.round(1000 * Math.log(frac / ISO_MIN_FRAC) /
                    Math.log(ISO_MAX_FRAC / ISO_MIN_FRAC));
}
function isoLabel(iso) {
  const peak = C3.peak || 1;
  const pct = (iso / peak) * 100;
  const num = iso >= 1e-3 ? iso.toFixed(4) : iso.toExponential(2);
  return `±${num}  (${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%)`;
}

function showIsoControls(on) {
  // Docked in the footer now: hide the whole dock, so the row collapses
  // cleanly instead of leaving an empty gap above the buttons.
  const was = $('isodock').style.display;
  $('isodock').style.display = on ? 'flex' : 'none';
  $('isobar').style.display = on ? 'flex' : 'none';
  if (was !== $('isodock').style.display) resizeViewer();
  // The 2D zoom controls are meaningless for a 3D scene
  // Both toolbars stay up for cubes — their buttons drive the camera instead
  // of the bitmap, matching the desktop build.
  $('zoombar').style.display = 'flex';
  $('imgbar').style.display = 'flex';
  if (on) updateCubeOrientLabel();
  layoutOverlays();
  if (on && C3.grid) {
    C3.peak = Math.max(Math.abs(C3.grid.range[0]), Math.abs(C3.grid.range[1]));
    refreshLockBtn();
    const sl = $('isoSlide');
    sl.min = 0; sl.max = 1000;
    sl.value = isoToSlider(C3.iso, C3.peak);
    $('isoLbl').textContent = isoLabel(C3.iso);
    syncPanel();
  } else {
    $('cubePanel').classList.remove('on');
  }
}

function showUnsupported(f, why) {
  const reason = why || (f.type === 'cube'
    ? 'Cube files need the desktop app for 3D rendering.'
    : 'No in-browser renderer for this format.');
  $('view').replaceChildren();
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
  if (S.ii < list.length - 1) { S.ii++; }
  else if (S.navMode === 'wrap') { S.ii = 0; }   // stay in this folder
  else { S.fi = (S.fi + 1) % Math.max(1, S.folders.length); S.ii = 0; }
  show();
}
function prevImage() {
  if (S.ii > 0) { S.ii--; }
  else if (S.navMode === 'wrap') { S.ii = Math.max(0, cur().length - 1); }
  else {
    S.fi = (S.fi - 1 + S.folders.length) % Math.max(1, S.folders.length);
    S.ii = Math.max(0, cur().length - 1);
  }
  show();
}

function setNavMode(mode) {
  S.navMode = mode;
  store.set('vm.navMode', mode);
  refreshNavModeBtn();
}

function setAutoAdvance(on) {
  S.autoAdvance = on;
  store.set('vm.autoAdvance', on ? 'on' : 'off');
  refreshAutoBtn();
}

function refreshAutoBtn() {
  const b = $('bAuto');
  if (!b) return;
  b.textContent = S.autoAdvance ? 'Advance after marking' : 'Stay on file';
  b.className = 'sm ' + (S.autoAdvance ? 'teal' : '');
  b.title = S.autoAdvance
    ? 'Marking keep or delete moves to the next file. Click to stay put.'
    : 'Marking leaves you on the same file. Click to advance automatically.';
}
$('bAuto').onclick = () => setAutoAdvance(!S.autoAdvance);

function refreshNavModeBtn() {
  const b = $('bNavMode');
  if (!b) return;
  const wrap = S.navMode === 'wrap';
  b.textContent = wrap ? 'Wrap in folder' : 'Continuous (all folders)';
  b.className = 'sm ' + (wrap ? 'primary' : 'teal');
  // Rewriting textContent above drops the <kbd>, so put it back here rather
  // than relying on the caller's ordering.
  if (typeof KEYS !== 'undefined' && KEYS.navMode) {
    const k = document.createElement('kbd');
    k.textContent = prettyKey(KEYS.navMode);
    b.appendChild(k);
  }

}
function stepFolder(d) {
  if (!S.folders.length) return;
  S.fi = (S.fi + d + S.folders.length) % S.folders.length; S.ii = 0; show();
}
function mark(keep) {
  const f = curFile();
  if (!f) return;
  S.state.set(f.path, keep);
  // Advancing automatically suits a first pass; staying put suits comparing a
  // file against its neighbours or changing your mind about one.
  if (S.autoAdvance) nextImage();
  else show();
}
function toggleFlag() {
  const f = curFile(); if (!f) return;
  S.notes.has(f.path) ? S.notes.delete(f.path) : S.notes.set(f.path, '');
  show();
}
function removeFile(path) {
  // Drop it from the session entirely. This is separate from marking DELETE:
  // a removed file appears in no export and no delete list, as though it had
  // never been loaded.
  S.files = S.files.filter(f => f.path !== path);
  S.state.delete(path);
  S.notes.delete(path);
  rebuild();
  if (S.ii >= cur().length) S.ii = Math.max(0, cur().length - 1);
  show();
}

function removeFolder(folder) {
  const n = S.files.filter(f => f.folder === folder).length;
  if (!confirm(`Remove "${folder}" and its ${n} file(s) from the review?\n\n` +
               `Nothing on disk is touched.`)) return;
  S.files = S.files.filter(f => f.folder !== folder);
  for (const p of [...S.state.keys()]) {
    if (p.startsWith(folder + '/')) { S.state.delete(p); S.notes.delete(p); }
  }
  rebuild();
  S.fi = Math.min(S.fi, Math.max(0, S.folders.length - 1));
  S.ii = 0;
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
  const steps = X_BOXES.filter(id => $(id).checked).length || 1;
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
    for (const f of kept) {
      const target = convertChoice.get(f.folder);
      const convertible = NATIVE.has(f.type) || f.type === 'tga';
      if (!target || !convertible) { zip.file(f.path, f.file); continue; }
      status.textContent = `converting ${f.name} to ${target.toUpperCase()}…`;
      const out = target === 'pdf'
        ? await (async () => { const b = await buildPdf([f]);
            return b ? new Uint8Array(await b.arrayBuffer()) : null; })()
        : await encodeImageBytes(f, target);
      if (out) {
        const base = f.path.replace(/\.[^.]+$/, '');
        zip.file(`${base}.${target === 'jpeg' ? 'jpg' : target}`, out);
      } else {
        zip.file(f.path, f.file);       // conversion failed; keep the original
      }
    }
    const blob = await zip.generateAsync({type: 'blob', compression: 'STORE'},
      m => { status.textContent = `zipping… ${m.percent.toFixed(0)}%`; });
    download('kept-files.zip', blob);
    done++;
  }
  if ($('xEach').checked) {
    // One output per kept file, in whichever format is chosen. Raster targets
    // honour the multiplier by re-rendering the source at that scale.
    const type = $('xEachType').value;
    const mult = +$('xEachScale').value;
    const items = kept.filter(f => NATIVE.has(f.type) || f.type === 'tga' ||
                                   (f.type === 'pdf' && type === 'pdf'));
    let n = 0;
    for (const f of items) {
      status.textContent = `${type.toUpperCase()} ${++n}/${items.length} — ${f.name}`;
      prog.value = ((done + n / items.length) / steps) * 100;
      const base = f.name.replace(/\.[^.]+$/, '');
      if (type === 'pdf') {
        const blob = await buildPdf([f]);
        if (blob) download(`${base}.pdf`, blob);
      } else {
        const blob = await encodeImage(f, type, mult);
        if (blob) download(`${base}_${mult}x.${type === 'jpeg' ? 'jpg' : type}`, blob);
      }
    }
    done++;
  }
  if ($('xPdfEach').checked) {
    // One PDF per folder, named after the folder, mirroring the desktop
    // app's per-folder mode.
    const byFolder = new Map();
    for (const f of kept) {
      if (!NATIVE.has(f.type) && f.type !== 'tga') continue;
      if (!byFolder.has(f.folder)) byFolder.set(f.folder, []);
      byFolder.get(f.folder).push(f);
    }
    let n = 0;
    for (const [folder, files] of byFolder) {
      status.textContent = `PDF for ${folder} (${++n}/${byFolder.size})`;
      const blob = await buildPdf(files, msg => { status.textContent = msg; });
      if (blob) {
        const safe = folder.replace(/[\\/]+/g, '_') || 'root';
        download(`${safe}.pdf`, blob);
      }
    }
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
        const png = await encodeImageBytes(f);
        if (!png) continue;
        const img = await pdf.embedPng(png);
        const page = pdf.addPage([img.width, img.height]);
        page.drawImage(img, {x: 0, y: 0, width: img.width, height: img.height});
      }
      download('kept-images.pdf', new Blob([await pdf.save()], {type: 'application/pdf'}));
      done++;
    }
  }
  if ($('xCubes').checked) {
    const n = await exportCubeSnapshots(kept, cubeScale, $('xCubeWhite').checked,
                                        status, frac => {
      prog.value = ((done + frac) / steps) * 100;
    });
    status.textContent = `${n} snapshot(s) written`;
    done++;
  }

  prog.value = 100;
  status.textContent = 'Done.';
}

/** Assemble a list of image files into one PDF blob. */
async function buildPdf(files, onProgress) {
  const {PDFDocument} = PDFLib;
  const pdf = await PDFDocument.create();
  let added = 0;
  for (let i = 0; i < files.length; i++) {
    if (onProgress) onProgress(`${files[i].name} (${i + 1}/${files.length})`);
    const png = await encodeImageBytes(files[i]);
    if (!png) continue;
    const img = await pdf.embedPng(png);
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, {x: 0, y: 0, width: img.width, height: img.height});
    added++;
  }
  if (!added) return null;
  return new Blob([await pdf.save()], {type: 'application/pdf'});
}



/**
 * Encode a file as an image blob, optionally scaled.
 *
 * This replaces three near-identical helpers that each decoded to a canvas and
 * re-encoded with slightly different arguments. One path means one place to
 * fix when a format behaves unexpectedly.
 *
 *   type  'png' | 'jpeg' | 'webp'
 *   mult  size multiplier; 1 leaves the source size alone
 */
async function encodeImage(f, type = 'png', mult = 1) {
  const src = await toCanvas(f);
  if (!src) return null;
  let cv = src;
  if (mult !== 1) {
    cv = document.createElement('canvas');
    cv.width = Math.round(src.width * mult);
    cv.height = Math.round(src.height * mult);
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, cv.width, cv.height);
  }
  const mime = {png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp'}[type];
  return new Promise(r => cv.toBlob(r, mime, 0.92));
}

/** The same, as bytes, for embedding in a PDF. */
async function encodeImageBytes(f, type = 'png', mult = 1) {
  const blob = await encodeImage(f, type, mult);
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** Decode any supported raster into a canvas. */
async function toCanvas(f) {
  if (f.type === 'tga') return showTgaOffscreen(f).catch(() => null);
  const bitmap = await createImageBitmap(f.file).catch(() => null);
  if (!bitmap) return null;
  const cv = document.createElement('canvas');
  cv.width = bitmap.width; cv.height = bitmap.height;
  cv.getContext('2d').drawImage(bitmap, 0, 0);
  return cv;
}

/**
 * Render each kept cube to a PNG at the chosen multiplier.
 *
 * Every cube is re-read and its surface re-extracted, so this is by far the
 * slowest export; it is off by default for that reason.
 */
async function exportCubeSnapshots(kept, scale, white, status, onStep) {
  const cubes = kept.filter(f => f.type === 'cube');
  if (!cubes.length) { status.textContent = 'no cube files kept'; return 0; }
  const THREE = await loadThree();
  if (!THREE) { status.textContent = '3D library unavailable'; return 0; }

  // Sizing and background are renderSnapshot's job now.
  let written = 0;
  for (let i = 0; i < cubes.length; i++) {
    const f = cubes[i];
    status.textContent = `3D snapshot ${i + 1}/${cubes.length} — ${f.name}`;
    if (onStep) onStep(i / cubes.length);
    try {
      if (!await stageCube(f, THREE)) continue;
      const blob = await renderSnapshot(scale, 'png', white ? 'white' : 'scene');
      if (blob) {
        download(f.name.replace(/\.[^.]+$/, '') + `_${scale}x.png`, blob);
        written++;
      }
    } catch (err) {
      console.error('snapshot failed for', f.name, err);
    }
  }
  C3.grid = null;                 // leave cube mode as we found it
  resizeViewer();
  return written;
}

async function showTgaOffscreen(f) {
  const keep = $('view').innerHTML;
  await showTga(f);            // no token: this render is for export, not display
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
$('bNavMode').onclick = () =>
  setNavMode(S.navMode === 'wrap' ? 'continuous' : 'wrap');
$('bDrop').onclick = () => {
  const f = curFile();
  if (f && confirm(`Remove "${f.name}" from the review?\n\n` +
                   `Nothing on disk is touched.`)) removeFile(f.path);
};
$('bDropFolder').onclick = () => {
  if (S.folders.length) removeFolder(S.folders[S.fi]);
};
$('bKeepAll').onclick = () => bulk(() => true);
$('bDelAll').onclick = () => bulk(() => false);
$('bInvert').onclick = () => bulk(v => !v);
/**
 * Help is built at open time rather than written into the markup, so the
 * shortcut table always reflects the current bindings instead of drifting
 * out of date the first time someone rebinds a key.
 */

/**
 * Export formats a file can actually produce.
 *
 * Driven by what the app can decode, not by a fixed list: a cube renders to
 * an image but cannot become a PDF page directly, and TIFF/DDS have no decoder
 * so they can only be copied as they are.
 */
function formatsFor(f) {
  if (!f) return [];
  if (f.type === 'cube') {
    return [['png', 'PNG image'], ['jpeg', 'JPEG image'], ['webp', 'WebP image']];
  }
  if (f.type === 'pdf') {
    return [['pdf', 'PDF (copy)'], ['png', 'PNG of page 1'],
            ['jpeg', 'JPEG of page 1'], ['webp', 'WebP of page 1']];
  }
  if (NATIVE.has(f.type) || f.type === 'tga') {
    return [['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP'],
            ['pdf', 'PDF (single page)']];
  }
  return [['copy', 'Copy original']];      // no decoder for this type
}

function buildOneFileRow() {
  const f = curFile();
  const sel = $('xOneFmt');
  sel.innerHTML = '';
  $('xOneName').textContent = f ? f.name : 'nothing selected';
  $('xOneName').title = f ? f.path : '';
  for (const [v, label] of formatsFor(f)) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  }
  $('xOneGo').disabled = !f || !sel.value;
}

/** Write the current file in the chosen format, at the chosen resolution. */
async function exportCurrentFile() {
  const f = curFile();
  const fmt = $('xOneFmt').value;
  if (!f || !fmt) return;
  const status = $('xStatus');
  status.textContent = `exporting ${f.name}…`;
  try {
    if (f.type === 'cube') {
      $('isoSnap').click();
    } else if (fmt === 'pdf') {
      const blob = await buildPdf([f]);
      if (blob) download(f.name.replace(/\.[^.]+$/, '') + '.pdf', blob);
    } else if (f.type === 'pdf' && fmt === 'png') {
      // Re-render page one at the chosen multiplier
      const cv = $('view').querySelector('canvas');
      if (cv) {
        const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
        if (blob) download(f.name.replace(/\.[^.]+$/, '') + '.png', blob);
      }
    } else {
      const src = await toCanvas(f);
      if (!src) throw new Error('could not decode this file');
      // Upscale by the chosen factor so "8x" means something for images too
      const cv = document.createElement('canvas');
      cv.width = src.width * cubeScale;
      cv.height = src.height * cubeScale;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, cv.width, cv.height);
      const mime = {png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp'}[fmt];
      const blob = await new Promise(r => cv.toBlob(r, mime, 0.92));
      if (blob) {
        const ext = fmt === 'jpeg' ? 'jpg' : fmt;
        download(`${f.name.replace(/\.[^.]+$/, '')}_${cubeScale}x.${ext}`, blob);
      }
    }
    status.textContent = 'Done.';
  } catch (err) {
    status.textContent = 'Failed: ' + err.message;
  }
}
$('xOneGo').onclick = exportCurrentFile;

// Conversion targets offered per folder in the export dialog.
const CONVERT_TO = [
  ['', 'Keep original'], ['png', 'PNG'], ['jpeg', 'JPEG'],
  ['webp', 'WebP'], ['pdf', 'PDF'],
];

/** Per-folder conversion choices, keyed by folder path. */
const convertChoice = new Map();

/** Resolution multiplier for cube snapshots. */
let cubeScale = 2;

function buildConvertRows() {
  const box = $('xConvert');
  box.innerHTML = '';
  const folders = [...new Set(S.files.filter(f => S.state.get(f.path))
                                     .map(f => f.folder))];
  if (!folders.length) {
    box.innerHTML = '<p class="hint">Nothing kept to convert.</p>';
    return;
  }
  for (const folder of folders) {
    const n = S.files.filter(f => f.folder === folder && S.state.get(f.path) &&
                                  (NATIVE.has(f.type) || f.type === 'tga')).length;
    if (!n) continue;
    const row = document.createElement('div');
    row.className = 'convRow';
    const label = document.createElement('span');
    label.textContent = `${folder} (${n})`;
    label.title = folder;
    const sel = document.createElement('select');
    for (const [v, t] of CONVERT_TO) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      sel.appendChild(o);
    }
    sel.value = convertChoice.get(folder) || '';
    sel.onchange = () => convertChoice.set(folder, sel.value);
    row.append(label, sel);
    box.appendChild(row);
  }
}

function syncCubeOpts() {
  // The multiplier drives single-file export as well, so it stays visible.
  $('xCubeOpts').style.display = 'block';
  for (const b of document.querySelectorAll('.xres'))
    b.classList.toggle('on', +b.dataset.s === cubeScale);
  const stage = $('stagebox');
  $('xResNote').textContent =
    `${Math.round(stage.clientWidth * cubeScale)} x ` +
    `${Math.round(stage.clientHeight * cubeScale)} px`;
}
$('xCubes').onchange = syncCubeOpts;
for (const b of document.querySelectorAll('.xres'))
  b.onclick = () => { cubeScale = +b.dataset.s; syncCubeOpts(); };

const X_BOXES = ['xZip', 'xPdf', 'xPdfEach', 'xEach', 'xNotes', 'xList', 'xCubes'];
$('xAll').onclick = () => {
  X_BOXES.forEach(id => { $(id).checked = true; });
  syncCubeOpts();
};
$('xNone').onclick = () => {
  X_BOXES.forEach(id => { $(id).checked = false; });
  syncCubeOpts();
};

$('bExport').onclick = () => {
  const kept = S.files.filter(f => S.state.get(f.path)).length;
  const del = S.files.length - kept;
  $('xSummary').textContent =
    `${kept} kept, ${del} marked for deletion, ${S.notes.size} flagged.`;
  $('xStatus').textContent = ''; $('xProg').style.display = 'none';
  buildConvertRows();
  buildOneFileRow();
  syncCubeOpts();
  $('dExport').showModal();
};
$('xCancel').onclick = () => $('dExport').close();
$('xGo').onclick = () => runExport();

// The wheel handler lives on #viewwrap and the panel sits inside it, so
// scrolling the settings list was bubbling up and dollying the camera — which
// also meant the list never scrolled and its scrollbar stayed hidden.
$('cubePanel').addEventListener('wheel', e => e.stopPropagation(), {passive: true});
$('cubePanel').addEventListener('pointerdown', e => e.stopPropagation());

// Right-dragging must not raise the context menu over the 3D view
$('view').addEventListener('contextmenu', e => {
  if (C3.grid) e.preventDefault();
});

/* ── Parsed-cube cache ────────────────────────────────────────────────────
 *
 * Reading and parsing a cube is the slow part of showing one — a 370 MB file
 * takes seconds, and the surface extraction on top of that. Caching the parsed
 * grid makes revisiting a file immediate.
 *
 * A downsampled 96^3 grid is 3.4 MB, so fifty of them is 169 MB: the cache is
 * bounded by bytes and evicts least-recently-used entries rather than growing
 * until the tab is killed.
 */
const CUBE_CACHE_BYTES = 280 * 1024 * 1024;
const cubeCache = new Map();          // path -> {grid, bytes}; insertion = LRU order
let prefetchRun = 0;                  // cancels an in-flight folder prefetch

function cacheBytes() {
  let n = 0;
  for (const e of cubeCache.values()) n += e.bytes;
  return n;
}

function cachePut(path, grid) {
  const bytes = grid.values.byteLength;
  if (bytes > CUBE_CACHE_BYTES) return;        // single file too big to hold
  cubeCache.delete(path);
  cubeCache.set(path, {grid, bytes});
  while (cacheBytes() > CUBE_CACHE_BYTES && cubeCache.size > 1) {
    const oldest = cubeCache.keys().next().value;
    cubeCache.delete(oldest);
  }
  updateCacheLabel();
}

function cacheGet(path) {
  const hit = cubeCache.get(path);
  if (!hit) return null;
  cubeCache.delete(path);                      // refresh recency
  cubeCache.set(path, hit);
  return hit.grid;
}

/** Read and parse one cube, using the cache when possible. */
async function loadGrid(file, token) {
  const hit = cacheGet(file.path);
  if (hit) return hit;
  const text = await file.file.text();
  if (token !== undefined && !stillCurrent(token)) return null;
  const grid = CubeLib.downsample(CubeLib.parseCube(text), 96);
  cachePut(file.path, grid);
  return grid;
}

function updateCacheLabel() {
  const el = $('cacheLbl');
  if (!el) return;
  const n = cubeCache.size;
  el.textContent = n
    ? `${n} cube(s) cached · ${(cacheBytes() / 1048576).toFixed(0)} MB`
    : '';
}

function setLoadMode(mode) {
  S.loadMode = mode;
  localStorage.setItem('vm.loadMode', mode);
  refreshLoadBtn();
  if (mode === 'folder') prefetchFolder();
  else prefetchRun++;                          // cancel any running prefetch
}

function refreshLoadBtn() {
  const b = $('bLoadMode');
  if (!b) return;
  const whole = S.loadMode === 'folder';
  b.textContent = whole ? 'Load: whole folder' : 'Load: one at a time';
  b.className = 'sm ' + (whole ? 'teal' : '');
  b.title = whole
    ? 'Cube files in this folder are parsed in the background so moving ' +
      'between them is immediate'
    : 'Each cube is read only when you open it';
}

/**
 * Parse the current folder's cubes in the background.
 *
 * Sequential rather than parallel: these are large reads, and running them at
 * once competes with the file the user is actually looking at. Each step
 * yields so the UI stays responsive, and the run is abandoned if the folder
 * changes or the mode is switched off.
 */
async function prefetchFolder() {
  const run = ++prefetchRun;
  const folder = S.folders[S.fi];
  const cubes = (S.byFolder.get(folder) || []).filter(f => f.type === 'cube');
  if (!cubes.length) { updateCacheLabel(); return; }

  for (let i = 0; i < cubes.length; i++) {
    if (run !== prefetchRun || S.loadMode !== 'folder') return;
    const f = cubes[i];
    if (cubeCache.has(f.path)) continue;
    const el = $('cacheLbl');
    if (el) el.textContent = `caching ${i + 1}/${cubes.length}…`;
    try {
      const text = await f.file.text();
      if (run !== prefetchRun) return;
      cachePut(f.path, CubeLib.downsample(CubeLib.parseCube(text), 96));
    } catch (err) {
      console.warn('prefetch failed for', f.name, err);
    }
    await new Promise(r => setTimeout(r, 0));   // let the UI breathe
  }
  updateCacheLabel();
}

$('bLoadMode').onclick = () =>
  setLoadMode(S.loadMode === 'folder' ? 'lazy' : 'folder');

/**
 * Pin a cube's isovalue, camera and appearance.
 *
 * Orientation is part of the result for an orbital: the angle that shows a
 * lobe clearly is chosen by eye and is worth keeping. A locked file restores
 * exactly what you left, and batch export renders it from that same view
 * rather than a default one.
 */
/** Pinned views survive a reload; they represent real work. */
function saveLocks() {
  try {
    store.set('vm.cubeLocks', JSON.stringify([...S.cubeLocks.entries()]));
  } catch (e) { /* storage full or blocked; locks stay in memory */ }
}

function loadLocks() {
  try {
    const raw = JSON.parse(store.get('vm.cubeLocks') || '[]');
    S.cubeLocks = new Map(raw);
  } catch (e) {
    S.cubeLocks = new Map();
  }
}

function cubeLockState() {
  if (!C3.root || !C3.camera) return null;
  const r = C3.root.rotation;
  return {
    iso: C3.iso, opacity: C3.opacity, pos: C3.pos, neg: C3.neg, bg: C3.bg,
    atomScale: C3.atomScale, showH: C3.showH, showAtoms: C3.showAtoms,
    showBonds: C3.showBonds, showPos: C3.showPos, showNeg: C3.showNeg,
    smooth: C3.smooth,
    rot: {x: r.x, y: r.y, z: r.z},
    dist: C3.dist, panX: C3.panX || 0, panY: C3.panY || 0,
  };
}

function applyCubeLock(lock) {
  if (!lock) return;
  Object.assign(C3, {
    iso: lock.iso, opacity: lock.opacity, pos: lock.pos, neg: lock.neg,
    bg: lock.bg, atomScale: lock.atomScale, showH: lock.showH,
    showAtoms: lock.showAtoms, showBonds: lock.showBonds,
    showPos: lock.showPos, showNeg: lock.showNeg, smooth: lock.smooth,
  });
  if (C3.root) {
    C3.root.rotation.set(lock.rot.x, lock.rot.y, lock.rot.z);
    C3.panX = lock.panX; C3.panY = lock.panY;
    if (C3.centerOffset) {
      C3.root.position.x = -C3.centerOffset.x + lock.panX;
      C3.root.position.y = -C3.centerOffset.y + lock.panY;
    }
  }
  if (C3.camera) {
    C3.dist = lock.dist;
    C3.camera.position.setZ(lock.dist);
    C3.camera.updateProjectionMatrix();
  }
}

/**
 * Keep a pinned view current while it is pinned.
 *
 * Adjusting the isovalue or camera on a locked file should update the pin,
 * otherwise Lock silently means "as of when you clicked it" and the next
 * export uses a stale view.
 */
function updateLockIfActive() {
  const f = curFile();
  if (!f || f.type !== 'cube' || !C3.grid) return;
  if (!S.cubeLocks.has(f.path)) return;
  const state = cubeLockState();
  if (state) { S.cubeLocks.set(f.path, state); saveLocks(); }
}

function toggleCubeLock() {
  const f = curFile();
  if (!f || f.type !== 'cube' || !C3.grid) return;
  if (S.cubeLocks.has(f.path)) S.cubeLocks.delete(f.path);
  else S.cubeLocks.set(f.path, cubeLockState());
  saveLocks();
  refreshLockBtn();
  drawStats();
}

function refreshLockBtn() {
  const b = $('isoLock');
  if (!b) return;
  const f = curFile();
  const locked = f && S.cubeLocks.has(f.path);
  b.textContent = locked ? 'Locked' : 'Lock';
  b.className = 'sm' + (locked ? ' primary' : '');
  b.title = locked
    ? 'This view is pinned: isovalue, colours and camera are restored, and ' +
      'batch export uses this angle. Click to unpin.'
    : 'Pin this isovalue, colours and camera angle to this file';
}

/* ── Snapshot ─────────────────────────────────────────────────────────────
 *
 * Renders the 3D view to an image at a chosen size, format and background,
 * either for the cube on screen or for every kept cube in the folder. A
 * transparent background needs an alpha context, which is fixed when the
 * WebGL context is created, so the renderer is rebuilt for that case.
 */
function snapSizeNote() {
  const stage = $('stagebox');
  const sc = +$('snapScale').value;
  const w = Math.round(Math.max(64, stage.clientWidth) * sc);
  const h = Math.round(Math.max(64, stage.clientHeight) * sc);
  $('snapSize').textContent = `${w} x ${h} px`;
  const all = $('snapAll').checked;
  const jpegAlpha = $('snapBg').value === 'transparent' &&
                    $('snapFmt').value === 'jpeg';
  $('snapNote').textContent = jpegAlpha
    ? 'JPEG has no transparency; the background will be white.'
    : all
      ? 'Locked cubes are rendered from their pinned angle; the rest use ' +
        'the current one.'
      : '';
}
for (const id of ['snapScale', 'snapFmt', 'snapBg', 'snapAll'])
  $(id).onchange = snapSizeNote;

$('isoSnap').onclick = () => {
  $('snapMenu').classList.toggle('on');
  if ($('snapMenu').classList.contains('on')) snapSizeNote();
};
$('snapClose').onclick = () => $('snapMenu').classList.remove('on');
$('snapMenu').addEventListener('wheel', e => e.stopPropagation(), {passive: true});
$('snapMenu').addEventListener('pointerdown', e => e.stopPropagation());

/**
 * Load a cube and make it the live scene, honouring its lock.
 *
 * Both export paths did this inline with slightly different wording — one
 * re-read the file, the other used the cache. Sharing it means a locked view
 * is respected identically wherever a cube is rendered.
 */
async function stageCube(file, THREE) {
  const grid = await loadGrid(file);
  if (!grid) return false;
  const lock = S.cubeLocks.get(file.path);
  C3.grid = grid;
  C3.iso = lock ? lock.iso : CubeLib.chooseIsovalue(grid.values);
  buildCubeScene(THREE, grid);
  if (lock) applyCubeLock(lock);        // render from the pinned angle
  return true;
}

/** Render the current scene to a blob at the requested size and background. */
async function renderSnapshot(scale, fmt, bg) {
  const stage = $('stagebox');
  const w = Math.max(64, stage.clientWidth) * scale;
  const h = Math.max(64, stage.clientHeight) * scale;
  const wantAlpha = bg === 'transparent' && fmt !== 'jpeg';

  const savedBg = C3.bg;
  if (bg === 'white') C3.bg = 0xffffff;

  if (wantAlpha !== !!C3.alpha) {
    C3.alpha = wantAlpha;
    C3.aa = C3.aa;                       // force the renderer to be rebuilt
    C3.rendererAA = null;
    buildCubeScene(C3.THREE, C3.grid);
  } else if (bg === 'white') {
    C3.scene.background.setHex(0xffffff);
  }
  if (wantAlpha && C3.scene) C3.scene.background = null;

  C3.renderer.setSize(w, h, false);
  C3.camera.aspect = w / h;
  C3.camera.updateProjectionMatrix();
  C3.renderer.render(C3.scene, C3.camera);

  const mime = {png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp'}[fmt];
  const blob = await new Promise(r => C3.renderer.domElement.toBlob(r, mime, 0.95));

  C3.bg = savedBg;
  if (C3.scene && !wantAlpha) C3.scene.background = new C3.THREE.Color(savedBg);
  return blob;
}

$('snapGo').onclick = async () => {
  if (!C3.grid) return;
  const scale = +$('snapScale').value;
  const fmt = $('snapFmt').value;
  const bg = $('snapBg').value;
  const ext = fmt === 'jpeg' ? 'jpg' : fmt;
  const btn = $('snapGo');
  const label = btn.textContent;
  btn.disabled = true;

  try {
    if (!$('snapAll').checked) {
      btn.textContent = 'Rendering…';
      const f = curFile();
      const blob = await renderSnapshot(scale, fmt, bg);
      if (blob) download(`${f.name.replace(/\.[^.]+$/, '')}_${scale}x.${ext}`, blob);
    } else {
      const folder = S.folders[S.fi];
      const cubes = (S.byFolder.get(folder) || [])
        .filter(f => f.type === 'cube' && S.state.get(f.path));
      const THREE = await loadThree();
      for (let i = 0; i < cubes.length; i++) {
        const f = cubes[i];
        btn.textContent = `${i + 1}/${cubes.length}…`;
        if (!await stageCube(f, THREE)) continue;
        const blob = await renderSnapshot(scale, fmt, bg);
        if (blob) download(`${f.name.replace(/\.[^.]+$/, '')}_${scale}x.${ext}`, blob);
      }
      await show();                    // put the viewer back where it was
    }
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    resizeViewer();
  }
};

$('isoLock').onclick = toggleCubeLock;

/* Isosurface controls */
$('isoUp').onclick = () => rebuildIso(C3.iso * 1.35);
$('isoDown').onclick = () => rebuildIso(C3.iso / 1.35);
let isoTimer = null;
$('isoSlide').oninput = e => {
  if (!C3.grid) return;
  const target = sliderToIso(+e.target.value, C3.peak);
  $('isoLbl').textContent = isoLabel(target);
  $('cpIsoVal').textContent = isoLabel(target);
  $('cpIso').value = e.target.value;
  // Re-extraction costs hundreds of milliseconds, so wait for the drag to
  // settle rather than rebuilding on every step.
  clearTimeout(isoTimer);
  isoTimer = setTimeout(() => rebuildIso(target), 180);
};
$('isoRecentre').onclick = () => {
  if (!C3.root) return;
  C3.root.rotation.set(0, 0, 0);
  renderCube();
};

/* Cube camera operations.
 *
 * Same mapping as the desktop build: on a cube these controls move the
 * camera rather than rotating the rendered bitmap, because spinning a picture
 * of a 3D scene leaves the lighting and perspective wrong.
 *
 *   rotate  -> roll about the view axis
 *   flip H  -> half turn about the vertical
 *   flip V  -> half turn about the horizontal
 *   reset   -> back to the framing the file opened with
 */
function cubeOp(op) {
  if (!C3.root) return;
  if (op === 'reset') { C3.panX = 0; C3.panY = 0; }
  const HALF = Math.PI;
  if (op === 'cw') C3.root.rotateZ(-Math.PI / 2);
  else if (op === 'ccw') C3.root.rotateZ(Math.PI / 2);
  else if (op === 'h') C3.root.rotateY(HALF);
  else if (op === 'v') C3.root.rotateX(HALF);
  else { C3.root.rotation.set(0, 0, 0); refit(); }
  renderCube();
  updateLockIfActive();
  updateCubeOrientLabel();
}

function updateCubeOrientLabel() {
  if (!C3.root) return;
  const deg = v => Math.round(v * 180 / Math.PI / 5) * 5;
  const r = C3.root.rotation;
  const bits = [];
  if (deg(r.x)) bits.push('X' + deg(r.x) + '\u00b0');
  if (deg(r.y)) bits.push('Y' + deg(r.y) + '\u00b0');
  if (deg(r.z)) bits.push('Z' + deg(r.z) + '\u00b0');
  $('rotLbl').textContent = bits.length ? bits.join(' ') : '3D';
}

function cubeZoom(factor) {
  if (!C3.camera) return;
  C3.dist *= factor;
  C3.camera.position.setZ(C3.dist);
  C3.camera.updateProjectionMatrix();
  renderCube();
  updateLockIfActive();
  $('zlbl').textContent = C3.homeDist
    ? Math.round(C3.homeDist / C3.dist * 100) + '%' : 'Fit';
}

/* 2D rotate / flip.
 * Flips are composed the same way as in the desktop build: mirroring only
 * commutes with rotation after negating the angle, so a flip after a rotation
 * must invert it too. Toggling the mirror alone would behave erratically once
 * the image had been rotated. */
function rotate(dir) {
  S.rot = (S.rot + dir + 4) % 4;
  S.fit = computeFit();               // the footprint changed
  applyTransform();
}
function flip(axis) {
  if (axis === 'h') { S.rot = (4 - S.rot) % 4; S.mirror = !S.mirror; }
  else { S.rot = (6 - S.rot) % 4; S.mirror = !S.mirror; }
  S.fit = computeFit();
  applyTransform();
}
$('rotL').onclick = () => { if (C3.grid) cubeOp('ccw'); else rotate(-1); };
$('rotR').onclick = () => { if (C3.grid) cubeOp('cw'); else rotate(1); };
$('flipH').onclick = () => { if (C3.grid) cubeOp('h'); else flip('h'); };
$('flipV').onclick = () => { if (C3.grid) cubeOp('v'); else flip('v'); };
$('rotReset').onclick = () => {
  if (C3.grid) { cubeOp('reset'); return; }
  S.rot = 0; S.mirror = false; S.fit = computeFit(); applyTransform();
};

/* Cube settings panel */
$('isoMore').onclick = () => {
  $('cubePanel').classList.toggle('on');
  if ($('cubePanel').classList.contains('on')) syncPanel();
};
$('cpClose').onclick = () => $('cubePanel').classList.remove('on');

let cpIsoTimer = null;
$('cpIso').oninput = e => {
  if (!C3.grid) return;
  const target = sliderToIso(+e.target.value, C3.peak);
  $('cpIsoVal').textContent = isoLabel(target);
  $('isoLbl').textContent = isoLabel(target);
  $('isoSlide').value = e.target.value;
  clearTimeout(cpIsoTimer);
  cpIsoTimer = setTimeout(() => rebuildIso(target), 180);
};
$('cpOp').oninput = e => {
  C3.opacity = +e.target.value / 100;
  $('cpOpVal').textContent = e.target.value + '%';
  restyle();                       // no re-extraction needed for a material
};
$('cpPos').oninput = e => { C3.pos = unhex(e.target.value); restyle(); };
$('cpNeg').oninput = e => { C3.neg = unhex(e.target.value); restyle(); };
$('cpBg').oninput = e => { C3.bg = unhex(e.target.value); restyle(); };
$('cpFlat').onchange = e => { C3.flat = e.target.checked; restyle(); };
$('cpPosOn').onchange = e => { C3.showPos = e.target.checked; restyle(); };
$('cpNegOn').onchange = e => { C3.showNeg = e.target.checked; restyle(); };
$('cpH').onchange = e => { C3.showH = e.target.checked; restyle(); };
$('cpScale').oninput = e => {
  C3.atomScale = +e.target.value / 100;
  $('cpScaleVal').textContent = e.target.value + '%';
  rebuildMolecule();
};
$('cpBgDark').onclick = () => { C3.bg = 0x0b0712; $('cpBg').value = hex(C3.bg); restyle(); };
$('cpBgWhite').onclick = () => { C3.bg = 0xffffff; $('cpBg').value = hex(C3.bg); restyle(); };
$('cpFront').onclick = () => setView(0, 0);
$('cpSide').onclick  = () => setView(Math.PI / 2, 0);
$('cpTop').onclick   = () => setView(0, -Math.PI / 2);
$('cpFit').onclick   = () => refit();
$('cpAtoms').onchange = e => { C3.showAtoms = e.target.checked; restyle(); };
$('cpBonds').onchange = e => { C3.showBonds = e.target.checked; restyle(); };
$('cpReset').onclick = () => {
  Object.assign(C3, {opacity: 0.85, pos: 0xf2e120, neg: 0x2fd0e0,
                     bg: 0x0b0712, flat: false, showAtoms: true,
                     showBonds: true, elementColors: {}, atomScale: 1.0,
                     showH: true, showPos: true, showNeg: true,
                     brightness: 1.0});
  applyGraphics('high');
  rebuildMolecule(); refit();
  if (C3.grid) rebuildIso(CubeLib.chooseIsovalue(C3.grid.values));
  restyle(); syncPanel();
};

/* Atom scale changes geometry, so the molecule is rebuilt rather than
 * restyled; the isosurface is untouched and needs no re-extraction. */
function rebuildMolecule() {
  if (!C3.root) return;
  loadThree().then(THREE => {
    if (!THREE) return;
    for (const m of [...C3.atomMeshes, ...C3.bondMeshes]) {
      m.geometry.dispose(); m.material.dispose(); C3.root.remove(m);
    }
    addMolecule(THREE, C3.root, C3.grid);
    renderCube();
  });
}

function setView(yaw, pitch) {
  if (!C3.root) return;
  C3.root.rotation.set(pitch, yaw, 0);
  renderCube();
}

function refit() {
  if (!C3.root) return;
  loadThree().then(THREE => {
    if (!THREE) return;
    const wrap = $('stagebox');
    frameScene(THREE, wrap.clientWidth, wrap.clientHeight);
    renderCube();
  });
}

/* Announce the build before anything else can fail, so the console always
 * shows which version is actually running. */
console.log(`VisManager Web build ${BUILD}`);
{
  const el = document.getElementById('ver');
  if (el) el.textContent = 'build ' + BUILD;
}

/* Apply the supplied icon set to the buttons. Done in JS rather than inline
 * markup so the base64 payload lives in one file. */
(function applyIcons() {
  // Degrade to text-only buttons if icons.js is missing, rather than throwing
  // and aborting the rest of this file — which silently kills every handler
  // declared below it.
  if (typeof window.ICONS !== 'object' || typeof window.setBtnIcon !== 'function') {
    console.warn('icons.js did not load; continuing without icons');
    return;
  }
  // Guarded: if icons.js failed to load, or was not deployed alongside the
  // other files, the buttons should fall back to text rather than the whole
  // script aborting here and leaving a dead page.
  if (typeof ICONS === 'undefined' || typeof setBtnIcon !== 'function') {
    console.warn('icons.js did not load; buttons will show text only');
    return;
  }
  const logo = document.getElementById('logo');
  if (logo && window.ICONS.logo64) logo.src = window.ICONS.logo64;
  const map = {
    bPF: 'folder-prev', bPI: 'file-prev', bNI: 'file-next', bNF: 'folder-next',
    bNote: 'pencil', bFlag: 'flag', bExport: 'doc', zFull: 'corners',
    // These four had their text glyphs stripped and no icon assigned, so they
    // rendered as blank pills.
    rotL: 'undo', rotR: 'redo',
    flipH: 'flip-horizontal', flipV: 'flip-vertical',
    zIn: 'expand', zOut: 'collapse',
  };
  for (const [id, name] of Object.entries(map)) window.setBtnIcon(id, name);
})();

/**
 * Keep the stage and the settings panel clear of the overlay bars.
 *
 * The bar row wraps on narrow windows, so its height is not fixed; measuring
 * it is the only way to place things below it reliably.
 */
/**
 * Switch the control groups to compact form when the viewer is narrow.
 *
 * Same treatment the overlay bars already get in expanded and fullscreen mode:
 * labels drop out and padding tightens, so the row keeps to one line instead
 * of wrapping and stealing height from the stage.
 */
function updateBarDensity() {
  const w = $('stage').clientWidth || innerWidth;
  const tight = w < 1000 || document.body.classList.contains('expanded') ||
                !!document.fullscreenElement;
  $('topbars').classList.toggle('flat', tight);
  $('isodock').classList.toggle('flat', tight);
  // Below this the action row wraps to three lines and pushes the viewer out
  // of the window, so the buttons themselves shrink instead.
  document.body.classList.toggle('tightbtn', w < 1200);
}

function layoutOverlays() {
  updateBarDensity();
  const bars = $('topbars'), stage = $('stagebox'), panel = $('cubePanel');
  if (!bars || !stage) return;
  const h = bars.offsetHeight || 0;
  stage.style.top = (h ? h + 18 : 14) + 'px';
  for (const el of [panel, $('snapMenu')])
    if (el) el.style.top = (h ? h + 16 : 12) + 'px';
}
window.addEventListener('resize', layoutOverlays);

$('addAppend').onclick = () => { $('dAdd').close(); ingestNow(pendingFiles, true); };
$('addReplace').onclick = () => { $('dAdd').close(); ingestNow(pendingFiles, false); };
$('addCancel').onclick = () => { $('dAdd').close(); pendingFiles = null; };

/**
 * Arrow-key navigation inside the folder list.
 *
 * Scoped to the sidebar having focus, so the same arrow keys keep stepping
 * through images when the viewer is in use.
 */
function moveTreeCursor(delta) {
  const rows = S.treeRows;
  if (!rows.length) return;
  let i = S.treeCursor;
  if (i < 0) i = rows.findIndex(r => r.el.classList.contains('on'));
  i = Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i) + delta));
  S.treeCursor = i;
  for (const r of rows) r.el.classList.remove('cursor');
  const row = rows[i];
  row.el.classList.add('cursor');
  // Guarded: not every embedding provides it, and a missing scroll helper
  // should never break keyboard navigation.
  if (row.el.scrollIntoView) row.el.scrollIntoView({block: 'nearest'});
}

function activateTreeCursor() {
  const row = S.treeRows[S.treeCursor];
  if (!row) return;
  if (row.kind === 'group') { toggleGroup(row.top); return; }
  if (row.kind === 'folder') {
    S.openFolders.has(row.folder) ? S.openFolders.delete(row.folder)
                                  : S.openFolders.add(row.folder);
    S.fi = S.folders.indexOf(row.folder); S.ii = 0;
    drawTree(); show();
    return;
  }
  S.fi = S.folders.indexOf(row.folder); S.ii = row.idx; show();
}

$('tree').addEventListener('keydown', e => {
  const map = {ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8};
  if (map[e.key] !== undefined) { e.preventDefault(); moveTreeCursor(map[e.key]); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTreeCursor(); }
  else if (e.key === 'ArrowRight') {
    const r = S.treeRows[S.treeCursor];
    if (r && r.kind === 'folder') { e.preventDefault(); S.openFolders.add(r.folder); drawTree(); }
  } else if (e.key === 'ArrowLeft') {
    const r = S.treeRows[S.treeCursor];
    if (r && r.kind === 'folder') { e.preventDefault(); S.openFolders.delete(r.folder); drawTree(); }
  }
});

function toggleGroup(top) {
  S.collapsed.has(top) ? S.collapsed.delete(top) : S.collapsed.add(top);
  drawTree();
}

/**
 * Let the stage be resized.
 *
 * Shrinking it gives the controls a narrower row to lay out in, which is what
 * makes them collapse onto a single line; growing it maximises the picture.
 */
// The stage deliberately has no resize grip of its own: its size follows the
// sidebar and the bottom panel, so there is one way to change the layout
// rather than three that can disagree.

/**
 * Re-sync everything to the stage's current size.
 *
 * The WebGL canvas has a fixed pixel size; if the stage box changes while the
 * drawing buffer does not, the picture is stretched. Resizing only on release
 * is what made dragging the panel look like it distorted the view.
 */
let resizeQueued = false;
/**
 * Keep the framing distance consistent as the viewport changes shape.
 *
 * frameScene picks a distance from the content radius and the field of view;
 * that distance is only right for the aspect it was computed at.
 */
function refitDistanceForAspect(w, h) {
  if (!C3.camera || !C3.contentRadius) return;
  const fov = C3.camera.fov * Math.PI / 180;
  const fitH = C3.contentRadius / Math.sin(fov / 2);
  const fitW = fitH / Math.min(1, w / h);
  const dist = Math.max(fitH, fitW) * 1.15;
  C3.homeDist = dist;
  C3.dist = dist;
  C3.camera.position.setZ(dist);
  C3.camera.updateProjectionMatrix();
}

function resizeViewer() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    // Position the overlays FIRST. layoutOverlays() sets the stage's top from
    // the measured toolbar height, so running it afterwards resized the stage
    // out from under a canvas that had just been sized to the old dimensions —
    // the drawing buffer then no longer matched its CSS box and the scene came
    // out stretched.
    layoutOverlays();
    const stage = $('stagebox');
    const w = Math.max(64, stage.clientWidth), h = Math.max(64, stage.clientHeight);
    if (C3.renderer && C3.camera) {
      const aspectChanged = Math.abs(C3.camera.aspect - w / h) > 1e-4;
      C3.renderer.setSize(w, h, true);
      C3.camera.aspect = w / h;
      C3.camera.updateProjectionMatrix();
      // A narrower view needs the camera further back to keep the same content
      // visible. Without this the model appears to drift and clip as the
      // window changes shape, since the framing distance was computed for the
      // old aspect. Panned or pinned views are left alone — the user placed
      // those deliberately.
      if (aspectChanged && C3.homeDist && !C3.panX && !C3.panY) {
        const f = curFile();
        if (!(f && S.cubeLocks.has(f.path))) refitDistanceForAspect(w, h);
      }
      renderCube();
    }
    if (S.el) { S.fit = computeFit(); applyTransform(); }
  });
}

/**
 * Resize the control panel, trading space with the viewer.
 *
 * Dragging it small switches the footer to a compact mode: the labels and
 * status lines drop out and the buttons shrink onto one line, which is the
 * same trade the sidebar offers horizontally.
 */
(function footResize() {
  const grip = $('footGrip'), foot = $('foot');
  if (!grip) return;
  const applyHeight = px => {
    foot.style.maxHeight = px ? px + 'px' : '';
    document.body.classList.toggle('footmin', px && px < 120);
    resizeViewer();
  };
  const saved = +store.get('vm.footH');
  if (saved) applyHeight(saved);

  let drag = null;
  grip.addEventListener('pointerdown', e => {
    drag = {y: e.clientY, h: foot.getBoundingClientRect().height};
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', e => {
    if (!drag) return;
    const h = Math.max(46, Math.min(innerHeight * 0.6, drag.h - (e.clientY - drag.y)));
    applyHeight(h);
  });
  grip.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    store.set('vm.footH', Math.round(foot.getBoundingClientRect().height));
    resizeViewer();
    if (C3.grid) refit();        // reframe once the size has settled
  });
  grip.addEventListener('dblclick', () => {
    const compact = document.body.classList.contains('footmin');
    applyHeight(compact ? 0 : 60);
    store.set('vm.footH', compact ? 0 : 60);
  });
})();

/**
 * Browse every flagged file and jump straight to it.
 *
 * Flags are only useful if they can be revisited; scrolling the folder tree
 * hunting for the ones you marked defeats the point of marking them.
 */
function openNotes() {
  const list = $('notesList');
  list.innerHTML = '';
  const entries = [...S.notes.entries()];
  $('notesCount').textContent = entries.length
    ? `${entries.length} flagged file(s)`
    : 'Nothing flagged yet. Press F on a file, or add a note with N.';

  // Group by folder, in the order the folders appear in the review
  const byFolder = new Map();
  for (const [path, text] of entries) {
    const folder = path.split('/').slice(0, -1).join('/') || '(root)';
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push({path, text});
  }
  for (const [folder, items] of byFolder) {
    const head = document.createElement('div');
    head.className = 'hint';
    head.style.marginTop = '10px';
    head.textContent = folder;
    list.appendChild(head);

    for (const {path, text} of items) {
      const file = S.files.find(f => f.path === path);
      const kept = S.state.get(path);
      const el = document.createElement('div');
      el.className = 'noteItem';
      el.innerHTML =
        `<div class="nf"><span>${path.split('/').pop()}</span>` +
        `<span class="badge${kept ? '' : ' del'}">${kept ? 'KEEP' : 'DELETE'}</span>` +
        (file ? '' : '<span class="badge del">removed</span>') + `</div>` +
        `<div class="np">${path}</div>` +
        (text ? `<div class="nt">${text.replace(/[<>&]/g,
            c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</div>` : '');
      el.onclick = () => {
        if (!file) return;
        const fi = S.folders.indexOf(file.folder);
        if (fi < 0) return;
        S.fi = fi;
        S.ii = Math.max(0, S.byFolder.get(file.folder).findIndex(f => f.path === path));
        $('dNotes').close();
        show();
      };
      list.appendChild(el);
    }
  }
  $('dNotes').showModal();
}
$('bNote').onclick = () => {
  const f = curFile();
  if (!f) return;
  $('noteFor').textContent = f.path;
  $('noteText').value = S.notes.get(f.path) || '';
  $('dNote').showModal();
  $('noteText').focus();
};
$('noteSave').onclick = () => {
  const f = curFile();
  if (!f) { $('dNote').close(); return; }
  const text = $('noteText').value.trim();
  text ? S.notes.set(f.path, text) : S.notes.delete(f.path);
  $('dNote').close();
  show();
};
$('noteDel').onclick = () => {
  const f = curFile();
  if (f) S.notes.delete(f.path);
  $('dNote').close();
  show();
};
$('noteCancel').onclick = () => $('dNote').close();

$('bHelp').onclick = () => $('dHelp').showModal();
$('helpClose').onclick = () => $('dHelp').close();

$('bNotes').onclick = openNotes;
$('notesClose').onclick = () => $('dNotes').close();
$('notesCopy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(notesReport());
    $('notesCount').textContent = 'Report copied to the clipboard.';
  } catch (e) {
    download('vismanager-notes.txt',
             new Blob([notesReport()], {type: 'text/plain'}));
  }
};

/* Sidebar resizing. Width is remembered so the layout survives a reload. */
(function () {
  const grip = $('grip'), side = $('side');
  const saved = +store.get('vm.sideWidth');
  if (saved >= 170) side.style.width = saved + 'px';
  let dragging = false;
  grip.addEventListener('pointerdown', e => {
    dragging = true; grip.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
  });
  grip.addEventListener('pointermove', e => {
    if (!dragging) return;
    const w = Math.max(170, Math.min(innerWidth * 0.6, e.clientX));
    side.style.width = w + 'px';
  });
  grip.addEventListener('pointerup', e => {
    dragging = false; document.body.style.userSelect = '';
    store.set('vm.sideWidth', parseInt(side.style.width, 10) || 290);
    // The viewport changed width, so refit whatever is on screen
    if (S.el) { S.fit = computeFit(); applyTransform(); }
    if (C3.grid) refit();
  });
})();

/* Graphics quality */
function gqNote() {
  const [a1, b1] = C3.sphereSeg;
  $('gqNote').textContent =
    `${a1}x${b1} spheres, ${C3.cylSeg}-sided bonds, up to ${C3.pixelCap}x ` +
    `pixel ratio${C3.aa ? ', AA' : ''}${C3.tone ? ', tone mapped' : ''}`;
  for (const [id, key] of [['gqLow', 'low'], ['gqMed', 'medium'],
                           ['gqHigh', 'high'], ['gqUltra', 'ultra']]) {
    $(id).style.background = C3.quality === key
      ? 'var(--teal)' : 'var(--nav)';
  }
  $('cpAA').checked = C3.aa;
  $('cpTone').checked = C3.tone;
}
for (const [id, key] of [['gqLow', 'low'], ['gqMed', 'medium'],
                         ['gqHigh', 'high'], ['gqUltra', 'ultra']]) {
  $(id).onclick = () => { applyGraphics(key); gqNote(); };
}
$('cpBright').oninput = e => {
  const v = +e.target.value / 100;
  $('cpBrightVal').textContent = e.target.value + '%';
  setBrightness(v);
};
$('cpAA').onchange = e => { C3.aa = e.target.checked; C3.quality = 'custom'; applyGraphics(); gqNote(); };
$('cpTone').onchange = e => { C3.tone = e.target.checked; C3.quality = 'custom'; applyGraphics(); gqNote(); };

/* Surface quality and bonding */
$('cpSmooth').oninput = e => {
  C3.smooth = +e.target.value;
  $('cpSmoothVal').textContent = C3.smooth ? C3.smooth + ' passes' : 'off';
};
$('cpSmooth').onchange = () => rebuildIso(C3.iso);
$('cpTol').oninput = e => {
  C3.bondTol = +e.target.value / 100;
  $('cpTolVal').textContent = '+' + C3.bondTol.toFixed(2) + ' A';
};
$('cpTol').onchange = () => rebuildMolecule();

/* Expand to window: hide the chrome and give the stage the whole window.
 * Distinct from fullscreen, which takes over the display. */
function toggleExpanded() {
  const on = !document.body.classList.contains('expanded');
  document.body.classList.toggle('expanded', on);

  $('zExpand').textContent = on ? 'Restore' : 'Expand';
  setTimeout(resizeViewer, 50);
}
$('zExpand').onclick = toggleExpanded;

/* Panel dragging and resizing. The settings panel covers the model, so being
 * able to move it out of the way matters more than it would for a dialog. */
(function panelChrome() {
  const panel = $('cubePanel'), head = $('cpDrag'), grip = $('cpGrip');
  let mode = null, sx = 0, sy = 0, sl = 0, st = 0, sw = 0, sh = 0;
  const begin = (kind, e) => {
    mode = kind;
    const r = panel.getBoundingClientRect();
    const host = $('viewwrap').getBoundingClientRect();
    sx = e.clientX; sy = e.clientY;
    sl = r.left - host.left; st = r.top - host.top;
    sw = r.width; sh = r.height;
    e.preventDefault();
    e.target.setPointerCapture(e.pointerId);
  };
  head.addEventListener('pointerdown', e => {
    if (e.target.tagName !== 'BUTTON') begin('move', e);
  });
  grip.addEventListener('pointerdown', e => begin('size', e));
  const move = e => {
    if (!mode) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (mode === 'move') {
      panel.style.left = Math.max(0, sl + dx) + 'px';
      panel.style.top = Math.max(0, st + dy) + 'px';
    } else {
      panel.style.width = Math.max(240, sw + dx) + 'px';
      panel.style.height = Math.max(200, sh + dy) + 'px';
    }
  };
  head.addEventListener('pointermove', move);
  grip.addEventListener('pointermove', move);
  const end = () => { mode = null; };
  head.addEventListener('pointerup', end);
  grip.addEventListener('pointerup', end);
})();

/* Fullscreen — requested on the view area so the overlaid isosurface bar,
 * settings panel and zoom controls stay usable. Requesting it on the whole
 * document would keep the sidebar and footer, which defeats the point. */
function toggleFullscreen() {
  // Fullscreen the stage COLUMN, not just the viewer, so the navigation and
  // marking buttons come along. Requesting it on the viewer alone left the
  // controls behind, which made fullscreen useless for actually reviewing.
  const el = $('stage');
  if (!document.fullscreenElement) {
    (el.requestFullscreen || el.webkitRequestFullscreen).call(el)
      .catch(err => alert('Fullscreen refused: ' + err.message));
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
}
$('zFull').onclick = toggleFullscreen;
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  updateBarDensity();
  setBtnIcon('zFull', 'corners');
  // The canvas has a fixed pixel size, so it must be resized to the new box
  setTimeout(resizeViewer, 60);
});

/* Zoom and pan */
$('zIn').onclick = () => { if (C3.grid) return cubeZoom(1 / 1.15); S.zoom *= 1.25; applyTransform(); };
$('zOut').onclick = () => { if (C3.grid) return cubeZoom(1.15); S.zoom /= 1.25; applyTransform(); };
$('zFit').onclick = () => {
  if (C3.grid) { refit(); $('zlbl').textContent = 'Fit'; return; }
  S.zoom = 1; S.ox = S.oy = 0; applyTransform();
};
$('z1').onclick = () => {
  if (C3.grid) { refit(); $('zlbl').textContent = 'Fit'; return; }
  S.zoom = 1 / S.fit; S.ox = S.oy = 0; applyTransform();
};
$('viewwrap').addEventListener('wheel', e => {
  if (C3.grid && !S.el) {
    e.preventDefault();
    cubeZoom(e.deltaY < 0 ? 1 / 1.12 : 1.12);
    return;
  }
  if (!S.el) return;
  e.preventDefault();
  S.zoom *= e.deltaY < 0 ? 1.12 : 1 / 1.12;
  applyTransform();
}, {passive: false});
let panning = null;
$('view').addEventListener('pointerdown', e => {
  if (C3.grid && !S.el) {
    // Left button orbits, right button repositions the structure.
    C3.drag = {x: e.clientX, y: e.clientY,
               pan: e.button === 2 || e.shiftKey};
    $('view').setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  if (!S.el) return;
  panning = {x: e.clientX, y: e.clientY, ox: S.ox, oy: S.oy};
  $('view').classList.add('drag'); $('view').setPointerCapture(e.pointerId);
});
$('view').addEventListener('pointermove', e => {
  if (C3.drag && C3.root) {
    const dx = e.clientX - C3.drag.x, dy = e.clientY - C3.drag.y;
    C3.drag = {x: e.clientX, y: e.clientY, pan: C3.drag.pan};
    if (C3.drag.pan) panScene(dx, dy); else orbitScene(dx, dy);
    renderCube();
    updateLockIfActive();
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
window.addEventListener('resize', resizeViewer);

/**
 * Watch the stage itself rather than guessing when it changes.
 *
 * Its size depends on the toolbar row wrapping, the isosurface strip appearing,
 * the sidebar and panel being dragged, and expand/fullscreen — every one of
 * which had to remember to call resizeViewer, and missing any left the WebGL
 * drawing buffer out of step with its CSS box. That mismatch both stretches
 * the scene and shifts it off centre. Observing the element removes the
 * ordering problem entirely.
 */
if (typeof ResizeObserver !== 'undefined') {
  const stageObserver = new ResizeObserver(() => resizeViewer());
  const stageEl = $('stagebox');
  if (stageEl) stageObserver.observe(stageEl);
}

/* ── Rebindable shortcuts ────────────────────────────────────────────────
 * Actions are named so the binding can change without touching the handler.
 * Overrides live in localStorage; defaults fill any gaps, so a partially
 * customised set still works after new actions are added. */
const ACTIONS = [
  ['keep',     'Mark as KEEP',        'k'],
  ['delete',   'Mark as DELETE',      'd'],
  ['toggle',   'Toggle keep/delete',  ' '],
  ['next',     'Next image',          'arrowright'],
  ['prev',     'Previous image',      'arrowleft'],
  ['nextFold', 'Next folder',         '.'],
  ['prevFold', 'Previous folder',     ','],
  ['note',     'Edit note',           'n'],
  ['flag',     'Toggle flag',         'f'],
  ['rotL',     'Rotate left',         '['],
  ['rotR',     'Rotate right',        ']'],
  ['flipH',    'Flip horizontal',     'h'],
  ['flipV',    'Flip vertical',       'v'],
  ['resetRot', 'Reset orientation',   'r'],
  ['zoomIn',   'Zoom in',             '='],
  ['zoomOut',  'Zoom out',            '-'],
  ['zoomFit',  'Zoom to fit',         '0'],
  ['iso',      '3D settings',         'i'],
  ['full',     'Fullscreen',          'f11'],
  ['navMode',  'Continuous / wrap',   'w'],
  ['remove',   'Remove from review',  'x'],
  ['expandWin','Expand to window',    'e'],
  ['lock',     'Lock cube view',      'l'],
  ['snap',     'Snapshot cube',       's'],
];
const DEFAULT_KEYS = Object.fromEntries(ACTIONS.map(([id, , k]) => [id, k]));

function loadKeys() {
  let saved = {};
  try { saved = JSON.parse(store.get('vm.keys') || '{}'); } catch (e) {}
  return {...DEFAULT_KEYS, ...saved};
}
let KEYS = loadKeys();
const saveKeys = () => store.set('vm.keys', JSON.stringify(KEYS));

const HANDLERS = {
  keep: () => mark(true),
  delete: () => mark(false),
  toggle: () => { const f = curFile(); if (f) { S.state.set(f.path, !S.state.get(f.path)); show(); } },
  next: nextImage, prev: prevImage,
  nextFold: () => stepFolder(1), prevFold: () => stepFolder(-1),
  note: () => $('bNote').click(), flag: toggleFlag,
  rotL: () => rotate(-1), rotR: () => rotate(1),
  flipH: () => flip('h'), flipV: () => flip('v'),
  resetRot: () => $('rotReset').click(),
  zoomIn: () => $('zIn').click(), zoomOut: () => $('zOut').click(),
  zoomFit: () => $('zFit').click(),
  iso: () => { if (C3.grid) $('isoMore').click(); },
  full: toggleFullscreen,
  navMode: () => setNavMode(S.navMode === 'wrap' ? 'continuous' : 'wrap'),
  remove: () => $('bDrop').click(),
  expandWin: () => toggleExpanded(),
  lock: () => toggleCubeLock(),
  snap: () => $('isoSnap').click(),
};

/**
 * Put every shortcut inside its button.
 *
 * Captions under buttons duplicated keys that were already printed inline and
 * left stray letters floating under the row, so the key now lives in a <kbd>
 * within the label and nowhere else.
 */
const BTN_ACTIONS = {
  bKeep: 'keep', bDel: 'delete', bNote: 'note', bFlag: 'flag',
  bPI: 'prev', bNI: 'next', bPF: 'prevFold', bNF: 'nextFold',
  bDrop: 'remove', bNavMode: 'navMode',
  rotL: 'rotL', rotR: 'rotR', flipH: 'flipH', flipV: 'flipV',
  rotReset: 'resetRot', zIn: 'zoomIn', zOut: 'zoomOut', zFit: 'zoomFit',
  zFull: 'full', zExpand: 'expandWin', isoMore: 'iso',
};

function refreshKeyCaps() {
  for (const [id, action] of Object.entries(BTN_ACTIONS)) {
    const btn = $(id);
    if (!btn) continue;
    btn.querySelectorAll('.kcap').forEach(n => n.remove());   // legacy captions
    let kbd = btn.querySelector('kbd');
    const key = KEYS[action];
    if (!key) { if (kbd) kbd.remove(); continue; }
    if (!kbd) {
      kbd = document.createElement('kbd');
      btn.appendChild(kbd);
    }
    kbd.textContent = prettyKey(key);
    btn.title = (btn.title || '').replace(/\s*\[[^\]]*\]$/, '') +
                ` [${prettyKey(key)}]`;
  }
  refreshNavModeBtn();
}

const prettyKey = k => ({' ': 'Space', 'arrowleft': '←', 'arrowright': '→',
  'arrowup': '↑', 'arrowdown': '↓', 'escape': 'Esc', 'f11': 'F11'}[k] ||
  (k.length === 1 ? k.toUpperCase() : k));

function buildKeyRows() {
  const box = $('keyRows'); box.innerHTML = '';
  for (const [id, label] of ACTIONS) {
    const row = document.createElement('div');
    row.className = 'krow';
    const name = document.createElement('span'); name.textContent = label;
    const btn = document.createElement('button');
    btn.className = 'sm kbtn'; btn.textContent = prettyKey(KEYS[id]);
    btn.onclick = () => startCapture(id, btn);
    row.append(name, btn); box.appendChild(row);
  }
}

let capturing = null;
function startCapture(id, btn) {
  if (capturing) capturing.btn.classList.remove('listening');
  capturing = {id, btn};
  btn.classList.add('listening');
  btn.textContent = 'press a key…';
  $('keyMsg').textContent = 'Press any key, or Esc to cancel.';
}

$('dKeys').addEventListener('keydown', e => {
  if (!capturing) return;
  e.preventDefault(); e.stopPropagation();
  if (e.key === 'Escape') {
    capturing.btn.classList.remove('listening');
    capturing.btn.textContent = prettyKey(KEYS[capturing.id]);
    capturing = null; $('keyMsg').textContent = 'Cancelled.';
    return;
  }
  const k = e.key === ' ' ? ' ' : e.key.toLowerCase();
  // Clear whoever held this key, so two actions can never share one binding
  let stolenFrom = null;
  for (const [id, v] of Object.entries(KEYS)) {
    if (v === k && id !== capturing.id) { KEYS[id] = ''; stolenFrom = id; }
  }
  KEYS[capturing.id] = k;
  saveKeys();
  capturing.btn.classList.remove('listening');
  capturing = null;
  buildKeyRows();
  refreshKeyCaps();
  $('keyMsg').textContent = stolenFrom
    ? `Taken from "${ACTIONS.find(a => a[0] === stolenFrom)[1]}".` : '';
});

$('bKeys').onclick = () => { buildKeyRows(); $('keyMsg').textContent = ''; $('dKeys').showModal(); };
$('keysClose').onclick = () => $('dKeys').close();
$('keysReset').onclick = () => {
  KEYS = {...DEFAULT_KEYS}; saveKeys(); buildKeyRows(); refreshKeyCaps();
  $('keyMsg').textContent = 'Defaults restored.';
};

/* Keyboard — ignored while a dialog or text field has focus */
document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]')) return;
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  const k = e.key === ' ' ? ' ' : e.key.toLowerCase();
  for (const [id, bound] of Object.entries(KEYS)) {
    if (bound && bound === k && HANDLERS[id]) {
      e.preventDefault(); HANDLERS[id](); return;
    }
  }
  const map = {
    k: () => mark(true), d: () => mark(false),
    ' ': () => { const f = curFile(); if (f) { S.state.set(f.path, !S.state.get(f.path)); show(); } },
    arrowright: nextImage, arrowleft: prevImage,
    '.': () => stepFolder(1), ',': () => stepFolder(-1),
    n: () => $('bNote').click(), f: toggleFlag,
    i: () => { if (C3.grid) $('isoMore').click(); },
    '[': () => rotate(-1), ']': () => rotate(1),
    h: () => flip('h'), v: () => flip('v'),
    r: () => $('rotReset').click(),
    f11: () => toggleFullscreen(),
    '=': () => $('zIn').click(), '+': () => $('zIn').click(),
    '-': () => $('zOut').click(), '0': () => $('zFit').click(),
  };
  if (e.key === 'Escape' && document.fullscreenElement) return;  // browser handles
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

/* Final wiring. KEYS and ACTIONS are const bindings declared above this
 * point; calling into them any earlier hits the temporal dead zone and the
 * ReferenceError aborts the rest of the script. */
// Guarded: a failure in any one of these should not leave the page dead.
for (const step of [refreshKeyCaps, refreshNavModeBtn, refreshAutoBtn,
                    layoutOverlays, loadLocks]) {
  try { step(); } catch (err) { console.error('init step failed:', err); }
}
