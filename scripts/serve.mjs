// Minimal static file server so the viewer page can load the .glb through http
// (three's GLTFLoader refuses file:// requests).
//
//   node scripts/serve.mjs [port]
import { createServer } from 'node:http';
import { createReadStream, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[3] ?? process.cwd());
const port = Number(process.argv[2] ?? 5177);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.css': 'text/css; charset=utf-8',
};

createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);

  // Lets the page hand a canvas capture back to disk, so the render can be
  // inspected without a visible browser window.
  if (req.method === 'POST' && url === '/__shot') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const base64 = body.replace(/^data:image\/\w+;base64,/, '');
      const target = join(root, 'exports', 'changli-preview.png');
      writeFileSync(target, Buffer.from(base64, 'base64'));
      res.writeHead(200, { 'content-type': 'text/plain' }).end(target);
    });
    return;
  }
  const path = join(root, normalize(url === '/' ? '/viewer.html' : url).replace(/^([/\\])+/, ''));

  if (!path.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = statSync(path);
    if (info.isDirectory()) throw new Error('is a directory');
    res.writeHead(200, {
      'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`http://localhost:${port}/`));
