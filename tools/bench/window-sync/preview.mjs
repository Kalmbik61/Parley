// Parley-browser-first UI preview. Transport is an explicit disconnected stub;
// actual Electron/IPC evidence is collected separately by the e2e fixture.
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
const root = path.resolve(process.argv[2], 'packages/desktop/out/renderer');
const stub = `<script>
const noop=()=>{};let api;
api=new Proxy(function(){return Promise.resolve(null)},{get(_t,key){if(key==='then')return undefined;if(String(key).startsWith('on'))return()=>noop;return api;}});
window.parley=new Proxy({app:new Proxy({isDark:()=>true,version:async()=>'P7 browser preview',onAppearance:()=>noop},{get:(t,k)=>t[k]??api}),on:()=>noop,onStatus:cb=>{queueMicrotask(()=>cb({state:'disconnected'}));return noop;}},{get:(t,k)=>t[k]??api});
</script>`;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  try {
    let data = await fs.readFile(file);
    if (file.endsWith('.html')) data = data.toString().replace('<head>', '<head>' + stub);
    response.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream'); response.end(data);
  } catch { response.writeHead(404).end(); }
});
server.listen(Number(process.argv[3] ?? 44218), '127.0.0.1', () => process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, transport: 'disconnected stub; not Electron evidence' }) + '\n'));
