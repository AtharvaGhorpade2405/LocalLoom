import { Box, Text, useInput, useStdin } from "ink";
import React, { useMemo, useState } from "react";
import { listModels } from "../llm.js";
import { saveLastModel, type Config, type Provider } from "../config.js";

export interface ModelEntry {
  provider: Provider;
  model: string;
}

export interface ModelsDialogProps {
  config: Config;
  current: { providerId: string; model: string };
  onClose: () => void;
  onSelect: (entry: ModelEntry) => void;
}

export function ModelsDialog(props: ModelsDialogProps): React.ReactElement {
  const { config, current, onClose, onSelect } = props;
  const { isRawModeSupported } = useStdin();
  const [entries, setEntries] = useState<ModelEntry[]>([]);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("");

  const providers = useMemo(() => config.providers, [config.providers]);

  useMemo(() => {
    if (loaded) return;
    setLoaded(true);
    void (async () => {
      const found: ModelEntry[] = [];
      for (const provider of providers) {
        const models = await listModels(provider.kind, provider.baseUrl, provider.apiKey);
        for (const model of models) found.push({ provider, model });
      }
      setEntries(found);
    })();
  }, [loaded, providers]);

  const visible = useMemo(
    () => (filter ? entries.filter((e) => e.model.toLowerCase().includes(filter.toLowerCase())) : entries),
    [entries, filter],
  );
  const activeIndex = visible.length === 0 ? 0 : Math.min(index, visible.length - 1);
  const active = visible[activeIndex];

  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.return) {
      if (active) {
        saveLastModel(active.provider.id, active.model);
        onSelect(active);
      }
      return onClose();
    }
    if (key.upArrow) return setIndex((i) => Math.max(0, activeIndex - 1));
    if (key.downArrow) return setIndex((i) => Math.min(visible.length - 1, activeIndex + 1));
    if (key.backspace || key.delete) return setFilter((f) => f.slice(0, -1));
    if (input && !key.ctrl && !key.meta) setFilter((f) => f + input);
  }, { isActive: isRawModeSupported });

  const window = visible.slice(Math.max(0, activeIndex - 6), Math.max(0, activeIndex - 6) + 13);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Text bold color="cyan">
        select model
      </Text>
      <Text dimColor>↑↓ select · enter apply · esc cancel · type to filter</Text>
      {filter ? (
        <Text>
          filter: <Text color="yellow">{filter}</Text>
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {loaded && visible.length === 0 ? (
          <Text dimColor>no local models found — is ollama / lm studio / llama.cpp running?</Text>
        ) : null}
        {window.map((entry, i) => {
          const idx = Math.max(0, activeIndex - 6) + i;
          const selected = idx === activeIndex;
          const isCurrent = entry.provider.id === current.providerId && entry.model === current.model;
          return (
            <Text key={`${entry.provider.id}/${entry.model}`} color={selected ? "cyan" : undefined} bold={selected}>
              {selected ? "❯ " : "  "}
              {entry.model}
              <Text color="gray"> · {entry.provider.label ?? entry.provider.id}</Text>
              {isCurrent ? <Text color="green"> (active)</Text> : null}
            </Text>
          );
        })}
      </Box>
      {active ? (
        <Text dimColor>
          {active.provider.kind} · {active.provider.baseUrl}
        </Text>
      ) : null}
    </Box>
  );
}
