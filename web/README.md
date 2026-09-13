# VisManager Web

A browser build of the reviewer that works on **copies**. Files are read from
the folder you pick and never written back, so it needs no special permissions
and runs in any modern browser — no server, no install.

## Hosting it free

Push this repo to GitHub, then **Settings → Pages → Source: GitHub Actions**.
`.github/workflows/deploy-web.yml` publishes the `web/` folder on every push to
`main`. The site appears at `https://<user>.github.io/<repo>/`.

To try it locally first:

```bash
cd web && python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly with `file://` will not work — the CDN scripts
and object URLs need a real origin.

## What it does

Pick or drag a folder, review with the same shortcuts as the desktop app, then
export:

| Output | Contents |
|---|---|
| `kept-files.zip` | every file you kept, original folder structure preserved |
| `kept-images.pdf` | the kept raster images as one PDF |
| `<folder>.pdf` | optionally, one PDF per folder |
| `vismanager-notes.txt` | flagged files and their notes, grouped by folder |
| `delete-list.txt` | the paths you marked for deletion, with commands to act on them |

Nothing on your disk changes. If you want to prune the originals, run the
delete list yourself — it ships with the exact command for macOS, Linux and
PowerShell.

## Shortcuts

`K` keep · `D` delete · `Space` toggle · `N` note · `F` flag ·
`←` `→` images · `,` `.` folders · `[` `]` rotate · `H` `V` flip ·
`=` `-` zoom · `0` fit · `I` 3D settings · `F11` fullscreen

All of these are **rebindable** — click the keyboard button in the toolbar.
Custom bindings are stored in the browser.

## Format support

PNG, JPEG, GIF, WebP, BMP and ICO render natively. PDF previews through
pdf.js. TGA is decoded in-page by a small built-in decoder (uncompressed and
RLE truecolour, plus greyscale). TIFF and DDS are listed and markable but not previewed.

**Cube files render in 3D** with a full control panel — isovalue, opacity,
lobe colours, per-element atom colours, structure scale, hydrogen and bond
toggles, background presets, and Front/Side/Top view buttons. Press `I` or
**Settings…**, and `F11` for fullscreen (the controls stay on screen, because
fullscreen is requested on the view area rather than the document).

The isovalue slider is **logarithmic** and reads as a percentage of the peak.
Cube amplitudes span orders of magnitude, so a linear slider spends most of
its travel where nothing changes; the log mapping gives even resolution from
0.05% to 90% of the peak and means the same thing across files with completely
different amplitudes.

Camera framing comes from the bounding sphere of molecule plus isosurface, so
the subject fills the view instead of floating in empty space.

**Cube files render in 3D.** Isosurfaces are extracted in-page and drawn with
three.js, with a ball-and-stick molecule alongside. Drag to orbit, scroll to
zoom, and use the isosurface bar to change the level.

Surface quality comes from three steps: consistent triangle winding (without
it roughly half the faces point backwards and the surface shades as a
patchwork — mean angle between neighbouring faces was 68 degrees, now 3),
vertex welding (83% fewer vertices to upload), and optional Taubin smoothing,
which removes faceting without the shrinkage plain Laplacian smoothing causes.

Bond detection follows OpenBabel's `ConnectTheDots`, which is what Avogadro
uses: bond when the separation is within the summed Cordero covalent radii
plus a slack of 0.45 A, then prune by valence. The slack is adjustable in the
settings panel. An additive tolerance behaves far better than a multiplicative
one on mixed organic/metal structures.

Two implementation notes. The surface uses marching *tetrahedra* rather than
marching cubes: it needs no 256-entry lookup table, so there is nothing to
mistype, and it is watertight. Validated against an analytic sphere — vertices
land within 0.01 A of the true radius and the triangulated area comes to 99.5%
of the exact value.

Large grids are strided down before extraction. Production cubes are often
300 cubed (27 million points), which would take tens of seconds in JavaScript;
at 1/4 resolution a full orbital extracts in about 0.75 s with no visible loss
in the isosurface, and the physical extent is unchanged.

## Memory

`File` objects stay backed by the file on disk, so loading several hundred
files costs almost nothing; only the image currently on screen is decoded.
The ZIP export is the one memory-hungry step, since it assembles the archive
in memory before download.
