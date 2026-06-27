/**
 * Patterns that are destructive, irreversible, or that can lock you out of
 * your own server. If a command matches one of these, the tool refuses to
 * run it UNLESS the caller passes confirmed: true.
 *
 * This list is intentionally pattern-based rather than a strict whitelist:
 * a whitelist would constantly reject legitimate deploy commands we didn't
 * think of in advance, which defeats the point of a "just tell it what you
 * want" tool. A blacklist of dangerous *shapes* of commands is the better
 * fit for this project's goal.
 */
const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, reason: "recursive force delete (rm -rf)" },
  { pattern: /\brm\s+-[a-z]*r[a-z]*\s+\/(?!\S)/i, reason: "recursive delete of root path" },
  { pattern: /\bmkfs\b/i, reason: "formats a filesystem, destroys all data on the target" },
  { pattern: /\bdd\s+if=/i, reason: "raw disk write, can overwrite an entire disk" },
  { pattern: /\bshutdown\b/i, reason: "shuts the server down" },
  { pattern: /\breboot\b/i, reason: "reboots the server" },
  { pattern: /\bhalt\b/i, reason: "halts the server" },
  { pattern: /\bpoweroff\b/i, reason: "powers off the server" },
  { pattern: /\bkillall\b/i, reason: "kills all matching processes, can take down unrelated services" },
  { pattern: /\bkill\s+-9\s+1\b/, reason: "kills PID 1 (init), crashes the system" },
  { pattern: /\biptables\s+-F\b/i, reason: "flushes all firewall rules, can cut off your own access" },
  { pattern: /\bufw\s+disable\b/i, reason: "disables the firewall" },
  { pattern: />\s*\/dev\/(sd|nvme|vd)/i, reason: "writes directly to a block device" },
  { pattern: /\bchmod\s+-R\s+000\b/i, reason: "removes all permissions recursively, can lock you out" },
  { pattern: /\bchown\s+-R\b.*\/(?!\S)/i, reason: "recursive ownership change on root path" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i, reason: "fork bomb" },
  { pattern: /\buserdel\b/i, reason: "deletes a user account" },
  { pattern: /\bpasswd\b/i, reason: "changes a password, may lock out the deploy user" },
  { pattern: /\bdrop\s+database\b/i, reason: "drops an entire database" },
  { pattern: /\btruncate\s+table\b/i, reason: "empties a database table" },
  { pattern: /\bdocker\s+system\s+prune\s+(-a|--all)/i, reason: "removes all unused docker images/containers/volumes" },
  { pattern: /\bsystemctl\s+(stop|disable)\s+ssh/i, reason: "stops/disables the SSH service, can lock you out" },
  { pattern: /\bcrontab\s+-r\b/i, reason: "wipes the crontab" },
];

export interface SafetyCheck {
  dangerous: boolean;
  reason?: string;
}

export function checkCommandSafety(command: string): SafetyCheck {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { dangerous: true, reason };
    }
  }
  return { dangerous: false };
}

/**
 * Throws a descriptive error if a dangerous command is attempted without
 * confirmation. The error message is written for an LLM caller: it explains
 * what to tell the human and how to proceed (re-call with confirmed: true).
 */
export function assertSafeOrConfirmed(command: string, confirmed: boolean): void {
  const check = checkCommandSafety(command);
  if (check.dangerous && !confirmed) {
    throw new Error(
      `BLOCKED: this command was flagged as dangerous (${check.reason}). ` +
        `Command: "${command}". ` +
        `Explain this risk to the user in plain language and ask them to explicitly confirm. ` +
        `If they confirm, call this tool again with the same arguments plus confirmed: true.`
    );
  }
}
