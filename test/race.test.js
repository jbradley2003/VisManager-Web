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
  Object.defineProperty(el,'naturalWidth',{value:640});
  Object.defineProperty(el,'naturalHeight',{value:480});
  setTimeout(()=>el.onload&&el.onload(),0);
  return el;}});
w.eval(['icons.js','cube.js','app.js'].map(f=>fs.readFileSync(P+f,'utf8')).join('\n;\n')
  + '\n;window.__api={S,C3,ingest,show,showCube,loadThree,stillCurrent};');
const api=w.__api;

// Mock three.js
class V3{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}
 copy(v){return this.set(v.x,v.y,v.z);}clone(){return new V3(this.x,this.y,this.z);}
 sub(v){return this;}add(v){return this;}multiplyScalar(){return this;}normalize(){return this;}
 length(){return 1;}setScalar(){return this;}setZ(){return this;}}
class Obj{constructor(){this.children=[];this.position=new V3();
 this.rotation={x:0,y:0,z:0,set(){},copy(){},clone(){return{};}};this.scale=new V3(1,1,1);
 this.quaternion={setFromUnitVectors(){}};}
 add(...o){this.children.push(...o);return this;}remove(){}rotateZ(){}rotateY(){}rotateX(){}rotateOnWorldAxis(){}}
const THREE={WebGLRenderer:class{constructor(){this.domElement=d.createElement('canvas');}
  setPixelRatio(){}setSize(){}render(){}dispose(){}},
 Scene:class extends Obj{constructor(){super();this.background={setHex(){}};}},
 Group:class extends Obj{},PerspectiveCamera:class extends Obj{lookAt(){}updateProjectionMatrix(){}},
 AmbientLight:class extends Obj{},DirectionalLight:class extends Obj{},
 BufferGeometry:class{setAttribute(){}setIndex(){}dispose(){}},BufferAttribute:class{},
 MeshPhongMaterial:class{constructor(o){Object.assign(this,o);this.color={setHex(){}};}dispose(){}},
 Mesh:class extends Obj{constructor(g,m){super();this.isMesh=true;this.geometry=g;this.material=m;this.userData={};}},
 SphereGeometry:class{dispose(){}},CylinderGeometry:class{dispose(){}},
 Box3:class{setFromObject(){return this;}isEmpty(){return false;}
  getBoundingSphere(){return{radius:8,center:new V3()};}getSize(){return new V3(9,9,9);}getCenter(){return new V3();}},
 Sphere:class{constructor(){this.radius=8;this.center=new V3();}},Vector3:V3,Color:class{setHex(){}},
 ACESFilmicToneMapping:1,NoToneMapping:0,DoubleSide:2,FrontSide:0,BackSide:1};
w.__THREE=THREE; w.eval('loadThree = () => Promise.resolve(window.__THREE);');

// A deliberately SLOW cube, like a 370 MB file
const BOHR=0.529177210903, n=10, lo=-2, step=4/(n-1);
let t='c\nMO\n'+`    1 ${(lo/BOHR).toFixed(6)} ${(lo/BOHR).toFixed(6)} ${(lo/BOHR).toFixed(6)}\n`;
for(let a=0;a<3;a++){const v=[0,0,0];v[a]=step/BOHR;
  t+=` ${String(n).padStart(4)} ${v[0].toFixed(6)} ${v[1].toFixed(6)} ${v[2].toFixed(6)}\n`;}
t+='    6    6.000000 0.000000 0.000000 0.000000\n';
const vals=[];for(let i=0;i<n*n*n;i++)vals.push(0.05);
for(let i=0;i<vals.length;i+=6)t+=vals.slice(i,i+6).map(v=>v.toExponential(5).padStart(13)).join('')+'\n';
const cube=new w.File([t],'slow.cube');
Object.defineProperty(cube,'webkitRelativePath',{value:'D/slow.cube'});
cube.text=()=>new Promise(r=>setTimeout(()=>r(t),120));   // slow read
const png=new w.File([new Uint8Array(16)],'quick.png');
Object.defineProperty(png,'webkitRelativePath',{value:'D/quick.png'});

api.ingest([cube, png]);
(async () => {
  // Files are sorted alphabetically, so locate them by path rather than
  // assuming an order.
  const list = api.S.byFolder.get(api.S.folders[api.S.fi]);
  const cubeIdx = list.findIndex(f => f.path.endsWith('.cube'));
  const pngIdx  = list.findIndex(f => f.path.endsWith('.png'));
  console.log(`=== Race: open the cube (index ${cubeIdx}), switch to the image (index ${pngIdx}) ===`);
  api.S.ii = cubeIdx;
  const slow = api.show();          // starts reading the cube
  await new Promise(r => setTimeout(r, 10));
  api.S.ii = pngIdx;
  await api.show();                 // user switches to the image
  await slow;                       // the cube read finally completes
  await new Promise(r => setTimeout(r, 200));

  const hasCanvas = !!d.getElementById('view').querySelector('canvas');
  const hasImg = !!d.getElementById('view').querySelector('img');
  console.log('  cube mode active :', !!api.C3.grid, '(must be false)');
  console.log('  canvas in view   :', hasCanvas, '(must be false)');
  console.log('  image in view    :', hasImg, '(must be true)');
  console.log('  filename shown   :', d.getElementById('fname').textContent);
  if (api.C3.grid) problems.push('late cube result took over the view');
  if (hasCanvas) problems.push('cube canvas is still mounted');
  if (d.getElementById('fname').textContent !== 'quick.png')
    problems.push('wrong file displayed');

  console.log('\n=== Twisty contrast ===');
  const css = fs.readFileSync(P+'index.html','utf8');
  const m = css.match(/\.tw\{[^}]*\}/);
  console.log(' ', m ? m[0].replace(/\s+/g,' ') : 'rule missing');
  console.log('  uses muted colour:', /\.tw\{[^}]*var\(--muted\)/.test(css) ? 'yes (too faint)' : 'no');

  console.log('\nproblems:', problems.length?problems:'none');
  process.exit(problems.length?1:0);
})();
