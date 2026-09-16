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
  ACESFilmicToneMapping: 1, NoToneMapping: 0,
  DoubleSide: 2, FrontSide: 0, BackSide: 1,
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
    const pairs = C3.surfaces.filter(Boolean);
    console.log('surfaces built   :', pairs.length, 'lobe(s)');
    const twoPass = pairs.every(p => p.back && p.front &&
                                     p.back.material.side === 1 &&
                                     p.front.material.side === 0);
    console.log('two-pass per lobe:', twoPass);
    if (!twoPass) problems.push('lobes are not rendered back-then-front');
    const orders = pairs.flatMap(p => [p.back.renderOrder, p.front.renderOrder]);
    const strictlyIncreasing = orders.every((v, i) => i === 0 || v > orders[i - 1]);
    console.log('render order     :', orders.join(' < '), strictlyIncreasing ? 'OK' : 'AMBIGUOUS');
    if (!strictlyIncreasing) problems.push('render order is ambiguous');
    const shared = pairs.every(p => p.back.geometry === p.front.geometry);
    console.log('geometry shared  :', shared, '(one upload, not two)');
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
  // Writer-variant coverage: the units flag is not always honoured, and some
  // writers emit fixed-width columns with no separators.
  console.log('\n=== Parser robustness across writer variants ===');
  const CL = w.eval('CubeLib');
  const BOHR2 = 0.529177210903;
  const mkText = (coordScale, sign, atomList, wide) => {
    const nn = 8, lo = -8, st = 16/(nn-1), gs = sign < 0 ? 1 : 1/BOHR2;
    let o = 'c\nMO\n';
    o += `${String(atomList.length*sign).padStart(5)} ${(lo*gs).toFixed(6)} ${(lo*gs).toFixed(6)} ${(lo*gs).toFixed(6)}\n`;
    for (let a=0;a<3;a++){const v=[0,0,0];v[a]=st*gs;
      o += ` ${String(nn).padStart(4)} ${v[0].toFixed(6)} ${v[1].toFixed(6)} ${v[2].toFixed(6)}\n`;}
    for (const [z,x,y,zz] of atomList) {
      const X=x*coordScale, Y=y*coordScale, Z=zz*coordScale;
      o += wide
        ? `${String(z).padStart(5)}${z.toFixed(6).padStart(12)}${X.toFixed(6).padStart(12)}${Y.toFixed(6).padStart(12)}${Z.toFixed(6).padStart(12)}\n`
        : `${String(z).padStart(5)} ${z.toFixed(6)} ${X.toFixed(6)} ${Y.toFixed(6)} ${Z.toFixed(6)}\n`;
    }
    if (sign < 0) o += '    1    1\n';
    const vv = new Array(nn*nn*nn).fill(0.01);
    for (let i=0;i<vv.length;i+=6) o += vv.slice(i,i+6).map(v=>v.toExponential(5).padStart(13)).join('')+'\n';
    return o;
  };
  const organic = [[6,0,0,0],[8,1.23,0,0],[1,-1.09,0,0]];
  const metal = [[28,0,0,0],[7,2.10,0,0],[7,-2.10,0,0],[8,0,2.05,0],[8,0,-2.05,0]];
  const variants = [
    ['organic Bohr/+',    organic, 1/BOHR2,  1, false, 1.23, 2],
    ['organic Ang/-',     organic, 1,       -1, false, 1.23, 2],
    ['organic Ang/+ bad', organic, 1,        1, false, 1.23, 2],
    ['organic Bohr/- bad',organic, 1/BOHR2, -1, false, 1.23, 2],
    ['fixed-width cols',  organic, 1/BOHR2,  1, true,  1.23, 2],
    ['metal Bohr/+',      metal,   1/BOHR2,  1, false, 2.10, 4],
  ];
  for (const [nm, at, cs, sg, wide, wantD, wantB] of variants) {
    const g = CL.parseCube(mkText(cs, sg, at, wide));
    const dd = Math.hypot(g.atoms[0].x-g.atoms[1].x, g.atoms[0].y-g.atoms[1].y,
                          g.atoms[0].zc-g.atoms[1].zc);
    const nb = CL.inferBonds(g.atoms).length;
    const ok = Math.abs(dd - wantD) < 0.03 && nb === wantB;
    console.log(`  ${nm.padEnd(20)} d=${dd.toFixed(3)} bonds=${nb} ${ok ? 'OK' : 'FAIL'}`);
    if (!ok) problems.push(`parser variant "${nm}" wrong (d=${dd.toFixed(3)}, bonds=${nb})`);
  }

  // A real ORCA molecular-orbital header. ORCA writes a NEGATIVE atom count
  // to flag the orbital-index line, not to declare Angstrom as the Gaussian
  // convention says — the coordinates stay in Bohr. Trusting the sign made
  // every MO cube 1.89x oversized: bonds vanished and the isosurface floated
  // off the molecule.
  console.log('\n=== Real ORCA MO cube header ===');
  const realPath = require('path').join(__dirname, 'fixtures', 'orca_mo_header.cube');
  if (fs.existsSync(realPath)) {
    const CL2 = w.eval('CubeLib');
    const rg = CL2.parseCube(fs.readFileSync(realPath, 'utf8'));
    const zn = rg.atoms[0];
    const near = rg.atoms.slice(1)
      .map(a => Math.hypot(a.x-zn.x, a.y-zn.y, a.zc-zn.zc))
      .sort((p, q) => p - q).slice(0, 6);
    const bonds = CL2.inferBonds(rg.atoms);
    const toMetal = bonds.filter(([i, j]) => rg.atoms[i].z === 30 || rg.atoms[j].z === 30).length;
    const gc = [0,1,2].map(i => rg.origin[i] + rg.spacing[i]*(rg.dims[i]-1)/2);
    const ac = [0,1,2].map(i => rg.atoms.reduce((s2, a) => s2 + [a.x,a.y,a.zc][i], 0) / rg.atoms.length);
    const off = Math.hypot(gc[0]-ac[0], gc[1]-ac[1], gc[2]-ac[2]);

    console.log(`  atoms ${rg.atoms.length}, Zn-O ${near[0].toFixed(2)} A, ` +
                `bonds ${bonds.length} (${toMetal} to the metal), offset ${off.toFixed(2)} A`);
    if (rg.atoms.length !== 69) problems.push('real header: wrong atom count');
    if (!(near[0] > 1.8 && near[0] < 2.3)) problems.push(`real header: Zn-O ${near[0].toFixed(2)} A implausible`);
    if (toMetal < 4) problems.push('real header: metal coordination not detected');
    if (off > 2) problems.push(`real header: surface displaced by ${off.toFixed(2)} A`);
  } else {
    console.log('  fixture missing, skipped');
  }

  // A canvas larger than the browser allows allocates nothing and throws
  // nothing — the page just renders white. A 12900 pt page at a fixed 2x asked
  // for 670 megapixels.
  console.log('\n=== PDF preview scale stays allocatable ===');
  const scaleFn = w.eval('pdfPreviewScale');
  const MAXD = 8192, MAXA = 32e6;
  for (const [nm, pw, ph] of [['huge page', 12900, 12990], ['A4', 595, 842],
                              ['A0', 2384, 3370], ['banner', 40000, 200]]) {
    const sc = scaleFn(pw, ph, 1400, 800);
    const cw = Math.round(pw * sc), ch = Math.round(ph * sc);
    const ok = cw <= MAXD && ch <= MAXD && cw * ch <= MAXA * 1.01 && sc > 0;
    console.log(`  ${nm.padEnd(10)} ${cw}x${ch} (${((cw*ch)/1e6).toFixed(1)} MP) ${ok ? 'OK' : 'OVER LIMIT'}`);
    if (!ok) problems.push(`pdf scale for ${nm} exceeds canvas limits`);
  }

  console.log('\nproblems:', problems.length?problems:'none');
  process.exit(problems.length?1:0);
})();
