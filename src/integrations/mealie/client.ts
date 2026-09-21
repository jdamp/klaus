import type { AppConfig } from "../../config.js";

export type MealieFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type MealieConfig = NonNullable<AppConfig["mealie"]>;

export class MealieStreamError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MealieStreamError";
  }
}

export class MealieHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "MealieHttpError";
  }
}

export type MealieStreamEvent = {
  event?: string;
  data: unknown;
};

export class MealieClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: MealieFetch;
  readonly #config: MealieConfig;

  constructor(
    config: MealieConfig,
    apiKey: string,
    fetcher: MealieFetch = (input, init) => fetch(input, init),
  ) {
    this.#baseUrl = config.baseUrl;
    this.#apiKey = apiKey;
    this.#fetch = fetcher;
    this.#config = config;
  }

  async about(signal?: AbortSignal): Promise<unknown> {
    return this.json("GET", "/api/app/about", undefined, signal);
  }

  async getRecipe(slug: string, signal?: AbortSignal): Promise<unknown> {
    return this.json("GET", `/api/recipes/${encodeURIComponent(slug)}`, undefined, signal);
  }

  async searchRecipes(
    params: Record<string, string | number | boolean | readonly string[] | undefined>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.json("GET", `/api/recipes?${query(params)}`, undefined, signal);
  }

  async listOrganizers(
    kind: "category" | "tag" | "food",
    params: Record<string, string | number | boolean | undefined>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const path = kind === "category" ? "categories" : kind === "tag" ? "tags" : "foods";
    return this.json("GET", `/api/organizers/${path}?${query(params)}`, undefined, signal);
  }

  async getOrganizer(kind: "category" | "tag", id: string, signal?: AbortSignal): Promise<unknown> {
    const path = kind === "category" ? "categories" : "tags";
    return this.json("GET", `/api/organizers/${path}/${encodeURIComponent(id)}`, undefined, signal);
  }

  async createOrganizer(
    kind: "category" | "tag",
    name: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const path = kind === "category" ? "categories" : "tags";
    return this.json("POST", `/api/organizers/${path}`, { name }, signal);
  }

  async renameOrganizer(
    kind: "category" | "tag",
    id: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const path = kind === "category" ? "categories" : "tags";
    return this.json("PUT", `/api/organizers/${path}/${encodeURIComponent(id)}`, { name }, signal);
  }

  async updateRecipe(slug: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.json("PUT", `/api/recipes/${encodeURIComponent(slug)}`, value, signal);
  }

  async parseIngredients(ingredients: readonly string[], signal?: AbortSignal): Promise<unknown> {
    return this.json("POST", "/api/parser/ingredients", { parser: "openai", ingredients }, signal);
  }

  async importRecipeUrl(
    strategy: "scraper" | "ai",
    options: Record<string, string | boolean | undefined>,
    signal?: AbortSignal,
  ): Promise<MealieStreamEvent[]> {
    const path =
      strategy === "scraper" ? "/api/recipes/create/url/stream" : "/api/recipes/create/ai/stream";
    const form = new FormData();
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) form.append(key, String(value));
    }
    return this.stream(path, form, signal);
  }

  private url(path: string): string {
    return `${this.#baseUrl}${path}`;
  }

  private async json<T>(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#apiKey}` };
    let requestBody: BodyInit | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      requestBody = JSON.stringify(body);
    }
    const response = await this.#fetch(this.url(path), {
      method,
      headers,
      redirect: "error",
      ...(requestBody === undefined ? {} : { body: requestBody }),
      ...(signal ? { signal } : {}),
    });
    const text = await boundedText(response, this.#config.maxResponseBytes);
    const parsed = parseBody(text);
    if (!response.ok)
      throw new MealieHttpError(`Mealie HTTP ${response.status}`, response.status, parsed);
    return parsed as T;
  }

  private async stream(
    path: string,
    body: FormData,
    signal?: AbortSignal,
  ): Promise<MealieStreamEvent[]> {
    const response = await this.#fetch(this.url(path), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#apiKey}` },
      body,
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const text = await boundedText(response, this.#config.maxResponseBytes);
      throw new MealieHttpError(`Mealie HTTP ${response.status}`, response.status, parseBody(text));
    }
    if (!response.body) throw new MealieStreamError("Mealie returned no import stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let bytes = 0;
    const events: MealieStreamEvent[] = [];
    let terminal = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.#config.maxResponseBytes)
          throw new Error("Mealie stream exceeded response limit");
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const event = parseSseFrame(frame);
          if (!event) continue;
          events.push(event);
          if (event.event === "done" || event.event === "error" || isTerminalData(event.data))
            terminal = true;
        }
        if (terminal) break;
      }
    } catch (error) {
      throw new MealieStreamError("Mealie import stream ended unexpectedly", {
        cause: error,
      });
    }
    buffer += decoder.decode();
    const finalEvent = parseSseFrame(buffer);
    if (finalEvent) events.push(finalEvent);
    return events;
  }
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes)
      throw new Error("Mealie response exceeded response limit");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) throw new Error("Mealie response exceeded response limit");
    chunks.push(chunk.value);
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}

function parseBody(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseSseFrame(frame: string): MealieStreamEvent | undefined {
  const dataLines: string[] = [];
  let event: string | undefined;
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return undefined;
  const value = dataLines.join("\n");
  let data: unknown = value;
  try {
    data = JSON.parse(value) as unknown;
  } catch {
    // Some Mealie versions send plain text progress events.
  }
  return { ...(event ? { event } : {}), data };
}

function isTerminalData(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && ("slug" in value || "error" in value));
}

function query(
  params: Record<string, string | number | boolean | readonly string[] | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(","));
    } else search.set(key, String(value));
  }
  return search.toString();
}
