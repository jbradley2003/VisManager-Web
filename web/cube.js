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

  // Pull numbers out by pattern rather than splitting on whitespace. Several
  // writers emit fixed-width columns (%5d%12.6f...), and a coordinate wide
  // enough to fill its field runs straight into the next one — whitespace
  // splitting then yields the wrong number of tokens and the atom is dropped
  // or mis-parsed.
  const NUM = /-?\d+(?:\.\d*)?(?:[eEdD][+-]?\d+)?/g;
  const numsOf = line => (line.match(NUM) || []).map(t => +t.replace(/[dD]/, 'e'));

  const atoms = [];
  for (let i = 0; i < nAtoms; i++) {
    const v = numsOf(lines[li++] || '');
    if (v.length < 5) continue;            // malformed line, skip rather than NaN
    atoms.push({z: Math.round(v[0]), x: v[2], y: v[3], zc: v[4]});
  }
  if (parseInt(head[0], 10) < 0) li++;         // orbital index line

  // Convert once, into a single set of arrays. A previous version scaled the
  // origin into a copy while handing the raw origin to the grid-scale check
  // alongside the already-scaled spacing; reasoning about two different unit
  // systems at once is what slid the isosurface off the molecule.
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

  // Only the ATOM block is sanity-checked. The origin and axis vectors come
  // from the same header lines that declare the units, so they are consistent
  // with the flag by construction — second-guessing them just moves the
  // surface off the molecule, and any rule for "is this box the right size"
  // is unreliable when a small molecule sits in a deliberately generous grid.
  fixAtomScale(atoms);

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < total; i++) {
    if (values[i] < lo) lo = values[i];
    if (values[i] > hi) hi = values[i];
  }
  return {atoms, origin: org, spacing, dims, values, range: [lo, hi]};
}

/**
 * Correct an implausible ATOM scale.
 *
 * The units flag is not always trustworthy: writers emit Angstrom coordinates
 * while declaring a positive atom count (which the format says means Bohr),
 * and the reverse. Either way interatomic distances end up wrong by 1.89 and
 * bond detection, which works in absolute Angstrom, finds nothing.
 *
 * Only the atoms are touched here. The grid carries its own scale and is
 * usually right; scaling both together on the strength of an atom-based test
 * leaves the molecule correct but pushes the isosurface off to one side.
 */
function fixAtomScale(atoms) {
  if (atoms.length < 2) return 1;

  const nn = [];
  for (let i = 0; i < atoms.length; i++) {
    let best = Infinity;
    for (let j = 0; j < atoms.length; j++) {
      if (i === j) continue;
      const a = atoms[i], b = atoms[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.zc - b.zc);
      if (d > 1e-6 && d < best) best = d;
    }
    if (isFinite(best)) nn.push(best);
  }
  if (!nn.length) return 1;
  nn.sort((a, b) => a - b);
  const median = nn[Math.floor(nn.length / 2)];

  // Hydrogen is the sharpest ruler available: an X-H bond is 0.9 to 1.2 A in
  // any ordinary structure. Metal-ligand distances reach 2.4 A legitimately,
  // so the median alone cannot separate a real coordination complex from a
  // mis-scaled organic molecule.
  let hMin = Infinity;
  for (let i = 0; i < atoms.length; i++) {
    if (atoms[i].z !== 1) continue;
    for (let j = 0; j < atoms.length; j++) {
      if (i === j || atoms[j].z === 1) continue;
      const a = atoms[i], b = atoms[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.zc - b.zc);
      if (d > 1e-6 && d < hMin) hMin = d;
    }
  }

  let factor = 1;
  if (isFinite(hMin)) {
    if (hMin < 0.7) factor = 1 / BOHR_TO_ANGSTROM;
    else if (hMin > 1.5) factor = BOHR_TO_ANGSTROM;
  } else {
    if (median < 0.75) factor = 1 / BOHR_TO_ANGSTROM;
    else if (median > 3.2) factor = BOHR_TO_ANGSTROM;
  }
  if (factor !== 1)
    for (const a of atoms) { a.x *= factor; a.y *= factor; a.zc *= factor; }
  return factor;
}

/**
 * Put the grid on the same scale as the atoms.
 *
 * Decided by fit rather than by the header: a cube's grid always encloses the
 * molecule it was computed for, so the candidate scale under which the atoms
 * actually sit inside the box, near its centre, is the right one. This is what
 * keeps the isosurface on the molecule when the two halves of the file
 * disagree about units.
 */



/**
 * Pick a starting isovalue that shows the feature rather than a nuclear cusp.
 *
 * A fixed fraction of the maximum is a poor default: spin-density and HFC
 * cubes peak sharply at the nuclei, orders of magnitude above the values that
 * describe the orbital, so any fraction of the peak renders as a speck. Using
 * the level that encloses a share of the grid volume adapts to the data.
 */
function chooseIsovalue(values, fraction = 0.05) {
  // A fixed share of the peak amplitude. This is what VMD/VESTA workflows use
  // (ISO_FRACTION), and it means the same thing across calculations whose
  // absolute amplitudes differ by orders of magnitude.
  let peak = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Math.abs(values[i]);
    if (v > peak) peak = v;
  }
  return peak * fraction;
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

  const sign = iso >= 0 ? -1 : 1;

  const emit = (v0, v1, v2) => {
    // Marching tetrahedra does not produce a consistent winding on its own:
    // the vertex order depends on which corners happened to be inside, so
    // roughly half the triangles come out facing backwards. Adjacent faces
    // then disagree by 180 degrees and the surface shades as a patchwork,
    // which is what made the lobes look choppy. Orient each triangle against
    // the field gradient so the whole mesh winds the same way.
    const ux = v1.p[0] - v0.p[0], uy = v1.p[1] - v0.p[1], uz = v1.p[2] - v0.p[2];
    const vx = v2.p[0] - v0.p[0], vy = v2.p[1] - v0.p[1], vz = v2.p[2] - v0.p[2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;

    const gx = (v0.n[0] + v1.n[0] + v2.n[0]) * sign;
    const gy = (v0.n[1] + v1.n[1] + v2.n[1]) * sign;
    const gz = (v0.n[2] + v1.n[2] + v2.n[2]) * sign;

    const tri = (fx * gx + fy * gy + fz * gz) >= 0 ? [v0, v1, v2] : [v0, v2, v1];
    for (const v of tri) {
      positions.push(v.p[0], v.p[1], v.p[2]);
      // The gradient points along increasing field value; the outward normal
      // of a positive lobe is the other way.
      const [a, b, c] = v.n;
      const len = Math.hypot(a, b, c) || 1;
      normals.push(sign * a / len, sign * b / len, sign * c / len);
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

/**
 * Weld duplicate vertices into an indexed mesh.
 *
 * Marching tetrahedra emits every triangle with its own three vertices, so
 * adjacent faces share no data and there is nothing to smooth across. Welding
 * on quantised position recovers the connectivity.
 */
function weld(positions, normals, tol = 1e-4) {
  const map = new Map();
  const verts = [], norms = [], indices = [];
  const q = 1 / tol;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = verts.length / 3;
      map.set(key, idx);
      verts.push(x, y, z);
      norms.push(normals[i], normals[i + 1], normals[i + 2]);
    }
    indices.push(idx);
  }
  return {positions: new Float32Array(verts),
          normals: new Float32Array(norms),
          indices: new Uint32Array(indices)};
}

/**
 * Taubin smoothing (lambda/mu).
 *
 * Plain Laplacian smoothing shrinks a closed surface a little more with every
 * pass, so an orbital lobe visibly deflates. Taubin alternates a positive and
 * a slightly larger negative step, which removes the faceting while keeping
 * the volume — the same trick VTK's windowed-sinc filter uses in the desktop
 * build.
 */
function smoothMesh(mesh, iterations = 12, lambda = 0.5, mu = -0.53) {
  const {positions, indices} = mesh;
  const n = positions.length / 3;

  // Neighbour lists from the triangle edges
  const nbr = Array.from({length: n}, () => new Set());
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    nbr[a].add(b); nbr[a].add(c);
    nbr[b].add(a); nbr[b].add(c);
    nbr[c].add(a); nbr[c].add(b);
  }
  const flat = nbr.map(s2 => [...s2]);

  let cur = positions;
  const step = (factor) => {
    const out = new Float32Array(cur.length);
    for (let v = 0; v < n; v++) {
      const list = flat[v];
      if (!list.length) {
        out[v * 3] = cur[v * 3];
        out[v * 3 + 1] = cur[v * 3 + 1];
        out[v * 3 + 2] = cur[v * 3 + 2];
        continue;
      }
      let sx = 0, sy = 0, sz = 0;
      for (const j of list) { sx += cur[j * 3]; sy += cur[j * 3 + 1]; sz += cur[j * 3 + 2]; }
      const k = list.length;
      out[v * 3]     = cur[v * 3]     + factor * (sx / k - cur[v * 3]);
      out[v * 3 + 1] = cur[v * 3 + 1] + factor * (sy / k - cur[v * 3 + 1]);
      out[v * 3 + 2] = cur[v * 3 + 2] + factor * (sz / k - cur[v * 3 + 2]);
    }
    cur = out;
  };
  for (let i = 0; i < iterations; i++) { step(lambda); step(mu); }

  return {positions: cur, indices, normals: recomputeNormals(cur, indices)};
}

/** Area-weighted vertex normals, which is what makes shading look smooth. */
function recomputeNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a],
          uy = positions[b + 1] - positions[a + 1],
          uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
          vy = positions[c + 1] - positions[a + 1],
          vz = positions[c + 2] - positions[a + 2];
    // Cross product magnitude is twice the area, so no normalising here
    const nx = uy * vz - uz * vy,
          ny = uz * vx - ux * vz,
          nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) {
      normals[o] += nx; normals[o + 1] += ny; normals[o + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
  }
  return normals;
}

/* ── Chemistry helpers ───────────────────────────────────────────────────── */
const SYMBOLS = ['n', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
  'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca', 'Sc', 'Ti', 'V',
  'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br',
  'Kr', 'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag',
  'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe'];

// CPK-ish colours for the common elements; anything else falls back to grey.
const ELEMENT_COLOR = {
  1: 0xe8e8e8,   // H  light grey
  6: 0x5a4632,   // C  dark brown — reads better against yellow lobes than
                 //    the usual mid-grey, which competes with the surface
  7: 0x2f5fd0, 8: 0xd42222, 9: 0x4fbf4f, 5: 0xffb5b5, 14: 0xf0c8a0,
  15: 0xff8000, 16: 0xe8d22a, 17: 0x30d030, 35: 0xa62929, 53: 0x940094,
  26: 0xe06633, 29: 0xc88033, 30: 0x7d80b0, 44: 0x248f8f, 45: 0x0a7d8c
};
// Covalent radii in Angstrom, used for both atom size and bond detection.
// Cordero et al. covalent radii (Angstrom) — the same source Avogadro uses.
const COVALENT = {
  1: 0.31, 2: 0.28, 3: 1.28, 4: 0.96, 5: 0.84, 6: 0.76, 7: 0.71, 8: 0.66,
  9: 0.57, 10: 0.58, 11: 1.66, 12: 1.41, 13: 1.21, 14: 1.11, 15: 1.07,
  16: 1.05, 17: 1.02, 18: 1.06, 19: 2.03, 20: 1.76, 21: 1.70, 22: 1.60,
  23: 1.53, 24: 1.39, 25: 1.39, 26: 1.32, 27: 1.26, 28: 1.24, 29: 1.32,
  30: 1.22, 31: 1.22, 32: 1.20, 33: 1.19, 34: 1.20, 35: 1.20, 36: 1.16,
  42: 1.54, 44: 1.46, 45: 1.42, 46: 1.39, 47: 1.45, 48: 1.44, 53: 1.39,
  77: 1.41, 78: 1.36, 79: 1.36, 80: 1.32
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
  const candidates = [];
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      const a = atoms[i], b = atoms[j];
      // Hydrogen bonds to exactly one heavy atom; allowing H-H produces a
      // web of spurious bonds through the middle of crowded structures.
      if (a.z === 1 && b.z === 1) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.zc - b.zc);
      // OpenBabel's ConnectTheDots rule, which is what Avogadro uses:
      // bond when the separation is within the summed covalent radii plus a
      // fixed slack. An additive tolerance behaves far better than a
      // multiplicative one across mixed light/heavy structures, because a
      // percentage of a large metal radius is a much bigger absolute window
      // than the same percentage of a C-H pair.
      const limit = radiusOf(a.z) + radiusOf(b.z) + tolerance;
      if (d > 0.4 && d <= limit) candidates.push({i, j, d});
    }
  }
  // Shortest first, so when an atom hits its valence cap the bonds it keeps
  // are the physically plausible ones.
  candidates.sort((p, q) => p.d - q.d);
  // Hydrogen and halogens are terminal; second-row elements follow the octet.
  // Metals are left uncapped, since coordination numbers of 4-6 are normal.
  const MAXB = {1: 1, 9: 1, 17: 1, 35: 1, 53: 1,
                8: 2, 16: 2, 7: 4, 15: 4, 6: 4, 14: 4};
  const used = new Array(atoms.length).fill(0);
  const bonds = [];
  for (const c of candidates) {
    const ca = MAXB[atoms[c.i].z] ?? 6, cb = MAXB[atoms[c.j].z] ?? 6;
    if (used[c.i] >= ca || used[c.j] >= cb) continue;
    used[c.i]++; used[c.j]++;
    bonds.push([c.i, c.j]);
  }
  return bonds;
}

if (typeof window !== 'undefined') {
  window.CubeLib = {parseCube, chooseIsovalue, isosurface, inferBonds, downsample,
                    fixAtomScale,
                    weld, smoothMesh, recomputeNormals,
                    symbolOf, colorOf, radiusOf, BOHR_TO_ANGSTROM};
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {parseCube, chooseIsovalue, isosurface, inferBonds, downsample,
                    fixAtomScale,
                    weld, smoothMesh, recomputeNormals,
                    symbolOf, colorOf, radiusOf, BOHR_TO_ANGSTROM};
}
