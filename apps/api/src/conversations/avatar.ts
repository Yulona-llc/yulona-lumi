import { createHash } from "node:crypto";

export const MAX_AVATAR_BYTES = 512 * 1024;
export type AvatarType = "image/png" | "image/jpeg" | "image/webp";

/** Identify an image by its magic bytes. SVG and everything else is rejected (returns null); the client-sent type is never trusted. */
export function sniffAvatarType(b: Uint8Array): AvatarType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export const avatarEtag = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").slice(0, 32);
