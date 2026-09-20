# pi-context-audit

Passive context-growth estimates for Pi.

The extension observes outgoing context messages and tool lifecycle events without changing the messages sent to the model. It keeps only bounded in-memory snapshots and tool-size records; complete tool results are not retained.

## Commands

- `/context-audit` — show the latest snapshot and recent large tool-result sizes.
- `/context-audit recent` — show the bounded list of recent snapshots and estimated deltas.
- `/context-audit reset` — clear only the audit state.

Token values are deterministic estimates (`ceil(chars / 4)`) of observed context-message content only. They do not include system-prompt sections, serialized tool schemas, provider/request framing, or provider-reported input tokens. Use provider usage events for billing- and cache-accurate token counts. Tool event traffic is observed for size accounting, but no LLM-callable tool is registered.
