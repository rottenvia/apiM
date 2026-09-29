import { ValidationError } from "./errors.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function problemWith(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return "record must be an object";
  if (typeof obj.id !== "string" || !obj.id) return "id must be a non-empty string";
  if (typeof obj.date !== "string" || !DATE.test(obj.date)) return `${obj.id}: date must be YYYY-MM-DD`;
  if (typeof obj.category !== "string" || !obj.category.trim()) return `${obj.id}: category is required`;
  if (typeof obj.amount !== "number" || !Number.isFinite(obj.amount) || obj.amount < 0) return `${obj.id}: amount must be a non-negative number`;
  return null;
}

/**
 * Parse and validate the JSON text of one record.
 * callback(err, record) where record is
 *   { id, date, category (trimmed, lower-case), amountCents, note }
 */
export function parseRecord(text, callback) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return callback(new ValidationError(`invalid JSON: ${e.message}`));
  }
  const problem = problemWith(obj);
  if (problem) return callback(new ValidationError(problem));
  callback(null, {
    id: obj.id,
    date: obj.date,
    category: obj.category.trim().toLowerCase(),
    amountCents: Math.round(obj.amount * 100),
    note: typeof obj.note === "string" ? obj.note : "",
  });
}
