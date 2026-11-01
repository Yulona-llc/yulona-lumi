/** Square crop maths: which part of the source image to draw, given a zoom (1 = the whole short side) and a centre offset in -1..1. */
export function cropRect(w: number, h: number, zoom: number, offX: number, offY: number): { sx: number; sy: number; size: number } {
  const z = Math.min(4, Math.max(1, zoom));
  const size = Math.min(w, h) / z;
  const clamp = (v: number) => Math.min(1, Math.max(-1, v));
  const sx = (w - size) / 2 + clamp(offX) * ((w - size) / 2);
  const sy = (h - size) / 2 + clamp(offY) * ((h - size) / 2);
  return { sx, sy, size };
}

export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const AVATAR_OUT = 256;

/** Draw the chosen square onto a 256 px canvas and return a PNG (always well under the 512 KB limit). */
export async function cropToBlob(img: CanvasImageSource & { width: number; height: number }, zoom: number, offX: number, offY: number): Promise<Blob> {
  const { sx, sy, size } = cropRect(img.width, img.height, zoom, offX, offY);
  const c = document.createElement("canvas");
  c.width = c.height = AVATAR_OUT;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Your browser cannot edit images");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, size, size, 0, 0, AVATAR_OUT, AVATAR_OUT);
  return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Could not prepare the image"))), "image/png"));
}
