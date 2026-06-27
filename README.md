# DPLoy

An MCP server that deploys to your VPS in plain English. Give your AI coding
agent an IP address and an SSH key path, then just say what you want — "deploy
this repo as a Python bot", "put SSL on this domain", "spin up this
docker-compose project" — and it does the work over SSH.

Built for use with **Claude Code**, **Cursor**, **Codex**, or any other
MCP-compatible client. No dashboard, no daemon, no account. It's a thin
stdio MCP server that wraps SSH.

## Why this exists

Most "AI + infrastructure" tools are full platforms with their own UI,
memory, and message-routing layer. This is the opposite: a small set of
tools that plug straight into the agent you already use, so you don't have
to leave your editor to deploy something.

## What it can do

- `exec` — run any single shell command over SSH
- `write_file` — write a file to the server via SFTP
- `deploy_python_bot` — clone a repo, set up a venv, install
  `requirements.txt`, and run it as a `systemd` service with auto-restart
  (built with aiogram-style Telegram bots in mind, but works for any
  long-running Python process)
- `setup_nginx_ssl` — install nginx + certbot, reverse-proxy to a local
  port, and get a free Let's Encrypt certificate
- `deploy_docker_compose` — clone a repo, install Docker if needed, and run
  `docker compose up -d --build`
- `view_audit_log_path` — find the local log of everything that's been run

## Security model

- **Key-based auth only.** Password authentication isn't supported anywhere
  in this codebase, on purpose.
- **No persisted server list.** You pass `host` / `username` /
  `privateKeyPath` on every call. Nothing about your servers is written to
  disk by this tool (besides the audit log of commands run).
- **Dangerous commands require confirmation.** Things like `rm -rf`,
  `reboot`, `mkfs`, `dd`, flushing iptables, etc. are pattern-matched and
  blocked unless the call includes `confirmed: true`. The intended flow is:
  the agent tries the command, gets blocked, explains the risk to you in
  plain language, and only retries with confirmation after you say yes.
- **Local audit log.** Every command run through this tool is appended to
  `~/.dploy-mcp/audit.log` as one JSON line per command (host, command,
  exit code, duration, timestamp).

This is a tool that gives an AI agent shell access to a real server. Use a
non-root deploy user with `sudo` only where needed, point it at
non-critical / staging servers first, and read what the agent is about to
run before approving anything destructive.

## Install

```bash
git clone https://github.com/wellmb/DPloy.git
cd DPloy
npm install
npm run build
```

### Claude Code

```bash
claude mcp add --transport stdio dploy -- node /absolute/path/to/DPloy/build/index.js
```

### Cursor

Add to `~/.cursor/mcp.json` (or your project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "dploy": {
      "command": "node",
      "args": ["/absolute/path/to/DPloy/build/index.js"]
    }
  }
}
```

### Any other MCP client (Claude Desktop, etc.)

Same shape as above — point `command` at `node` and `args` at the built
`build/index.js`.

## Usage

Once connected, just talk to your agent normally:

> Deploy https://github.com/me/my-bot.git to 168.119.45.12 as root using
> ~/.ssh/id_ed25519. Entry point is main.py, app name "my-bot". Here's the
> .env content: ...

> Put SSL on bot.example.com for 168.119.45.12, my app listens on port
> 3000, use ~/.ssh/id_ed25519 as root, email me@example.com

> SSH into 168.119.45.12 and check the systemd status of my-bot

If the agent ever needs to run something destructive, it will tell you what
it wants to do and why, and ask you to confirm before it's allowed through.

## Recipes vs. raw exec

The `deploy_*` tools cover the common cases end to end. For anything outside
that — checking logs, restarting a single service, inspecting disk space,
one-off debugging — the agent will fall back to `exec` and just run the
right command directly.

## License

MIT
