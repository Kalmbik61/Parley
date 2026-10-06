export function makeRecord(kind, seq) {
  return { id: `${kind}-${seq}`, kind };
}

let invoiceCounter = 0;

export function makeInvoice(total) {
  invoiceCounter += 1;
  return { id: `bnch_inv_${invoiceCounter}`, kind: 'invoice', total };
}
