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
  + '\n;window.__api={S,C3,ingest,showCube,loadThree,toggleCubeLock,cubeLockState,applyCubeLock,refreshLockBtn};');
const api=w.__api;
class V3{constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}
 copy(v){return this.set(v.x,v.y,v.z);}clone(){return new V3(this.x,this.y,this.z);}
 sub(){return this;}add(){return this;}multiplyScalar(){return this;}normalize(){return this;}
 length(){return 1;}setScalar(){return this;}setZ(z){this.z=z;return this;}}
class Obj{constructor(){this.children=[];this.position=new V3();
 this.rotation={x:0,y:0,z:0,set(a,b,c){this.x=a;this.y=b;this.z=c;},copy(){},clone(){return{...this};}};
 this.scale=new V3(1,1,1);this.quaternion={setFromUnitVectors(){}};}
 add(...o){this.children.push(...o);return this;}remove(){}rotateZ(){}rotateY(){}rotateX(){}rotateOnWorldAxis(){}}
const THREE={WebGLRenderer:class{constructor(){this.domElement=d.createElement('canvas');}
  setPixelRatio(){}setSize(){}render(){}dispose(){}},
 Scene:class extends Obj{constructor(){super();this.background={setHex(){}};}},
 Group:class extends Obj{},PerspectiveCamera:class extends Obj{constructor(){super();this.fov=45;}lookAt(){}updateProjectionMatrix(){}},
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

const BOHR=0.529177210903,n=10,lo=-2,step=4/(n-1);
let t='c\nMO\n'+`    1 ${(lo/BOHR).toFixed(6)} ${(lo/BOHR).toFixed(6)} ${(lo/BOHR).toFixed(6)}\n`;
for(let a=0;a<3;a++){const v=[0,0,0];v[a]=step/BOHR;
  t+=` ${String(n).padStart(4)} ${v[0].toFixed(6)} ${v[1].toFixed(6)} ${v[2].toFixed(6)}\n`;}
t+='    6    6.000000 0.000000 0.000000 0.000000\n';
const vals=[];for(let i=0;i<n*n*n;i++)vals.push(0.05*Math.sin(i));
for(let i=0;i<vals.length;i+=6)t+=vals.slice(i,i+6).map(v=>v.toExponential(5).padStart(13)).join('')+'\n';
const cube=new w.File([t],'orb.cube');
Object.defineProperty(cube,'webkitRelativePath',{value:'D/orb.cube'});
cube.text=()=>Promise.resolve(t);
api.ingest([cube]);

(async () => {
  await api.showCube(api.S.files[0]);
  console.log('=== Lock a view ===');
  // Set a distinctive orientation and isovalue
  api.C3.root.rotation.set(0.5, 1.2, 0.3);
  api.C3.iso = 0.0123; api.C3.dist = 42; api.C3.opacity = 0.4;
  api.toggleCubeLock();
  const locked = api.S.cubeLocks.get('D/orb.cube');
  console.log('  lock stored      :', !!locked);
  console.log('  captured iso     :', locked.iso);
  console.log('  captured rotation:', [locked.rot.x, locked.rot.y, locked.rot.z].join(', '));
  console.log('  captured distance:', locked.dist);
  console.log('  button label     :', d.getElementById('isoLock').textContent);
  console.log('  persisted        :', !!w.localStorage.getItem('vm.cubeLocks'));
  if (!locked || locked.iso !== 0.0123) problems.push('lock did not capture the isovalue');

  console.log('\n=== Reopen restores it ===');
  api.C3.root.rotation.set(0, 0, 0); api.C3.iso = 9; api.C3.dist = 5;
  await api.showCube(api.S.files[0]);
  const r = api.C3.root.rotation;
  console.log('  iso restored     :', api.C3.iso);
  console.log('  rotation restored:', [r.x, r.y, r.z].join(', '));
  console.log('  distance restored:', api.C3.dist);
  if (Math.abs(api.C3.iso - 0.0123) > 1e-9) problems.push('isovalue not restored');
  if (Math.abs(r.y - 1.2) > 1e-9) problems.push('orientation not restored');

  console.log('\n=== Unlock ===');
  api.toggleCubeLock();
  console.log('  lock cleared     :', !api.S.cubeLocks.has('D/orb.cube'));
  console.log('  button label     :', d.getElementById('isoLock').textContent);

  console.log('\n=== Toolbar groups ===');
  for (const g of ['isobar','imgbar','zoombar']) {
    const el = d.getElementById(g);
    console.log(`  ${g.padEnd(8)} "${el.querySelector('.glabel').textContent}" ` +
                `${el.querySelectorAll('button').length} buttons`);
  }
  console.log('  snapshot button  :', !!d.getElementById('isoSnap'));
  console.log('\nproblems:', problems.length?problems:'none');
  process.exit(problems.length?1:0);
})();
