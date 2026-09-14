const {JSDOM} = require('jsdom');
const fs = require('fs');
const P = require('path').join(__dirname, '..') + '/';

const dom = new JSDOM(fs.readFileSync(P+'index.html','utf8'),
  {runScripts:'outside-only', pretendToBeVisual:true, url:'https://x.io/'});
const w = dom.window, d = w.document;
w.URL.createObjectURL=()=>'blob:s'; w.URL.revokeObjectURL=()=>{};
w.HTMLCanvasElement.prototype.getContext=()=>null;
const problems=[];
w.addEventListener('error', e=>problems.push('window: '+e.message));

const bundle = ['icons.js','cube.js','app.js'].map(f=>fs.readFileSync(P+f,'utf8')).join('\n;\n')
  + `\n;window.__api={S,ingest,showCube,loadThree,C3,buildCubeScene};`;
w.eval(bundle);
const api = w.__api;

// Minimal three.js stand-in: enough surface for the cube code path to run.
class V3 { constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}
  set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}
  copy(v){return this.set(v.x,v.y,v.z);} clone(){return new V3(this.x,this.y,this.z);}
  sub(v){this.x-=v.x;this.y-=v.y;this.z-=v.z;return this;}
  add(v){this.x+=v.x;this.y+=v.y;this.z+=v.z;return this;}
  multiplyScalar(s){this.x*=s;this.y*=s;this.z*=s;return this;}
  normalize(){const l=Math.hypot(this.x,this.y,this.z)||1;return this.multiplyScalar(1/l);}
  length(){return Math.hypot(this.x,this.y,this.z);}
  setScalar(s){return this.set(s,s,s);} setZ(z){this.z=z;return this;}}
class Obj { constructor(){this.children=[];this.position=new V3();
    this.rotation={x:0,y:0,z:0,set(a,b,c){this.x=a;this.y=b;this.z=c;},
      copy(r){this.x=r.x;this.y=r.y;this.z=r.z;},clone(){return {...this};}};
    this.scale=new V3(1,1,1);this.quaternion={setFromUnitVectors(){}};}
  add(...o){this.children.push(...o);return this;}
  remove(o){this.children=this.children.filter(c=>c!==o);}
  rotateZ(){} rotateY(){} rotateX(){} }
const THREE = {
  WebGLRenderer: class { constructor(){this.domElement=d.createElement('canvas');}
    setPixelRatio(){} setSize(){} render(){} dispose(){} },
  Scene: class extends Obj { constructor(){super();this.background={setHex(){}};} },
  Group: class extends Obj {},
  PerspectiveCamera: class extends Obj { constructor(){super();this.position=new V3();}
    lookAt(){} updateProjectionMatrix(){} },
  AmbientLight: class extends Obj {}, DirectionalLight: class extends Obj {},
  BufferGeometry: class { setAttribute(){} setIndex(){} dispose(){} },
  BufferAttribute: class {}, MeshPhongMaterial: class { constructor(o){Object.assign(this,o);
    this.color={setHex(){}};} dispose(){} },
  Mesh: class extends Obj { constructor(g,m){super();this.isMesh=true;this.geometry=g;this.material=m;
    this.userData={};} },
  SphereGeometry: class { dispose(){} }, CylinderGeometry: class { dispose(){} },
  Box3: class { setFromObject(){return this;} isEmpty(){return false;}
    getBoundingSphere(){return {radius:8, center:new V3()};}
    getSize(){return new V3(10,10,10);} getCenter(){return new V3();} },
  Sphere: class { constructor(){this.radius=8;this.center=new V3();} },
  Vector3: V3, Color: class { setHex(){} },
  ACESFilmicToneMapping: 1, NoToneMapping: 0, DoubleSide: 2,
};
// Stub the dynamic import
w.eval('loadThree = () => Promise.resolve(window.__THREE);');
w.__THREE = THREE;

// Build a small but real cube file
const BOHR = 0.529177210903;
const n = 16, lo = -3, step = 6/(n-1);
let text = 'test\nMO\n';
text += `    2 ${(lo/BOHR).toFixed(6)} ${(lo/BOHR).toFixed(6)} ${(lo/BOHR).toFixed(6)}\n`;
for (let a=0;a<3;a++){const v=[0,0,0];v[a]=step/BOHR;
  text += ` ${String(n).padStart(4)} ${v[0].toFixed(6)} ${v[1].toFixed(6)} ${v[2].toFixed(6)}\n`;}
text += `    6    6.000000 0.000000 0.000000  ${(0.7/BOHR).toFixed(6)}\n`;
text += `    8    8.000000 0.000000 0.000000 ${(-0.7/BOHR).toFixed(6)}\n`;
const vals=[];
for(let x=0;x<n;x++)for(let y=0;y<n;y++)for(let z=0;z<n;z++){
  const px=lo+x*step,py=lo+y*step,pz=lo+z*step;
  vals.push(pz*Math.exp(-Math.hypot(px,py,pz)));
}
for(let i=0;i<vals.length;i+=6)
  text += vals.slice(i,i+6).map(v=>v.toExponential(5).padStart(13)).join('')+'\n';

const file = new w.File([text], 'orb.cube');
Object.defineProperty(file,'webkitRelativePath',{value:'D/orb.cube'});
file.text = () => Promise.resolve(text);

api.ingest([file]);
console.log('ingested cube files:', api.S.files.length);

(async () => {
  try {
    await api.showCube(api.S.files[0]);
    const C3 = w.__api.C3;
    console.log('grid dims        :', C3.grid && C3.grid.dims.join('x'));
    console.log('atoms parsed     :', C3.grid && C3.grid.atoms.length);
    console.log('auto isovalue    :', C3.iso && C3.iso.toExponential(2));
    console.log('surfaces built   :', C3.surfaces.length);
    console.log('atom meshes      :', C3.atomMeshes.length);
    console.log('bond meshes      :', C3.bondMeshes.length);
    console.log('camera created   :', !!C3.camera);
    console.log('canvas in view   :', !!d.getElementById('view').querySelector('canvas'));
    console.log('iso bar shown    :', d.getElementById('isobar').style.display);
    console.log('finfo            :', d.getElementById('finfo').textContent.slice(0,70));
  } catch (err) {
    problems.push('showCube: ' + err.message);
    console.log('showCube THREW:', err.message);
    console.log((err.stack||'').split('\n').slice(1,3).join('\n'));
  }
  console.log('\nproblems:', problems.length?problems:'none');
  process.exit(problems.length?1:0);
})();
