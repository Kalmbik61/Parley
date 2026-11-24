#!/usr/bin/env node
// Optional http hook target: node hook-server.mjs <log-file> -> 127.0.0.1:<port> (written to <log-file>.port).
// Appends {headers, body} per POST and answers 200 {}.
import http from 'node:http';
import fs from 'node:fs';

const log = process.argv[2];
http
  .createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      fs.appendFileSync(log, `${JSON.stringify({ url: req.url, headers: req.headers, body: b })}\n`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  })
  .listen(0, '127.0.0.1', function () {
    fs.writeFileSync(`${log}.port`, String(this.address().port));
  });
