# TripAI Deployment & Cleanup Runbook

## Infrastructure Overview

| Component | AWS Service |
|-----------|------------|
| Backend (FastAPI + agents) | EC2 t2.micro (Amazon Linux 2023) |
| Frontend (React/Vite static) | S3 + CloudFront |
| Database (observability) | DynamoDB (3 tables) |
| Secrets | `.env` file on EC2 |

**CloudFront** is the single entry point: `/api/*` and `/health` → EC2:8000, everything else → S3.

CDK stack name: `TripAIStack`  
EC2 key pair: `tripai-key` (file: `tripai-key.pem` at repo root)  
EC2 default region: `us-east-1`

---

## One-Shot Deploy

### Prerequisites (run once per machine)
```bash
# AWS CLI configured
aws configure

# CDK bootstrapped for account/region
cd infra && npx cdk bootstrap

# Node deps for CDK
cd infra && npm install
```

### 1. Deploy the stack
```bash
cd infra
cdk deploy TripAIStack --require-approval never
```

Note the outputs — you'll need:
- `InstancePublicIP` — EC2 IP for SSH
- `FrontendBucketName` — S3 bucket for frontend
- `CloudFrontURL` — public frontend URL

### 2. SSH into EC2 and set up .env
```bash
ssh -i tripai-key.pem ec2-user@<InstancePublicIP>

# Create .env on the instance
cat > /home/ec2-user/app/.env << 'EOF'
ANTHROPIC_API_KEY=sk-ant-...
EOF
```

### 3. Start the backend service
```bash
# On EC2
sudo systemctl start tripai
sudo systemctl status tripai

# Verify backend is up
curl http://localhost:8000/health
```

### 4. Build and deploy the frontend
```bash
# Locally — build the React app
cd frontend
VITE_API_URL=https://<CloudFrontURL> npm run build

# Upload to S3
aws s3 sync dist/ s3://<FrontendBucketName>/ --delete

# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id <DistributionId> \
  --paths "/*"
```

> Get DistributionId via:
> ```bash
> aws cloudfront list-distributions --query "DistributionList.Items[?Origins.Items[0].DomainName=='<FrontendBucketName>.s3.amazonaws.com'].Id" --output text
> ```

---

## EC2 Setup Details (first boot via UserData)

UserData in `infra/lib/infra-stack.ts` handles:
- `dnf` installs: git, curl, nodejs, npm, Playwright system libs
- `uv` install from astral.sh
- `git clone https://github.com/arpan65/Claude-Agentic-Workflow.git app`
- `uv sync --frozen` (Python deps)
- `uv run playwright install chromium`
- Writes `/etc/systemd/system/tripai.service` (does NOT start it — start manually after .env is in place)

### Install playwright-mcp globally (required — do this after first boot)
```bash
ssh -i tripai-key.pem ec2-user@<InstancePublicIP>
sudo npm install -g @playwright/mcp@0.0.73
# Verify
which playwright-mcp   # should be /usr/bin/playwright-mcp
```

**Why:** `npx @playwright/mcp@0.0.73` re-downloads on every pipeline run (~30s) causing MCP initialize() timeout. The global binary has no download overhead.

### Verify Chromium path
```bash
# On EC2 (as root, since service runs as root)
sudo PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright \
  /root/.local/bin/uv run playwright install chromium
```

---

## Useful EC2 Commands

```bash
# SSH
ssh -i tripai-key.pem ec2-user@<InstancePublicIP>

# Service control
sudo systemctl start tripai
sudo systemctl stop tripai
sudo systemctl restart tripai
sudo systemctl status tripai

# Live logs
sudo journalctl -u tripai -f

# Recent logs (last 100 lines)
sudo journalctl -u tripai -n 100

# Health check
curl http://localhost:8000/health

# Quick E2E test (returns SSE stream)
curl -s -X POST http://localhost:8000/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"Toronto to Montreal, 3 nights, 2 people, train, May 15-18 2026","test_mode":false}' \
  --no-buffer

# Test mode (replays last successful run, no agent calls)
curl -s -X POST http://localhost:8000/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"Toronto to Montreal, 3 nights, 2 people, train","test_mode":true}' \
  --no-buffer

# Pull latest code and restart
cd /home/ec2-user/app && git pull && sudo systemctl restart tripai
```

---

## Deploy Code Updates

```bash
# Locally — commit and push
git push origin main

# On EC2 — pull and restart
ssh -i tripai-key.pem ec2-user@<InstancePublicIP>
cd /home/ec2-user/app && git pull && sudo systemctl restart tripai
```

---

## One-Shot Cleanup (destroy everything)

### 1. Destroy CDK stack
```bash
cd infra
cdk destroy TripAIStack --force
```

This deletes: EC2, CloudFront, S3 bucket (+ all objects), IAM roles, security group.  
DynamoDB tables are **RETAINED** (removalPolicy: RETAIN) — delete manually in step 2.

### 2. Delete DynamoDB tables
```bash
aws dynamodb delete-table --table-name tripai-runs
aws dynamodb delete-table --table-name tripai-agent-calls
aws dynamodb delete-table --table-name tripai-tool-calls
```

### 3. (Optional) Delete EC2 key pair from AWS
```bash
aws ec2 delete-key-pair --key-name tripai-key
```

---

## Known Issues & Fixes

### playwright-mcp defaults to `chrome` distribution
**Symptom:** `Error: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome`  
**Fix:** Always pass `--browser chromium` in the MCP server args (already in `app/agent/config.py`):
```python
"browser": StdioServerParameters(
    command="playwright-mcp",
    args=["--browser", "chromium", "--config", playwright_config, "--isolated"],
    env=base_env,
)
```

### Pricer falls back to estimates ("browser unavailable")
**Cause:** playwright-mcp binary not installed globally, or Chromium not installed at `PLAYWRIGHT_BROWSERS_PATH`.  
**Fix:**
```bash
sudo npm install -g @playwright/mcp@0.0.73
sudo PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright \
  /root/.local/bin/uv run playwright install chromium
sudo systemctl restart tripai
```

### INFO logs not visible in journalctl
**Cause:** uvicorn `--log-level info` only affects uvicorn's own loggers; `app.*` loggers default to WARNING.  
**Fix:** Add `--log-level debug` or configure Python logging in `app/api.py`. Use `logger.error` for important pipeline events that must appear in journalctl.

### MCP connection timeout on first run after deploy
**Cause:** `npx` re-downloading `@playwright/mcp` (30s+).  
**Fix:** Use `npm install -g` (global binary, no download per invocation).
