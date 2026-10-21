import "@testing-library/jest-dom/vitest";

// jsdom lacks these browser APIs; Radix, cmdk and motion call them.
class RO { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver;
if (typeof window !== "undefined") {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  class IO { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
  window.IntersectionObserver ??= IO as unknown as typeof IntersectionObserver;
}
