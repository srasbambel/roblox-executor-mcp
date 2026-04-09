# Cursor Setup

## Option 1: Deeplink (Quick)

Click the button below to auto-install (you'll need to update the path afterwards):

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en-US/install-mcp?name=roblox-executor-mcp&config=eyJjb21tYW5kIjoibm9kZSAvcGF0aC90by9NQ1BTZXJ2ZXIvZGlzdC9pbmRleC5qcyJ9)

## Option 2: Manual

1. Open Cursor
2. Go to **Settings** > **Features** > **MCP**
3. Click **Add New MCP Server**
4. Fill in:
   - **Name:** `roblox-executor-mcp`
   - **Type:** `command`
   - **Command:** `node /path/to/roblox-executor-mcp/dist/index.js`

Replace `/path/to/roblox-executor-mcp` with the actual path where you cloned the repo.

## Option 3: JSON Config

Add this to your Cursor MCP config file (`.cursor/mcp.json` in your project or global config):

```json
{
  "mcpServers": {
    "roblox-executor-mcp": {
      "command": "node",
      "args": ["/path/to/roblox-executor-mcp/dist/index.js"]
    }
  }
}
```

## Verify

After setup, you should see `roblox-executor-mcp` listed in your MCP servers with a green status indicator. If it shows red, check that:

- You ran `pnpm install && pnpm run build` first
- The path to `dist/index.js` is correct
- Node.js ≥ 18 is installed
