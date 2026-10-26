/* ---------------------------------------------------------------------------
 * serve.js — zero-dependency static server
 *
 * `python -m http.server` is unavailable on this machine (the `python` on PATH
 * is the Microsoft Store alias stub), so this stands in. Node only, no install.
 *
 *   node serve.js          -> http://localhost:8000
 *   node serve.js 3000     -> http://localhost:3000
 * ------------------------------------------------------------------------- */

const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2]) || 8000;
const root = __dirname;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
};

http
  .createServer((req, res) => {
    /* This is a static file server: it has nothing to receive a form POST
     * with. Without this guard it would answer one with 200 and the page's
     * index.html, the fetch in js/form.js would see res.ok, and the visitor
     * would get the success state for a lead that went nowhere. Netlify Forms
     * only exists on a deploy, so locally the honest answer is 405 — which
     * exercises the form's real error path. Set FORM.devEcho in js/config.js
     * to inspect the success state instead. */
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
      return res.end('405 — static server; form POSTs are handled by Netlify on deploy.');
    }

    // Strip the query string and normalise away any `..` traversal.
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const safe = path.normalize(rel).replace(/^(\.\.[\\/])+/, '');
    let file = path.join(root, safe);

    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      file = path.join(file, 'index.html');
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('404');
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        // No caching, so a re-extracted frame set shows up on reload.
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  })
  .listen(port, () => console.log(`CARTA 60 -> http://localhost:${port}`));
