import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentUpstream, anthropicToOpenAI, messageAsEvents, openAIToAnthropic } from "../src/anthropic";
import { fileStore } from "../src/file-store";
import { createPortal } from "../src/portal";

const shot = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };

describe("anthropicToOpenAI", () => {
  it("maps system, text, images, tools, tool_use and tool_result", () => {
    const out = anthropicToOpenAI({
      system: [{ type: "text", text: "be a tester" }], max_tokens: 99999, tool_choice: { type: "any" },
      tools: [{ name: "Bash", description: "run", input_schema: { type: "object", properties: { cmd: { type: "string" } } } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }, shot] },
        { role: "assistant", content: [{ type: "text", text: "tapping" }, { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.txt" }, shot] }] },
      ],
    }, 4096) as { messages: Array<Record<string, unknown>>; max_tokens: number; tools: unknown[]; tool_choice: string };
    expect(out.max_tokens).toBe(4096);
    expect(out.tool_choice).toBe("required");
    expect(out.tools).toEqual([{ type: "function", function: { name: "Bash", description: "run", parameters: { type: "object", properties: { cmd: { type: "string" } } } } }]);
    expect(out.messages[0]).toEqual({ role: "system", content: "be a tester" });
    expect(out.messages[1].content).toEqual([{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]);
    expect(out.messages[2]).toEqual({ role: "assistant", content: "tapping", tool_calls: [{ id: "t1", type: "function", function: { name: "Bash", arguments: '{"cmd":"ls"}' } }] });
    expect(out.messages[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "a.txt" });
    expect(out.messages[4].content).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]);
  });
  it("keeps plain text turns as strings", () => {
    const out = anthropicToOpenAI({ messages: [{ role: "user", content: "hi" }] }, 10) as { messages: unknown[] };
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("openAIToAnthropic", () => {
  it("turns OpenAI tool calls into tool_use blocks with stop_reason tool_use", () => {
    const m = openAIToAnthropic({ choices: [{ message: { content: "ok", tool_calls: [{ id: "c1", function: { name: "Bash", arguments: '{"cmd":"ls"}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }, "flisk-wolf-agent") as { content: unknown[]; stop_reason: string; usage: unknown };
    expect(m.content).toEqual([{ type: "text", text: "ok" }, { type: "tool_use", id: "c1", name: "Bash", input: { cmd: "ls" } }]);
    expect(m.stop_reason).toBe("tool_use");
    expect(m.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
  });
  it("reads the older Workers AI shape and strips thinking notes", () => {
    const m = openAIToAnthropic({ response: "<think>x</think>done", tool_calls: [{ name: "Read", arguments: { path: "a" } }] }, "m") as { content: Array<Record<string, unknown>> };
    expect(m.content[0]).toEqual({ type: "text", text: "done" });
    expect(m.content[1]).toMatchObject({ type: "tool_use", name: "Read", input: { path: "a" } });
    expect(String(m.content[1].id).startsWith("toolu_")).toBe(true);
  });
});

describe("messageAsEvents", () => {
  it("sends the Anthropic event sequence", async () => {
    const msg = openAIToAnthropic({ choices: [{ message: { content: "hi", tool_calls: [{ id: "c", function: { name: "X", arguments: "{}" } }] } }] }, "m");
    const body = await messageAsEvents(msg).text();
    const names = [...body.matchAll(/^event: (.+)$/gm)].map((x) => x[1]);
    expect(names).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(body).toContain('"type":"input_json_delta"');
  });
});

describe("POST /v1/messages", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "anth-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const BASE = "http://portal.test";
  const ai = { run: async (_m: string, i: Record<string, unknown>) => ({ choices: [{ message: { content: `saw ${(i.messages as unknown[]).length}` } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }) };
  async function setup(dailyLimit = 500) {
    const portal = createPortal({ publicUrl: BASE, upstreamUrl: "http://u.test", store: fileStore(dir), indexHtml: () => readFileSync(join(import.meta.dir, "..", "public", "index.html"), "utf-8"),
      devLogin: async () => ({ id: 1, login: "o", name: "o", avatar_url: "" }), dailyLimit: 1,
      fetchImpl: (async () => new Response("{}", { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
      agent: { run: agentUpstream({ ai, model: "base", publicModel: "flisk-wolf-agent" }), dailyLimit, maxBody: 8 * 1024 * 1024 } });
    const cookie = ((await portal.fetch(new Request(`${BASE}/auth/dev`))).headers.get("set-cookie") ?? "").split(";")[0];
    const k = (await (await portal.fetch(new Request(`${BASE}/api/keys`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "t" }) }))).json()) as { key: string };
    return { portal, key: k.key };
  }
  const call = (p: ReturnType<typeof createPortal>, headers: Record<string, string>, body: unknown) =>
    p.fetch(new Request(`${BASE}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

  it("answers with x-api-key or Bearer, accepts a big screenshot, and rejects a bad key", async () => {
    const { portal, key } = await setup();
    const big = { messages: [{ role: "user", content: [{ type: "text", text: "go" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(500_000) } }] }] };
    const a = await call(portal, { "x-api-key": key }, { model: "claude-sonnet-4-5", max_tokens: 50, ...big });
    expect(a.status).toBe(200);
    expect(((await a.json()) as { content: Array<{ text: string }> }).content[0].text).toBe("saw 1");
    expect((await call(portal, { authorization: `Bearer ${key}` }, { model: "m", ...big })).status).toBe(200);
    expect((await call(portal, { "x-api-key": "nope" }, big)).status).toBe(401);
  });
  it("streams, counts tokens, and does not use up the shared chat limit", async () => {
    const { portal, key } = await setup();
    const s = await call(portal, { "x-api-key": key }, { stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(s.headers.get("content-type")).toContain("text/event-stream");
    expect(await s.text()).toContain("message_stop");
    const c = await portal.fetch(new Request(`${BASE}/v1/messages/count_tokens`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) }));
    expect(((await c.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
    // the shared limit is 1 chat call a day and was not touched by the agent calls above
    const chat = await portal.fetch(new Request(`${BASE}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) }));
    expect(chat.status).not.toBe(429);
  });
  it("stops at the per-key daily limit with an Anthropic-shaped error", async () => {
    const { portal, key } = await setup(1);
    expect((await call(portal, { "x-api-key": key }, { messages: [{ role: "user", content: "a" }] })).status).toBe(200);
    const r = await call(portal, { "x-api-key": key }, { messages: [{ role: "user", content: "b" }] });
    expect(r.status).toBe(429);
    expect(((await r.json()) as { type: string }).type).toBe("error");
  });
});
