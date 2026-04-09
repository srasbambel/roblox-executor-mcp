<p align="center">
  <img src="docs/banner.svg" alt="Roblox Executor MCP" width="900"/>
</p>

# Roblox Executor MCP Server

An MCP server that allows Agents to interact with a running Roblox game client — execute code, inspect scripts, spy on remotes, and more.

## Features

- **Code Execution** — Run Lua code and fetch data from the game client.
- **Script Inspection** — Decompile scripts and search across all sources.
- **Instance Search** — CSS-like selectors and hierarchy trees.
- **Remote Spy** — Intercept, log, block, and ignore Remotes/Bindables via [Cobalt](https://github.com/notpoiu/cobalt).
- **GUI Interaction** — Click buttons and type into text boxes.
- **Screenshot** — Capture Roblox window screenshots (Windows only).
- **Multi-Client** — Connect multiple Roblox clients at once. Dashboard at `http://localhost:16384/`.
- **Primary / Secondary** — Multiple MCP instances auto-coordinate with automatic promotion. Supports remote relaying via `--baseurl`. See [Advanced](docs/advanced.md).

## Prerequisites

- **Node.js** ≥ 18
- **A Roblox executor** that supports `loadstring`, `request`, and (preferably) `WebSocket`

## Quick Start

### 1. Build the server

```bash
git clone https://github.com/notpoiu/roblox-executor-mcp.git
cd roblox-executor-mcp
pnpm install && pnpm run build
```

### 2. Add to your AI client

Follow the setup guide for your client:

| Client | Guide |
|---|---|
| Cursor | [Setup Guide](docs/setup-cursor.md) |
| Claude Desktop | [Setup Guide](docs/setup-claude-desktop.md) |
| Claude Code | [Setup Guide](docs/setup-claude-code.md) |
| Codex CLI | [Setup Guide](docs/setup-codex.md) |
| Windsurf | [Setup Guide](docs/setup-windsurf.md) |
| Antigravity | [Setup Guide](docs/setup-antigravity.md) |

### 3. Connect from Roblox

Run `connector.luau` in your executor, or use the quick loader:

```lua
loadstring(game:HttpGet("https://raw.githubusercontent.com/notpoiu/roblox-executor-mcp/refs/heads/main/connector.luau"))()
```

**Optional settings** (set before the `loadstring`):
```lua
getgenv().BridgeURL = "10.0.0.4:16384"                  -- default: localhost:16384
getgenv().DisableWebSocket = true                        -- force HTTP polling
getgenv().DisableInitialScriptDecompMapping = true       -- skip initial decompilation
```

## Security

> **This server allows arbitrary code execution.** Only use with AI clients you trust. Port `16384` has no authentication — **never expose it to the internet.** For cross-machine setups, use a local network, VPN, or SSH tunnel. See [Advanced](docs/advanced.md) for details.

## License

[MIT](LICENSE)
