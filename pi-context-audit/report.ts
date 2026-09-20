import type { ContextBucket, ContextSnapshot, ToolRecord } from "./types.ts";

export const LARGE_TOOL_RESULT_CHARS = 1024;

function formatCount(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatSigned(value: number): string {
  return value > 0 ? `+${formatCount(value)}` : formatCount(value);
}

function formatBucket(name: string, bucket: ContextBucket): string {
  return `${name.padEnd(11)}${formatCount(bucket.estimatedTokens)} estimated tokens (${bucket.chars} chars, ${bucket.messages} messages)`;
}

export function formatToolRecords(records: readonly ToolRecord[]): string {
  const large = records
    .filter((record) => (record.resultChars ?? 0) >= LARGE_TOOL_RESULT_CHARS)
    .slice(-5);
  if (large.length === 0) return "";

  return [
    "Recent large tool results",
    ...large.map((record) => {
      const resultChars = record.resultChars ?? 0;
      const sequence = record.afterSnapshotSequence === undefined ? "-" : `#${record.afterSnapshotSequence}`;
      return `- ${record.toolName} (${formatCount(resultChars)} chars, after ${sequence})`;
    }),
  ].join("\n");
}

export function formatSnapshot(snapshot: ContextSnapshot, records: readonly ToolRecord[] = []): string {
  const lines = [
    "Context Audit",
    `Estimated message context: ${formatCount(snapshot.estimatedTokens)} estimated tokens`,
    snapshot.delta
      ? `Delta: ${formatSigned(snapshot.delta.estimatedTokens)} estimated tokens`
      : "Delta: first snapshot",
    "",
    formatBucket("user", snapshot.user),
    formatBucket("assistant", snapshot.assistant),
    formatBucket("tool", snapshot.tool),
    formatBucket("custom", snapshot.custom),
  ];
  const tools = formatToolRecords(records);
  if (tools) lines.push("", tools);
  return lines.join("\n");
}

export function formatRecentSnapshots(snapshots: readonly ContextSnapshot[]): string {
  if (snapshots.length === 0) return "No context snapshots.";

  return [
    "Recent Context Audits",
    ...snapshots.slice(-10).map((snapshot) => {
      const delta = snapshot.delta ? `Delta: ${formatSigned(snapshot.delta.estimatedTokens)} estimated tokens` : "first snapshot";
      return `#${snapshot.sequence} ${new Date(snapshot.timestamp).toISOString()} — ${formatCount(snapshot.estimatedTokens)} estimated tokens — ${delta}`;
    }),
  ].join("\n");
}

export function formatNoSnapshot(records: readonly ToolRecord[] = []): string {
  const tools = formatToolRecords(records);
  return tools ? `No context snapshot yet.\n\n${tools}` : "No context snapshot yet.";
}
