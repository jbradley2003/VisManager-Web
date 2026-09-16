/**
 * Structural checks on the source itself.
 *
 * Several bugs in this project were not logic errors but drift: a handler
 * bound to a function that had been removed, an element referenced after its
 * markup changed, two copies of the same helper diverging. Those never throw
 * until the moment a user clicks the thing, so they are checked here.
 */
const fs = require('fs');
const path = require('path').join(__dirname, '..') + '/';
const problems = [];

const app = fs.readFileSync(path + 'app.js', 'utf8');
const cube = fs.readFileSync(path + 'cube.js', 'utf8');
const icons = fs.readFileSync(path + 'icons.js', 'utf8');
const html = fs.readFileSync(path + 'index.html', 'utf8');
const js = app + '\n' + cube + '\n' + icons;
const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const markup = html.slice(html.indexOf('</style>'));

// 1. Every $('id') must exist in the markup
const htmlIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map(m => m[1]));
const referenced = [...new Set([...app.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]))];
const missing = referenced.filter(id => !htmlIds.has(id));
console.log('ids referenced in JS   :', referenced.length,
            '| missing from HTML:', missing.length ? missing : 'none');
if (missing.length) problems.push('missing ids: ' + missing.join(', '));

// 2. No duplicate top-level declarations
const decl = new Map();
app.split('\n').forEach((l, i) => {
  const m = l.match(/^(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/);
  if (m) { if (!decl.has(m[1])) decl.set(m[1], []); decl.get(m[1]).push(i + 1); }
});
const dupDecl = [...decl].filter(([, v]) => v.length > 1);
console.log('duplicate declarations :', dupDecl.length ? dupDecl.map(d => d[0]) : 'none');
if (dupDecl.length) problems.push('duplicate declarations: ' + dupDecl.map(d => `${d[0]} (${d[1]})`).join(', '));

// 3. No element assigned the same handler twice (the earlier one is dead)
const handlers = new Map();
app.split('\n').forEach((l, i) => {
  const m = l.match(/\$\('([\w-]+)'\)\.(onclick|onchange|oninput)\s*=/);
  if (m) {
    const k = `${m[1]}.${m[2]}`;
    if (!handlers.has(k)) handlers.set(k, []);
    handlers.get(k).push(i + 1);
  }
});
const dupH = [...handlers].filter(([, v]) => v.length > 1);
console.log('duplicate handlers     :', dupH.length ? dupH.map(h => h[0]) : 'none');
if (dupH.length) problems.push('duplicate handlers: ' + dupH.map(h => `${h[0]} (${h[1]})`).join(', '));

// 4. Every function called is defined somewhere reachable
const defined = new Set([
  // function declarations
  ...[...js.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
  // arrow functions assigned to a binding
  ...[...js.matchAll(/(?:^|\n)(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)].map(m => m[1]),
  // object-literal method shorthand, e.g. `json(key, fallback) {`
  ...[...js.matchAll(/\n\s{2,}([a-z][\w$]*)\s*\([^)]*\)\s*\{/g)].map(m => m[1]),
]);
// Keywords, callback parameter names and IIFE labels are not function calls;
// without excluding them the check is too noisy to act on.
const KEYWORDS = new Set(['if','for','while','switch','catch','return','typeof','await',
  'async','function','var','let','const','new','delete','void','in','of','do','else',
  'true','false','null','undefined','import','export','yield','throw','case']);
const LOCAL_NAMES = new Set([...js.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)]
  .flatMap(m => m[1].split(',').map(a => a.trim().split(/[\s=:]/)[0]))
  .filter(Boolean));
const IIFE_NAMES = new Set([...js.matchAll(/\(function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
const BUILTIN = new Set(['if','for','while','switch','catch','return','typeof','function',
  'Promise','Array','Object','Math','JSON','Number','String','Boolean','Map','Set','Date',
  'parseInt','parseFloat','isFinite','isNaN','setTimeout','clearTimeout','setInterval',
  'requestAnimationFrame','fetch','alert','confirm','console','document','window','eval',
  'Image','File','Blob','URL','Uint8Array','Float32Array','Uint32Array','Uint8ClampedArray',
  'ImageData','createImageBitmap','structuredClone','queueMicrotask','encodeURIComponent']);
// Strip comments and string/template literals first: a CSS transform written
// into a template ("translate(...)") and a promise parameter ("res(...)") are
// not function calls, and scanning raw source reports both.
const codeOnly = app
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""');
const called = [...new Set([...codeOnly.matchAll(/(?:^|[^.\w$])([a-z][\w$]*)\s*\(/g)].map(m => m[1]))];
const undef = called.filter(n => !defined.has(n) && !BUILTIN.has(n) &&
  !KEYWORDS.has(n) && !LOCAL_NAMES.has(n) && !IIFE_NAMES.has(n) &&
  !new RegExp(`\\b${n}\\s*[:=]`).test(js) && !new RegExp(`\\.${n}\\b`).test(js));
console.log('calls with no definition:', undef.length ? undef : 'none');
if (undef.length) problems.push('undefined functions called: ' + undef.join(', '));

// 5. CSS must not style elements that no longer exist
const cssIds = [...new Set([...style.matchAll(/#([\w-]+)[\s{,:.]/g)].map(m => m[1]))];
const deadCss = cssIds.filter(id => !htmlIds.has(id));
console.log('CSS rules for missing ids:', deadCss.length ? deadCss : 'none');
if (deadCss.length) problems.push('dead CSS rules: ' + deadCss.join(', '));

// 6. Unused CSS classes (counting ones the scripts apply)
const cssClasses = [...new Set([...style.matchAll(/\.([\w-]+)[\s{,:.]/g)].map(m => m[1]))]
  .filter(c => !/^\d/.test(c));
const deadClasses = cssClasses.filter(c => {
  const re = new RegExp(`\\b${c.replace(/-/g, '\\-')}\\b`);
  return !re.test(markup) && !re.test(js);
});
console.log('unused CSS classes      :', deadClasses.length ? deadClasses : 'none');
if (deadClasses.length) problems.push('unused CSS classes: ' + deadClasses.join(', '));

console.log('\nproblems:', problems.length ? problems : 'none');
process.exit(problems.length ? 1 : 0);
