"use client";

import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";

const Block = memo(function Block({
  text,
  components,
}: {
  text: string;
  components?: Components | null;
}) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components ?? undefined}>
      {text}
    </ReactMarkdown>
  );
});

/**
 * Markdown rendered one block at a time (see splitMarkdownBlocks). Finished
 * blocks keep their text and their memo, so a streaming reply only re-parses
 * the block still being written.
 */
export const BlockMarkdown = memo(function BlockMarkdown({
  text,
  components,
}: {
  text: string;
  components?: Components | null;
}) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  return (
    <>
      {blocks.map((block, i) => (
        <Block key={i} text={block} components={components} />
      ))}
    </>
  );
});
