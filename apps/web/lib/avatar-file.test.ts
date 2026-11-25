import { describe, expect, it } from "vitest";
import { avatarExtensionFor } from "./avatar-file.ts";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");

describe("avatarExtensionFor", () => {
  it("accepts each allowed format when the bytes match the declared type", () => {
    expect(avatarExtensionFor("image/jpeg", jpeg)).toBe("jpg");
    expect(avatarExtensionFor("image/png", png)).toBe("png");
    expect(avatarExtensionFor("image/webp", webp)).toBe("webp");
  });

  it("refuses a file whose bytes do not match what the browser claimed", () => {
    expect(avatarExtensionFor("image/png", jpeg)).toBeNull();
    expect(avatarExtensionFor("image/jpeg", svg)).toBeNull();
  });

  it("refuses other types, including SVG and GIF", () => {
    expect(avatarExtensionFor("image/svg+xml", svg)).toBeNull();
    expect(avatarExtensionFor("image/gif", new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });

  it("refuses truncated files", () => {
    expect(avatarExtensionFor("image/png", new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(avatarExtensionFor("image/webp", new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull();
  });
});
