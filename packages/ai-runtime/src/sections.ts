/**
 * Splits extracted text into titled sections, the unit an agent reads. No tokenizer and no embeddings: markdown
 * headings (and `htmlToText`'s heading markers) give natural boundaries, otherwise paragraphs are grouped.
 */
export interface Section {
  index: number;
  title: string;
  content: string;
}
export interface SectionOptions {
  /** hard cap per section (characters) */
  maxChars?: number;
  /** headings-based sections smaller than this are merged into their neighbour */
  minChars?: number;
  /** title for text before the first heading */
  fallbackTitle?: string;
}

const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;

export const slugify = (s: string): string =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "skill";

const firstLine = (s: string, n = 60) => {
  const l = s.split("\n").find((x) => x.trim())?.trim() ?? "";
  return l.length > n ? l.slice(0, n - 1).trimEnd() + "…" : l;
};

/** Group paragraphs into pieces no longer than `max` characters; an oversized paragraph is cut at sentence ends. */
function pack(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length > max) {
      push();
      let piece = "";
      for (const s of p.split(/(?<=[.!?])\s+|\n/)) {
        if (piece && piece.length + s.length + 1 > max) {
          out.push(piece.trim());
          piece = "";
        }
        if (s.length > max) for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
        else piece += (piece ? " " : "") + s;
      }
      if (piece.trim()) out.push(piece.trim());
      continue;
    }
    if (cur && cur.length + p.length + 2 > max) push();
    cur += (cur ? "\n\n" : "") + p;
  }
  push();
  return out;
}

export function sectionize(text: string, o: SectionOptions = {}): Section[] {
  const max = o.maxChars ?? 3000;
  const min = o.minChars ?? 500;
  const fallback = o.fallbackTitle ?? "Overview";
  const src = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!src) return [];

  // 1) blocks by heading, title = heading path
  type Block = { title: string; body: string };
  const blocks: Block[] = [];
  const path: string[] = [];
  let cur: Block = { title: fallback, body: "" };
  let hasHeading = false;
  for (const line of src.split("\n")) {
    const m = HEADING.exec(line);
    if (m) {
      hasHeading = true;
      if (cur.body.trim() || blocks.length === 0 && cur.title !== fallback) blocks.push(cur);
      const depth = m[1]!.length;
      path.length = depth - 1;
      path[depth - 1] = m[2]!.trim();
      cur = { title: path.filter(Boolean).slice(-2).join(" › "), body: "" };
    } else cur.body += line + "\n";
  }
  if (cur.body.trim()) blocks.push(cur);

  // 2) no headings at all: pack paragraphs, title from the first line of each pack
  const out: { title: string; content: string }[] = [];
  if (!hasHeading) {
    for (const piece of pack(src, Math.min(max, 2000))) out.push({ title: firstLine(piece), content: piece });
  } else {
    // 3) merge tiny blocks into the previous one, split huge ones
    const merged: Block[] = [];
    for (const b of blocks) {
      const body = b.body.trim();
      const prev = merged[merged.length - 1];
      if (prev && (body.length < min || prev.body.length < min) && prev.body.length + body.length + b.title.length + 6 <= max) {
        prev.body += `\n\n${b.title}\n${body}`;
      } else merged.push({ title: b.title, body });
    }
    for (const b of merged) {
      const parts = b.body.length > max ? pack(b.body, max) : [b.body];
      parts.forEach((p, i) => out.push({ title: parts.length > 1 ? `${b.title} (part ${i + 1})` : b.title, content: p }));
    }
  }
  return out.filter((s) => s.content.trim()).map((s, index) => ({ index, title: s.title.slice(0, 200), content: s.content }));
}

/** Deterministic one-line description of a skill (no AI): the operator can overwrite it. */
export function describeSkill(sections: Section[], sourceName: string): string {
  const first = sections[0];
  if (!first) return sourceName;
  const sentence = /^(.{20,200}?[.!?])(\s|$)/s.exec(first.content.replace(/\s+/g, " ").trim())?.[1] ?? first.content.replace(/\s+/g, " ").trim().slice(0, 160);
  const titles = sections.slice(0, 6).map((s) => s.title).filter((t) => t && t !== "Overview");
  const topics = titles.length > 1 ? ` Covers: ${titles.join("; ")}.` : "";
  return `${sentence}${topics}`.slice(0, 500);
}
