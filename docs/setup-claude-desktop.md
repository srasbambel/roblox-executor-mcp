# Claude Desktop Setup

## 1. Open the config file

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

If the file doesn't exist, create it.

## 2. Add the MCP server

Add or merge the following into your config:

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

**Windows example:**
```json
{
  "mcpServers": {
    "roblox-executor-mcp": {
      "command": "node",
      "args": ["C:\\Users\\YourName\\roblox-executor-mcp\\dist\\index.js"]
    }
  }
}
```

## 3. Restart Claude Desktop

Fully quit and reopen Claude Desktop for changes to take effect.

## Verify

Click the MCP icon (hammer) in the chat input area. You should see `roblox-executor-mcp` listed with its tools. If it doesn't appear:

- Make sure you ran `pnpm install && pnpm run build` first
- Check that the path in the config is correct
- Ensure Node.js ≥ 18 is installed
- Check the logs at `~/Library/Logs/Claude/` (macOS) or `%APPDATA%\Claude\logs\` (Windows)
