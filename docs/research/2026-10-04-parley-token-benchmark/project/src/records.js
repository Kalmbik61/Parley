export function makeRecord(kind, seq) {
  return { id: `${kind}-${seq}`, kind };
}
