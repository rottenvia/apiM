// Copies the tool schemas and prompts from the web app (src/lib) into
// desktop/assets, so both versions hand the model the same text.
// Run from the repo root: npx tsx desktop/sync-from-web.mts
import { writeFileSync } from "node:fs";
import { WORKSPACE_TOOLS, GITHUB_TOOLS, WORK_LOOP_PROMPT } from "@/lib/tools";
import { AVAILABLE_PLUGINS, BASE_PROMPT, PLUGIN_DIRECTIVES_MARKER } from "@/lib/plugins";
import { MODELS, PROVIDER_INFO } from "@/lib/models";
import { BROWSER_POLICY_PROMPT, NO_BROWSER_PROMPT } from "@/lib/browser-policy";

const out = (name: string, data: unknown) =>
  writeFileSync(new URL(`./assets/${name}`, import.meta.url), JSON.stringify(data, null, 1) + "\n");

out("tools.json", [...WORKSPACE_TOOLS, ...GITHUB_TOOLS]);
out("plugins.json", AVAILABLE_PLUGINS);
out("models.json", { models: MODELS, providers: PROVIDER_INFO });
out("prompts.json", {
  base: BASE_PROMPT,
  workLoop: WORK_LOOP_PROMPT,
  browserPolicy: BROWSER_POLICY_PROMPT,
  noBrowser: NO_BROWSER_PROMPT,
  pluginMarker: PLUGIN_DIRECTIVES_MARKER,
});
console.log("synced");
