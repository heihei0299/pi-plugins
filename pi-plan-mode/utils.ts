/**
 * Plan-mode command safety helpers.
 * Based on Pi's official plan-mode example, with compound-command validation
 * kept fail-closed so every pipeline/sequence segment must be allowlisted.
 */

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\$\(/,
  /`[^`]*`/,
  /<\(/,
  />\(/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish|add|remove)\b/i,
  /\byarn\s+(add|remove|install|publish)\b/i,
  /\bpnpm\s+(add|remove|install|publish|update)\b/i,
  /\bbun\s+(add|remove|install|update)\b/i,
  /\bpip3?\s+(install|uninstall)\b/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)\b/i,
  /\b(pacman|yay|paru)\s+-[SRU]/i,
  /\bbrew\s+(install|uninstall|upgrade|update)\b/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|stash|cherry-pick|revert|tag|init|clone|clean)\b/i,
  /\bgit\s+branch\s+-[dDmM]\b/i,
  /\b(sudo|su|kill|pkill|killall|reboot|shutdown)\b/i,
  /\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask)\b/i,
  /\bservice\s+\S+\s+(start|stop|restart|reload)\b/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS: RegExp[] = [
  /^\s*cat\b/i,
  /^\s*head\b/i,
  /^\s*tail\b/i,
  /^\s*less\b/i,
  /^\s*more\b/i,
  /^\s*grep\b/i,
  /^\s*rg\b/i,
  /^\s*find\b/i,
  /^\s*fd\b/i,
  /^\s*ls\b/i,
  /^\s*eza\b/i,
  /^\s*tree\b/i,
  /^\s*pwd\b/i,
  /^\s*echo\b/i,
  /^\s*printf\b/i,
  /^\s*wc\b/i,
  /^\s*sort\b/i,
  /^\s*uniq\b/i,
  /^\s*diff\b/i,
  /^\s*file\b/i,
  /^\s*stat\b/i,
  /^\s*du\b/i,
  /^\s*df\b/i,
  /^\s*which\b/i,
  /^\s*whereis\b/i,
  /^\s*type\b/i,
  /^\s*env\b/i,
  /^\s*printenv\b/i,
  /^\s*uname\b/i,
  /^\s*whoami\b/i,
  /^\s*id\b/i,
  /^\s*date\b/i,
  /^\s*cal\b/i,
  /^\s*uptime\b/i,
  /^\s*ps\b/i,
  /^\s*top\b/i,
  /^\s*htop\b/i,
  /^\s*free\b/i,
  /^\s*git\s+(status|log|diff|show|branch|remote|rev-parse|describe)\b/i,
  /^\s*git\s+config\s+--get\b/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
  /^\s*pnpm\s+(list|ls|view|why|outdated|audit)\b/i,
  /^\s*yarn\s+(list|info|why|audit)\b/i,
  /^\s*node\s+--version\b/i,
  /^\s*(python|python3)\s+--version\b/i,
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-\b/i,
  /^\s*jq\b/i,
  /^\s*sed\s+-n\b/i,
  /^\s*awk\b/i,
  /^\s*bat\b/i,
];

export function isSafeCommand(command: string): boolean {
  if (!command.trim() || DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))) return false;

  const segments = command
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  return segments.length > 0 && segments.every((segment) => SAFE_PATTERNS.some((pattern) => pattern.test(segment)));
}
