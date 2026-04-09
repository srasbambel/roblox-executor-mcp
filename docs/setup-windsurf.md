# Windsurf Setup

## 1. Open the MCP config

In Windsurf, open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and search for **"Windsurf: Open MCP Config"**, or manually edit the config file:

- **macOS:** `~/.codeium/windsurf/mcp_config.json`
- **Windows:** `%USERPROFILE%\.codeium\windsurf\mcp_config.json`
- **Linux:** `~/.codeium/windsurf/mcp_config.json`

## 2. Add the MCP server

Add or merge the following:

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

Restart Windsurf or reload the window for the MCP server to connect.

## Verify

Open Cascade (Windsurf's AI panel) and check that the MCP tools are available. If the server isn't connecting:

- Make sure you ran `pnpm install && pnpm run build` first
- Check that the path to `dist/index.js` is correct
- Ensure Node.js ≥ 18 is installed
