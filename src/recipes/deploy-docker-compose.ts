import type { ServerTarget } from "../ssh-client.js";
import { execCommand } from "../ssh-client.js";
import type { RecipeStepResult } from "./deploy-python-bot.js";

export interface DeployDockerComposeOptions {
  target: ServerTarget;
  /** Git repo URL containing a docker-compose.yml at its root. */
  repoUrl: string;
  /** Directory name on the server, lives under ~/apps/. */
  appName: string;
  /** Optional: contents to write as a .env file next to docker-compose.yml. */
  envFileContent?: string;
  branch?: string;
}

/**
 * Deploys a docker-compose project:
 *  1. Clones/pulls the repo into ~/apps/<appName>
 *  2. Ensures Docker + the Compose plugin are installed
 *  3. Writes .env if provided
 *  4. Runs docker compose up -d --build
 */
export async function deployDockerCompose(
  opts: DeployDockerComposeOptions
): Promise<RecipeStepResult[]> {
  const { target, repoUrl, appName, envFileContent, branch } = opts;
  const appDir = `~/apps/${appName}`;
  const results: RecipeStepResult[] = [];

  async function run(step: string, command: string): Promise<RecipeStepResult> {
    const res = await execCommand(target, command);
    const stepResult: RecipeStepResult = { step, command, ...res };
    results.push(stepResult);
    return stepResult;
  }

  await run("ensure apps dir", `mkdir -p ~/apps`);

  await run(
    "check docker installed",
    `if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER; else echo "docker already installed"; fi`
  );

  const branchFlag = branch ? `-b ${branch} ` : "";
  await run(
    "clone or update repo",
    `if [ -d "${appDir}/.git" ]; then cd "${appDir}" && git pull; else git clone ${branchFlag}"${repoUrl}" "${appDir}"; fi`
  );

  if (envFileContent !== undefined) {
    const escaped = envFileContent.replace(/'/g, `'\\''`);
    await run(
      "write .env",
      `cat > "${appDir}/.env" << 'DPLOY_EOF'\n${escaped}\nDPLOY_EOF`
    );
  }

  await run(
    "compose up",
    `cd "${appDir}" && (sudo docker compose up -d --build || sudo docker-compose up -d --build)`
  );

  await run("list running containers", `cd "${appDir}" && (sudo docker compose ps || sudo docker-compose ps)`);

  return results;
}
