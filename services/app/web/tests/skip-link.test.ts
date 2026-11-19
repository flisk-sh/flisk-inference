import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore } from "../src/file-store";
import { createPortal } from "../src/portal";

const skip = '<a class="skip-link" href="#main">Skip to content</a>';
const indexHtml = readFileSync(join(import.meta.dir, "..", "public", "index.html"), "utf-8");

describe("inference skip link", () => {
	it("puts the skip link first in the app shell body", () => {
		expect(indexHtml).toMatch(/<body>\s*<a class="skip-link" href="#main">Skip to content<\/a>/);
		expect(indexHtml.indexOf(skip)).toBeLessThan(indexHtml.indexOf('<div id="root">'));
	});

	it("gives the app main landmark an id for the skip link", () => {
		expect(indexHtml).toContain('h("main",{id:"main"}');
	});

	it("keeps the app skip link hidden until focused", () => {
		expect(indexHtml).toMatch(/\.skip-link\{[^}]*left:-9999px/);
		expect(indexHtml).toMatch(/\.skip-link:focus\{[^}]*left:12px/);
	});

	it("adds a skip link and main target to info pages", async () => {
		const dir = mkdtempSync(join(tmpdir(), "inference-skip-"));
		const portal = createPortal({
			publicUrl: "http://portal.test",
			upstreamUrl: "http://upstream.test",
			store: fileStore(dir),
			indexHtml: () => indexHtml,
		});
		const res = await portal.fetch(new Request("http://portal.test/no-such-page", { headers: { accept: "text/html" } }));
		const html = await res.text();
		expect(res.status).toBe(404);
		expect(html).toContain(skip);
		expect(html).toContain('<main id="main">');
		expect(html.indexOf(skip)).toBeLessThan(html.indexOf('<main id="main">'));
		expect(html).toMatch(/\.skip-link\{[^}]*left:-9999px/);
		expect(html).toMatch(/\.skip-link:focus\{[^}]*left:12px/);
	});
});
