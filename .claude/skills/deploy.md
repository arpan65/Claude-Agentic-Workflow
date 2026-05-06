# /deploy — Deploy TripAI to AWS

Deploy the full TripAI stack to AWS. Runs CDK deploy, then builds and uploads the frontend to S3.

## Steps

Run these in order. Stop and report any failure immediately.

### 1. Deploy CDK stack
```bash
cd /Users/arpan/Downloads/Projects/Claude-Agentic-Workflow/infra
cdk deploy TripAIStack --require-approval never 2>&1
```

Parse the output to extract:
- `InstancePublicIP` — EC2 IP address
- `FrontendBucketName` — S3 bucket name
- `CloudFrontURL` — CloudFront distribution URL

Also get the CloudFront Distribution ID:
```bash
aws cloudfront list-distributions --query "DistributionList.Items[0].Id" --output text
```

### 2. Remind user to SSH and set up .env
Tell the user:
> SSH into the EC2 instance and create /home/ec2-user/app/.env with ANTHROPIC_API_KEY and USE_DYNAMODB=true, then run: sudo systemctl start tripai

Wait for the user to confirm the backend is running before proceeding.

### 3. Install playwright-mcp on EC2
Remind the user to run on EC2 if not already done:
```
sudo npm install -g @playwright/mcp@0.0.73
```

### 4. Build and upload frontend
```bash
cd /Users/arpan/Downloads/Projects/Claude-Agentic-Workflow/frontend
VITE_API_URL=<CloudFrontURL> npm run build
aws s3 sync dist/ s3://<FrontendBucketName>/ --delete
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths "/*"
```

### 5. Report
Print a summary:
- CloudFront URL (frontend)
- EC2 IP (backend direct access)
- Backend health check result: `curl -s http://<EC2_IP>:8000/health`
