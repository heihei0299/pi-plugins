export type JsonlLineHandler = (line: string, terminated: boolean) => void;

export class JsonlParser {
  private pending = "";

  constructor(private readonly onLine: JsonlLineHandler) {}

  push(chunk: string): void {
    this.pending += chunk;
    let newlineIndex = this.pending.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.pending.slice(0, newlineIndex).replace(/\r$/, "");
      this.pending = this.pending.slice(newlineIndex + 1);
      this.onLine(line, true);
      newlineIndex = this.pending.indexOf("\n");
    }
  }

  finish(): void {
    if (this.pending.length === 0) return;
    const line = this.pending;
    this.pending = "";
    this.onLine(line, false);
  }
}
