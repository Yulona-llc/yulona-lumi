import type { WidgetAppearance, WidgetConfig } from "@yulona/shared";

export const DEFAULT_COLOR = "#f97316";
export const SOLID_SWATCHES: { name: string; color: string }[] = [
  { name: "Orange", color: "#f97316" }, { name: "Red", color: "#e11d48" }, { name: "Pink", color: "#ec4899" }, { name: "Purple", color: "#7c3aed" },
  { name: "Blue", color: "#2563eb" }, { name: "Teal", color: "#0d9488" }, { name: "Green", color: "#16a34a" }, { name: "Slate", color: "#334155" },
];
export const GRADIENT_PRESETS: { name: string; color: string; color2: string }[] = [
  { name: "Sunset", color: "#f97316", color2: "#ec4899" }, { name: "Ocean", color: "#2563eb", color2: "#06b6d4" },
  { name: "Berry", color: "#7c3aed", color2: "#ec4899" }, { name: "Forest", color: "#16a34a", color2: "#0d9488" },
];
export const ANGLES: { label: string; angle: number }[] = [
  { label: "Left to right", angle: 90 }, { label: "Top to bottom", angle: 180 }, { label: "Diagonal down", angle: 135 }, { label: "Diagonal up", angle: 45 },
];

const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);

/** Text colour that stays readable on a brand colour (same rule as the widget). */
export function readableOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? "#14161f" : "#fff";
}
export function mixHex(a: string, b: string): string {
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  const ch = (sh: number) => Math.round((((x >> sh) & 255) + ((y >> sh) & 255)) / 2);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

/** The effective appearance of a stored config (old configs only have `primaryColor`). */
export function appearanceOf(cfg: WidgetConfig): WidgetAppearance {
  const a = cfg.appearance;
  if (a) return { mode: a.mode, color: a.color, color2: a.color2, angle: a.angle ?? 135 };
  return { mode: "solid", color: isHex(cfg.primaryColor) ? cfg.primaryColor : DEFAULT_COLOR, angle: 135 };
}
/** CSS background and matching text colour for a brand fill. */
export function fillOf(a: WidgetAppearance): { background: string; color: string } {
  if (a.mode === "gradient" && isHex(a.color2)) return { background: `linear-gradient(${a.angle}deg, ${a.color}, ${a.color2})`, color: readableOn(mixHex(a.color, a.color2)) };
  return { background: a.color, color: readableOn(a.color) };
}
/** Store an appearance and keep `primaryColor` (read by older widget scripts) in step. */
export function withAppearance(cfg: WidgetConfig, a: WidgetAppearance): WidgetConfig {
  return { ...cfg, appearance: a.mode === "gradient" ? a : { mode: "solid", color: a.color, angle: a.angle }, primaryColor: a.color };
}
