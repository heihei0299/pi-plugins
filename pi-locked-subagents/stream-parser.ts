export type JsonlLineHandler = (line: string, terminated: boolean) => void;

export class JsonlLineLimitError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`subagent JSONL line exceeded ${maxBytes} bytes`);
    this.name = "JsonlLineLimitError";
  }
}

export class JsonlParser {
  private pending = "";
  private pendingBytes = 0;
  private overflowed = false;

  constructor(
    private readonly onLine: JsonlLineHandler,
    private readonly maxLineBytes: number,
  ) {}

  push(chunk: string): void {
    if (this.overflowed || chunk.length === 0) return;

    let offset = 0;
    while (offset < chunk.length) {
      const newlineIndex = chunk.indexOf("\n", offset);
      const end = newlineIndex === -1 ? chunk.length : newlineIndex;
      const segment = chunk.slice(offset, end);
      const segmentBytes = Buffer.byteLength(segment, "utf8");
      if (this.pendingBytes + segmentBytes > this.maxLineBytes) {
        this.overflowed = true;
        throw new JsonlLineLimitError(this.maxLineBytes);
      }

      this.pending += segment;
      this.pendingBytes += segmentBytes;
      if (newlineIndex === -1) return;

      this.onLine(this.pending.replace(/\r$/, ""), true);
      this.pending = "";
      this.pendingBytes = 0;
      offset = newlineIndex + 1;
    }
  }

  finish(): void {
    if (this.overflowed || this.pending.length === 0) return;
    const line = this.pending;
    this.pending = "";
    this.pendingBytes = 0;
    this.onLine(line, false);
  }
}
