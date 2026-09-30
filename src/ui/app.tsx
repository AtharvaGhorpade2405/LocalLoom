import { Box, Static, Text, useApp, useInput, useStdin } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { getProvider, loadConfig, type Config } from "../config.js";
import { orchestrate, type AgentEvent, type Phase } from "../orchestrator.js";
import { Markdown } from "./markdown.js";
import { ModelsDialog, type ModelEntry } from "./models.js";

interface Entry {
  id: number;
  role: "user" | "agent" | "note";
  label: string;
  body: string;
  streaming?: boolean;
  dim?: boolean;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const PHASE_COLOR: Record<Phase, string> = {
  plan: "magenta",
  build: "green",
  review: "yellow",
  fix: "cyan",
  direct: "green",
};

export function App(): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const configRef = useRef<Config>(loadConfig());
  const [config, setConfig] = useState<Config>(configRef.current);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [spinner, setSpinner] = useState(0);
  const [status, setStatus] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const seq = useRef(0);

  const provider = getProvider(config);
  const cwd = process.cwd();

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setSpinner((i) => i + 1), 90);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (!config.model) setStatus("no model selected — press /models to pick one");
    else setStatus("");
  }, [config.model]);

  const push = useCallback((entry: Omit<Entry, "id">) => {
    const id = ++seq.current;
    setEntries((prev) => [...prev, { ...entry, id }]);
    return id;
  }, []);

  const append = useCallback((id: number, text: string) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, body: e.body + text } : e)));
  }, []);

  const patch = useCallback((id: number, changes: Partial<Entry>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...changes } : e)));
  }, []);

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;
      setDraft("");

      if (text.startsWith("/")) {
        const [cmd, ...rest] = text.slice(1).split(/\s+/);
        if (cmd === "models") return setShowModels(true);
        if (cmd === "clear") return setEntries([]);
        if (cmd === "quit" || cmd === "q" || cmd === "exit") return exit();
        push({ role: "note", label: "localloom", body: `unknown command /${cmd}. try /models` });
        return;
      }

      if (!config.model) {
        push({ role: "note", label: "localloom", body: "no model selected. type /models to choose one." });
        setShowModels(true);
        return;
      }

      push({ role: "user", label: "you", body: text });
      setBusy(true);
      setStatus(`${SPINNER[0]} planning`);

      const controller = new AbortController();
      abortRef.current = controller;
      let live = 0;

      const onEvent = (event: AgentEvent) => {
        if (event.kind === "phase") {
          setStatus(`${SPINNER[spinner % SPINNER.length]} ${event.text ?? event.phase}`);
          if (event.phase !== (livePhase.current ?? event.phase)) {
            livePhase.current = event.phase;
            if (live) patch(live, { label: event.phase, streaming: false });
            live = push({ role: "agent", label: event.phase, body: "", streaming: true });
          }
        } else if (event.kind === "text") {
          if (!live) live = push({ role: "agent", label: event.phase, body: "", streaming: true });
          append(live, event.text ?? "");
        } else if (event.kind === "tool") {
          if (live) patch(live, { streaming: false });
          live = push({ role: "agent", label: event.phase, body: `· ${event.tool} ${event.detail ?? ""}`.trim(), dim: true });
          setStatus(`${SPINNER[spinner % SPINNER.length]} ${event.tool}`);
        } else if (event.kind === "tool_result") {
          if (live && event.text) append(live, `\n${event.text}\n`);
        } else if (event.kind === "error") {
          if (live) patch(live, { streaming: false, label: "error" });
          push({ role: "note", label: "error", body: event.text ?? "unknown error" });
        }
      };

      const livePhase = { current: null as Phase | null };

      try {
        await orchestrate({ config, provider, model: config.model, cwd, signal: controller.signal, onEvent }, text);
        if (live) patch(live, { streaming: false });
        push({ role: "note", label: "done", body: "press /models to switch model, ctrl+c to exit" });
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          if (live) patch(live, { streaming: false });
          push({ role: "note", label: "interrupted", body: "run stopped" });
        } else {
          if (live) patch(live, { streaming: false });
          push({ role: "note", label: "error", body: (error as Error).message });
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        setStatus("");
      }
    },
    [busy, config, cwd, exit, patch, provider, push, spinner],
  );

  useInput(
    (input, key) => {
      if (showModels) return;
      if (key.escape && busy) {
        abortRef.current?.abort();
        return;
      }
      if (key.ctrl && input === "c") {
        if (busy) abortRef.current?.abort();
        else exit();
        return;
      }
      if (key.return) {
        void submit(draft);
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((d) => d.slice(0, -1));
        return;
      }
      if (key.leftArrow) return setDraft((d) => d.slice(0, -1));
      if (key.rightArrow) return setDraft((d) => d + " ");
      if (input && !key.ctrl && !key.meta) setDraft((d) => d + input);
    },
    { isActive: !showModels && isRawModeSupported },
  );

  const visible = entries.filter((e) => !e.streaming);
  const live = entries.filter((e) => e.streaming);

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          localloom
        </Text>
        <Text dimColor>
          {config.model || "no model"} · {provider.label ?? provider.id}
        </Text>
      </Box>

      {showModels ? (
        <ModelsDialog
          config={config}
          current={{ providerId: config.providerId, model: config.model }}
          onClose={() => setShowModels(false)}
          onSelect={(entry: ModelEntry) => {
            setConfig({ ...config, model: entry.model, providerId: entry.provider.id });
            setStatus("");
          }}
        />
      ) : null}

      <Static items={visible}>
        {(entry) => (
          <Box key={entry.id} flexDirection="column" marginTop={1}>
            <Text color={entry.role === "user" ? "white" : entry.role === "note" ? "gray" : (PHASE_COLOR[entry.label as Phase] ?? "green")} bold>
              {entry.role === "user" ? "› " : entry.role === "note" ? "· " : ""}
              {entry.label}
            </Text>
            {entry.role === "note" ? (
              <Text dimColor>  {entry.body}</Text>
            ) : (
              <Box paddingLeft={2}>
                <Markdown text={entry.body} dim={Boolean(entry.dim)} />
              </Box>
            )}
          </Box>
        )}
      </Static>

      {live.map((entry) => (
        <Box key={entry.id} flexDirection="column" marginTop={1}>
          <Text color={PHASE_COLOR[entry.label as Phase] ?? "green"} bold>
            {entry.label}
          </Text>
          <Box paddingLeft={2}>
            <Markdown text={entry.body} streaming />
          </Box>
        </Box>
      ))}

      <Box flexDirection="column" marginTop={1}>
        {status ? (
          <Text dimColor> {status}</Text>
        ) : null}
        <Text>
          <Text color="green">❯ </Text>
          <Text>{draft}</Text>
          <Text inverse> </Text>
        </Text>
        <Text dimColor>
          {busy ? "esc interrupt · " : ""}
          {isRawModeSupported ? "enter send · /models · ctrl+c exit" : "stdin is not a tty — run localloom in a real terminal"}
        </Text>
      </Box>
    </Box>
  );
}
