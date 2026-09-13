/* Gaussian cube parsing and isosurface extraction, in the browser.
 *
 * The surface uses marching TETRAHEDRA rather than marching cubes. Marching
 * cubes needs a 256-entry triangle table — about a thousand lines of literal
 * data that is easy to mistype and impossible to review. Splitting each voxel
 * into six tetrahedra reduces the problem to 16 trivial cases with no lookup
 * table at all, and the result is watertight. It produces roughly twice the
 * triangles, which costs nothing here because the grids are small and the GPU
 * does the drawing.
 */
'use strict';

const BOHR_TO_ANGSTROM = 0.529177210903;

/* ── Parsing ─────────────────────────────────────────────────────────────── */
/**
 * Parse a Gaussian cube file.
 *
 * The units flag matters and is easy to miss: a NEGATIVE atom count means the
 * file is already in Angstrom, positive means Bohr. Ignoring it puts the atoms
 * at 1.89x their real separation, which breaks bond detection and makes the
 * molecule float outside its own isosurface.
 */
function parseCube(text) {
  const lines = text.split('\n');
  let li = 2;                                  // two comment lines first

  const head = lines[li++].trim().split(/\s+/);
  let nAtoms = parseInt(head[0], 10);
  const origin = [+head[1], +head[2], +head[3]];
  let angstrom = nAtoms < 0;
  nAtoms = Math.abs(nAtoms);

  const dims = [], axes = [];
  for (let i = 0; i < 3; i++) {
    const row = lines[li++].trim().split(/\s+/);
    let n = parseInt(row[0], 10);
    if (n < 0) { angstrom = true; n = Math.abs(n); }
    dims.push(n);
    axes.push([+row[1], +row[2], +row[3]]);
  }

  const atoms = [];
  for (let i = 0; i < nAtoms; i++) {
    const row = lines[li++].trim().split(/\s+/);
    atoms.push({z: parseInt(row[0], 10), x: +row[2], y: +row[3], zc: +row[4]});
  }
  if (parseInt(head[0], 10) < 0) li++;         // orbital index line

  const scale = angstrom ? 1 : BOHR_TO_ANGSTROM;
  const spacing = axes.map(a => Math.hypot(a[0], a[1], a[2]) * scale);
  const org = origin.map(v => v * scale);
  for (const a of atoms) { a.x *= scale; a.y *= scale; a.zc *= scale; }

  const total = dims[0] * dims[1] * dims[2];
  const values = new Float32Array(total);
  let vi = 0;
  for (; li < lines.length && vi < total; li++) {
    const line = lines[li];
    if (!line) continue;
    // Split on whitespace; cube files wrap six values per line but tools vary
    for (const tok of line.split(/\s+/)) {
      if (!tok) continue;
      values[vi++] = +tok;
      if (vi >= total) break;
    }
  }

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < total; i++) {
    if (values[i] < lo) lo = values[i];
    if (values[i] > hi) hi = values[i];
  }
  return {atoms, origin: org, spacing, dims, values, range: [lo, hi]};
}

/**
 * Pick a starting isovalue that shows the feature rather than a nuclear cusp.
 *
 * A fixed fraction of the maximum is a poor default: spin-density and HFC
 * cubes peak sharply at the nuclei, orders of magnitude above the values that
 * describe the orbital, so any fraction of the peak renders as a speck. Using
 * the level that encloses a share of the grid volume adapts to the data.
 */
function chooseIsovalue(values, volumeFraction = 0.12) {
  const mag = [];
  for (let i = 0; i < values.length; i++) {
    const v = Math.abs(values[i]);
    if (v > 0) mag.push(v);
  }
  if (!mag.length) return 0;
  mag.sort((a, b) => a - b);
  const idx = Math.floor((1 - volumeFraction) * (mag.length - 1));
  const q = mag[idx], peak = mag[mag.length - 1];
  return Math.max(Math.min(q, peak * 0.5), peak * 1e-4);
}

/**
 * Reduce a large grid by striding.
 *
 * Production cubes are often 300^3 — 27 million points. Extracting a surface
 * from that in JavaScript takes tens of seconds and produces millions of
 * triangles, which is neither interactive nor necessary: the isosurface of a
 * smooth orbital is well described by a much coarser sampling. Striding keeps
 * the physical extent identical and only reduces detail.
 */
function downsample(grid, maxDim = 96) {
  const {dims, values, origin, spacing} = grid;
  const stride = Math.max(1, Math.ceil(Math.max(...dims) / maxDim));
  if (stride === 1) return grid;

  const nd = dims.map(d => Math.floor((d - 1) / stride) + 1);
  const out = new Float32Array(nd[0] * nd[1] * nd[2]);
  const [nx, ny, nz] = dims;
  let k = 0;
  for (let x = 0; x < nd[0]; x++)
    for (let y = 0; y < nd[1]; y++)
      for (let z = 0; z < nd[2]; z++)
        out[k++] = values[((x * stride) * ny + y * stride) * nz + z * stride];

  return {
    ...grid,
    dims: nd,
    values: out,
    spacing: spacing.map(s => s * stride),
    reducedBy: stride
  };
}

/* ── Isosurface ──────────────────────────────────────────────────────────── */
// Six tetrahedra covering the unit cube, given as indices into the 8 corners.
const TETS = [
  [0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6],
  [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]
];
// Corner offsets, ordered so the tetrahedra above tile the cube exactly.
const CORNER = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]
];

/**
 * Extract the surface at `iso` and return interleaved positions and normals.
 *
 * Normals come from the central-difference gradient of the field, which gives
 * smooth shading without a separate smoothing pass.
 */
function isosurface(grid, iso) {
  const {dims, values, origin, spacing} = grid;
  const [nx, ny, nz] = dims;
  const at = (x, y, z) => values[(x * ny + y) * nz + z];

  const positions = [], normals = [];

  // Central-difference gradient, clamped at the boundary
  const grad = (x, y, z) => {
    const cx = Math.min(Math.max(x, 1), nx - 2);
    const cy = Math.min(Math.max(y, 1), ny - 2);
    const cz = Math.min(Math.max(z, 1), nz - 2);
    return [
      (at(cx + 1, cy, cz) - at(cx - 1, cy, cz)) / (2 * spacing[0]),
      (at(cx, cy + 1, cz) - at(cx, cy - 1, cz)) / (2 * spacing[1]),
      (at(cx, cy, cz + 1) - at(cx, cy, cz - 1)) / (2 * spacing[2])
    ];
  };

  const world = (x, y, z) => [
    origin[0] + x * spacing[0],
    origin[1] + y * spacing[1],
    origin[2] + z * spacing[2]
  ];

  // Interpolate along an edge to where the field crosses `iso`
  const lerp = (a, b) => {
    const d = b.v - a.v;
    const t = Math.abs(d) < 1e-12 ? 0.5 : (iso - a.v) / d;
    const p = [a.p[0] + (b.p[0] - a.p[0]) * t,
               a.p[1] + (b.p[1] - a.p[1]) * t,
               a.p[2] + (b.p[2] - a.p[2]) * t];
    const n = [a.n[0] + (b.n[0] - a.n[0]) * t,
               a.n[1] + (b.n[1] - a.n[1]) * t,
               a.n[2] + (b.n[2] - a.n[2]) * t];
    return {p, n};
  };

  const emit = (v0, v1, v2) => {
    for (const v of [v0, v1, v2]) {
      positions.push(v.p[0], v.p[1], v.p[2]);
      // The gradient points along increasing field value; the outward normal
      // of a positive lobe is the other way.
      let [a, b, c] = v.n;
      const len = Math.hypot(a, b, c) || 1;
      const s = iso >= 0 ? -1 : 1;
      normals.push(s * a / len, s * b / len, s * c / len);
    }
  };

  const corners = new Array(8);
  for (let x = 0; x < nx - 1; x++) {
    for (let y = 0; y < ny - 1; y++) {
      for (let z = 0; z < nz - 1; z++) {
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = CORNER[c];
          const cx = x + dx, cy = y + dy, cz = z + dz;
          corners[c] = {v: at(cx, cy, cz), p: world(cx, cy, cz),
                        n: grad(cx, cy, cz)};
        }
        for (const tet of TETS) {
          const t = [corners[tet[0]], corners[tet[1]],
                     corners[tet[2]], corners[tet[3]]];
          // Classify the four vertices against the isolevel
          let mask = 0;
          for (let i = 0; i < 4; i++) if (t[i].v >= iso) mask |= 1 << i;
          if (mask === 0 || mask === 15) continue;    // wholly in or out

          // Which vertices are inside determines the crossing edges. There are
          // only two shapes: a single triangle, or a quad split into two.
          const inside = [], outside = [];
          for (let i = 0; i < 4; i++) (mask & (1 << i) ? inside : outside).push(i);

          if (inside.length === 1 || outside.length === 1) {
            const apex = inside.length === 1 ? inside[0] : outside[0];
            const others = [0, 1, 2, 3].filter(i => i !== apex);
            emit(lerp(t[apex], t[others[0]]),
                 lerp(t[apex], t[others[1]]),
                 lerp(t[apex], t[others[2]]));
          } else {
            // Two in, two out: a quad across four crossing edges
            const [a, b] = inside, [c, d] = outside;
            const p1 = lerp(t[a], t[c]), p2 = lerp(t[a], t[d]);
            const p3 = lerp(t[b], t[d]), p4 = lerp(t[b], t[c]);
            emit(p1, p2, p3);
            emit(p1, p3, p4);
          }
        }
      }
    }
  }
  return {positions: new Float32Array(positions),
          normals: new Float32Array(normals)};
}

/* ── Chemistry helpers ───────────────────────────────────────────────────── */
const SYMBOLS = ['n', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
  'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca', 'Sc', 'Ti', 'V',
  'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br',
  'Kr', 'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag',
  'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe'];

// CPK-ish colours for the common elements; anything else falls back to grey.
const ELEMENT_COLOR = {
  1: 0xffffff, 6: 0x909090, 7: 0x3050f8, 8: 0xff0d0d, 9: 0x90e050,
  15: 0xff8000, 16: 0xffff30, 17: 0x1ff01f, 35: 0xa62929, 53: 0x940094,
  5: 0xffb5b5, 14: 0xf0c8a0, 26: 0xe06633, 29: 0xc88033, 30: 0x7d80b0
};
// Covalent radii in Angstrom, used for both atom size and bond detection.
const COVALENT = {
  1: 0.31, 5: 0.84, 6: 0.76, 7: 0.71, 8: 0.66, 9: 0.57, 14: 1.11, 15: 1.07,
  16: 1.05, 17: 1.02, 26: 1.32, 29: 1.32, 30: 1.22, 35: 1.20, 53: 1.39
};

const symbolOf = z => SYMBOLS[z] || `Z${z}`;
const colorOf = z => ELEMENT_COLOR[z] ?? 0xb0b0b0;
const radiusOf = z => COVALENT[z] ?? 0.9;

/**
 * Infer bonds from interatomic distance.
 *
 * Cube files record positions but no connectivity, so bonds have to be
 * guessed. The usual rule — within 45% of the summed covalent radii — is what
 * VMD and VESTA effectively use.
 */
function inferBonds(atoms, tolerance = 0.45) {
  const bonds = [];
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      const a = atoms[i], b = atoms[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.zc - b.zc);
      const limit = (radiusOf(a.z) + radiusOf(b.z)) * (1 + tolerance);
      if (d > 0.1 && d <= limit) bonds.push([i, j]);
    }
  }
  return bonds;
}

if (typeof window !== 'undefined') {
  window.CubeLib = {parseCube, chooseIsovalue, isosurface, inferBonds, downsample,
                    symbolOf, colorOf, radiusOf, BOHR_TO_ANGSTROM};
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {parseCube, chooseIsovalue, isosurface, inferBonds, downsample,
                    symbolOf, colorOf, radiusOf, BOHR_TO_ANGSTROM};
}
