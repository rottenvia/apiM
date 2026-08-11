import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  // Keep the starter on the flat config export that actually runs under the pinned ESLint/Next toolchain.
  ...nextCoreWebVitals,
  /*
   * `data/` is the user's runtime data, not our source.
   *
   * It holds their chats and their workspaces — and a workspace contains
   * whatever the agent installed on their behalf. A Playwright install alone
   * ships thousands of lines of bundled, minified JavaScript, and linting it
   * produced 215 errors about React hooks in Playwright's own trace viewer.
   *
   * None of those are actionable: it is not our code, we cannot fix it, and
   * it must never be edited. Worse, the failure is silent for anyone whose
   * data folder is empty and appears only once the agent has done real work,
   * which is exactly when a red lint run is most confusing.
   *
   * `.test-data/` is the same thing for the parallel test runner.
   */
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "data/**",
    ".test-data/**",
  ]),
]);
