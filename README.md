# Garmin for Claude (cloud spike)

Ask Claude about your Garmin sleep and HRV from any device: phone, web or desktop.
Runs in **your own** free Cloudflare account on Garmin's official Personal API. Read-only.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Leon-Rud/garmin-claude-worker-spike)

1. Click the button, sign in to Cloudflare, connect GitHub.
2. Paste your Garmin Personal API key and a password you make up (`MCP_TOKEN`). Deploy.
3. In Claude: Settings > Connectors > Add custom connector, URL `https://garmin-claude.<your-subdomain>.workers.dev/mcp`, then add header `Authorization: Bearer <MCP_TOKEN>`.

Experimental spike. Not affiliated with Garmin or Anthropic.
