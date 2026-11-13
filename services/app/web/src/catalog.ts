// The models Flisk apps may offer, in one public list. Chat (chat.flisk.si) draws its model picker from it, so a model
// added here shows up in chat with no chat change. `free` models run on Flisk Inference itself; the others are called
// with the visitor's own key for that provider (`key`), which never reaches us. An empty `model` means the visitor types it.
export interface CatalogModel {
  id: string; name: string; provider: string; providerName: string; description: string;
  price: "free" | "$" | "$$" | "$$$"; free: boolean; key: "" | "anthropic" | "openai" | "openrouter"; model: string;
  tags: string[];
}

export const CATALOG: CatalogModel[] = [
  { id: "flisk-wolf-chat", name: "Flisk Wolf", provider: "flisk", providerName: "Flisk", description: "Free model for everyday tasks and small websites", price: "free", free: true, key: "", model: "flisk-wolf-chat", tags: ["code", "fast"] },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic", providerName: "Anthropic", description: "Fast, strong model for websites, code and everyday work", price: "$$", free: false, key: "anthropic", model: "claude-sonnet-5-5", tags: ["code", "reasoning"] },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", providerName: "Anthropic", description: "Anthropic's most capable model for long, demanding tasks", price: "$$$", free: false, key: "anthropic", model: "claude-opus-5-5", tags: ["code", "reasoning"] },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic", providerName: "Anthropic", description: "Quick and low-cost for short tasks", price: "$", free: false, key: "anthropic", model: "claude-haiku-5-5", tags: ["fast"] },
  { id: "openai", name: "OpenAI", provider: "openai", providerName: "OpenAI", description: "Any OpenAI model: type its name from your OpenAI model list", price: "$$", free: false, key: "openai", model: "", tags: [] },
  { id: "openrouter", name: "OpenRouter", provider: "openrouter", providerName: "OpenRouter", description: "Hundreds of models (Gemini, Llama, DeepSeek, Kimi, Qwen) with one OpenRouter key", price: "$", free: false, key: "openrouter", model: "", tags: [] },
];

export const catalogResponse = (): Response =>
  Response.json({ object: "list", data: CATALOG }, { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" } });
