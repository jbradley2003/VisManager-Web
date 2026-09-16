const {JSDOM} = require('jsdom');
const fs = require('fs');
const P = require('path').join(__dirname,'..') + '/';
const dom = new JSDOM(fs.readFileSync(P+'index.html','utf8'),
  {runScripts:'outside-only', pretendToBeVisual:true, url:'https://x.io/'});
const w=dom.window, d=w.document; const problems=[];
w.URL.createObjectURL=()=>'b'; w.URL.revokeObjectURL=()=>{};
w.HTMLCanvasElement.prototype.getContext=()=>null;
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
w.HTMLDialogElement.prototype.close=function(){this.open=false;};
w.Element.prototype.scrollIntoView=function(){};
w.eval(['icons.js','cube.js','app.js'].map(f=>fs.readFileSync(P+f,'utf8')).join('\n;\n')
  + '\n;window.__api={S,ingest,setLoadMode,prefetchFolder,cubeCache,loadGrid,cacheBytes,CUBE_CACHE_BYTES};');
const api=w.__api;

const BOHR=0.529177210903;
let reads = 0;
function mkCube(name, n=14){
  const lo=-3, step=6/(n-1);
  let t='c\nMO\n'+`    1 ${(lo/BOHR).toFixed(6)} ${(lo/BOHR).toFixed(6)} ${(lo/BOHR).toFixed(6)}\n`;
  for(let a=0;a<3;a++){const v=[0,0,0];v[a]=step/BOHR;
    t+=` ${String(n).padStart(4)} ${v[0].toFixed(6)} ${v[1].toFixed(6)} ${v[2].toFixed(6)}\n`;}
  t+='    6    6.000000 0.000000 0.000000 0.000000\n';
  const vals=[];for(let i=0;i<n*n*n;i++)vals.push(0.02*Math.sin(i));
  for(let i=0;i<vals.length;i+=6)t+=vals.slice(i,i+6).map(v=>v.toExponential(5).padStart(13)).join('')+'\n';
  const f=new w.File([t],name);
  Object.defineProperty(f,'webkitRelativePath',{value:'D/'+name});
  f.text=()=>{ reads++; return Promise.resolve(t); };
  return f;
}
api.ingest([mkCube('a.cube'),mkCube('b.cube'),mkCube('c.cube'),mkCube('d.cube')]);

(async () => {
  console.log('=== One at a time (default) ===');
  console.log('  mode        :', api.S.loadMode);
  console.log('  cached      :', api.cubeCache.size);

  console.log('\n=== Switch to whole folder ===');
  reads = 0;
  api.setLoadMode('folder');
  await new Promise(r => setTimeout(r, 300));
  console.log('  button label:', d.getElementById('bLoadMode').textContent);
  console.log('  files read  :', reads, '(expect 4)');
  console.log('  cached      :', api.cubeCache.size, 'cubes');
  console.log('  status text :', d.getElementById('cacheLbl').textContent);
  if (api.cubeCache.size !== 4) problems.push('prefetch did not cache the folder');

  console.log('\n=== A cached file is not re-read ===');
  reads = 0;
  const g = await api.loadGrid(api.S.files[0]);
  console.log('  grid returned:', !!g, '| extra reads:', reads, '(expect 0)');
  if (reads !== 0) problems.push('cache miss on a cached file');

  console.log('\n=== Budget is enforced ===');
  console.log('  budget      :', (api.CUBE_CACHE_BYTES/1048576).toFixed(0), 'MB');
  console.log('  in use      :', (api.cacheBytes()/1024).toFixed(0), 'KB');
  console.log('  under budget:', api.cacheBytes() <= api.CUBE_CACHE_BYTES);

  console.log('\n=== Switching back stops prefetching ===');
  api.setLoadMode('lazy');
  console.log('  mode        :', api.S.loadMode);
  console.log('  label       :', d.getElementById('bLoadMode').textContent);
  console.log('  persisted   :', w.localStorage.getItem('vm.loadMode'));

  console.log('\nproblems:', problems.length?problems:'none');
  process.exit(problems.length?1:0);
})();
