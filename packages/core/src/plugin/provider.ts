import { OllamaPlugin } from "./provider/ollama.js"
import type { PluginInternal } from "./internal.js"

export const ProviderPlugins: PluginInternal.InternalPlugin[] = [
  OllamaPlugin,
]
