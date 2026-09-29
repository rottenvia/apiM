/**
 * Natural ("human") ordering for file names.
 *
 * naturalCompare(a, b) -> a negative number if a sorts first, a positive
 * number if b sorts first, 0 only if a === b. It must be a consistent
 * comparator (usable with Array.prototype.sort) for any strings.
 *
 * Rules, applied in order — a later rule only breaks ties left by the
 * earlier ones:
 *
 * 1. Split each string into chunks: maximal runs of ASCII digits 0-9, and
 *    maximal runs of everything else ("text").
 *    Compare the chunks pairwise from the left:
 *      - digit vs digit: by numeric value. Numbers can be arbitrarily long
 *        and must still compare exactly.
 *      - text vs text: case-insensitively, by comparing their
 *        toLowerCase() forms code unit by code unit (NOT locale-aware).
 *      - digit vs text: the digit chunk sorts first.
 *    If all chunks of one string match the start of the other, the one with
 *    fewer chunks sorts first ("file" < "file1" < "file1a").
 *    So "file2" < "file10", "1.9" < "1.10" < "1.10.1" < "2.0".
 * 2. Leading zeros: compare the digit chunks pairwise from the left again;
 *    at the first pair whose number of leading zeros differs, the one with
 *    fewer leading zeros sorts first: "a1" < "a01" < "a001", "0" < "00".
 * 3. Case: compare the original strings code unit by code unit; at the
 *    first difference, the smaller code unit sorts first (so upper-case
 *    before lower-case: "File" < "file").
 *
 * naturalSort(items, { key, descending } = {}) -> a NEW array, sorted by
 *   naturalCompare of key(item) (key defaults to the item itself, for
 *   arrays of strings). The input array is not modified. The sort is stable:
 *   items whose keys compare equal keep their original relative order, also
 *   when descending is true (descending only reverses the order of items
 *   whose keys differ).
 */

export function naturalCompare(a, b) {
  throw new Error("not implemented");
}

export function naturalSort(items, options = {}) {
  throw new Error("not implemented");
}
