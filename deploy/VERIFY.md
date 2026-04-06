# Deployment Verification

Run these checks after install, restart, and every upgrade.

## Service checks

```bash
sudo systemctl status ooda-agent --no-pager
sudo journalctl -u ooda-agent -n 100 --no-pager
```

Expected: active service, no crash loop, no repeated auth/env errors.

## Network checks

```bash
curl -fsS http://127.0.0.1:3100/health
curl -fsS https://your-agent.example.com/health
```

Expected response shape:

```json
{"ok":true,"checks":{"sqlite":true,"llm":true,"webhook":null},"timestamp":"..."}
```

## Auth check

```bash
curl -i https://your-agent.example.com/status
```

Expected: `401` without bearer token.

## Protected endpoint check

```bash
curl -fsS https://your-agent.example.com/status \
  -H "Authorization: Bearer $AUTH_TOKEN"
```

Expected: JSON payload with goals/recent activations.

## Persistence check

```bash
sudo ls -lh /var/lib/ooda/agent.db
```

Expected: sqlite file exists and updates over time.

## Nginx config check

```bash
sudo nginx -t
sudo systemctl status nginx --no-pager
```

Expected: config test passes and nginx active.
