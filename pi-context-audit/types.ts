export interface ContextBucket {
  messages: number;
  chars: number;
  estimatedTokens: number;
}

export interface ContextDelta {
  chars: number;
  estimatedTokens: number;
  user: number;
  assistant: number;
  tool: number;
  custom: number;
}

export interface ContextSnapshot {
  sequence: number;
  timestamp: number;
  totalChars: number;
  estimatedTokens: number;
  user: ContextBucket;
  assistant: ContextBucket;
  tool: ContextBucket;
  custom: ContextBucket;
  customTypes: Record<string, ContextBucket>;
  delta?: ContextDelta;
}

export interface ToolRecord {
  toolCallId: string;
  toolName: string;
  inputChars: number;
  resultChars?: number;
  snapshotSequence?: number;
  timestamp: number;
}

export interface AuditState {
  snapshots: ContextSnapshot[];
  tools: ToolRecord[];
  nextSequence: number;
}
