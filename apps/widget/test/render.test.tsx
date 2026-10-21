import { describe, expect, it } from "vitest";
import { render } from "preact";
import { Blocks } from "../src/render/Blocks";
import { normalize } from "../src/render/normalize";

const ix = { answered: {}, emit: async () => true };
function html(ui: unknown, text?: string) {
  const el = document.createElement("div");
  render(<Blocks blocks={normalize(ui, text, "m")} ix={ix} />, el);
  return el;
}

describe("XSS safety", () => {
  it("never interprets message text as HTML", () => {
    const el = html({ components: [{ type: "message", text: '<img src=x onerror="alert(1)"><script>alert(1)</script>' }] });
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent).toContain("<img");
  });
  it("only linkifies http(s)/mailto and adds rel=noopener", () => {
    const el = html({ components: [{ type: "message", text: "see https://a.test/x, javascript:alert(1) and mailto:a@b.co" }] });
    const hrefs = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://a.test/x", "mailto:a@b.co"]);
    el.querySelectorAll("a").forEach((a) => expect(a.getAttribute("rel")).toContain("noopener"));
  });
  it("renders unknown component text safely", () => {
    const el = html({ components: [{ type: "weird", text: "<b>x</b>" }] });
    expect(el.querySelector("b")).toBeNull();
  });
});

describe("form validation", () => {
  it("blocks submit with errors and exposes aria-invalid", async () => {
    let emitted = false;
    const el = document.createElement("div");
    document.body.appendChild(el);
    const blocks = normalize({ components: [{ type: "form", fields: [{ name: "email", label: "Email", kind: "email", required: true }] }] }, undefined, "m");
    render(<Blocks blocks={blocks} ix={{ answered: {}, emit: async () => ((emitted = true), true) }} />, el);
    el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted).toBe(false);
    expect(el.querySelector("input")!.getAttribute("aria-invalid")).toBe("true");
    expect(el.querySelector('[role="alert"], .y-err')).not.toBeNull();
  });
});
