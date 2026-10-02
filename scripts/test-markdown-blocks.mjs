/**
 * Block-by-block markdown must look exactly like the whole reply parsed at
 * once. Rendering per block is what keeps long streamed replies smooth (only
 * the last block re-parses), so a split that changed the output would trade
 * lag for wrong formatting. Each case renders both ways and compares HTML.
 *
 * Run with: npx tsx scripts/test-markdown-blocks.mjs
 */
import assert from "node:assert/strict";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitMarkdownBlocks } from "../src/lib/markdown-blocks.ts";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : err}`);
  }
}

const md = (text) => createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, text);
const whole = (text) => renderToStaticMarkup(md(text));
const blocked = (text) =>
  renderToStaticMarkup(createElement(Fragment, null, ...splitMarkdownBlocks(text).map((b, i) => createElement(Fragment, { key: i }, md(b)))));
// Newlines between two tags are the only allowed difference: whitespace
// between block elements is not drawn, inside <pre> it never occurs this way.
const norm = (html) => html.replace(/>\n</g, "><");
const same = (text) => assert.equal(norm(blocked(text)), norm(whole(text)));

const CASES = {
  "paragraphs and headings": "# Title\n\nFirst paragraph\nwith a soft break.\n\n## Next\n\nSecond paragraph.",
  "a code fence with blank lines inside": "Intro\n\n```js\nconst a = 1;\n\n\nconst b = 2;\n```\n\nAfter.",
  "a tilde fence containing a backtick fence": "~~~md\n```\ninner\n\n```\n~~~\n\nDone.",
  "a tight bullet list": "Items:\n\n- one\n- two\n- three\n\nEnd.",
  "a loose list with blank lines between items": "- one\n\n- two\n\n- three\n\nEnd.",
  "an ordered list starting at 3, loose": "3. three\n\n4. four\n\n5. five",
  "a list item with an indented paragraph": "- item\n\n  more of the item\n\n- next\n\nAfter list.",
  "a nested list": "- a\n  - a1\n  - a2\n- b\n\nText.",
  "a table": "| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter the table.",
  "a blockquote": "> quoted\n> lines\n\nNot quoted.",
  "inline code, bold and links": "Use `x` and **bold** and [a link](https://example.com).\n\nNext.",
  "an unclosed fence (mid-stream)": "Writing:\n\n```python\nprint('hi')\n\nprint('still code')",
  "indented code after a paragraph": "Para\n\n    indented code\n\n    more code\n\nBack.",
  "a horizontal rule": "Above\n\n---\n\nBelow",
};
for (const [name, text] of Object.entries(CASES)) test(`renders the same: ${name}`, () => same(text));

test("a long streamed reply really is split into many blocks", () => {
  const text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} with some words.`).join("\n\n");
  assert.equal(splitMarkdownBlocks(text).length, 50);
});

test("finished blocks keep identical text as the stream grows (so their memo holds)", () => {
  const full = "# H\n\nOne.\n\n```js\nx()\n```\n\n- a\n- b\n\nTail text growing";
  const a = splitMarkdownBlocks(full.slice(0, full.length - 8));
  const b = splitMarkdownBlocks(full);
  for (let i = 0; i < a.length - 1; i++) assert.equal(a[i], b[i], `block ${i} changed`);
});

test("empty and whitespace-only text give no blocks", () => {
  assert.deepEqual(splitMarkdownBlocks(""), []);
  assert.deepEqual(splitMarkdownBlocks("\n\n  \n"), []);
});

console.log(`\n${passed + failed} checks · ${passed} passed${failed ? ` · ${failed} failed` : ""}`);
if (failed) process.exit(1);
