import type { Config } from "./config.ts";

const MAX_ADVERTISED_AGENTS = 16;
const MAX_AGENT_DESCRIPTION_CHARS = 160;

export function compactDescription(value: string | undefined): string {
  const text = (value ?? "").replace(/[\\u0000-\\u001f\\u007f]+/g, " ").replace(/\\s+/g, " ").trim();
  if (!text) return "";
  const firstSentence = text.match(/^.*?[.!?](?=\\s|$)/)?.[0] ?? text;
  return firstSentence.length <= MAX_AGENT_DESCRIPTION_CHARS
    ? firstSentence
    : `${firstSentence.slice(0, MAX_AGENT_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

export function agentNames(config: Config): string[] {
  return Object.keys(config.agents).sort((left, right) => left.localeCompare(right));
}

export function agentCatalog(config: Config): string {
  const entries = Object.entries(config.agents)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_ADVERTISED_AGENTS)
    .map(([name, agent]) => {
      const description = compactDescription(agent.description);
      return description ? `- ${name}: ${description}` : `- ${name}`;
    });

  const omitted = Math.max(0, Object.keys(config.agents).length - entries.length);
  if (omitted > 0) entries.push(`- … ${omitted} more configured role(s)`);
  return entries.join("\\n");
}
