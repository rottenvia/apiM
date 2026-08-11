import { promises as fs } from "node:fs";
import path from "node:path";
import type { Plugin, PluginCategory } from "@/lib/plugins";

/**
 * File-backed store for user-authored plugins ("styles" / preprompts).
 *
 * Saved next to the chats in ./data so everything the user creates lives in
 * one place and can be edited or backed up by hand.
 */

/** Overridable so parallel test suites do not share one plugin store. */
const DATA_DIR = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.resolve(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "plugins.json");

export interface CustomPlugin extends Plugin {
  custom: true;
  createdAt: string;
  updatedAt: string;
}

const VALID_CATEGORIES: PluginCategory[] = [
  "token-saving",
  "enhancement",
  "formatting",
  "safety",
];

async function readAll(): Promise<CustomPlugin[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as CustomPlugin[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(plugins: CustomPlugin[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(plugins, null, 2), "utf8");
    await fs.rename(tmp, FILE);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function listCustomPlugins(): Promise<CustomPlugin[]> {
  return readAll();
}

export interface PluginInput {
  name?: string;
  icon?: string;
  description?: string;
  prompt?: string;
  category?: string;
}

export class PluginValidationError extends Error {}

/** Normalise and validate user input before it reaches the system prompt. */
function normalise(input: PluginInput): Omit<Plugin, "id"> {
  const name = (input.name ?? "").trim();
  const prompt = (input.prompt ?? "").trim();

  if (name.length < 1) throw new PluginValidationError("Name is required");
  if (name.length > 40)
    throw new PluginValidationError("Name must be 40 characters or fewer");
  if (prompt.length < 1) throw new PluginValidationError("Prompt is required");
  if (prompt.length > 4000)
    throw new PluginValidationError("Prompt must be 4000 characters or fewer");

  const category = VALID_CATEGORIES.includes(input.category as PluginCategory)
    ? (input.category as PluginCategory)
    : "enhancement";

  return {
    name,
    // Emoji can be multi-codepoint, so slice by character, not by code unit.
    icon: [...((input.icon ?? "").trim() || "✨")].slice(0, 2).join(""),
    description: (input.description ?? "").trim().slice(0, 140),
    category,
    prompt,
  };
}

export async function createPlugin(input: PluginInput): Promise<CustomPlugin> {
  const base = normalise(input);
  const now = new Date().toISOString();

  const plugin: CustomPlugin = {
    ...base,
    // Prefixed so a custom plugin can never collide with a built-in id.
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    custom: true,
    createdAt: now,
    updatedAt: now,
  };

  const all = await readAll();
  all.push(plugin);
  await writeAll(all);
  return plugin;
}

export async function updatePlugin(
  id: string,
  input: PluginInput
): Promise<CustomPlugin | null> {
  const all = await readAll();
  const index = all.findIndex((p) => p.id === id);
  if (index === -1) return null;

  const base = normalise(input);
  const updated: CustomPlugin = {
    ...all[index],
    ...base,
    updatedAt: new Date().toISOString(),
  };

  all[index] = updated;
  await writeAll(all);
  return updated;
}

export async function deletePlugin(id: string): Promise<boolean> {
  const all = await readAll();
  const next = all.filter((p) => p.id !== id);
  if (next.length === all.length) return false;
  await writeAll(next);
  return true;
}
