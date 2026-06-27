import { Client, type ConnectConfig } from "ssh2";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface ServerTarget {
  host: string;
  port?: number;
  username: string;
  /** Path to the private key file on the LOCAL machine running this MCP server. */
  privateKeyPath: string;
  /** Optional passphrase if the key is encrypted. */
  passphrase?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Expands a leading "~" in a path to the user's home directory.
 * People constantly write "~/.ssh/id_ed25519" and it should just work.
 */
function expandHome(path: string): string {
  if (path.startsWith("~")) {
    return resolve(homedir(), path.slice(1).replace(/^[/\\]/, ""));
  }
  return resolve(path);
}

function loadPrivateKey(privateKeyPath: string): Buffer {
  const fullPath = expandHome(privateKeyPath);
  try {
    return readFileSync(fullPath);
  } catch (err) {
    throw new Error(
      `Could not read private key at "${fullPath}". Check the path is correct and readable. Original error: ${(err as Error).message}`
    );
  }
}

/**
 * Opens a fresh SSH connection, runs ONE command, then closes the connection.
 * We deliberately do not keep a connection pool / session cache around:
 * this tool has no persistent state by design (see project scope notes).
 */
export function execCommand(
  target: ServerTarget,
  command: string,
  timeoutMs = 60_000
): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    const conn = new Client();

    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    const connectConfig: ConnectConfig = {
      host: target.host,
      port: target.port ?? 22,
      username: target.username,
      privateKey: loadPrivateKey(target.privateKeyPath),
      passphrase: target.passphrase,
      // Password auth is intentionally not supported anywhere in this codebase.
      readyTimeout: 20_000,
    };

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            return reject(err);
          }

          let stdout = "";
          let stderr = "";

          stream
            .on("close", (code: number | null) => {
              clearTimeout(timer);
              conn.end();
              resolvePromise({ stdout, stderr, exitCode: code });
            })
            .on("data", (data: Buffer) => {
              stdout += data.toString("utf8");
            });

          stream.stderr.on("data", (data: Buffer) => {
            stderr += data.toString("utf8");
          });
        });
      })
      .on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`SSH connection error for ${target.username}@${target.host}: ${err.message}`));
      })
      .connect(connectConfig);
  });
}

/**
 * Uploads a single file's content to a remote path via SFTP.
 * Used by recipes that need to write config files (nginx confs, systemd units, etc).
 */
export function writeRemoteFile(
  target: ServerTarget,
  remotePath: string,
  content: string
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const conn = new Client();

    const connectConfig: ConnectConfig = {
      host: target.host,
      port: target.port ?? 22,
      username: target.username,
      privateKey: loadPrivateKey(target.privateKeyPath),
      passphrase: target.passphrase,
      readyTimeout: 20_000,
    };

    conn
      .on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          const writeStream = sftp.createWriteStream(remotePath);
          writeStream.on("close", () => {
            conn.end();
            resolvePromise();
          });
          writeStream.on("error", (e: Error) => {
            conn.end();
            reject(e);
          });
          writeStream.end(content, "utf8");
        });
      })
      .on("error", (err) => {
        reject(new Error(`SSH connection error for ${target.username}@${target.host}: ${err.message}`));
      })
      .connect(connectConfig);
  });
}
