import { describe, expect, it } from "vitest";

import {
  TelegramVisualInputLoader,
  selectPhotoVariant,
  validateImageBytes,
} from "../src/telegram/visual-input.js";
import type { VisualInputError } from "../src/telegram/visual-input.js";
import type { TelegramApi } from "../src/telegram/client.js";
import type { TelegramVisualAttachment } from "../src/telegram/types.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const webp = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function apiFor(bytes: Uint8Array, fileSize?: number): TelegramApi {
  return {
    getFile: async () => ({
      file_path: "photos/file",
      ...(fileSize ? { file_size: fileSize } : {}),
    }),
    downloadFile: async () => bytes,
  } as unknown as TelegramApi;
}

describe("Telegram visual input", () => {
  it("selects the largest photo variant within the configured bound", () => {
    const selected = selectPhotoVariant(
      [
        { file_id: "small", width: 100, height: 100, file_size: 100 },
        { file_id: "large", width: 1000, height: 1000, file_size: 2000 },
        { file_id: "medium", width: 500, height: 500, file_size: 500 },
      ],
      600,
    );
    expect(selected.file_id).toBe("medium");
    expect(() =>
      selectPhotoVariant([{ file_id: "large", width: 1, height: 1, file_size: 601 }], 600),
    ).toThrow("size limit");
  });

  it("validates canonical image signatures and rejects animated or mislabeled data", () => {
    expect(validateImageBytes(png, "image/png").mimeType).toBe("image/png");
    expect(validateImageBytes(jpeg).mimeType).toBe("image/jpeg");
    expect(validateImageBytes(webp).mimeType).toBe("image/webp");
    expect(() => validateImageBytes(png, "image/jpeg")).toThrow("mislabeled");
    expect(() => validateImageBytes(new Uint8Array([1, 2, 3]))).toThrow("unsupported");
    expect(() =>
      validateImageBytes(new Uint8Array([...png, ...new TextEncoder().encode("acTL")])),
    ).toThrow("Animated");
    expect(() =>
      validateImageBytes(new Uint8Array([...webp, ...new TextEncoder().encode("ANMF")])),
    ).toThrow("Animated");
  });

  it("loads a document into Pi image content without writing a file", async () => {
    const attachment: TelegramVisualAttachment = {
      kind: "document",
      document: { file_id: "document", file_name: "photo.png", mime_type: "image/png" },
    };
    const image = await new TelegramVisualInputLoader(apiFor(png), 1024, 1000).load(attachment);
    expect(image).toEqual({
      type: "image",
      mimeType: "image/png",
      data: Buffer.from(png).toString("base64"),
    });
  });

  it("fails deterministically for oversized and unavailable images", async () => {
    const oversized: TelegramVisualAttachment = {
      kind: "document",
      document: { file_id: "document", file_size: 1025, mime_type: "image/png" },
    };
    await expect(
      new TelegramVisualInputLoader(apiFor(png), 1024, 1000).load(oversized),
    ).rejects.toMatchObject({
      failure: "oversized",
    } satisfies Partial<VisualInputError>);

    const unavailable = new TelegramVisualInputLoader({} as TelegramApi, 1024, 1000);
    await expect(
      unavailable.load({ kind: "photo", variants: [{ file_id: "photo", width: 1, height: 1 }] }),
    ).rejects.toMatchObject({
      failure: "unavailable",
    } satisfies Partial<VisualInputError>);
  });
});
