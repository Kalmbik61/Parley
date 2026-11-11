#!/usr/bin/env node
// Command hook target: appends the stdin JSON payload (one line) to the file in argv[2].
import fs from 'node:fs';
let s = '';
process.stdin.on('data', (d) => (s += d));
process.stdin.on('end', () => fs.appendFileSync(process.argv[2], `${s.replace(/\n/g, ' ').trim()}\n`));
