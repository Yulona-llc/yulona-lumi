import { describe, expect, it } from "vitest";
import { brandStyle, readableOn } from "../src/App";
import { mount } from "../src/mount";
import { createMockFetch } from "../src/mock";

describe("brand gradient", () => {
  it("falls back to a solid fill for old configs", () => {
    expect(brandStyle({ primaryColor: "#112233" })).toEqual({ "--c": "#112233", "--cbg": "#112233", "--c-fg": "#fff" });
    expect(brandStyle(undefined)["--cbg"]).toBe("#4f46e5");
  });
  it("builds a linear-gradient and picks text from the mid colour", () => {
    const s = brandStyle({ primaryColor: "#000000", appearance: { mode: "gradient", color: "#ffee00", color2: "#ffffff", angle: 90 } });
    expect(s["--cbg"]).toBe("linear-gradient(90deg, #ffee00, #ffffff)");
    expect(s["--c"]).toBe("#fff780");
    expect(s["--c-fg"]).toBe(readableOn("#fff780"));
    expect(s["--c-fg"]).toBe("#14161f");
    const dark = brandStyle({ primaryColor: "#000000", appearance: { mode: "gradient", color: "#1e1b4b", color2: "#7c3aed", angle: 135 } });
    expect(dark["--c-fg"]).toBe("#fff");
  });
  it("ignores an unsafe or missing second colour and solid mode", () => {
    expect(brandStyle({ primaryColor: "#000000", appearance: { mode: "gradient", color: "#112233", color2: "red;x", angle: 10 } })["--cbg"]).toBe("#112233");
    expect(brandStyle({ primaryColor: "#000000", appearance: { mode: "solid", color: "#112233", color2: "#ffffff", angle: 10 } })["--cbg"]).toBe("#112233");
  });
  it("applies the gradient variable on the mounted widget", async () => {
    const fetchImpl = createMockFetch({ latency: 0 });
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetchImpl(input, init);
      if (!String(input).includes("/config")) return res;
      const j = await res.json();
      j.config.appearance = { mode: "gradient", color: "#f97316", color2: "#ec4899", angle: 45 };
      return new Response(JSON.stringify(j), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const w = mount({ widgetKey: "wk_t", open: true, apiBase: "http://m/api/v1" }, wrapped);
    const root = document.querySelector("[data-yulona-widget]")!.shadowRoot!;
    const t = Date.now();
    while (!root.querySelector(".y-root")?.getAttribute("style")?.includes("linear-gradient")) {
      if (Date.now() - t > 3000) throw new Error("gradient not applied");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(root.querySelector(".y-root")!.getAttribute("style")).toContain("linear-gradient(45deg, #f97316, #ec4899)");
    w.destroy();
  });
});
