import { describe, expect, it, vi } from "vitest";

import type { TelegramApi } from "../src/telegram/client.js";
import type { TelegramUploadAttachment } from "../src/telegram/types.js";
import { TelegramUploadFileLoader } from "../src/telegram/upload-file.js";

const pdfBytes = new TextEncoder().encode("%PDF-1.7\nprivate document");
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function apiFor(bytes: Uint8Array, fileSize = bytes.byteLength) {
  const getFile = vi.fn(async () => ({ file_path: "secure/path", file_size: fileSize }));
  const downloadFile = vi.fn(async () => bytes);
  return {
    api: { getFile, downloadFile } as unknown as TelegramApi,
    getFile,
    downloadFile,
  };
}

function documentAttachment(overrides: Record<string, unknown> = {}): TelegramUploadAttachment {
  return {
    kind: "document",
    document: {
      file_id: "telegram-file-id",
      file_name: "../../Household bill.pdf",
      mime_type: "application/pdf",
      ...overrides,
    },
  };
}

describe("TelegramUploadFileLoader", () => {
  it("loads bounded PDF bytes from the exact Telegram document and returns a safe name and digest", async () => {
    const fixture = apiFor(pdfBytes);
    const loader = new TelegramUploadFileLoader(fixture.api, 100, 1000);
    const file = await loader.load(documentAttachment());
    expect(file).toMatchObject({
      mediaType: "application/pdf",
      name: "_.._Household bill.pdf",
      bytes: pdfBytes,
    });
    expect(file.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(fixture.getFile).toHaveBeenCalledWith("telegram-file-id", expect.any(AbortSignal));
    expect(fixture.downloadFile).toHaveBeenCalledWith(
      "secure/path",
      100,
      1000,
      expect.any(AbortSignal),
    );
  });

  it("sniffs content when Telegram omits MIME, filename, and size metadata", async () => {
    const api = {
      getFile: vi.fn(async () => ({ file_path: "secure/path" })),
      downloadFile: vi.fn(async () => pdfBytes),
    } as unknown as TelegramApi;
    const file = await new TelegramUploadFileLoader(api, 100, 1000).load(
      documentAttachment({ file_name: undefined, mime_type: undefined, file_size: undefined }),
    );
    expect(file).toMatchObject({ mediaType: "application/pdf", name: "document.pdf" });
  });

  it("detects photo MIME from content and supports JPEG and PNG only", async () => {
    for (const [bytes, mediaType, suffix] of [
      [jpegBytes, "image/jpeg", ".jpg"],
      [pngBytes, "image/png", ".png"],
    ] as const) {
      const fixture = apiFor(bytes);
      const loader = new TelegramUploadFileLoader(fixture.api, 100, 1000);
      const file = await loader.load({
        kind: "photo",
        variants: [{ file_id: "photo-id", width: 100, height: 100, file_size: bytes.length }],
      });
      expect(file.mediaType).toBe(mediaType);
      expect(file.name.endsWith(suffix)).toBe(true);
    }
  });

  it("rejects unsupported, mislabeled, and oversized attachments before submission", async () => {
    const noRequest = apiFor(pdfBytes);
    const loader = new TelegramUploadFileLoader(noRequest.api, 5, 1000);
    await expect(
      loader.load(documentAttachment({ file_size: pdfBytes.byteLength + 1 })),
    ).rejects.toMatchObject({ failure: "oversized" });
    expect(noRequest.getFile).not.toHaveBeenCalled();

    const actualOverflow = apiFor(pdfBytes, 1);
    await expect(
      new TelegramUploadFileLoader(actualOverflow.api, 5, 1000).load(documentAttachment()),
    ).rejects.toMatchObject({ failure: "oversized" });
    expect(actualOverflow.downloadFile).toHaveBeenCalled();

    const mismatch = apiFor(pdfBytes);
    const mismatchLoader = new TelegramUploadFileLoader(mismatch.api, 100, 1000);
    await expect(
      mismatchLoader.load(documentAttachment({ mime_type: "image/png", file_name: "invoice.png" })),
    ).rejects.toMatchObject({ failure: "unsupported" });
    expect(mismatch.getFile).toHaveBeenCalledOnce();

    const supported = apiFor(pdfBytes);
    const supportedLoader = new TelegramUploadFileLoader(supported.api, 100, 1000);
    await expect(
      supportedLoader.load(
        documentAttachment({ mime_type: "application/pdf", file_name: "invoice.pdf" }),
      ),
    ).resolves.toMatchObject({ mediaType: "application/pdf" });
    const unsafeName = apiFor(pdfBytes);
    await expect(
      new TelegramUploadFileLoader(unsafeName.api, 100, 1000).load(
        documentAttachment({ file_name: `../secret${String.fromCharCode(0, 10)}.pdf` }),
      ),
    ).resolves.toMatchObject({ name: "_secret__.pdf" });
    const oversizedTelegram = apiFor(pdfBytes, 101);
    await expect(
      new TelegramUploadFileLoader(oversizedTelegram.api, 100, 1000).load(documentAttachment()),
    ).rejects.toMatchObject({ failure: "oversized" });
    expect(oversizedTelegram.downloadFile).not.toHaveBeenCalled();
  });

  it("rejects content without a supported signature and maps Telegram errors to safe failures", async () => {
    const bad = apiFor(new TextEncoder().encode("not really a PDF"));
    await expect(
      new TelegramUploadFileLoader(bad.api, 100, 1000).load(documentAttachment()),
    ).rejects.toMatchObject({ failure: "unsupported" });

    const brokenApi = {
      getFile: vi.fn(async () => {
        throw new Error("telegram token and remote details");
      }),
      downloadFile: vi.fn(),
    } as unknown as TelegramApi;
    await expect(
      new TelegramUploadFileLoader(brokenApi, 100, 1000).load(documentAttachment()),
    ).rejects.toThrow("Telegram could not retrieve this attachment");
    await expect(
      new TelegramUploadFileLoader(brokenApi, 100, 1000).load(documentAttachment()),
    ).rejects.not.toThrow("telegram token");
  });
});
