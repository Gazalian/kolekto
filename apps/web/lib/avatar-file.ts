/**
 * Pure checks for a profile photo, shared by the server upload and its tests.
 *
 * The declared MIME type is what the browser claims; the first bytes are what
 * the file is. Both must agree on one of the three allowed formats.
 */

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_ACCEPT = "image/jpeg,image/png,image/webp";

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, i) => bytes[offset + i] === value);
}

/** Returns the file extension when the declared type and the file's signature agree, otherwise null. */
export function avatarExtensionFor(declaredType: string, bytes: Uint8Array): "jpg" | "png" | "webp" | null {
  if (declaredType === "image/jpeg" && startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (declaredType === "image/png" && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (
    declaredType === "image/webp" &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && // "RIFF"
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8) // "WEBP"
  ) {
    return "webp";
  }
  return null;
}
