// Shared disposable file rendezvous. This is not a production security boundary.
const fs = require('node:fs');
const file = process.env.PROBE_LEASE;
const generation = process.env.PROBE_GENERATION;

exports.read = () => {
  if (!file || !generation) return null; // Unbound launches never access the rendezvous.
  const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
  return lease.generation === generation ? lease : null;
};
exports.write = (lease) => {
  const next = `${file}.${process.pid}`;
  fs.writeFileSync(next, JSON.stringify(lease));
  fs.renameSync(next, file);
};
exports.record = (event) => {
  if (file && generation) fs.appendFileSync(`${file}.events`, JSON.stringify({ generation, ...event }) + '\n');
};
