const {JSDOM} = require('jsdom');
const fs = require('fs');
const P = require('path').join(__dirname,'..') + '/';
const dom = new JSDOM(fs.readFileSync(P+'index.html','utf8'),
  {runScripts:'outside-only', pretendToBeVisual:true, url:'https://x.io/'});
const w = dom.window, d = w.document;
w.URL.createObjectURL=()=>'blob:s'; w.URL.revokeObjectURL=()=>{};
w.HTMLCanvasElement.prototype.getContext=()=>null;
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
w.HTMLDialogElement.prototype.close=function(){this.open=false;};
w.eval(['icons.js','cube.js','app.js'].map(f=>fs.readFileSync(P+f,'utf8')).join('\n;\n')
  + '\n;window.__api={S,ingest,ingestNow,mark,toggleFlag};');
const api=w.__api;
const mk=(p)=>{const f=new w.File([new Uint8Array(8)],p.split('/').pop());
  Object.defineProperty(f,'webkitRelativePath',{value:p});return f;};

api.ingest([mk('A/x.png'), mk('A/y.png')]);
console.log('first load          :', api.S.files.length, 'files');
api.mark(false);                 // mark one DELETE
api.toggleFlag();                // flag current
const marked = [...api.S.state.values()].filter(v=>!v).length;
console.log('marked delete       :', marked, '| flagged:', api.S.notes.size);

// A second load must ask rather than silently wiping
api.ingest([mk('B/p.png'), mk('B/q.png')]);
console.log('prompt shown        :', d.getElementById('dAdd').open === true);
console.log('files unchanged yet :', api.S.files.length === 2);

d.getElementById('addAppend').click();
console.log('after "Add to list" :', api.S.files.length, 'files (expect 4)');
console.log('  marks preserved   :', [...api.S.state.values()].filter(v=>!v).length === marked);
console.log('  notes preserved   :', api.S.notes.size === 1);

// Now replace
api.ingest([mk('C/z.png')]);
d.getElementById('addReplace').click();
console.log('after "Replace"     :', api.S.files.length, 'files (expect 1)');
console.log('  marks cleared     :', [...api.S.state.values()].every(Boolean));
console.log('  notes cleared     :', api.S.notes.size === 0);

process.exit(0);
