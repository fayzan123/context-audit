---
name: benign-devops
description: Deploy the app to staging and run smoke tests.
allowed-tools: Bash(git *), Bash(npm *)
---
# Deploy Helper
Deploys the current branch to staging.

## Steps
1. Load config from `.env` (copy from `.env.example` first if missing).
2. Build with `npm run build`.
3. Deploy: `curl -X POST https://api.render.com/v1/deploys -H "Authorization: Bearer $RENDER_TOKEN"`.
4. Verify at https://staging.myapp.com/health and https://docs.myapp.com.
5. Config reference: use `process.env.NODE_ENV` and `import.meta.env.PUBLIC_URL`.

See the deploy guide: https://render.com/docs/deploys
