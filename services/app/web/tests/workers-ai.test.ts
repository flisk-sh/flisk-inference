import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseModelfile, workersAiUpstream } from "../src/workers-ai";

const modelfile = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "deploy", "Modelfile"), "utf-8");
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

describe("parseModelfile", () => {
  it("reads the system prompt and the example turns in order", () => {
    const msgs = parseModelfile(modelfile);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("You write Flisk service.json files");
    expect(msgs.slice(1).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(msgs.some((m) => m.content.includes('"""'))).toBe(false);
  });
});

describe("workersAiUpstream", () => {
  const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  const up = workersAiUpstream({
    ai: { run: async (model, input) => { calls.push({ model, input }); return { response: '{"a":1}', usage: { prompt_tokens: 7, completion_tokens: 3 } }; } },
    model: "@cf/qwen/qwen2.5-coder-32b-instruct", publicModel: "flisk-wolf", prelude: [{ role: "system", content: "rules" }],
  });
  it("puts the rules first, caps output tokens and answers in the OpenAI shape", async () => {
    const res = await up("/v1/chat/completions", post({ model: "flisk-wolf", max_tokens: 99999, messages: [{ role: "user", content: "hi" }] }));
    const json = (await res.json()) as { model: string; choices: Array<{ message: { content: string } }>; usage: { total_tokens: number } };
    expect(json.model).toBe("flisk-wolf");
    expect(json.choices[0].message.content).toBe('{"a":1}');
    expect(json.usage.total_tokens).toBe(10);
    expect(calls[0].model).toBe("@cf/qwen/qwen2.5-coder-32b-instruct");
    expect(calls[0].input.messages).toEqual([{ role: "system", content: "rules" }, { role: "user", content: "hi" }]);
    expect(calls[0].input.max_tokens).toBe(1024);
  });
  it("returns an answer the model gave as parsed JSON as text, the way OpenAI clients expect", async () => {
    const parsed = workersAiUpstream({ ai: { run: async () => ({ response: { appName: "x" } }) }, model: "m", publicModel: "p", prelude: [] });
    const json = (await (await parsed("/v1/chat/completions", post({ messages: [{ role: "user", content: "x" }] }))).json()) as { choices: Array<{ message: { content: unknown } }> };
    expect(json.choices[0].message.content).toBe('{\n  "appName": "x"\n}');
  });
  it("serves flisk-wolf-chat from the same model without the Flisk rules, and lists both names", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const two = workersAiUpstream({ ai: { run: async (_m, input) => { seen.push(input); return { response: "hello" }; } }, model: "m", publicModel: "flisk-wolf", prelude: [{ role: "system", content: "rules" }], others: { "flisk-wolf-chat": [] } });
    const json = (await (await two("/v1/chat/completions", post({ model: "flisk-wolf-chat", messages: [{ role: "user", content: "hi" }] }))).json()) as { model: string };
    expect(json.model).toBe("flisk-wolf-chat");
    expect(seen[0].messages).toEqual([{ role: "user", content: "hi" }]);
    await two("/v1/chat/completions", post({ model: "toString", messages: [{ role: "user", content: "hi" }] }));
    expect(seen[1].messages).toEqual([{ role: "system", content: "rules" }, { role: "user", content: "hi" }]);
    const list = (await (await two("/v1/models", { method: "GET" })).json()) as { data: Array<{ id: string }> };
    expect(list.data.map((m) => m.id).sort()).toEqual(["flisk-wolf", "flisk-wolf-chat"]);
  });
  it("lists only the public model name", async () => {
    expect(((await (await up("/v1/models", {})).json()) as { data: Array<{ id: string }> }).data.map((d) => d.id)).toEqual(["flisk-wolf"]);
  });
  it("refuses an empty conversation and reports a failed model call as 502", async () => {
    expect((await up("/v1/chat/completions", post({ messages: [] }))).status).toBe(400);
    const broken = workersAiUpstream({ ai: { run: async () => { throw new Error("quota"); } }, model: "m", publicModel: "p", prelude: [] });
    expect((await broken("/v1/chat/completions", post({ messages: [{ role: "user", content: "x" }] }))).status).toBe(502);
  });
});
