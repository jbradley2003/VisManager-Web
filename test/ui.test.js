const {JSDOM} = require('jsdom');
const problems = [];
const fs = require('fs');
const P = require('path').join(__dirname,'..') + '/';
const dom = new JSDOM(fs.readFileSync(P+'index.html','utf8'),
  {runScripts:'outside-only', pretendToBeVisual:true, url:'https://x.io/'});
const w=dom.window, d=w.document;
w.URL.createObjectURL=()=>'b'; w.URL.revokeObjectURL=()=>{};
w.HTMLCanvasElement.prototype.getContext=()=>null;
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
w.HTMLDialogElement.prototype.close=function(){this.open=false;};
w.eval(['icons.js','cube.js','app.js'].map(f=>fs.readFileSync(P+f,'utf8')).join('\n;\n')
  + '\n;window.__api={S,ingest,KEYS,refreshKeyCaps,setNavMode,drawTree,moveTreeCursor,activateTreeCursor};');
const api=w.__api;
const mk=p=>{const f=new w.File([new Uint8Array(8)],p.split('/').pop());
  Object.defineProperty(f,'webkitRelativePath',{value:p});return f;};
api.ingest([mk('R/a/1.png'),mk('R/a/2.png'),mk('R/b/3.png')]);

console.log('=== Logo ===');
console.log('  logo src set:', (d.getElementById('logo').src||'').startsWith('data:image/png'));

console.log('\n=== Nav mode ===');
api.setNavMode('wrap');
console.log('  label:', d.getElementById('bNavMode').textContent.trim().slice(0,30));
api.setNavMode('continuous');
console.log('  label:', d.getElementById('bNavMode').textContent.trim().slice(0,30));

console.log('\n=== Keybind captions follow the bindings ===');
const capOf = id => {const c=d.getElementById(id).querySelector('.kcap'); return c?c.textContent:'(none)';};
console.log('  folder prev cap:', capOf('bPF'), '| folder next cap:', capOf('bNF'));
api.KEYS.prevFold = 'q'; api.KEYS.nextFold = 'e';
api.refreshKeyCaps();
console.log('  after rebinding:', capOf('bPF'), '/', capOf('bNF'));

console.log('\n=== Expandable tree ===');
const before = d.getElementById('tree').children.length;
api.S.openFolders.add('R/a'); api.drawTree();
const after = d.getElementById('tree').children.length;
console.log(`  rows ${before} -> ${after} after expanding a folder`);
console.log('  file rows rendered:', d.querySelectorAll('.fileRow').length);
console.log('  tree focusable    :', d.getElementById('tree').tabIndex === 0);

console.log('\n=== Arrow navigation ===');
api.moveTreeCursor(1); api.moveTreeCursor(1);
console.log('  cursor row:', api.S.treeCursor, 'of', api.S.treeRows.length);
console.log('  highlighted:', d.querySelectorAll('.cursor').length === 1);

console.log('\n=== Panel + expand ===');
console.log('  panel drag handle :', !!d.getElementById('cpDrag'));
console.log('  panel resize grip :', !!d.getElementById('cpGrip'));
console.log('  expand button     :', !!d.getElementById('zExpand'));
const css = fs.readFileSync(P+'index.html','utf8');
console.log('  permanent scrollbar:', /\.cp-body\{[^}]*overflow-y:scroll/.test(css));
console.log('  toolbar spread     :', /#toolbar\{[^}]*justify-content:space-between/.test(css));

console.log('\nproblems:', problems.length?problems:'none');
process.exit(problems.length?1:0);
