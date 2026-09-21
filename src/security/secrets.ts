import { readFile } from "node:fs/promises";

export async function readSecret(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (!value) {
    throw new Error(`Secret file is empty: ${path}`);
  }
  return value;
}

export class SecretRedactor {
  readonly #values = new Set<string>();

  add(value: string | undefined): void {
    if (value) this.#values.add(value);
  }

  redact(value: unknown): unknown {
    if (typeof value === "string") {
      let redacted = value.replace(/(authorization\s*[:=]\s*)([^\s,}]+)/gi, "$1[REDACTED]");
      for (const secret of this.#values) redacted = redacted.replaceAll(secret, "[REDACTED]");
      return redacted;
    }
    if (Array.isArray(value)) return value.map((entry) => this.redact(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          /token|secret|authorization|api[-_]?key/i.test(key) ? "[REDACTED]" : this.redact(entry),
        ]),
      );
    }
    return value;
  }
}
