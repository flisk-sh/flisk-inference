import { expect, test } from "bun:test";
import { CATALOG, catalogResponse } from "../src/catalog";

test("catalog lists the free Flisk model first and every entry is complete", () => {
  expect(CATALOG[0]).toMatchObject({ id: "flisk-wolf-chat", free: true, key: "" });
  const ids = new Set<string>();
  for (const m of CATALOG) {
    expect(ids.has(m.id)).toBe(false);
    ids.add(m.id);
    expect(m.name && m.providerName && m.description).toBeTruthy();
    expect(m.free).toBe(m.key === "");
  }
});

test("catalog is public JSON any Flisk site can read", async () => {
  const res = catalogResponse();
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  const body = (await res.json()) as { data: unknown[] };
  expect(body.data.length).toBe(CATALOG.length);
});
