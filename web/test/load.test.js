/* Loads the page over HTTP with real <script src> tags, exactly as a browser
 * does: separate script elements, one shared global scope, in order.
 *
 * An earlier version concatenated the files into a single eval, which could
 * not reproduce a duplicate <script src="icons.js"> tag — two separate script
 * elements make that a redeclaration error, concatenation does not. That
 * duplicate shipped a dead page.
 */
const http = require('http'), fs = require('fs'), path = require('path');
const {JSDOM, VirtualConsole} = require('jsdom');
const root = path.join(__dirname, '..');

const errors = [];
const srv = http.createServer((req, res) => {
  const f = path.join(root, req.url.split('?')[0] === '/' ? 'index.html' : req.url);
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html'});
    res.end(data);
  });
});

srv.listen(0, () => {
  const port = srv.address().port;
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    // The CDN libraries cannot load offline; that is not a page fault.
    if (/Could not load script: "https?:\/\//.test(e.message)) return;
    errors.push(e.message);
  });

  JSDOM.fromURL(`http://127.0.0.1:${port}/index.html`, {
    runScripts: 'dangerously', resources: 'usable',
    pretendToBeVisual: true, virtualConsole: vc,
  }).then(dom => {
    const w = dom.window, d = w.document;
    w.HTMLCanvasElement.prototype.getContext = () => null;

    setTimeout(() => {
      const srcs = [...d.querySelectorAll('script[src]')]
        .map(s => s.getAttribute('src')).filter(s => !/^https?:/.test(s));
      const dupes = srcs.filter((s, i) => srcs.indexOf(s) !== i);
      console.log('local scripts    :', srcs.join(', '));
      console.log('duplicate tags   :', dupes.length ? dupes : 'none');
      if (dupes.length) errors.push('duplicate <script src>: ' + dupes.join(', '));
      for (const s of srcs)
        if (!fs.existsSync(path.join(root, s))) errors.push('missing file: ' + s);

      console.log('script errors    :', errors.length ? errors : 'none');

      const ids = ['bOpen','bKeep','bDel','bNote','bFlag','bExport','bKeys',
                   'bNotes','rotL','zIn','picker','isoLock','isoSnap','isoMore',
                   'xOneGo'];
      const missing = ids.filter(i => {
        const el = d.getElementById(i);
        return !el || (!el.onclick && !el.onchange);
      });
      console.log('handlers attached:', missing.length ? 'MISSING ' + missing.join(', ') : 'all');
      if (missing.length) errors.push('no handler on ' + missing.join(', '));

      console.log('icons injected   :', d.querySelectorAll('button img').length);
      const logo = d.getElementById('logo');
      const logoOK = logo && (logo.src || '').startsWith('data:image/png');
      console.log('logo applied     :', logoOK);
      if (!logoOK) errors.push('logo not applied');

      const blank = [...d.querySelectorAll('button')]
        .filter(b => !b.querySelector('img') && !b.textContent.trim())
        .map(b => b.id || '(unnamed)');
      console.log('blank buttons    :', blank.length ? blank : 'none');
      if (blank.length) errors.push('blank buttons: ' + blank.join(', '));

      const expectParent = {
        head: 'stage', bar: 'stage', viewwrap: 'stage', foot: 'stage',
        stagebox: 'viewwrap', view: 'stagebox', topbars: 'viewwrap',
  // The isosurface controls are docked in the footer with the action buttons,
  // not in the overlay row: they are used constantly while reviewing.
  isodock: 'stage', isobar: 'isodock', imgbar: 'topbars', zoombar: 'topbars',
        cubePanel: 'viewwrap', side: 'main', stage: 'main', tree: 'side',
      };
      const wrong = [];
      for (const [id, parent] of Object.entries(expectParent)) {
        const el = d.getElementById(id);
        if (!el) { wrong.push(`#${id} missing`); continue; }
        if (el.parentElement.id !== parent)
          wrong.push(`#${id} inside #${el.parentElement.id}, expected #${parent}`);
      }
      console.log('DOM hierarchy    :', wrong.length ? wrong : 'correct');
      if (wrong.length) errors.push(...wrong);

      console.log();
      console.log('problems:', errors.length ? errors : 'none');
      srv.close();
      process.exit(errors.length ? 1 : 0);
    }, 500);
  }).catch(e => { console.log('load failed:', e.message); srv.close(); process.exit(1); });
});
