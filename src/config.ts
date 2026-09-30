import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const ProviderSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  kind: z.enum(["ollama", "openai"]),
  baseUrl: z.string(),
  apiKey: z.string().optional(),
});

export type Provider = z.infer<typeof ProviderSchema>;

export const ConfigSchema = z.object({
  model: z.string().default(""),
  providerId: z.string().default("ollama"),
  providers: z.array(ProviderSchema).default([]),
  orchestrator: z
    .object({
      enabled: z.boolean().default(true),
      review: z.boolean().default(true),
      maxRounds: z.number().int().min(0).max(5).default(1),
    })
    .default({ enabled: true, review: true, maxRounds: 1 }),
  maxSteps: z.number().int().min(1).max(50).default(24),
  temperature: z.number().default(0.2),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_PROVIDERS: Provider[] = [
  { id: "ollama", label: "Ollama", kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
  { id: "lmstudio", label: "LM Studio", kind: "openai", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "lm-studio" },
  { id: "llamacpp", label: "llama.cpp", kind: "openai", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "no-key" },
  { id: "vllm", label: "vLLM", kind: "openai", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "no-key" },
];

export function configPath(): string {
  const env = process.env.LOCALLOOM_CONFIG;
  if (env) return env;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = process.platform === "win32" ? join(process.env.APPDATA ?? homedir(), "localloom") : join(xdg ?? join(homedir(), ".config"), "localloom");
  return join(base, "config.json");
}

export function statePath(): string {
  const base = process.env.XDG_STATE_HOME ?? join(process.platform === "win32" ? tmpdir() : homedir(), ".local", "state");
  return join(base, "localloom", "last-model.json");
}

function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function loadConfig(): Config {
  const base = { providers: DEFAULT_PROVIDERS };
  const fromFile = { ...(readJson(configPath()) as object | undefined), ...(readJson("localloom.json") as object | undefined) };
  const raw = { ...base, ...fromFile };
  const parsed = ConfigSchema.safeParse(raw);
  const config = parsed.success ? parsed.data : ConfigSchema.parse(base);

  const envProvider = process.env.LOCALLOOM_BASE_URL;
  if (envProvider) {
    const kind: Provider["kind"] = envProvider.includes(":11434") ? "ollama" : "openai";
    config.providers = [
      { id: "env", label: "env", kind, baseUrl: envProvider, apiKey: process.env.LOCALLOOM_API_KEY },
      ...config.providers.filter((p) => p.id !== "env"),
    ];
    config.providerId = "env";
  }
  if (process.env.LOCALLOOM_MODEL) config.model = process.env.LOCALLOOM_MODEL;
  if (!config.model) config.model = readLastModel() ?? "";
  return config;
}

export function readLastModel(): string | undefined {
  const v = readJson(statePath());
  return typeof v === "object" && v && typeof (v as { model?: string }).model === "string" ? (v as { model: string }).model : undefined;
}

export function saveLastModel(providerId: string, model: string): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ providerId, model }, null, 2));
}

export function getProvider(config: Config, providerId?: string): Provider {
  const id = providerId ?? config.providerId;
  return config.providers.find((p) => p.id === id) ?? config.providers[0] ?? DEFAULT_PROVIDERS[0];
}
