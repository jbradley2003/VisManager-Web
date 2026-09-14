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
w.Element.prototype.scrollIntoView = function(){};
// jsdom never loads blob URLs, so Image.onload would never fire and show()
// would hang. Resolve immediately with a plausible size.
// Use a real element so style/appendChild behave, just with instant load.
Object.defineProperty(w, 'Image', {value: function () {
  const el = d.createElement('img');
  Object.defineProperty(el, 'naturalWidth', {value: 800});
  Object.defineProperty(el, 'naturalHeight', {value: 600});
  setTimeout(() => el.onload && el.onload(), 0);
  return el;
}});
w.eval(['icons.js','cube.js','app.js'].map(f=>fs.readFileSync(P+f,'utf8')).join('\n;\n')
  + '\n;window.__api={S,C3,ingest,show,showCube,loadThree,nextImage};');
const api=w.__api;

// Minimal three.js so the cube path can run
class V3{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}
 copy(v){return this.set(v.x,v.y,v.z);}clone(){return new V3(this.x,this.y,this.z);}
 sub(v){this.x-=v.x;this.y-=v.y;this.z-=v.z;return this;}add(v){this.x+=v.x;this.y+=v.y;this.z+=v.z;return this;}
 multiplyScalar(s){this.x*=s;this.y*=s;this.z*=s;return this;}normalize(){return this;}
 length(){return 1;}setScalar(){return this;}setZ(z){this.z=z;return this;}}
class Obj{constructor(){this.children=[];this.position=new V3();
 this.rotation={x:0,y:0,z:0,set(){},copy(){},clone(){return{};}};this.scale=new V3(1,1,1);
 this.quaternion={setFromUnitVectors(){}};}
 add(...o){this.children.push(...o);return this;}remove(o){this.children=this.children.filter(c=>c!==o);}
 rotateZ(){}rotateY(){}rotateX(){}rotateOnWorldAxis(){}}
const THREE={WebGLRenderer:class{constructor(){this.domElement=d.createElement('canvas');}
  setPixelRatio(){}setSize(){}render(){}dispose(){}},
 Scene:class extends Obj{constructor(){super();this.background={setHex(){}};}},
 Group:class extends Obj{}, PerspectiveCamera:class extends Obj{lookAt(){}updateProjectionMatrix(){}},
 AmbientLight:class extends Obj{}, DirectionalLight:class extends Obj{},
 BufferGeometry:class{setAttribute(){}setIndex(){}dispose(){}}, BufferAttribute:class{},
 MeshPhongMaterial:class{constructor(o){Object.assign(this,o);this.color={setHex(){}};}dispose(){}},
 Mesh:class extends Obj{constructor(g,m){super();this.isMesh=true;this.geometry=g;this.material=m;this.userData={};}},
 SphereGeometry:class{dispose(){}}, CylinderGeometry:class{dispose(){}},
 Box3:class{setFromObject(){return this;}isEmpty(){return false;}
   getBoundingSphere(){return{radius:8,center:new V3()};}getSize(){return new V3(9,9,9);}getCenter(){return new V3();}},
 Sphere:class{constructor(){this.radius=8;this.center=new V3();}}, Vector3:V3, Color:class{setHex(){}},
 ACESFilmicToneMapping:1,NoToneMapping:0,DoubleSide:2,FrontSide:0,BackSide:1};
w.__THREE=THREE; w.eval('loadThree = () => Promise.resolve(window.__THREE);');

// A cube and a PNG in the same folder
const BOHR=0.529177210903, n=12, lo=-2, step=4/(n-1);
let t='c\nMO\n'+`    1 ${(lo/BOHR).toFixed(6)} ${(lo/BOHR).toFixed(6)} ${(lo/BOHR).toFixed(6)}\n`;
for(let a=0;a<3;a++){const v=[0,0,0];v[a]=step/BOHR;
  t+=` ${String(n).padStart(4)} ${v[0].toFixed(6)} ${v[1].toFixed(6)} ${v[2].toFixed(6)}\n`;}
t+='    6    6.000000 0.000000 0.000000 0.000000\n';
const vals=[];for(let i=0;i<n*n*n;i++)vals.push(Math.sin(i)*0.1);
for(let i=0;i<vals.length;i+=6)t+=vals.slice(i,i+6).map(v=>v.toExponential(5).padStart(13)).join('')+'\n';
const cube=new w.File([t],'a.cube');
Object.defineProperty(cube,'webkitRelativePath',{value:'D/a.cube'});
cube.text=()=>Promise.resolve(t);
const png=new w.File([new Uint8Array(16)],'b.png');
Object.defineProperty(png,'webkitRelativePath',{value:'D/b.png'});

api.ingest([cube, png]);
(async () => {
  console.log('=== Open the cube ===');
  api.S.ii = 0;
  await api.showCube(api.S.files[0]);
  console.log('  cube mode active :', !!api.C3.grid);

  console.log('\n=== Navigate to the image ===');
  api.S.ii = 1;
  await api.show();
  console.log('  cube mode cleared:', api.C3.grid === null, '(was the bug: stayed set)');
  console.log('  iso bar hidden   :', d.getElementById('isobar').style.display === 'none');
  console.log('  panel closed     :', !d.getElementById('cubePanel').classList.contains('on'));
  if (api.C3.grid !== null) problems.push('cube mode leaked into image view');

  console.log('\n=== 2D controls act on the image again ===');
  const before = api.S.rot;
  d.getElementById('rotR').click();
  console.log(`  rotate: S.rot ${before} -> ${api.S.rot}`, api.S.rot !== before ? '(works)' : '(STUCK)');
  if (api.S.rot === before) problems.push('rotate did not affect the image');
  const z = api.S.zoom;
  d.getElementById('zIn').click();
  console.log(`  zoom  : ${z} -> ${api.S.zoom}`, api.S.zoom !== z ? '(works)' : '(STUCK)');
  if (api.S.zoom === z) problems.push('zoom did not affect the image');

  console.log('\n=== Wordmark and icon ===');
  console.log('  wordmark one element:', !!d.getElementById('wordmark'),
              JSON.stringify(d.getElementById('wordmark').textContent));
  const img = d.getElementById('bNavMode').querySelector('img');
  console.log('  nav-mode icon size  :', img ? img.width : 'none');

  console.log('\nproblems:', problems.length?problems:'none');
  process.exit(problems.length?1:0);
})();
