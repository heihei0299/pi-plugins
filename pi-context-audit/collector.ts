import { contentChars, emptyBucket, estimateTokens, messageChars, valueChars } from "./estimator.ts";
import type { AuditState, ContextBucket, ContextSnapshot, ToolRecord } from "./types.ts";

export const MAX_SNAPSHOTS = 50;
export const MAX_TOOL_RECORDS = 100;

function addMessage(bucket: ContextBucket, chars: number): void {
  bucket.messages += 1;
  bucket.chars += chars;
  bucket.estimatedTokens = estimateTokens(bucket.chars);
}

function bucketForRole(message: { role?: unknown }, buckets: {
  user: ContextBucket;
  assistant: ContextBucket;
  tool: ContextBucket;
  custom: ContextBucket;
}): ContextBucket {
  if (message.role === "user") return buckets.user;
  if (message.role === "assistant") return buckets.assistant;
  if (message.role === "toolResult") return buckets.tool;
  return buckets.custom;
}

function deltaFor(current: ContextSnapshot, previous: ContextSnapshot | undefined) {
  if (!previous) return undefined;
  return {
    chars: current.totalChars - previous.totalChars,
    estimatedTokens: current.estimatedTokens - previous.estimatedTokens,
    user: current.user.estimatedTokens - previous.user.estimatedTokens,
    assistant: current.assistant.estimatedTokens - previous.assistant.estimatedTokens,
    tool: current.tool.estimatedTokens - previous.tool.estimatedTokens,
    custom: current.custom.estimatedTokens - previous.custom.estimatedTokens,
  };
}

export function createAuditState(): AuditState {
  return { snapshots: [], tools: [], nextSequence: 0 };
}

export function createContextSnapshot(
  messages: readonly unknown[],
  sequence: number,
  previous: ContextSnapshot | undefined,
  timestamp = Date.now(),
): ContextSnapshot {
  const buckets = {
    user: emptyBucket(),
    assistant: emptyBucket(),
    tool: emptyBucket(),
    custom: emptyBucket(),
  };

  for (const value of messages) {
    const message = value && typeof value === "object"
      ? value as { role?: unknown; content?: unknown }
      : {};
    const chars = messageChars(message);
    addMessage(bucketForRole(message, buckets), chars);
  }

  const totalChars = Object.values(buckets).reduce((total, bucket) => total + bucket.chars, 0);
  const snapshot: ContextSnapshot = {
    sequence,
    timestamp,
    totalChars,
    estimatedTokens: estimateTokens(totalChars),
    ...buckets,
  };
  const delta = deltaFor(snapshot, previous);
  if (delta) snapshot.delta = delta;
  return snapshot;
}

export function observeContext(
  state: AuditState,
  messages: readonly unknown[],
  timestamp = Date.now(),
): ContextSnapshot {
  const snapshot = createContextSnapshot(
    messages,
    state.nextSequence + 1,
    state.snapshots.at(-1),
    timestamp,
  );
  state.nextSequence = snapshot.sequence;
  state.snapshots.push(snapshot);
  if (state.snapshots.length > MAX_SNAPSHOTS) state.snapshots.shift();
  return snapshot;
}

function trimTools(state: AuditState): void {
  if (state.tools.length > MAX_TOOL_RECORDS) {
    state.tools.splice(0, state.tools.length - MAX_TOOL_RECORDS);
  }
}

export function observeToolCall(
  state: AuditState,
  event: { toolCallId: string; toolName: string; input: unknown },
  timestamp = Date.now(),
): ToolRecord {
  const record: ToolRecord = {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    inputChars: valueChars(event.input),
    afterSnapshotSequence: state.snapshots.at(-1)?.sequence,
    timestamp,
  };
  state.tools.push(record);
  trimTools(state);
  return record;
}

export function observeToolResult(
  state: AuditState,
  event: { toolCallId: string; toolName: string; input: unknown; content: unknown },
  timestamp = Date.now(),
): ToolRecord {
  const resultChars = contentChars(event.content);
  const record = [...state.tools].reverse().find((item) => item.toolCallId === event.toolCallId);
  if (record) {
    record.resultChars = resultChars;
    return record;
  }

  const created: ToolRecord = {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    inputChars: valueChars(event.input),
    resultChars,
    afterSnapshotSequence: state.snapshots.at(-1)?.sequence,
    timestamp,
  };
  state.tools.push(created);
  trimTools(state);
  return created;
}
