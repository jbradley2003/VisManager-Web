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
Object.defineProperty(w,'Image',{value:function(){
  const el=d.createElement('img');
  Object.defineProperty(el,'naturalWidth',{value:400});
  Object.defineProperty(el,'naturalHeight',{value:300});
  setTimeout(()=>el.onload&&el.onload(),0); return el;}});
w.eval(['icons.js','cube.js','app.js'].map(f=>fs.readFileSync(P+f,'utf8')).join('\n;\n')
  + '\n;window.__api={S,ingest,mark,show,setAutoAdvance,updateBarDensity};');
const api=w.__api;
const mk=p=>{const f=new w.File([new Uint8Array(8)],p.split('/').pop());
  Object.defineProperty(f,'webkitRelativePath',{value:p});return f;};
api.ingest([mk('R/1.png'),mk('R/2.png'),mk('R/3.png')]);

(async () => {
  await new Promise(r=>setTimeout(r,20));
  console.log('=== Auto-advance ON (default) ===');
  console.log('  button   :', d.getElementById('bAuto').textContent.trim());
  api.S.ii = 0;
  api.mark(true);
  await new Promise(r=>setTimeout(r,20));
  console.log('  after marking, index:', api.S.ii, '(expect 1)');
  if (api.S.ii !== 1) problems.push('did not advance');

  console.log('\n=== Auto-advance OFF ===');
  api.setAutoAdvance(false);
  console.log('  button   :', d.getElementById('bAuto').textContent.trim());
  const at = api.S.ii;
  api.mark(false);
  await new Promise(r=>setTimeout(r,20));
  console.log('  after marking, index:', api.S.ii, `(expect ${at})`);
  if (api.S.ii !== at) problems.push('advanced while set to stay');
  console.log('  mark still applied  :', api.S.state.get(api.S.files[at].path) === false);
  console.log('  persisted           :', w.localStorage.getItem('vm.autoAdvance'));

  console.log('\n=== Mark tint on the strip ===');
  api.setAutoAdvance(true);
  api.S.ii = 0; api.mark(true);
  await new Promise(r=>setTimeout(r,20));
  api.S.ii = 0; await api.show();
  console.log('  keep  ->', d.getElementById('isodock').style.background);
  api.S.state.set(api.S.files[0].path, false);
  await api.show();
  console.log('  delete->', d.getElementById('isodock').style.background);
  const tinted = /del-bg/.test(d.getElementById('isodock').style.background);
  if (!tinted) problems.push('strip not tinted for delete');

  console.log('\n=== Compacting ===');
  Object.defineProperty(d.getElementById('stage'), 'clientWidth', {value: 700, configurable: true});
  api.updateBarDensity();
  console.log('  narrow -> flat:', d.getElementById('isodock').classList.contains('flat'),
              '| topbars flat:', d.getElementById('topbars').classList.contains('flat'));
  Object.defineProperty(d.getElementById('stage'), 'clientWidth', {value: 1600, configurable: true});
  api.updateBarDensity();
  console.log('  wide   -> flat:', d.getElementById('isodock').classList.contains('flat'));

  console.log('\nproblems:', problems.length?problems:'none');
  process.exit(problems.length?1:0);
})();
