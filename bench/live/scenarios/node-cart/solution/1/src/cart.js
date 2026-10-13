// Cart arithmetic, in whole cents. The rules are in README.md.

export function lineTotal(item) {
  if (!Number.isInteger(item.qty) || item.qty < 1) throw new RangeError(`qty must be a whole number of 1 or more: ${item.qty}`);
  if (!Number.isInteger(item.priceCents) || item.priceCents < 0) throw new RangeError(`priceCents must be whole cents: ${item.priceCents}`);
  return item.qty * item.priceCents;
}

export function subtotal(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

export function discount(cents, percent) {
  if (!(percent >= 0 && percent <= 100)) throw new RangeError(`percent must be 0 to 100: ${percent}`);
  return Math.floor((cents * percent + 50) / 100);
}

export function total(items, percent = 0) {
  const sum = subtotal(items);
  return sum - discount(sum, percent);
}

export function format(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
