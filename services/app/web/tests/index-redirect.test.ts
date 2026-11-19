import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore } from "../src/file-store";
import { createPortal } from "../src/portal";

const BASE = "https://inference.flisk.si";
const make = () => {
	const dir = mkdtempSync(join(tmpdir(), "inference-index-"));
	return createPortal({
		publicUrl: BASE,
		upstreamUrl: "http://upstream.test",
		store: fileStore(dir),
		indexHtml: () => readFileSync(join(import.meta.dir, "..", "public", "index.html"), "utf-8"),
	});
};
const get = (path: string) => make().fetch(new Request(BASE + path, { headers: { accept: "text/html" } }));

describe("/index.html redirect", () => {
	it("answers 301 to /", async () => {
		const res = await get("/index.html");
		expect(res.status).toBe(301);
		expect(res.headers.get("location")).toBe(BASE + "/");
	});

	it("preserves the query string", async () => {
		const res = await get("/index.html?section=keys");
		expect(res.status).toBe(301);
		expect(res.headers.get("location")).toBe(BASE + "/?section=keys");
	});

	it("still serves / with 200, including query strings", async () => {
		for (const path of ["/", "/?section=keys"]) {
			const res = await get(path);
			expect(res.status).toBe(200);
			expect((await res.text()).includes('<div id="root">')).toBe(true);
		}
	});
});
