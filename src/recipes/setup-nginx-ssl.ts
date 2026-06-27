import type { ServerTarget } from "../ssh-client.js";
import { execCommand } from "../ssh-client.js";
import type { RecipeStepResult } from "./deploy-python-bot.js";

export interface SetupNginxSslOptions {
  target: ServerTarget;
  /** Domain name, e.g. "example.com" or "bot.example.com". Must already point at this server's IP. */
  domain: string;
  /** Local port the app listens on, e.g. 3000. nginx will reverse-proxy to it. */
  upstreamPort: number;
  /** Email for Let's Encrypt registration / expiry notices. */
  email: string;
}

/**
 * Sets up nginx as a reverse proxy in front of a local app, then obtains
 * and installs a Let's Encrypt certificate via certbot.
 *
 * Assumes: domain's DNS A record already points at the target server,
 * and ports 80/443 are reachable from the internet.
 */
export async function setupNginxSsl(
  opts: SetupNginxSslOptions
): Promise<RecipeStepResult[]> {
  const { target, domain, upstreamPort, email } = opts;
  const results: RecipeStepResult[] = [];

  async function run(step: string, command: string): Promise<RecipeStepResult> {
    const res = await execCommand(target, command);
    const stepResult: RecipeStepResult = { step, command, ...res };
    results.push(stepResult);
    return stepResult;
  }

  await run(
    "install nginx + certbot",
    `sudo apt-get update -y && sudo apt-get install -y nginx certbot python3-certbot-nginx`
  );

  const siteConfig = `server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${upstreamPort};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
  const escapedConfig = siteConfig.replace(/'/g, `'\\''`);

  await run(
    "write nginx site config",
    `sudo tee /etc/nginx/sites-available/${domain} > /dev/null << 'DPLOY_EOF'\n${escapedConfig}\nDPLOY_EOF`
  );

  await run(
    "enable site",
    `sudo ln -sf /etc/nginx/sites-available/${domain} /etc/nginx/sites-enabled/${domain}`
  );

  await run("test nginx config", `sudo nginx -t`);
  await run("reload nginx", `sudo systemctl reload nginx`);

  await run(
    "obtain certificate",
    `sudo certbot --nginx -d ${domain} --non-interactive --agree-tos -m ${email} --redirect`
  );

  await run("verify certbot timer", `systemctl is-enabled certbot.timer || sudo systemctl enable certbot.timer`);

  return results;
}
