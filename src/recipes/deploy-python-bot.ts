import type { ServerTarget } from "../ssh-client.js";
import { execCommand } from "../ssh-client.js";

export interface DeployPythonBotOptions {
  target: ServerTarget;
  /** Git repo URL to clone, e.g. https://github.com/you/your-bot.git */
  repoUrl: string;
  /** Directory name on the server, e.g. "solpath-bot". Will live under ~/apps/. */
  appName: string;
  /** Entry point relative to the repo root, e.g. "main.py" or "bot/main.py". */
  entryPoint: string;
  /** Optional: contents to write as a .env file in the app directory. */
  envFileContent?: string;
  /** Optional: branch to checkout. Defaults to the repo's default branch. */
  branch?: string;
}

export interface RecipeStepResult {
  step: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Deploys a Python bot as a systemd service:
 *  1. Clones (or pulls, if it already exists) the repo into ~/apps/<appName>
 *  2. Creates a venv and installs requirements.txt if present
 *  3. Writes a systemd unit file that runs it with auto-restart
 *  4. Enables + (re)starts the service
 *
 * Designed for the aiogram / long-running-Python-process shape of bot that
 * doesn't need a reverse proxy in front of it.
 */
export async function deployPythonBot(
  opts: DeployPythonBotOptions
): Promise<RecipeStepResult[]> {
  const { target, repoUrl, appName, entryPoint, envFileContent, branch } = opts;
  const appDir = `~/apps/${appName}`;
  const serviceName = `dploy-${appName}`;
  const results: RecipeStepResult[] = [];

  async function run(step: string, command: string): Promise<RecipeStepResult> {
    const res = await execCommand(target, command);
    const stepResult: RecipeStepResult = { step, command, ...res };
    results.push(stepResult);
    return stepResult;
  }

  await run("ensure apps dir", `mkdir -p ~/apps`);

  // Clone if missing, otherwise pull. Using a single shell expression so
  // we only need one round-trip.
  const branchFlag = branch ? `-b ${branch} ` : "";
  await run(
    "clone or update repo",
    `if [ -d "${appDir}/.git" ]; then cd "${appDir}" && git pull; else git clone ${branchFlag}"${repoUrl}" "${appDir}"; fi`
  );

  await run(
    "create venv",
    `cd "${appDir}" && python3 -m venv .venv`
  );

  await run(
    "install requirements",
    `cd "${appDir}" && if [ -f requirements.txt ]; then .venv/bin/pip install --upgrade pip && .venv/bin/pip install -r requirements.txt; else echo "no requirements.txt, skipping"; fi`
  );

  if (envFileContent !== undefined) {
    // Written via a heredoc so we don't have to do a separate SFTP round-trip
    // and so multi-line .env content is handled safely.
    const escaped = envFileContent.replace(/'/g, `'\\''`);
    await run(
      "write .env",
      `cat > "${appDir}/.env" << 'DPLOY_EOF'\n${escaped}\nDPLOY_EOF`
    );
  }

  // Resolve the absolute home dir so the systemd unit doesn't rely on ~ expansion.
  const homeResult = await run("resolve home dir", "echo $HOME");
  const home = homeResult.stdout.trim();
  const absoluteAppDir = `${home}/apps/${appName}`;

  const unitContent = `[Unit]
Description=${appName} (managed by dploy-mcp)
After=network.target

[Service]
Type=simple
WorkingDirectory=${absoluteAppDir}
ExecStart=${absoluteAppDir}/.venv/bin/python ${entryPoint}
Restart=always
RestartSec=5
EnvironmentFile=${absoluteAppDir}/.env

[Install]
WantedBy=multi-user.target
`;
  const escapedUnit = unitContent.replace(/'/g, `'\\''`);

  await run(
    "write systemd unit",
    `sudo tee /etc/systemd/system/${serviceName}.service > /dev/null << 'DPLOY_EOF'\n${escapedUnit}\nDPLOY_EOF`
  );

  await run("reload systemd", `sudo systemctl daemon-reload`);
  await run("enable service", `sudo systemctl enable ${serviceName}`);
  await run("restart service", `sudo systemctl restart ${serviceName}`);
  await run("check status", `sudo systemctl is-active ${serviceName}`);

  return results;
}
