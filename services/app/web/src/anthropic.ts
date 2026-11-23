// Anthropic Messages API on top of the portal: POST /v1/messages in, a vision + tool-calling model out. Lets Claude Code (and
// anything else that speaks Anthropic's format) run on a Flisk Inference key: ANTHROPIC_BASE_URL=https://inference.flisk.si.
// The model call itself is OpenAI-shaped (Workers AI), so this file only translates in both directions.
import { SSE_HEADERS } from "./sse";
import type { AiBinding } from "./workers-ai";

type Json = Record<string, unknown>;
interface OaiMessage { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }

const text = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((b) => ((b as Json)?.type === "text" ? String((b as Json).text ?? "") : "")).filter(Boolean).join("\n");
  return "";
};
const dataUrl = (src: Json | undefined): string | null => {
  if (!src) return null;
  if (src.type === "base64") return `data:${String(src.media_type ?? "image/png")};base64,${String(src.data ?? "")}`;
  if (src.type === "url") return String(src.url ?? "");
  return null;
};

/** An Anthropic /v1/messages request as an OpenAI chat-completions request (tools and images kept). */
export function anthropicToOpenAI(body: Json, cap: number): Json {
  const out: OaiMessage[] = [];
  const system = text(body.system);
  if (system) out.push({ role: "system", content: system });
  for (const m of (Array.isArray(body.messages) ? body.messages : []) as Json[]) {
    const blocks: Json[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? (m.content as Json[]) : [];
    if (m.role === "assistant") {
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      const said = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
      out.push({ role: "assistant", content: said, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn: tool results become tool messages, in order; a picture inside a result rides along as a user message after it.
    const parts: unknown[] = [];
    const flush = () => { if (parts.length) { out.push({ role: "user", content: parts.every((p) => (p as Json).type === "text") ? parts.map((p) => (p as Json).text).join("\n") : [...parts] }); parts.length = 0; } };
    for (const b of blocks) {
      if (b.type === "tool_result") {
        flush();
        const inner = Array.isArray(b.content) ? (b.content as Json[]) : [];
        out.push({ role: "tool", tool_call_id: String(b.tool_use_id), content: text(b.content) || (b.is_error ? "error" : "ok") });
        const imgs = inner.filter((i) => i.type === "image").map((i) => dataUrl(i.source as Json)).filter((u): u is string => !!u);
        if (imgs.length) out.push({ role: "user", content: imgs.map((url) => ({ type: "image_url", image_url: { url } })) });
      } else if (b.type === "text") parts.push({ type: "text", text: String(b.text ?? "") });
      else if (b.type === "image") { const url = dataUrl(b.source as Json); if (url) parts.push({ type: "image_url", image_url: { url } }); }
    }
    flush();
  }
  const tools = (Array.isArray(body.tools) ? body.tools : []) as Json[];
  const choice = body.tool_choice as Json | undefined;
  return {
    messages: out,
    max_tokens: Math.min(Number(body.max_tokens) || cap, cap),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object", properties: {} } } })) } : {}),
    ...(tools.length && choice?.type === "any" ? { tool_choice: "required" } : {}),
    ...(tools.length && choice?.type === "tool" ? { tool_choice: { type: "function", function: { name: choice.name } } } : {}),
  };
}

interface OaiResult { choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }; finish_reason?: string }>;
  response?: unknown; tool_calls?: Array<{ id?: string; name?: string; arguments?: unknown }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }

const parseArgs = (a: unknown): Json => {
  if (a && typeof a === "object") return a as Json;
  try { const v = JSON.parse(String(a ?? "{}")); return v && typeof v === "object" ? (v as Json) : {}; } catch { return {}; }
};

/** What Workers AI (OpenAI-shaped or its older `response` + `tool_calls` shape) answered, as an Anthropic message. */
export function openAIToAnthropic(res: OaiResult, model: string): Json {
  const msg = res.choices?.[0]?.message;
  const raw = msg?.content ?? res.response ?? "";
  const said = (typeof raw === "string" ? raw : JSON.stringify(raw)).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const calls = (msg?.tool_calls ?? res.tool_calls ?? []).map((c) => {
    const f = (c as { function?: { name?: string; arguments?: unknown } }).function;
    return { id: c.id || `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`, name: String(f?.name ?? (c as { name?: string }).name ?? ""), input: parseArgs(f?.arguments ?? (c as { arguments?: unknown }).arguments) };
  }).filter((c) => c.name);
  const content: Json[] = [...(said ? [{ type: "text", text: said }] : []), ...calls.map((c) => ({ type: "tool_use", ...c }))];
  if (!content.length) content.push({ type: "text", text: "" });
  const length = res.choices?.[0]?.finish_reason === "length";
  return { id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`, type: "message", role: "assistant", model, content,
    stop_reason: calls.length ? "tool_use" : length ? "max_tokens" : "end_turn", stop_sequence: null,
    usage: { input_tokens: res.usage?.prompt_tokens ?? 0, output_tokens: res.usage?.completion_tokens ?? 0 } };
}

/** A whole Anthropic message as the server-sent events Claude Code reads when it asks for a stream. */
export function messageAsEvents(msg: Json): Response {
  const enc = new TextEncoder();
  const ev = (name: string, data: Json) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
  const usage = msg.usage as { input_tokens: number; output_tokens: number };
  let s = ev("message_start", { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } });
  (msg.content as Json[]).forEach((b, index) => {
    if (b.type === "tool_use") {
      s += ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      s += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) } });
    } else {
      s += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      s += ev("content_block_delta", { index, delta: { type: "text_delta", text: String(b.text ?? "") } });
    }
    s += ev("content_block_stop", { index });
  });
  s += ev("message_delta", { delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  s += ev("message_stop", {});
  return new Response(enc.encode(s), { headers: SSE_HEADERS });
}

export const anthropicError = (status: number, message: string, type = "invalid_request_error") => Response.json({ type: "error", error: { type, message } }, { status });

/** The model behind /v1/messages: one model that reads images and calls tools, whatever name the caller sends. Workers AI first; when it
 *  fails (its free daily allowance is used up, error 4006) the same request goes to OpenRouter, which takes the OpenAI body as it is. */
export function agentUpstream(opts: { ai: AiBinding; model: string; publicModel: string; maxTokens?: number; fallback?: { key: string; model: string; url?: string; fetchImpl?: typeof fetch } }) {
  const cap = opts.maxTokens ?? 4096;
  return async (anthropicBody: Json, signal?: AbortSignal): Promise<{ ok: true; message: Json; usage: { prompt_tokens: number; completion_tokens: number } } | { ok: false; status: number; message: string }> => {
    const input = anthropicToOpenAI(anthropicBody, cap);
    if (!(input.messages as unknown[]).length) return { ok: false, status: 400, message: "messages must not be empty" };
    let res: OaiResult | undefined;
    let failure = "";
    try { res = (await opts.ai.run(opts.model, input)) as OaiResult; }
    catch (e) { failure = (e as Error).message; }
    if (!res && opts.fallback) {
      try {
        const r = await (opts.fallback.fetchImpl ?? fetch)(opts.fallback.url ?? "https://openrouter.ai/api/v1/chat/completions", {
          method: "POST", signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.fallback.key}`, "x-title": "Flisk Inference" },
          body: JSON.stringify({ ...input, model: opts.fallback.model }),
        });
        if (r.ok) res = (await r.json()) as OaiResult;
        else failure = `${failure}; fallback answered ${r.status}`; // never pass the provider's error body on: it can name the key
      } catch (e) { failure = `${failure}; fallback failed: ${(e as Error).message}`; }
    }
    if (!res) return { ok: false, status: 502, message: `model call failed: ${failure}` };
    const message = openAIToAnthropic(res, opts.publicModel);
    const u = message.usage as { input_tokens: number; output_tokens: number };
    return { ok: true, message, usage: { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens } };
  };
}
