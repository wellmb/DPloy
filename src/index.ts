#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { execCommand, writeRemoteFile, type ServerTarget } from "./ssh-client.js";
import { assertSafeOrConfirmed } from "./safety.js";
import { logAudit, getAuditLogPath } from "./audit-log.js";
import { deployPythonBot } from "./recipes/deploy-python-bot.js";
import { setupNginxSsl } from "./recipes/setup-nginx-ssl.js";
import { deployDockerCompose } from "./recipes/deploy-docker-compose.js";

const server = new McpServer({
  name: "dploy-mcp",
  version: "0.1.0",
});

// Shared schema fragment for "which server am I talking to" — every tool
// needs this since we deliberately don't persist a server list.
const targetSchema = {
  host: z.string().describe("Server IP address or hostname, e.g. 168.119.45.12"),
  port: z.number().optional().describe("SSH port, defaults to 22"),
  username: z.string().describe("SSH username, e.g. root or deploy"),
  privateKeyPath: z
    .string()
    .describe('Path to the private key on THIS machine, e.g. "~/.ssh/id_ed25519"'),
  passphrase: z.string().optional().describe("Passphrase for the private key, if it has one"),
};

function buildTarget(args: {
  host: string;
  port?: number;
  username: string;
  privateKeyPath: string;
  passphrase?: string;
}): ServerTarget {
  return {
    host: args.host,
    port: args.port,
    username: args.username,
    privateKeyPath: args.privateKeyPath,
    passphrase: args.passphrase,
  };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// Tool: exec — the universal escape hatch. Runs any single shell command.
// ---------------------------------------------------------------------------
server.registerTool(
  "exec",
  {
    title: "Execute a shell command over SSH",
    description:
      "Runs a single shell command on the remote server over SSH and returns stdout/stderr/exit code. " +
        "Use this for anything that doesn't fit one of the deploy_* recipe tools. " +
        "Dangerous commands (rm -rf, reboot, mkfs, etc.) are blocked unless confirmed=true — " +
        "if blocked, explain the risk to the user in plain language, get their explicit OK, then retry with confirmed: true.",
    inputSchema: {
      ...targetSchema,
      command: z.string().describe("The shell command to run, e.g. 'systemctl status nginx'"),
      confirmed: z
        .boolean()
        .optional()
        .default(false)
        .describe("Set to true only after the user has explicitly approved a flagged dangerous command"),
    },
  },
  async (args) => {
    assertSafeOrConfirmed(args.command, args.confirmed ?? false);
    const target = buildTarget(args);
    const start = Date.now();
    const result = await execCommand(target, args.command);
    logAudit({
      host: args.host,
      username: args.username,
      command: args.command,
      exitCode: result.exitCode,
      durationMs: Date.now() - start,
      tool: "exec",
    });
    return textResult(
      `exit code: ${result.exitCode}\n--- stdout ---\n${result.stdout || "(empty)"}\n--- stderr ---\n${result.stderr || "(empty)"}`
    );
  }
);

// ---------------------------------------------------------------------------
// Tool: write_file — SFTP write, for arbitrary config files outside the
// recipes below.
// ---------------------------------------------------------------------------
server.registerTool(
  "write_file",
  {
    title: "Write a file to the remote server",
    description:
      "Writes text content to a file path on the remote server via SFTP. Useful for config files, " +
        "env files, or scripts that don't fit one of the deploy_* recipes.",
    inputSchema: {
      ...targetSchema,
      remotePath: z.string().describe("Absolute or ~-relative path on the remote server"),
      content: z.string().describe("File content to write"),
    },
  },
  async (args) => {
    const target = buildTarget(args);
    const start = Date.now();
    await writeRemoteFile(target, args.remotePath, args.content);
    logAudit({
      host: args.host,
      username: args.username,
      command: `write_file ${args.remotePath}`,
      exitCode: 0,
      durationMs: Date.now() - start,
      tool: "write_file",
    });
    return textResult(`Wrote ${args.content.length} bytes to ${args.remotePath} on ${args.host}.`);
  }
);

// ---------------------------------------------------------------------------
// Recipe: deploy_python_bot
// ---------------------------------------------------------------------------
server.registerTool(
  "deploy_python_bot",
  {
    title: "Deploy a Python bot as a systemd service",
    description:
      "Clones (or updates) a git repo, creates a venv, installs requirements.txt, writes a systemd unit " +
        "with auto-restart, and starts it. Designed for long-running Python processes like aiogram Telegram bots. " +
        "Does NOT set up a reverse proxy — use setup_nginx_ssl separately if the bot needs to be reachable over HTTP(S).",
    inputSchema: {
      ...targetSchema,
      repoUrl: z.string().describe("Git repo URL to clone, e.g. https://github.com/you/your-bot.git"),
      appName: z.string().describe("Short name for this app, used as the directory and service name, e.g. 'solpath-bot'"),
      entryPoint: z.string().describe("Path to the entry script relative to the repo root, e.g. 'main.py'"),
      envFileContent: z.string().optional().describe("Contents to write as .env in the app directory (API keys, etc.)"),
      branch: z.string().optional().describe("Git branch to checkout, defaults to the repo's default branch"),
    },
  },
  async (args) => {
    const target = buildTarget(args);
    const start = Date.now();
    const steps = await deployPythonBot({
      target,
      repoUrl: args.repoUrl,
      appName: args.appName,
      entryPoint: args.entryPoint,
      envFileContent: args.envFileContent,
      branch: args.branch,
    });
    logAudit({
      host: args.host,
      username: args.username,
      command: `deploy_python_bot ${args.appName}`,
      exitCode: steps.at(-1)?.exitCode ?? null,
      durationMs: Date.now() - start,
      tool: "deploy_python_bot",
    });
    const summary = steps
      .map((s) => `[${s.step}] exit=${s.exitCode}${s.stderr ? `\n  stderr: ${s.stderr.slice(0, 300)}` : ""}`)
      .join("\n");
    return textResult(`Deploy steps for "${args.appName}":\n${summary}`);
  }
);

// ---------------------------------------------------------------------------
// Recipe: setup_nginx_ssl
// ---------------------------------------------------------------------------
server.registerTool(
  "setup_nginx_ssl",
  {
    title: "Set up nginx reverse proxy + Let's Encrypt SSL",
    description:
      "Installs nginx and certbot, configures nginx as a reverse proxy to a local port, and obtains/installs " +
        "a free Let's Encrypt SSL certificate for the given domain. The domain's DNS A record must already " +
        "point at this server, and ports 80/443 must be open.",
    inputSchema: {
      ...targetSchema,
      domain: z.string().describe("Domain name pointing at this server, e.g. bot.example.com"),
      upstreamPort: z.number().describe("Local port the app listens on, e.g. 3000"),
      email: z.string().describe("Email for Let's Encrypt registration and expiry notices"),
    },
  },
  async (args) => {
    const target = buildTarget(args);
    const start = Date.now();
    const steps = await setupNginxSsl({
      target,
      domain: args.domain,
      upstreamPort: args.upstreamPort,
      email: args.email,
    });
    logAudit({
      host: args.host,
      username: args.username,
      command: `setup_nginx_ssl ${args.domain}`,
      exitCode: steps.at(-1)?.exitCode ?? null,
      durationMs: Date.now() - start,
      tool: "setup_nginx_ssl",
    });
    const summary = steps
      .map((s) => `[${s.step}] exit=${s.exitCode}${s.stderr ? `\n  stderr: ${s.stderr.slice(0, 300)}` : ""}`)
      .join("\n");
    return textResult(`SSL setup steps for "${args.domain}":\n${summary}`);
  }
);

// ---------------------------------------------------------------------------
// Recipe: deploy_docker_compose
// ---------------------------------------------------------------------------
server.registerTool(
  "deploy_docker_compose",
  {
    title: "Deploy a docker-compose project",
    description:
      "Clones (or updates) a git repo containing a docker-compose.yml, installs Docker if missing, " +
        "writes a .env file if provided, and runs docker compose up -d --build.",
    inputSchema: {
      ...targetSchema,
      repoUrl: z.string().describe("Git repo URL containing docker-compose.yml at its root"),
      appName: z.string().describe("Short name for this app, used as the directory name"),
      envFileContent: z.string().optional().describe("Contents to write as .env next to docker-compose.yml"),
      branch: z.string().optional().describe("Git branch to checkout"),
    },
  },
  async (args) => {
    const target = buildTarget(args);
    const start = Date.now();
    const steps = await deployDockerCompose({
      target,
      repoUrl: args.repoUrl,
      appName: args.appName,
      envFileContent: args.envFileContent,
      branch: args.branch,
    });
    logAudit({
      host: args.host,
      username: args.username,
      command: `deploy_docker_compose ${args.appName}`,
      exitCode: steps.at(-1)?.exitCode ?? null,
      durationMs: Date.now() - start,
      tool: "deploy_docker_compose",
    });
    const summary = steps
      .map((s) => `[${s.step}] exit=${s.exitCode}${s.stderr ? `\n  stderr: ${s.stderr.slice(0, 300)}` : ""}`)
      .join("\n");
    return textResult(`Docker Compose deploy steps for "${args.appName}":\n${summary}`);
  }
);

// ---------------------------------------------------------------------------
// Tool: view_audit_log — lets the agent show the user what's been run.
// ---------------------------------------------------------------------------
server.registerTool(
  "view_audit_log_path",
  {
    title: "Get the audit log file path",
    description:
      "Returns the local file path where every command this tool has run is logged (one JSON line per command). " +
        "Tell the user this path if they want to review history.",
    inputSchema: {},
  },
  async () => {
    return textResult(`Audit log: ${getAuditLogPath()}`);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("dploy-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal error in dploy-mcp:", err);
  process.exit(1);
});
