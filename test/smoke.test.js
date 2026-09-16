const {JSDOM} = require('jsdom');
const fs = require('fs');
const P = require('path').join(__dirname, '..') + '/';

const dom = new JSDOM(fs.readFileSync(P + 'index.html', 'utf8'), {
  runScripts: 'outside-only', pretendToBeVisual: true,
  url: 'https://example.github.io/VisManager-Web/',
});
const w = dom.window, d = w.document;
const problems = [];
w.addEventListener('error', e => problems.push('window error: ' + e.message));
w.URL.createObjectURL = () => 'blob:stub';
w.URL.revokeObjectURL = () => {};
w.HTMLCanvasElement.prototype.getContext = () => null;
w.confirm = () => true;
w.alert = m => problems.push('alert: ' + m);

// One eval so the three files share a scope, plus an export line so the test
// can reach the internals (top-level const does not become a window property).
const bundle = ['icons.js', 'cube.js', 'app.js']
  .map(f => fs.readFileSync(P + f, 'utf8')).join('\n;\n') +
  `\n;window.__api = {S, ingest, mark, toggleFlag, nextImage, stepFolder,
       removeFile, removeFolder, notesReport, deleteList, KEYS};`;
try { w.eval(bundle); }
catch (e) { problems.push('bundle: ' + e.message); }
const api = w.__api || {};

// Feed it a synthetic folder the way the file picker would
function fakeFile(relPath, bytes = 64) {
  const f = new w.File([new Uint8Array(bytes)], relPath.split('/').pop());
  Object.defineProperty(f, 'webkitRelativePath', {value: relPath});
  return f;
}
const files = [
  fakeFile('SPIN/a/one.png'), fakeFile('SPIN/a/two.tga'),
  fakeFile('SPIN/b/three.pdf'), fakeFile('SPIN/b/four.cube'),
  fakeFile('SPIN/b/notes.txt'),        // unsupported, must be ignored
];
try { api.ingest(files); } catch (e) { problems.push('ingest: ' + e.message); }

const S = api.S;
console.log('=== Ingest ===');
console.log('  files accepted :', S.files.length, '(expect 4, .txt ignored)');
console.log('  folders        :', S.folders.length, '(expect 2)');
console.log('  all marked keep:', [...S.state.values()].every(Boolean));
console.log('  sidebar rows   :', d.getElementById('tree').children.length);
console.log('  type chips     :', d.getElementById('chips').children.length);

console.log('\n=== Marking ===');
api.mark(false);
console.log('  after DELETE, kept :', [...S.state.values()].filter(Boolean).length, 'of 4');
api.toggleFlag();
console.log('  flagged            :', S.notes.size);
console.log('  stats keep label   :', d.getElementById('sKeep').textContent);
console.log('  stats del label    :', d.getElementById('sDel').textContent);

console.log('\n=== Navigation ===');
const before = S.ii + ':' + S.fi;
api.nextImage(); api.nextImage();
console.log(`  moved ${before} -> ${S.ii}:${S.fi}`);
api.stepFolder(1);
console.log('  folder step ok     :', S.fi === 0 || S.fi === 1);

console.log('\n=== Removal ===');
api.removeFile(S.files[0].path);
console.log('  after removeFile   :', S.files.length, '(expect 3)');
api.removeFolder('SPIN/b');
console.log('  after removeFolder :', S.files.length, '(expect 1)');

console.log('\n=== Reports ===');
const notes = api.notesReport();
const del = api.deleteList();
console.log('  notes report lines :', notes.split('\n').length);
console.log('  delete list has header:', del.startsWith('#'));

console.log('\n=== Shortcuts ===');
const KEYS = api.KEYS;
console.log('  bindings loaded    :', Object.keys(KEYS).length);
const dup = Object.values(KEYS).filter(Boolean);
console.log('  no duplicate keys  :', new Set(dup).size === dup.length);

console.log('\nproblems:', problems.length ? problems : 'none');
process.exit(problems.length ? 1 : 0);
