# EC2 Deployment Handoff (for @cirrus)

This runbook standardizes production deployment of OODA on a single EC2 host with `systemd` + `nginx`.

## Architecture baseline

- App: Node.js service (`server.js`) bound to `127.0.0.1:3100`
- Process manager: `systemd`
- TLS + ingress: `nginx` on `:443` (redirect `:80` -> HTTPS)
- Persistence: SQLite file at `/var/lib/ooda/agent.db`
- Access: prefer AWS Systems Manager Session Manager over public SSH

Templates in this repo:

- `deploy/ooda-agent.service`
- `deploy/nginx-ooda.conf`
- `deploy/VERIFY.md`

## 1. Instance and IAM hardening

1. Use an instance profile (IAM role), not static AWS keys in `.env`.
2. Require IMDSv2 (`HttpTokens=required`) on the instance metadata options.
3. Security group:
   - Inbound `443` from allowed CIDR(s)
   - Inbound `80` only if you need redirect/challenge
   - No public inbound `22` when Session Manager is enabled
4. Enable SSM Session Manager and session logging.
5. Set patching cadence via SSM Patch Manager.

## 2. Host bootstrap

```bash
sudo apt-get update
sudo apt-get install -y nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

Create app user and directories:

```bash
sudo useradd --system --home /opt/ooda --shell /usr/sbin/nologin ooda || true
sudo mkdir -p /opt/ooda /var/lib/ooda /var/log/ooda
sudo chown -R ooda:ooda /opt/ooda /var/lib/ooda /var/log/ooda
```

## 3. App deployment

```bash
cd /opt
sudo -u ooda git clone https://github.com/dgroch/ooda.git
cd /opt/ooda
sudo -u ooda npm install --omit=dev
sudo -u ooda cp .env.example .env
```

Set minimum env in `/opt/ooda/.env`:

- `AUTH_TOKEN=<strong secret>`
- `LLM_API_KEY=<provider key>`
- `LLM_MODEL=<model>`
- `DB_PATH=/var/lib/ooda/agent.db`
- `PORT=3100`

Protect env file:

```bash
sudo chown ooda:ooda /opt/ooda/.env
sudo chmod 600 /opt/ooda/.env
```

## 4. Systemd

```bash
sudo cp /opt/ooda/deploy/ooda-agent.service /etc/systemd/system/ooda-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now ooda-agent
sudo systemctl status ooda-agent --no-pager
```

## 5. Nginx

```bash
sudo cp /opt/ooda/deploy/nginx-ooda.conf /etc/nginx/sites-available/ooda
sudo ln -sf /etc/nginx/sites-available/ooda /etc/nginx/sites-enabled/ooda
sudo nginx -t
sudo systemctl reload nginx
```

Issue certs (example with certbot, adapt to your standard):

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-agent.example.com
```

## 6. Operational checks

Run `deploy/VERIFY.md` after every deployment.

## 7. Upgrade workflow

```bash
cd /opt/ooda
sudo -u ooda git pull origin main
sudo -u ooda npm install --omit=dev
sudo systemctl restart ooda-agent
```

Then execute verification checks and confirm `/health`.
