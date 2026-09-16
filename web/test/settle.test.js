const {JSDOM} = require('jsdom');
const fs = require('fs');
const P = require('path').join(__dirname,'..') + '/';
const dom = new JSDOM(fs.readFileSync(P+'index.html','utf8'),
  {runScripts:'outside-only', pretendToBeVisual:true, url:'https://x.io/'});
const w=dom.window, d=w.document; const problems=[];
w.URL.createObjectURL=()=>'b'; w.URL.revokeObjectURL=()=>{};
w.HTMLCanvasElement.prototype.getContext=()=>null;
w.Element.prototype.scrollIntoView=function(){};
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
w.HTMLDialogElement.prototype.close=function(){this.open=false;};

// The stage reports one size while the scene is built, then a different one
// once layout settles — exactly what showing the strip does in a browser.
let stageW = 1400, stageH = 900;
const stage = d.getElementById('stagebox');
Object.defineProperty(stage, 'clientWidth', {get: () => stageW});
Object.defineProperty(stage, 'clientHeight', {get: () => stageH});

let observerAttached = false;
w.ResizeObserver = class { constructor(cb){this.cb=cb;} observe(){observerAttached=true;} disconnect(){} };

w.eval(['icons.js','cube.js','app.js'].map(f=>fs.readFileSync(P+f,'utf8')).join('\n;\n')
  + '\n;window.__api={S,C3,ingest,showCube,loadThree};');
const api=w.__api;

class V3{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}
 copy(v){return this.set(v.x,v.y,v.z);}clone(){return new V3(this.x,this.y,this.z);}
 sub(){return this;}add(){return this;}multiplyScalar(){return this;}normalize(){return this;}
 length(){return 1;}setScalar(){return this;}setZ(z){this.z=z;return this;}}
class Obj{constructor(){this.children=[];this.position=new V3();
 this.rotation={x:0,y:0,z:0,set(){},copy(){},clone(){return{};}};this.scale=new V3(1,1,1);
 this.quaternion={setFromUnitVectors(){}};}
 add(...o){this.children.push(...o);return this;}remove(){}rotateZ(){}rotateY(){}rotateX(){}rotateOnWorldAxis(){}}
let sized=[];
const THREE={WebGLRenderer:class{constructor(){this.domElement=d.createElement('canvas');}
  setPixelRatio(){} setSize(a,b){sized.push([a,b]);} render(){} dispose(){}},
 Scene:class extends Obj{constructor(){super();this.background={setHex(){}};}},
 Group:class extends Obj{}, PerspectiveCamera:class extends Obj{constructor(){super();this.fov=45;this.aspect=1;}lookAt(){}updateProjectionMatrix(){}},
 AmbientLight:class extends Obj{}, DirectionalLight:class extends Obj{},
 BufferGeometry:class{setAttribute(){}setIndex(){}dispose(){}}, BufferAttribute:class{},
 MeshPhongMaterial:class{constructor(o){Object.assign(this,o);this.color={setHex(){}};}dispose(){}},
 Mesh:class extends Obj{constructor(g,m){super();this.isMesh=true;this.geometry=g;this.material=m;this.userData={};}},
 SphereGeometry:class{dispose(){}}, CylinderGeometry:class{dispose(){}},
 Box3:class{setFromObject(){return this;}isEmpty(){return false;}
  getBoundingSphere(){return{radius:9,center:new V3()};}getSize(){return new V3(9,9,9);}getCenter(){return new V3();}},
 Sphere:class{constructor(){this.radius=9;this.center=new V3();}}, Vector3:V3, Color:class{setHex(){}},
 ACESFilmicToneMapping:1,NoToneMapping:0,DoubleSide:2,FrontSide:0,BackSide:1};
w.__THREE=THREE; w.eval('loadThree = () => Promise.resolve(window.__THREE);');

const BOHR=0.529177210903,n=10,lo=-2,step=4/(n-1);
let t='c\nMO\n'+`    1 ${(lo/BOHR).toFixed(6)} ${(lo/BOHR).toFixed(6)} ${(lo/BOHR).toFixed(6)}\n`;
for(let a=0;a<3;a++){const v=[0,0,0];v[a]=step/BOHR;
  t+=` ${String(n).padStart(4)} ${v[0].toFixed(6)} ${v[1].toFixed(6)} ${v[2].toFixed(6)}\n`;}
t+='    6    6.000000 0.000000 0.000000 0.000000\n';
const vals=[];for(let i=0;i<n*n*n;i++)vals.push(0.05*Math.sin(i));
for(let i=0;i<vals.length;i+=6)t+=vals.slice(i,i+6).map(v=>v.toExponential(5).padStart(13)).join('')+'\n';
const cube=new w.File([t],'a.cube');
Object.defineProperty(cube,'webkitRelativePath',{value:'D/a.cube'});
cube.text=()=>Promise.resolve(t);
api.ingest([cube]);

(async () => {
  console.log('stage observer attached:', observerAttached);
  if (!observerAttached) problems.push('ResizeObserver not attached to the stage');

  sized = [];
  await api.showCube(api.S.files[0]);
  const atBuild = api.C3.camera.aspect;
  console.log('aspect at build time   :', atBuild.toFixed(3), `(stage ${stageW}x${stageH})`);

  // The strip appears and the stage gets shorter, as it does in a browser
  stageH = 700;
  await new Promise(r => setTimeout(r, 60));   // let the two frames run
  console.log('aspect after settling  :', api.C3.camera.aspect.toFixed(3),
              `(stage ${stageW}x${stageH})`);
  console.log('renderer resized to    :', sized[sized.length-1].join(' x '));
  const ok = Math.abs(api.C3.camera.aspect - stageW/stageH) < 1e-3;
  console.log('matches the final box  :', ok);
  if (!ok) problems.push('aspect not corrected after layout settled');

  // Note on scope: this asserts the end state — that the camera aspect and
  // the renderer match the stage's final box. It does not isolate WHICH
  // mechanism got it there (the explicit settle, the ResizeObserver, or the
  // deferred resize from revealing the strip), because jsdom does no layout
  // and cannot reproduce the browser's timing. It would still catch the
  // regression where none of them run.
  console.log('\nproblems:', problems.length?problems:'none');
  process.exit(problems.length?1:0);
})();
