import { expect, mock, test } from "bun:test";
import { BROWSER_ENGINE } from "../src/browser-models";
import { MAX_ANSWER_TOKENS, MAX_CONTENT, MAX_MESSAGES, RUNNER_CSP, runnerHtml } from "../src/browser-runner";

mock.module("../../../../deploy/Modelfile", () => ({ default: "FROM test" }));
const { default: worker } = await import("../src/worker");

test("the page loads the one pinned engine version, and nothing else from a CDN", () => {
  const html = runnerHtml();
  expect(html).toContain(JSON.stringify(BROWSER_ENGINE.url));
  expect(html.match(/https?:\/\/[a-z0-9.-]+/gi)?.filter((u) => !/esm\.run|w3|flisk\.si|localhost|127\.0\.0\.1/.test(u)) ?? []).toEqual([]);
});

test("it answers only *.flisk.si pages (and localhost), and only the window that framed it", () => {
  const html = runnerHtml();
  const re = new RegExp(/var OK=\/(.*)\/;/.exec(html)![1].replace(/\\\//g, "/"));
  for (const ok of ["https://chat.flisk.si", "https://flisk.si", "https://a.b.flisk.si", "http://localhost:3000", "http://127.0.0.1:8787"]) expect(re.test(ok)).toBe(true);
  for (const bad of ["https://evil.com", "https://flisk.si.evil.com", "https://evilflisk.si", "http://flisk.si", "https://chat.flisk.si.evil.com", "http://localhost.evil.com", "null"]) expect(re.test(bad)).toBe(false);
  expect(html).toContain("e.source!==parent");
});

test("it runs only a model inference serves for the browser, validates the messages and caps the answer", () => {
  const html = runnerHtml();
  expect(html).toContain('fetch("/v1/browser-models")');
  expect(html).toContain("that model is not one");
  expect(html).toContain(`messages.length>${MAX_MESSAGES}`);
  expect(html).toContain(`m.content.length>${MAX_CONTENT}`);
  expect(html).toContain(`Math.min(Number(m.maxTokens)||512,${MAX_ANSWER_TOKENS})`);
});

test("CSP: no default sources, the engine and weights from named hosts, framed only by *.flisk.si and localhost", () => {
  expect(RUNNER_CSP).toContain("default-src 'none'");
  expect(RUNNER_CSP).toContain("frame-ancestors https://*.flisk.si");
  expect(/frame-ancestors ([^;]*)/.exec(RUNNER_CSP)![1].split(" ")).toEqual(["https://*.flisk.si", "http://localhost:*", "http://127.0.0.1:*"]); // nobody else may frame it
  expect(RUNNER_CSP).toContain("https://huggingface.co");
  expect(RUNNER_CSP).not.toContain("'unsafe-eval'"); // WebAssembly only ('wasm-unsafe-eval'), never eval of text
});

test("the Worker serves /browser-model as an uncached page, framable by chat, with the baseline headers kept", async () => {
  const res = await worker.fetch(new Request("https://inference.flisk.si/browser-model"), {} as never);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("content-security-policy")).toBe(RUNNER_CSP);
  expect(res.headers.get("x-frame-options")).toBeNull(); // frame-ancestors in the CSP decides, X-Frame-Options would say no
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});
