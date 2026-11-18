// Models that run in the visitor's own browser tab (WebGPU), no server and no cost. The list is public, like /v1/catalog,
// but separate from it: a model in CATALOG is one a server calls, and every picker draws from CATALOG, so a model that only
// the tab can run must not be in there. Chat (chat.flisk.si) reads this list as its last tier, when every free model on
// the server is busy: the server sends the web results it already has, and the tab writes the answer from them.
//
// Rule for Flisk apps: AI reaches an app only through models served here. A browser model or a browser classifier is added
// to this file first; the app then asks inference for it and never hosts a model of its own.
export interface BrowserModel {
  id: string;
  name: string;
  // What it is for: "chat" writes an answer; "classify" picks one of a few labels (language, kind of ask, a reply's verdict).
  task: "chat" | "classify";
  engine: "web-llm";
  // The model id the engine loads, exactly as in the engine's prebuilt list.
  model: string;
  // WebGPU memory the model needs, from the engine's prebuilt list. A device with less must not try.
  vramMB: number;
  languages: string[];
  description: string;
  default?: boolean;
}

// The engine, pinned: a page that loads it must load exactly this version.
export const BROWSER_ENGINE = { name: "@mlc-ai/web-llm", version: "0.2.89", url: "https://esm.run/@mlc-ai/web-llm@0.2.89", needs: "webgpu" } as const;

export const BROWSER_MODELS: BrowserModel[] = [
  { id: "flisk-browser-chat", name: "Flisk Browser", task: "chat", engine: "web-llm", model: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", vramMB: 1630, languages: ["en", "uk", "ru", "de", "fr", "es", "pt", "it", "pl", "zh", "ja", "ko"], description: "Writes the answer inside your browser tab from the web results chat found. About 1 GB downloaded once, then cached. Needs WebGPU", default: true },
  { id: "flisk-browser-chat-lite", name: "Flisk Browser Lite", task: "chat", engine: "web-llm", model: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", vramMB: 945, languages: ["en", "uk", "ru", "de", "fr", "es", "pt", "it", "pl", "zh", "ja", "ko"], description: "The same idea for weaker devices: about 400 MB downloaded once. Shorter, simpler answers. Needs WebGPU" },
];

export const browserModelsResponse = (): Response =>
  Response.json({ object: "list", engine: BROWSER_ENGINE, data: BROWSER_MODELS }, { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" } });
