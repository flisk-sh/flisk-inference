// Serves the portal's /v1 API from Cloudflare Workers AI: the Flisk rules and examples from deploy/Modelfile go in
// front of every conversation, and the answer comes back in the OpenAI chat-completions shape.
export interface ChatMessage { role: string; content: string }
export interface AiBinding { run(model: string, input: Record<string, unknown>): Promise<unknown> }

/** The SYSTEM prompt and MESSAGE examples of an Ollama Modelfile, as chat messages. */
export function parseModelfile(text: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  const re = /^(SYSTEM|MESSAGE (user|assistant)) """([\s\S]*?)"""/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ role: m[2] ?? "system", content: m[3] });
  return out;
}

export function workersAiUpstream(opts: { ai: AiBinding; model: string; publicModel: string; prelude: ChatMessage[]; maxTokens?: number }) {
  const maxTokens = opts.maxTokens ?? 1024;
  return async (path: string, init: RequestInit): Promise<Response> => {
    if (path === "/v1/models") return Response.json({ object: "list", data: [{ id: opts.publicModel, object: "model", owned_by: "flisk" }] });
    if (path !== "/v1/chat/completions" || init.method !== "POST") return Response.json({ error: { message: "not found" } }, { status: 404 });
    const body = JSON.parse(String(init.body ?? "{}")) as { messages?: ChatMessage[]; max_tokens?: number };
    const messages = (body.messages ?? []).filter((m) => m && typeof m.content === "string").map((m) => ({ role: String(m.role), content: m.content }));
    if (!messages.length) return Response.json({ error: { message: "messages must not be empty", type: "invalid_request_error" } }, { status: 400 });
    let res: { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: Array<{ message?: { content?: string } }> };
    try {
      res = (await opts.ai.run(opts.model, { messages: [...opts.prelude, ...messages], max_tokens: Math.min(Number(body.max_tokens) || maxTokens, maxTokens), temperature: 0 })) as typeof res;
    } catch (e) {
      return Response.json({ error: { message: `model call failed: ${(e as Error).message}`, type: "api_error" } }, { status: 502 });
    }
    // Workers AI hands back JSON-looking answers already parsed; OpenAI clients expect the content as text.
    const raw = res.response ?? res.choices?.[0]?.message?.content ?? "";
    const content = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
    const usage = { prompt_tokens: res.usage?.prompt_tokens ?? 0, completion_tokens: res.usage?.completion_tokens ?? 0 };
    return Response.json({
      id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: opts.publicModel,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
    });
  };
}
