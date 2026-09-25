export type GeneratedImageMediaType = "image/png" | "image/jpeg";

export type ImageGenerationRequest = {
  prompt: string;
};

export type GeneratedImage = {
  bytes: Uint8Array;
  mediaType: GeneratedImageMediaType;
};

export interface ImageGenerator {
  generate(request: ImageGenerationRequest, signal: AbortSignal): Promise<GeneratedImage>;
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Uint8Array.from([0xff, 0xd8, 0xff]);

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

export function validateGeneratedImage(image: GeneratedImage, maxBytes: number): GeneratedImage {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid image byte limit");
  if (!(image.bytes instanceof Uint8Array) || image.bytes.byteLength === 0) {
    throw new Error("Generated image is empty");
  }
  if (image.bytes.byteLength > maxBytes) {
    throw new Error("Generated image exceeds the configured byte limit");
  }
  const valid =
    image.mediaType === "image/png"
      ? startsWith(image.bytes, PNG_SIGNATURE)
      : image.mediaType === "image/jpeg"
        ? startsWith(image.bytes, JPEG_SIGNATURE)
        : false;
  if (!valid) throw new Error("Generated image encoding does not match its media type");
  return { mediaType: image.mediaType, bytes: new Uint8Array(image.bytes) };
}

export function promptByteLength(prompt: string): number {
  return Buffer.byteLength(prompt, "utf8");
}
