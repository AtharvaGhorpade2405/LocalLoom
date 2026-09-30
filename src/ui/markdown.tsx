import { Box, Text } from "ink";
import React from "react";
import { useMemo, useState } from "react";

interface Block {
  kind: "code" | "text";
  text: string;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;

function Inline({ text, dim }: { text: string; dim?: boolean }): React.ReactElement {
  const parts = useMemo(() => text.split(INLINE).filter((p) => p !== ""), [text]);
  return (
    <Text dimColor={dim} wrap="truncate-end">
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) return <Text key={i} bold>{part.slice(2, -2)}</Text>;
        if (part.startsWith("`") && part.endsWith("`")) return <Text key={i} color="cyan">{part.slice(1, -1)}</Text>;
        if (part.startsWith("*") && part.endsWith("*")) return <Text key={i} italic>{part.slice(1, -1)}</Text>;
        return <Text key={i}>{part}</Text>;
      })}
    </Text>
  );
}

export function Markdown({ text, streaming, dim }: { text: string; streaming?: boolean; dim?: boolean }): React.ReactElement {
  const blocks = useMemo(() => parse(text), [text]);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) =>
        block.kind === "code" ? (
          <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
            <Box paddingLeft={1}>
              <Text color="gray">│ </Text>
              <Text color="cyan">{block.text}</Text>
            </Box>
          </Box>
        ) : (
          <Text key={i} dimColor={dim}>
            <Inline text={block.text} dim={dim} />
          </Text>
        ),
      )}
      {streaming ? <Text color="gray">▌</Text> : null}
    </Box>
  );
}

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let buffer: string[] = [];
  let code: string[] | null = null;
  let lang = "";

  const flush = () => {
    while (buffer.length && buffer[buffer.length - 1].trim() === "") buffer.pop();
    if (buffer.length) {
      blocks.push({ kind: "text", text: buffer.join("\n") });
      buffer = [];
    }
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      if (code) {
        blocks.push({ kind: "code", text: code.join("\n") });
        code = null;
      } else {
        flush();
        lang = fence[1] ?? "";
        code = lang ? [`  ${lang}`] : [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    buffer.push(line);
  }
  if (code) {
    if (code.length && lang) code.pop();
    blocks.push({ kind: "code", text: code.join("\n") });
  }
  flush();
  return blocks;
}
