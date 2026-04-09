# Antigravity Setup

## 1. Open the MCP config

In Antigravity, open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and search for **"Antigravity: Manage MCP Servers"**, or manually edit the config file:

- **macOS:** `~/.gemini/antigravity/mcp_config.json`
- **Windows:** `%USERPROFILE%\.gemini\antigravity\mcp_config.json`
- **Linux:** `~/.gemini/antigravity/mcp_config.json`

## 2. Add the MCP server

Clock on "View raw config" button and add or merge the following:

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

Replace `/path/to/roblox-executor-mcp` with the actual path where you cloned the repo.

## 3. Reload

Click on the "Refresh" button next to the View raw config button.

## Verify

Check that the MCP tools are available in the AI panel. If the server isn't connecting:

- Make sure you ran `pnpm install && pnpm run build` first
- Check that the path to `dist/index.js` is correct
- Ensure Node.js ≥ 18 is installed
