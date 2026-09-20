import type { ContextBucket } from "./types.ts";

export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export function valueChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === undefined || value === null) return 0;

  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : serialized.length;
  } catch {
    return String(value).length;
  }
}

export function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return valueChars(content);

  return content.reduce((total, block) => {
    if (!block || typeof block !== "object") return total + valueChars(block);

    const typedBlock = block as { type?: unknown; text?: unknown; thinking?: unknown; data?: unknown };
    if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
      return total + typedBlock.text.length;
    }
    if (typedBlock.type === "thinking" && typeof typedBlock.thinking === "string") {
      return total + typedBlock.thinking.length;
    }
    if (typedBlock.type === "image" && typeof typedBlock.data === "string") {
      return total + typedBlock.data.length;
    }
    return total + valueChars(block);
  }, 0);
}

export function messageChars(message: { content?: unknown }): number {
  return contentChars(message.content);
}

export function emptyBucket(): ContextBucket {
  return { messages: 0, chars: 0, estimatedTokens: 0 };
}
