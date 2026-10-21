import type { ComponentChildren } from "preact";
import { safeUrl } from "./normalize";

const URL_RE = /\b(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+)/gi;

/** Turns text into text nodes + sanitized anchors. Never uses innerHTML. */
export function linkify(text: string): ComponentChildren {
  const parts: ComponentChildren[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0;
    let raw = m[0];
    // Trim trailing punctuation that is almost never part of the URL.
    const trail = raw.match(/[.,;:!?)\]]+$/)?.[0] ?? "";
    raw = raw.slice(0, raw.length - trail.length);
    const href = safeUrl(raw, ["https:", "http:", "mailto:"]);
    if (!href) continue;
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push(
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {raw}
      </a>,
    );
    last = idx + raw.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
