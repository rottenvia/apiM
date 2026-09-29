/**
 * Natural ("human") ordering for file names — reference solution.
 * (See the rules in the task's natsort.js.)
 */

const CHUNK = /\d+|\D+/g;
const isDigit = (s) => s.charCodeAt(0) >= 48 && s.charCodeAt(0) <= 57;
const stripZeros = (s) => s.replace(/^0+(?=\d)/, "");

function cmpNumeric(x, y) {
  const a = stripZeros(x);
  const b = stripZeros(y);
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function naturalCompare(a, b) {
  if (a === b) return 0;
  const ca = a.match(CHUNK) ?? [];
  const cb = b.match(CHUNK) ?? [];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i];
    const y = cb[i];
    const dx = isDigit(x);
    const dy = isDigit(y);
    let r;
    if (dx && dy) r = cmpNumeric(x, y);
    else if (dx) r = -1;
    else if (dy) r = 1;
    else r = cmpUnits(x.toLowerCase(), y.toLowerCase());
    if (r !== 0) return r;
  }
  if (ca.length !== cb.length) return ca.length - cb.length;
  for (let i = 0; i < n; i++) {
    if (isDigit(ca[i])) {
      const za = ca[i].length - stripZeros(ca[i]).length;
      const zb = cb[i].length - stripZeros(cb[i]).length;
      if (za !== zb) return za - zb;
    }
  }
  return cmpUnits(a, b);
}

export function naturalSort(items, { key = (x) => x, descending = false } = {}) {
  const decorated = items.map((item, index) => ({ item, index, k: key(item) }));
  decorated.sort((p, q) => {
    const r = naturalCompare(p.k, q.k);
    if (r !== 0) return descending ? -r : r;
    return p.index - q.index;
  });
  return decorated.map((d) => d.item);
}
