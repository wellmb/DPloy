import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOG_DIR = join(homedir(), ".dploy-mcp");
const LOG_PATH = join(LOG_DIR, "audit.log");

export interface AuditEntry {
  host: string;
  username: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  tool: string;
}

function ensureLogDir(): void {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
}

export function logAudit(entry: AuditEntry): void {
  try {
    ensureLogDir();
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    });
    appendFileSync(LOG_PATH, line + "\n", "utf8");
  } catch {
    // Audit logging must never crash the actual deploy operation.
    // If we can't write the log, we silently skip it rather than
    // failing the user's real command.
  }
}

export function getAuditLogPath(): string {
  return LOG_PATH;
}
