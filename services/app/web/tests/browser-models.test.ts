import { expect, mock, test } from "bun:test";
import { BROWSER_ENGINE, BROWSER_MODELS, browserModelsResponse } from "../src/browser-models";
import { CATALOG } from "../src/catalog";

// wrangler.toml loads the Modelfile as text; Bun cannot parse it as a module.
mock.module("../../../../deploy/Modelfile", () => ({ default: "FROM test" }));

test("every browser model is complete, has one id, and exactly one default per task", () => {
  const ids = new Set<string>();
  for (const m of BROWSER_MODELS) {
    expect(ids.has(m.id)).toBe(false);
    ids.add(m.id);
    expect(m.name && m.description && m.model).toBeTruthy();
    expect(m.vramMB).toBeGreaterThan(100);
    expect(m.languages).toContain("en");
    expect(m.model).toMatch(/-MLC$/); // the engine's prebuilt ids
  }
  expect(BROWSER_MODELS.filter((m) => m.task === "chat" && m.default).length).toBe(1);
});

test("the engine is pinned to one exact version, in the url too", () => {
  expect(BROWSER_ENGINE.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(BROWSER_ENGINE.url).toContain(`@${BROWSER_ENGINE.version}`);
});

test("browser models are not in the catalog every picker draws from (a server cannot call them)", () => {
  const catalogIds = new Set(CATALOG.map((m) => m.id));
  for (const m of BROWSER_MODELS) expect(catalogIds.has(m.id)).toBe(false);
});

test("the list is public JSON any Flisk site can read, and it names the engine", async () => {
  const res = browserModelsResponse();
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  const body = (await res.json()) as { engine: { name: string }; data: unknown[] };
  expect(body.engine.name).toBe("@mlc-ai/web-llm");
  expect(body.data.length).toBe(BROWSER_MODELS.length);
});

test("the Worker serves /v1/browser-models with no key, cross-origin, and the catalog is unchanged", async () => {
  const { default: worker } = await import("../src/worker");
  const res = await worker.fetch(new Request("https://inference.flisk.si/v1/browser-models"), {} as never);
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const body = (await res.json()) as { data: Array<{ id: string }> };
  expect(body.data.map((m) => m.id)).toContain("flisk-browser-chat");
  const cat = (await (await worker.fetch(new Request("https://inference.flisk.si/v1/catalog"), {} as never)).json()) as { data: Array<{ id: string }> };
  expect(cat.data.some((m) => m.id.startsWith("flisk-browser"))).toBe(false);
});
