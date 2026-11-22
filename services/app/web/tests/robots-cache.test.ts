import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore } from "../src/file-store";
import { createPortal } from "../src/portal";

const BASE = "https://inference.flisk.si";
const make = () => createPortal({ publicUrl: BASE, store: fileStore(mkdtempSync(join(tmpdir(), "inference-robots-"))), indexHtml: () => "<div id=\"root\"></div>" });
const get = (path: string) => make().fetch(new Request(BASE + path));

describe("crawler files", () => {
	it("caches robots.txt for a day without changing the body or content type", async () => {
		const res = await get("/robots.txt");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
		expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		const body = await res.text();
		expect(body).toContain("User-agent: *");
		expect(body).toContain(`Sitemap: ${BASE}/sitemap.xml`);
	});

	it("gives sitemap.xml the same cache rule", async () => {
		const res = await get("/sitemap.xml");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
		expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
	});

	it("also sends the cache rule on HEAD", async () => {
		const res = await make().fetch(new Request(BASE + "/robots.txt", { method: "HEAD" }));
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
		expect(await res.text()).toBe("");
	});
});
