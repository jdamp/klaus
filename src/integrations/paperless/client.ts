import type { AppConfig } from "../../config.js";

export type PaperlessConfig = NonNullable<AppConfig["paperless"]>;
export type PaperlessFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type PaperlessCollection = "documents" | "tags" | "correspondents" | "document_types";
export type PaperlessPageParams = Record<
  string,
  string | number | boolean | readonly number[] | undefined
>;

export type PaperlessResponse = {
  body: unknown;
  apiVersion?: string;
  serverVersion?: string;
};

export class PaperlessHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PaperlessHttpError";
  }
}

export class PaperlessClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #config: PaperlessConfig;
  readonly #fetch: PaperlessFetch;

  constructor(
    config: PaperlessConfig,
    token: string,
    fetcher: PaperlessFetch = (input, init) => fetch(input, init),
  ) {
    this.#baseUrl = config.baseUrl;
    this.#token = token;
    this.#config = config;
    this.#fetch = fetcher;
  }

  probe(signal?: AbortSignal): Promise<PaperlessResponse> {
    return this.json("GET", "/api/documents/", { page: 1, page_size: 1, fields: "id" }, signal);
  }

  list(collection: PaperlessCollection, params: PaperlessPageParams, signal?: AbortSignal) {
    return this.json("GET", `/api/${collection}/`, params, signal);
  }

  getDocument(id: number, version?: number, signal?: AbortSignal) {
    return this.json(
      "GET",
      `/api/documents/${positiveId(id)}/`,
      version === undefined ? undefined : { version: positiveId(version) },
      signal,
    );
  }

  updateDocument(id: number, patch: Record<string, unknown>, signal?: AbortSignal) {
    return this.json("PATCH", `/api/documents/${positiveId(id)}/`, undefined, signal, patch);
  }

  createOrganizer(
    collection: Exclude<PaperlessCollection, "documents">,
    name: string,
    signal?: AbortSignal,
  ) {
    return this.json("POST", `/api/${collection}/`, undefined, signal, { name });
  }

  renameOrganizer(
    collection: Exclude<PaperlessCollection, "documents">,
    id: number,
    name: string,
    signal?: AbortSignal,
  ) {
    return this.json("PATCH", `/api/${collection}/${positiveId(id)}/`, undefined, signal, { name });
  }

  async uploadDocument(
    file: {
      bytes: Uint8Array;
      name: string;
      mediaType: "application/pdf" | "image/jpeg" | "image/png";
    },
    metadata: Record<string, string | number | readonly number[] | undefined>,
    signal?: AbortSignal,
  ): Promise<PaperlessResponse> {
    if (file.bytes.byteLength > this.#config.maxUploadBytes) {
      throw new Error("Paperless upload exceeds the configured attachment limit");
    }
    const form = new FormData();
    form.set(
      "document",
      new Blob([new Uint8Array(file.bytes).buffer], { type: file.mediaType }),
      file.name,
    );
    for (const [key, value] of Object.entries(metadata)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const entry of value) form.append(key, String(entry));
      } else form.set(key, String(value));
    }
    return this.request("POST", "/api/documents/post_document/", undefined, signal, form);
  }

  findTask(taskId: string, signal?: AbortSignal) {
    if (!/^[a-f0-9-]{16,64}$/i.test(taskId)) throw new Error("Invalid Paperless task identity");
    return this.json("GET", "/api/tasks/", { task_id: taskId, page: 1, page_size: 10 }, signal);
  }

  private async json(
    method: string,
    path: string,
    params?: PaperlessPageParams,
    signal?: AbortSignal,
    value?: unknown,
  ): Promise<PaperlessResponse> {
    return this.request(
      method,
      path,
      params,
      signal,
      value === undefined ? undefined : JSON.stringify(value),
    );
  }

  private async request(
    method: string,
    path: string,
    params?: PaperlessPageParams,
    signal?: AbortSignal,
    body?: BodyInit,
  ): Promise<PaperlessResponse> {
    const url = new URL(`${this.#baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
      }
    }
    const response = await this.#fetch(url, {
      method,
      headers: {
        Authorization: `Token ${this.#token}`,
        Accept: "application/json; version=10",
        ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}),
      },
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    const text = await readBounded(response, this.#config.maxResponseBytes);
    if (!response.ok)
      throw new PaperlessHttpError(`Paperless HTTP ${response.status}`, response.status);
    let parsed: unknown = {};
    if (text.trim()) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new Error("Paperless returned an invalid JSON response");
      }
    }
    return {
      body: parsed,
      ...(response.headers.get("x-api-version")
        ? { apiVersion: response.headers.get("x-api-version") as string }
        : {}),
      ...(response.headers.get("x-version")
        ? { serverVersion: response.headers.get("x-version") as string }
        : {}),
    };
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error("Paperless response exceeded the configured limit");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Paperless response exceeded the configured limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function positiveId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid Paperless identifier");
  return value;
}
