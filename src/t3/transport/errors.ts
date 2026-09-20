import * as z from "zod/v4";

export function summarizeError(value: unknown): string {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return value.slice(0, 300) || "(empty response)";
    }
  }
  if (parsed instanceof Error) {
    return parsed.message;
  }
  if (parsed && typeof parsed === "object") {
    const result = z.record(z.string(), z.unknown()).safeParse(parsed);
    if (!result.success) {
      return JSON.stringify(parsed).slice(0, 300);
    }
    const record = result.data;
    const tag = typeof record._tag === "string" ? record._tag : undefined;
    const message = ["message", "reason", "detail"]
      .map((key) => record[key])
      .find((v): v is string => typeof v === "string");
    if (tag && message) {
      return `${tag}: ${message}`;
    }
    if (tag) {
      return `${tag}: ${JSON.stringify(record).slice(0, 300)}`;
    }
    return message ?? JSON.stringify(record).slice(0, 300);
  }
  return String(parsed);
}
