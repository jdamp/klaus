import { describe, expect, it } from "vitest";

import { validateGeneratedImage } from "../src/image-generation/types.js";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x00]);

describe("provider-neutral generated image validation", () => {
  it("accepts bounded PNG and JPEG images and copies their bytes", () => {
    const image = validateGeneratedImage({ bytes: png, mediaType: "image/png" }, 100);
    expect(image.bytes).toEqual(png);
    expect(image.bytes).not.toBe(png);
    expect(validateGeneratedImage({ bytes: jpeg, mediaType: "image/jpeg" }, 100).mediaType).toBe(
      "image/jpeg",
    );
  });

  it("rejects empty, mismatched, unsupported, and oversized images", () => {
    expect(() =>
      validateGeneratedImage({ bytes: new Uint8Array(), mediaType: "image/png" }, 100),
    ).toThrow();
    expect(() => validateGeneratedImage({ bytes: jpeg, mediaType: "image/png" }, 100)).toThrow();
    expect(() =>
      validateGeneratedImage({ bytes: png, mediaType: "image/gif" as "image/png" }, 100),
    ).toThrow();
    expect(() => validateGeneratedImage({ bytes: png, mediaType: "image/png" }, 4)).toThrow();
  });
});
