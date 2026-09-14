const {JSDOM} = require('jsdom');
const fs = require('fs');
const path = require('path').join(__dirname, '..') + '/';

const html = fs.readFileSync(path + 'index.html', 'utf8');
const errors = [];

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'https://example.github.io/VisManager-Web/',
});
const w = dom.window;
w.addEventListener('error', e => errors.push('window error: ' + e.message));

// Stub the browser APIs jsdom lacks, so we surface OUR errors not theirs
w.URL.createObjectURL = () => 'blob:stub';
w.URL.revokeObjectURL = () => {};
w.HTMLCanvasElement.prototype.getContext = () => null;
w.matchMedia = () => ({matches: false, addListener(){}, removeListener(){}});

for (const file of ['icons.js', 'cube.js', 'app.js']) {
  try {
    w.eval(fs.readFileSync(path + file, 'utf8'));
    console.log(`  ${file.padEnd(10)} loaded OK`);
  } catch (err) {
    console.log(`  ${file.padEnd(10)} THREW: ${err.name}: ${err.message}`);
    const line = (err.stack || '').split('\n').find(l => l.includes('evalmachine'));
    if (line) console.log(`             at ${line.trim()}`);
    errors.push(file + ': ' + err.message);
  }
}
console.log();
console.log('runtime errors:', errors.length ? errors : 'none');

// Did the handlers actually get attached?
const d = w.document;
const checks = ['bOpen', 'bKeep', 'bDel', 'bNote', 'bFlag', 'bExport', 'bKeys',
                'rotL', 'zIn', 'picker'];
console.log();
console.log('handlers attached:');
for (const id of checks) {
  const el = d.getElementById(id);
  const has = el && (el.onclick || el.onchange);
  console.log(`  ${id.padEnd(9)} ${el ? (has ? 'yes' : 'NO HANDLER') : 'ELEMENT MISSING'}`);
}
const imgs = d.querySelectorAll('button img');
console.log();
console.log('icons injected into buttons:', imgs.length);

// A button with neither an icon nor text renders as a blank pill — easy to
// ship, since nothing throws.
const blank = [...d.querySelectorAll('button')]
  .filter(b => !b.querySelector('img') && !b.textContent.trim())
  .map(b => b.id || '(unnamed)');
console.log('blank buttons:', blank.length ? blank : 'none');
if (blank.length) errors.push('blank buttons: ' + blank.join(', '));

// The stage must have real layout height, or the fit calculation divides by
// zero and the image renders a few pixels wide.
const stageStyled = /#stagebox\{[^}]*position:absolute/.test(html);
console.log('stage positioned in CSS:', stageStyled);
if (!stageStyled) errors.push('#stagebox has no CSS rule');

process.exit(errors.length ? 1 : 0);
