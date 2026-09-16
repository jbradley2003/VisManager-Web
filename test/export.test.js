const {JSDOM} = require('jsdom');
const fs = require('fs');
const P = require('path').join(__dirname,'..') + '/';
const dom = new JSDOM(fs.readFileSync(P+'index.html','utf8'),
  {runScripts:'outside-only', pretendToBeVisual:true, url:'https://x.io/'});
const w=dom.window, d=w.document; const problems=[];
w.URL.createObjectURL=()=>'blob:s'; w.URL.revokeObjectURL=()=>{};
w.HTMLCanvasElement.prototype.getContext=()=>null;
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
w.HTMLDialogElement.prototype.close=function(){this.open=false;};
w.Element.prototype.scrollIntoView=function(){};
w.eval(['icons.js','cube.js','app.js'].map(f=>fs.readFileSync(P+f,'utf8')).join('\n;\n')
  + '\n;window.__api={S,ingest,openNotes,show,convertChoice,X_BOXES};');
const api=w.__api;
const mk=p=>{const f=new w.File([new Uint8Array(8)],p.split('/').pop());
  Object.defineProperty(f,'webkitRelativePath',{value:p});return f;};
api.ingest([mk('R/a/1.png'),mk('R/a/2.tga'),mk('R/b/3.png'),mk('R/b/m.cube')]);

console.log('=== Export dialog ===');
d.getElementById('bExport').click();
console.log('  opens               :', d.getElementById('dExport').open === true);
console.log('  convert rows        :', d.querySelectorAll('#xConvert .convRow').length, '(one per folder with images)');
const opts = [...d.querySelectorAll('#xConvert select option')].map(o=>o.textContent);
console.log('  conversion targets  :', opts.join(', '));

console.log('\n=== Select all / none ===');
d.getElementById('xAll').click();
const allOn = api.X_BOXES.every(id => d.getElementById(id).checked);
console.log('  All  -> every box on:', allOn);
if (!allOn) problems.push('"All" did not tick everything');
d.getElementById('xNone').click();
const allOff = api.X_BOXES.every(id => !d.getElementById(id).checked);
console.log('  None -> every box off:', allOff);
if (!allOff) problems.push('"None" did not clear everything');

console.log('\n=== Cube snapshot options ===');
d.getElementById('xCubes').checked = true;
d.getElementById('xCubes').onchange();
console.log('  options revealed    :', d.getElementById('xCubeOpts').style.display === 'block');
const res = [...d.querySelectorAll('.xres')].map(b=>b.dataset.s);
console.log('  resolutions offered :', res.join('x, ') + 'x');
d.querySelector('.xres[data-s="4"]').click();
console.log('  4x selected         :', d.querySelector('.xres[data-s="4"]').classList.contains('on'));
console.log('  size note           :', d.getElementById('xResNote').textContent);

console.log('\n=== Per-folder conversion choice ===');
const sel = d.querySelector('#xConvert select');
sel.value = 'jpeg'; sel.onchange();
console.log('  stored for folder   :', [...api.convertChoice.entries()][0]);

console.log('\n=== Notes browser ===');
api.S.notes.set('R/a/1.png', 'check the lobe on the left');
api.S.notes.set('R/b/3.png', '');
api.openNotes();
console.log('  dialog open         :', d.getElementById('dNotes').open === true);
console.log('  entries listed      :', d.querySelectorAll('.noteItem').length, '(expect 2)');
console.log('  count text          :', d.getElementById('notesCount').textContent);
console.log('  note text shown     :', /check the lobe/.test(d.getElementById('notesList').textContent));
// Clicking an entry should navigate to that file
api.S.fi = 1; api.S.ii = 0;
d.querySelectorAll('.noteItem')[0].click();
const cur = api.S.byFolder.get(api.S.folders[api.S.fi])[api.S.ii];
console.log('  click navigates to  :', cur ? cur.path : '(none)', cur && cur.path==='R/a/1.png' ? 'OK' : 'WRONG');
if (!cur || cur.path !== 'R/a/1.png') problems.push('notes click did not navigate');

console.log('\n=== Removals ===');
console.log('  shortcuts button    :', JSON.stringify(d.getElementById('bKeys').textContent.trim()));
console.log('  open folder icon    :', d.getElementById('bOpen').querySelector('img') ? 'STILL THERE' : 'removed');
console.log('  nav mode icon       :', d.getElementById('bNavMode').querySelector('img') ? 'STILL THERE' : 'removed');
console.log('  shortcuts icon      :', d.getElementById('bKeys').querySelector('img') ? 'STILL THERE' : 'removed');
console.log('  stage grip          :', d.getElementById('stageGrip') ? 'STILL THERE' : 'removed');

console.log('\nproblems:', problems.length?problems:'none');
process.exit(problems.length?1:0);
