// Cart arithmetic, in whole cents. The rules are in README.md.

export function lineTotal(item) {
  return item.qty * item.priceCents;
}

export function subtotal(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

export function discount(cents, percent) {
  return Math.floor((cents * percent) / 100);
}

export function total(items, percent = 0) {
  const sum = subtotal(items);
  return sum - discount(sum, percent);
}

export function format(cents) {
  return (cents / 100).toFixed(2);
}
