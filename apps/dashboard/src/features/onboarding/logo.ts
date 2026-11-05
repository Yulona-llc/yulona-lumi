import { AVATAR_TYPES, cropToBlob } from "../widget-config/crop";

/**
 * The logo picked in the setup wizard. The widget does not exist until the wizard finishes, so the cropped picture waits here
 * (in memory) and is uploaded to the new widget right after the starter setup is created.
 */
let picked: { blob: Blob; url: string } | null = null;

export const pickedLogoUrl = () => picked?.url ?? null;

export function clearPickedLogo() {
  if (picked) URL.revokeObjectURL(picked.url);
  picked = null;
}

/** Centre-crop the chosen image to a square. Rejects with a sentence the user can read. */
export async function pickLogo(file: File): Promise<string> {
  if (!AVATAR_TYPES.includes(file.type)) throw new Error("Use a PNG, JPEG or WebP picture.");
  if (file.size > 12 * 1024 * 1024) throw new Error("That picture is too large. Choose one under 12 MB.");
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file is not a picture we can read.")); i.src = src; });
    const blob = await cropToBlob(img, 1, 0, 0);
    clearPickedLogo();
    picked = { blob, url: URL.createObjectURL(blob) };
    return picked.url;
  } finally { URL.revokeObjectURL(src); }
}

/** The picked logo, once: returns it and forgets it. */
export function takePickedLogo(): Blob | null {
  const b = picked?.blob ?? null;
  clearPickedLogo();
  return b;
}
