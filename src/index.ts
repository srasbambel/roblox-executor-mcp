#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebSocketServer, WebSocket } from "ws";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync } from "child_process";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { z } from "zod";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const WS_PORT = 16384;
const HTTP_POLL_TIMEOUT = 10000; // 10 seconds
const PROMOTION_JITTER_MAX = 300; // ms
const TOOL_RESPONSE_TIMEOUT = 15000; // 15 seconds

// ─── CLI argument parsing ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const baseUrlIdx = args.indexOf("--baseurl");
const BASE_URL: string | null = baseUrlIdx !== -1 ? (args[baseUrlIdx + 1] ?? null) : null;

if (BASE_URL) {
  console.error(`[Config] --baseurl specified: ${BASE_URL} (will run as secondary relay to this host)`);
}

// ─── Instance role ──────────────────────────────────────────────────────────────
let instanceRole: "primary" | "secondary" = "primary";

// ─── Roblox Client Registry ─────────────────────────────────────────────────────
interface RobloxClient {
  clientId: string;
  username: string;
  userId: number;
  placeId: number;
  jobId: string;
  placeName: string;
  transport: "ws" | "http";
  ws?: WebSocket;
  lastHttpPoll: number;
  pendingHttpCommand: any;
}

let clientRegistry: Map<string, RobloxClient> = new Map();
// Map ws → clientId for quick lookup on message/close
let wsToClientId: Map<WebSocket, string> = new Map();

// ─── Global Active Client ───────────────────────────────────────────────────────
let activeClientId: string | undefined = undefined;

// ─── Primary-mode state ─────────────────────────────────────────────────────────
let httpServer: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;

let httpResponseResolvers: Map<string, (data: any) => void> = new Map();
// Track which clientId a given request id was sent to (for response routing)
let requestToClientId: Map<string, string> = new Map();

// Relay clients (secondaries connected to this primary)
let relayClients: Set<WebSocket> = new Set();
// Map request id → relay WebSocket that sent it, so responses route back
let relayRequestOrigin: Map<string, WebSocket> = new Map();

// ─── Secondary-mode state ───────────────────────────────────────────────────────
let relaySocket: WebSocket | null = null;
let secondaryResponseResolvers: Map<string, (data: any) => void> = new Map();

// ─── Status page HTML ───────────────────────────────────────────────────────────
const STATUS_PAGE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Roblox MCP — Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        /* ── Reset & Tokens ──────────────────────────────────────── */
        :root {
            --bg: #09090b;
            --surface: rgba(255,255,255,0.03);
            --surface-raised: rgba(255,255,255,0.05);
            --border: rgba(255,255,255,0.06);
            --border-highlight: rgba(255,255,255,0.1);
            --accent: #2dd4bf;
            --accent-dim: rgba(45,212,191,0.15);
            --accent-glow: rgba(45,212,191,0.3);
            --amber: #f59e0b;
            --amber-dim: rgba(245,158,11,0.15);
            --success: #34d399;
            --error: #f87171;
            --error-dim: rgba(248,113,113,0.12);
            --text: #fafafa;
            --text-secondary: #a1a1aa;
            --text-tertiary: #52525b;
            --mono: 'IBM Plex Mono', monospace;
            --sans: 'Instrument Sans', system-ui, sans-serif;
            --radius: 16px;
            --radius-sm: 10px;
        }

        *, *::before, *::after {
            margin: 0; padding: 0; box-sizing: border-box;
        }

        html { height: 100%; }

        body {
            font-family: var(--sans);
            background: var(--bg);
            color: var(--text);
            min-height: 100vh;
            overflow-x: hidden;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }

        /* ── Animated background layers ──────────────────────────── */
        .bg-layer {
            position: fixed; inset: 0; z-index: 0; pointer-events: none;
        }

        .bg-gradient {
            background:
                radial-gradient(ellipse 80% 60% at 10% 20%, rgba(45,212,191,0.08) 0%, transparent 60%),
                radial-gradient(ellipse 60% 80% at 90% 80%, rgba(245,158,11,0.06) 0%, transparent 60%),
                radial-gradient(ellipse 50% 50% at 50% 50%, rgba(45,212,191,0.03) 0%, transparent 80%);
            animation: bgShift 20s ease-in-out infinite alternate;
        }

        @keyframes bgShift {
            0% { opacity: 1; filter: hue-rotate(0deg); }
            100% { opacity: 0.7; filter: hue-rotate(15deg); }
        }

        .bg-grid {
            background-image: radial-gradient(circle, rgba(255,255,255,0.03) 1px, transparent 1px);
            background-size: 32px 32px;
        }

        .bg-noise {
            opacity: 0.015;
            background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
            background-repeat: repeat;
            background-size: 256px 256px;
        }



        /* ── Shell layout ────────────────────────────────────────── */
        .shell {
            position: relative; z-index: 1;
            max-width: 720px;
            margin: 0 auto;
            padding: 2rem 1.5rem 3rem;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }

        /* ── Header ──────────────────────────────────────────────── */
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.75rem 0;
            margin-bottom: 2.5rem;
            animation: fadeDown 0.7s cubic-bezier(0.16,1,0.3,1) both;
        }

        @keyframes fadeDown {
            from { opacity: 0; transform: translateY(-12px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .header-left {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .logo-mark {
            width: 36px; height: 36px;
            border-radius: 10px;
            background: linear-gradient(135deg, var(--accent) 0%, rgba(45,212,191,0.4) 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1rem;
            font-weight: 700;
            color: #09090b;
            letter-spacing: -0.04em;
            box-shadow: 0 0 20px var(--accent-dim), inset 0 1px 0 rgba(255,255,255,0.2);
        }

        .logo-text {
            font-weight: 600;
            font-size: 1.05rem;
            color: var(--text);
            letter-spacing: -0.01em;
        }

        .logo-text span {
            color: var(--text-secondary);
            font-weight: 400;
        }

        .header-right {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .uptime-chip {
            font-family: var(--mono);
            font-size: 0.7rem;
            color: var(--text-tertiary);
            background: var(--surface);
            border: 1px solid var(--border);
            padding: 0.3rem 0.65rem;
            border-radius: 99px;
            letter-spacing: 0.02em;
        }

        .role-chip {
            font-size: 0.65rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            padding: 0.3rem 0.7rem;
            border-radius: 99px;
            background: var(--accent-dim);
            color: var(--accent);
            border: 1px solid rgba(45,212,191,0.2);
        }

        /* ── Connection graph ─────────────────────────────────────── */
        .graph-section {
            padding: 1rem 0 2rem;
            animation: fadeUp 0.8s cubic-bezier(0.16,1,0.3,1) 0.1s both;
        }

        @keyframes fadeUp {
            from { opacity: 0; transform: translateY(16px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .graph-canvas {
            width: 100%;
            height: 320px;
            display: block;
        }

        .graph-label {
            text-align: center;
            margin-top: 0.75rem;
        }

        .graph-title {
            font-size: 1.4rem;
            font-weight: 700;
            letter-spacing: -0.035em;
            margin-bottom: 0.25rem;
            transition: color 0.5s ease;
        }

        .graph-sub {
            font-size: 0.85rem;
            color: var(--text-secondary);
            font-weight: 400;
        }

        @keyframes dashFlow {
            to { stroke-dashoffset: -20; }
        }

        @keyframes nodeAppear {
            from { transform: scale(0); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
        }

        @keyframes centerPulse {
            0%, 100% { r: 28; opacity: 0.15; }
            50% { r: 36; opacity: 0.05; }
        }

        /* ── Stats row ───────────────────────────────────────────── */
        .stats-row {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 0.75rem;
            margin-bottom: 2rem;
            animation: fadeUp 0.8s cubic-bezier(0.16,1,0.3,1) 0.25s both;
        }

        .stat-tile {
            position: relative;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            padding: 1.25rem 1rem;
            overflow: hidden;
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }

        .stat-tile:hover {
            border-color: var(--border-highlight);
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        }

        .stat-tile::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--accent-dim), transparent);
            opacity: 0;
            transition: opacity 0.3s ease;
        }

        .stat-tile:hover::before { opacity: 1; }

        .stat-tile-icon {
            font-size: 1.1rem;
            margin-bottom: 0.6rem;
            opacity: 0.7;
        }

        .stat-tile-value {
            font-family: var(--mono);
            font-size: 1.5rem;
            font-weight: 600;
            color: var(--text);
            line-height: 1;
            margin-bottom: 0.35rem;
        }

        .stat-tile-label {
            font-size: 0.7rem;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--text-tertiary);
            font-weight: 500;
        }

        /* ── Client panel ────────────────────────────────────────── */
        .panel {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            overflow: hidden;
            animation: fadeUp 0.8s cubic-bezier(0.16,1,0.3,1) 0.4s both;
            flex: 1;
            display: flex;
            flex-direction: column;
        }

        .panel-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.9rem 1.25rem;
            border-bottom: 1px solid var(--border);
            background: var(--surface-raised);
        }

        .panel-title {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: var(--text-secondary);
        }

        .panel-title-dot {
            width: 6px; height: 6px;
            border-radius: 50%;
            background: var(--accent);
            box-shadow: 0 0 8px var(--accent-dim);
        }

        .panel-count {
            font-family: var(--mono);
            font-size: 0.7rem;
            color: var(--text-tertiary);
            background: var(--surface);
            padding: 0.15rem 0.5rem;
            border-radius: 99px;
            border: 1px solid var(--border);
        }

        .panel-body {
            padding: 0.5rem;
            overflow-y: auto;
            max-height: 320px;
            flex: 1;
        }

        .panel-body::-webkit-scrollbar { width: 4px; }
        .panel-body::-webkit-scrollbar-track { background: transparent; }
        .panel-body::-webkit-scrollbar-thumb { background: var(--border-highlight); border-radius: 99px; }

        .client-empty {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 3rem 1rem;
            color: var(--text-tertiary);
            font-size: 0.85rem;
            gap: 0.5rem;
        }

        .client-empty-icon {
            font-size: 2rem;
            opacity: 0.3;
        }

        .client-card {
            display: flex;
            align-items: flex-start;
            gap: 0.75rem;
            padding: 0.85rem 0.9rem;
            border-radius: var(--radius-sm);
            transition: background 0.2s ease;
            cursor: default;
        }

        .client-card:hover {
            background: var(--surface-raised);
        }

        .client-avatar {
            width: 34px; height: 34px;
            border-radius: 8px;
            background: linear-gradient(135deg, var(--accent-dim), var(--amber-dim));
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            font-size: 0.75rem;
            color: var(--accent);
            flex-shrink: 0;
            border: 1px solid var(--border);
            overflow: hidden;
        }

        .client-avatar img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .client-info {
            flex: 1;
            min-width: 0;
        }

        .client-name-row {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin-bottom: 0.2rem;
        }

        .client-username {
            font-weight: 600;
            font-size: 0.85rem;
            color: var(--text);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .client-transport {
            font-family: var(--mono);
            font-size: 0.55rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            padding: 0.1rem 0.4rem;
            border-radius: 4px;
            flex-shrink: 0;
        }

        .transport-ws {
            background: var(--accent-dim);
            color: var(--accent);
        }

        .transport-http {
            background: var(--amber-dim);
            color: var(--amber);
        }

        .client-place {
            font-size: 0.75rem;
            color: var(--text-secondary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .client-id {
            font-family: var(--mono);
            font-size: 0.6rem;
            color: var(--text-tertiary);
            margin-top: 0.15rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* ── Footer ──────────────────────────────────────────────── */
        .footer {
            text-align: center;
            padding: 1.5rem 0 0;
            font-size: 0.7rem;
            color: var(--text-tertiary);
            letter-spacing: 0.02em;
            animation: fadeUp 0.8s cubic-bezier(0.16,1,0.3,1) 0.55s both;
        }

        .footer a {
            color: var(--text-tertiary);
            text-decoration: none;
            border-bottom: 1px solid var(--border);
            transition: color 0.2s ease, border-color 0.2s ease;
        }

        .footer a:hover {
            color: var(--accent);
            border-color: var(--accent);
        }

        /* ── Responsive ──────────────────────────────────────────── */
        @media (max-width: 520px) {
            .shell { padding: 1rem 1rem 2rem; }
            .stats-row { grid-template-columns: 1fr 1fr; }
            .stats-row .stat-tile:last-child { grid-column: span 2; }
            .hero-title { font-size: 1.6rem; }
            .header { flex-wrap: wrap; gap: 0.5rem; }
        }
    </style>
</head>
<body>
    <!-- Background layers -->
    <div class="bg-layer bg-gradient"></div>
    <div class="bg-layer bg-grid"></div>
    <div class="bg-layer bg-noise"></div>


    <div class="shell">
        <!-- Header -->
        <header class="header">
            <div class="header-left">
                <div class="logo-mark">M</div>
                <div class="logo-text">Roblox <span>MCP</span></div>
            </div>
            <div class="header-right">
                <div class="uptime-chip" id="uptimeChip">00:00:00</div>
                <div class="role-chip" id="roleChip">—</div>
            </div>
        </header>

        <!-- Connection graph -->
        <section class="graph-section">
            <svg class="graph-canvas" id="graphCanvas" viewBox="0 0 720 320"></svg>
            <div class="graph-label">
                <h1 class="graph-title" id="graphTitle">Disconnected</h1>
                <p class="graph-sub" id="graphSub">Waiting for Roblox clients…</p>
            </div>
        </section>

        <!-- Stats -->
        <div class="stats-row">
            <div class="stat-tile">
                <div class="stat-tile-icon">◈</div>
                <div class="stat-tile-value" id="statClients">0</div>
                <div class="stat-tile-label">Clients</div>
            </div>
            <div class="stat-tile">
                <div class="stat-tile-icon">⟁</div>
                <div class="stat-tile-value" id="statRelay">0</div>
                <div class="stat-tile-label">Relay Peers</div>
            </div>
        </div>

        <!-- Client panel -->
        <div class="panel">
            <div class="panel-header">
                <div class="panel-title">
                    <div class="panel-title-dot"></div>
                    Connected Clients
                </div>
                <div class="panel-count" id="panelCount">0</div>
            </div>
            <div class="panel-body" id="clientList">
                <div class="client-empty">
                    <div class="client-empty-icon">◌</div>
                    No clients connected
                </div>
            </div>
        </div>

        <!-- Footer -->
        <footer class="footer">
            Roblox MCP Server · Port ${String(WS_PORT)} · <a href="https://github.com/notpoiu/roblox-mcp" target="_blank" rel="noopener">GitHub</a>
        </footer>
    </div>

    <script>
        const SVG_NS = 'http://www.w3.org/2000/svg';
        const graphCanvas = document.getElementById('graphCanvas');
        const graphTitle = document.getElementById('graphTitle');
        const graphSub = document.getElementById('graphSub');
        const statClients = document.getElementById('statClients');
        const statRelay = document.getElementById('statRelay');
        const roleChip = document.getElementById('roleChip');
        const panelCount = document.getElementById('panelCount');
        const clientList = document.getElementById('clientList');
        const uptimeChip = document.getElementById('uptimeChip');

        const CX = 360, CY = 160;
        const ORBIT_RX = 200, ORBIT_RY = 110;
        const NODE_COLORS = ['#2dd4bf','#38bdf8','#a78bfa','#fb923c','#f472b6','#facc15','#4ade80','#f87171'];
        let prevNodeCount = -1;

        function svgEl(tag, attrs) {
            const el = document.createElementNS(SVG_NS, tag);
            for (const k in attrs) el.setAttribute(k, attrs[k]);
            return el;
        }

        function renderGraph(clients, relayCount) {
            const nodes = [];
            if (clients) {
                clients.forEach(function(c) {
                    nodes.push({ label: c.username.slice(0,2).toUpperCase(), name: c.username, type: 'client', userId: c.userId || 0 });
                });
            }
            for (var r = 0; r < (relayCount || 0); r++) {
                nodes.push({ label: 'R' + (r+1), name: 'Relay ' + (r+1), type: 'relay' });
            }

            if (nodes.length === prevNodeCount) return;
            prevNodeCount = nodes.length;

            graphCanvas.innerHTML = '';

            /* defs */
            const defs = svgEl('defs', {});
            const glow = svgEl('filter', { id: 'glow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
            glow.appendChild(svgEl('feGaussianBlur', { stdDeviation: '4', result: 'blur' }));
            const merge = svgEl('feMerge', {});
            merge.appendChild(svgEl('feMergeNode', { 'in': 'blur' }));
            merge.appendChild(svgEl('feMergeNode', { 'in': 'SourceGraphic' }));
            glow.appendChild(merge);
            defs.appendChild(glow);
            graphCanvas.appendChild(defs);

            /* center glow ring */
            const pulse = svgEl('circle', {
                cx: CX, cy: CY, r: '32',
                fill: nodes.length > 0 ? 'rgba(45,212,191,0.1)' : 'rgba(248,113,113,0.08)',
                stroke: 'none'
            });
            pulse.innerHTML = '<animate attributeName="r" values="28;38;28" dur="3s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.15;0.05;0.15" dur="3s" repeatCount="indefinite"/>';
            graphCanvas.appendChild(pulse);

            /* connecting lines + satellite nodes */
            var total = nodes.length;
            var spread = total <= 1 ? 0 : Math.PI * 1.4;
            var startAngle = total <= 1 ? 0 : -Math.PI / 2 - spread / 2;

            nodes.forEach(function(node, i) {
                var angle = total === 1 ? -Math.PI/2 : startAngle + (spread / (total - 1)) * i;
                var nx = CX + Math.cos(angle) * ORBIT_RX;
                var ny = CY + Math.sin(angle) * ORBIT_RY;
                var color = NODE_COLORS[i % NODE_COLORS.length];

                /* line (static dashes) */
                var line = svgEl('line', {
                    x1: CX, y1: CY, x2: nx, y2: ny,
                    stroke: color, 'stroke-width': '1.5', 'stroke-opacity': '0.3',
                    'stroke-dasharray': '6 4'
                });
                graphCanvas.appendChild(line);

                /* outbound travelling dot (center -> satellite) */
                var dotOut = svgEl('circle', { r: '2.5', fill: color, opacity: '0.8' });
                var motionOut = svgEl('animateMotion', {
                    dur: (2 + Math.random()).toFixed(1) + 's',
                    repeatCount: 'indefinite',
                    path: 'M'+CX+','+CY+' L'+nx+','+ny
                });
                dotOut.appendChild(motionOut);
                graphCanvas.appendChild(dotOut);

                /* inbound travelling dot (satellite -> center) */
                var dotIn = svgEl('circle', { r: '2.5', fill: color, opacity: '0.6' });
                var motionIn = svgEl('animateMotion', {
                    dur: (2.5 + Math.random()).toFixed(1) + 's',
                    repeatCount: 'indefinite',
                    path: 'M'+nx+','+ny+' L'+CX+','+CY
                });
                dotIn.appendChild(motionIn);
                graphCanvas.appendChild(dotIn);

                /* satellite node group */
                var g = svgEl('g', {
                    style: 'animation: nodeAppear 0.5s cubic-bezier(0.16,1,0.3,1) ' + (i * 0.08).toFixed(2) + 's both; transform-origin: '+nx+'px '+ny+'px'
                });

                /* outer ring */
                g.appendChild(svgEl('circle', {
                    cx: nx, cy: ny, r: '24',
                    fill: 'none', stroke: color, 'stroke-width': '1', 'stroke-opacity': '0.2'
                }));

                /* filled circle */
                g.appendChild(svgEl('circle', {
                    cx: nx, cy: ny, r: '18',
                    fill: '#09090b', stroke: color, 'stroke-width': '1.5', 'stroke-opacity': '0.6'
                }));

                /* avatar image or label */
                if (node.userId && node.userId > 0) {
                    /* clip path for circular avatar */
                    var clipId = 'avatarClip' + i;
                    var clip = svgEl('clipPath', { id: clipId });
                    clip.appendChild(svgEl('circle', { cx: nx, cy: ny, r: '15' }));
                    defs.appendChild(clip);

                    var img = svgEl('image', {
                        x: nx - 15, y: ny - 15, width: '30', height: '30',
                        href: '/api/avatar?userId=' + node.userId,
                        'clip-path': 'url(#' + clipId + ')',
                        preserveAspectRatio: 'xMidYMid slice'
                    });
                    g.appendChild(img);
                } else {
                    /* text label fallback */
                    var txt = svgEl('text', {
                        x: nx, y: ny, 'text-anchor': 'middle', 'dominant-baseline': 'central',
                        fill: color, 'font-family': 'IBM Plex Mono, monospace',
                        'font-size': '10', 'font-weight': '600', 'letter-spacing': '0.05em'
                    });
                    txt.textContent = node.label;
                    g.appendChild(txt);
                }

                /* name below */
                var nameTxt = svgEl('text', {
                    x: nx, y: ny + 30, 'text-anchor': 'middle',
                    fill: '#a1a1aa', 'font-family': 'Instrument Sans, sans-serif',
                    'font-size': '9', 'font-weight': '500'
                });
                nameTxt.textContent = node.name;
                g.appendChild(nameTxt);

                graphCanvas.appendChild(g);
            });

            /* center node (on top) */
            var cg = svgEl('g', { filter: 'url(#glow)' });
            var centerColor = nodes.length > 0 ? '#2dd4bf' : '#f87171';

            cg.appendChild(svgEl('circle', {
                cx: CX, cy: CY, r: '26',
                fill: '#09090b', stroke: centerColor, 'stroke-width': '2'
            }));

            var mTxt = svgEl('text', {
                x: CX, y: CY, 'text-anchor': 'middle', 'dominant-baseline': 'central',
                fill: centerColor, 'font-family': 'Instrument Sans, sans-serif',
                'font-size': '13', 'font-weight': '700'
            });
            mTxt.textContent = 'MCP';
            cg.appendChild(mTxt);
            graphCanvas.appendChild(cg);
        }

        /* initial idle state */
        renderGraph([], 0);

        const startTime = Date.now();

        function updateUptime() {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
            const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
            const s = String(elapsed % 60).padStart(2, '0');
            uptimeChip.textContent = h + ':' + m + ':' + s;
        }

        setInterval(updateUptime, 1000);

        function getInitials(name) {
            return name.slice(0, 2).toUpperCase();
        }

        function renderClients(clients) {
            if (!clients || clients.length === 0) {
                clientList.innerHTML = '<div class="client-empty"><div class="client-empty-icon">◌</div>No clients connected</div>';
                return;
            }

            clientList.innerHTML = clients.map(function(c) {
                var transportClass = c.transport === 'ws' ? 'transport-ws' : 'transport-http';
                var avatarContent = '';
                if (c.userId && c.userId > 0) {
                    avatarContent = '<img src="/api/avatar?userId=' + c.userId + '" data-initials="' + getInitials(c.username) + '" />';
                } else {
                    avatarContent = getInitials(c.username);
                }
                return '<div class="client-card">' +
                    '<div class="client-avatar">' + avatarContent + '</div>' +
                    '<div class="client-info">' +
                        '<div class="client-name-row">' +
                            '<span class="client-username">' + c.username + '</span>' +
                            '<span class="client-transport ' + transportClass + '">' + c.transport.toUpperCase() + '</span>' +
                        '</div>' +
                        '<div class="client-place">' + c.placeName + '</div>' +
                        '<div class="client-id">' + c.clientId + '</div>' +
                    '</div>' +
                '</div>';
            }).join('');

            /* attach onerror fallback to avatar images */
            clientList.querySelectorAll('.client-avatar img').forEach(function(img) {
                img.onerror = function() {
                    var initials = img.getAttribute('data-initials') || '??';
                    img.parentNode.textContent = initials;
                };
            });
        }

        async function updateStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();

                if (data.connected) {
                    graphTitle.textContent = 'Connected';
                    graphTitle.style.color = 'var(--success)';
                    graphSub.textContent = data.clientCount + ' client' + (data.clientCount !== 1 ? 's' : '') + ' active';
                } else {
                    graphTitle.textContent = 'Disconnected';
                    graphTitle.style.color = 'var(--error)';
                    graphSub.textContent = 'Waiting for Roblox clients\u2026';
                }

                renderGraph(data.clients || [], data.relayClients || 0);

                statClients.textContent = data.clientCount;
                statRelay.textContent = data.relayClients;
                roleChip.textContent = data.role;
                panelCount.textContent = data.clientCount;

                renderClients(data.clients);
            } catch (e) {
                graphTitle.textContent = 'Offline';
                graphTitle.style.color = 'var(--error)';
                graphSub.textContent = 'Cannot reach server';
                renderGraph([], 0);
            }
        }

        setInterval(updateStatus, 2000);
        updateStatus();
    </script>
</body>
</html>
`;

// ─── MCP Server (always created regardless of role) ─────────────────────────────
const server = new McpServer({
  name: "RobloxMCP",
  version: "1.0.0",
  description:
    "A MCP Server allowing interaction to the Roblox Game Client (including access to restricted APIs such as getgc(), getreg(), etc.) with full control over the game.",
});

const NO_CLIENT_ERROR = {
  content: [
    {
      type: "text" as const,
      text: "No Roblox client connected to the MCP server. Please notify the user that they have to run the connector.luau script in order to connect the MCP server to their game.",
    },
  ],
  isError: true,
};

const INVALID_CLIENT_ERROR = {
  content: [
    {
      type: "text" as const,
      text: "Invalid client ID provided. Please use the get-clients tool to get a list of valid client IDs.",
    },
  ],
  isError: true,
};

// ─── Client registry helpers ────────────────────────────────────────────────────

function registerClient(info: {
  username: string;
  userId: number;
  placeId: number;
  jobId: string;
  placeName: string;
  transport: "ws" | "http";
  ws?: WebSocket;
}): string {
  const clientId = crypto.randomUUID();
  const entry: RobloxClient = {
    clientId,
    username: info.username,
    userId: info.userId,
    placeId: info.placeId,
    jobId: info.jobId,
    placeName: info.placeName,
    transport: info.transport,
    ws: info.ws,
    lastHttpPoll: Date.now(),
    pendingHttpCommand: null,
  };
  clientRegistry.set(clientId, entry);
  if (info.ws) {
    wsToClientId.set(info.ws, clientId);
  }
  console.error(
    `[Registry] Client registered: ${clientId} (${info.username} @ ${info.placeName}, ${info.transport})`
  );
  return clientId;
}

function unregisterClient(clientId: string) {
  const entry = clientRegistry.get(clientId);
  if (entry?.ws) {
    wsToClientId.delete(entry.ws);
  }
  clientRegistry.delete(clientId);
  console.error(`[Registry] Client unregistered: ${clientId}`);
}

function getActiveClients(): RobloxClient[] {
  const active: RobloxClient[] = [];
  for (const entry of clientRegistry.values()) {
    if (entry.transport === "ws") {
      if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
        active.push(entry);
      }
    } else {
      if (Date.now() - entry.lastHttpPoll < HTTP_POLL_TIMEOUT) {
        active.push(entry);
      }
    }
  }
  return active;
}

function formatActiveClientListForTool(): string {
  const active = getActiveClients();
  if (active.length === 0) {
    return "No Roblox clients are currently connected.";
  }

  const clientList = active.map((c) => ({
    clientId: c.clientId,
    username: c.username,
    placeId: c.placeId,
    jobId: c.jobId,
    placeName: c.placeName,
    transport: c.transport,
  }));

  return JSON.stringify(clientList, null, 2);
}

/** Resolve a target client by clientId, or pick the most recently active one. */
function resolveTargetClient(clientId?: string): RobloxClient | null {
  if (clientId) {
    const entry = clientRegistry.get(clientId);
    if (!entry) return null;
    // Verify it's still alive
    if (entry.transport === "ws" && (!entry.ws || entry.ws.readyState !== WebSocket.OPEN)) return null;
    if (entry.transport === "http" && Date.now() - entry.lastHttpPoll >= HTTP_POLL_TIMEOUT) return null;
    return entry;
  }
  // Default: most recently active
  const active = getActiveClients();
  if (active.length === 0) return null;
  // Prefer WS clients, then most recent HTTP poll
  const wsCl = active.filter((c) => c.transport === "ws");
  if (wsCl.length > 0) return wsCl[wsCl.length - 1];
  return active.sort((a, b) => b.lastHttpPoll - a.lastHttpPoll)[0];
}

// ─── Abstraction layer — these work in both primary & secondary mode ────────────
function SendToClient(target: RobloxClient, message: string) {
  if (target.transport === "ws" && target.ws && target.ws.readyState === WebSocket.OPEN) {
    target.ws.send(message);
  } else if (target.transport === "http") {
    target.pendingHttpCommand = message;
  }
}

function GetResponseOfIdFromClient(
  id: string,
  timeoutMs: number = TOOL_RESPONSE_TIMEOUT
): Promise<any> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout;

    const resolveOnce = (data: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(data);
    };

    timeout = setTimeout(() => {
      if (instanceRole === "secondary") {
        secondaryResponseResolvers.delete(id);
      } else {
        httpResponseResolvers.delete(id);
      }

      resolveOnce({
        id,
        output: undefined,
        error: `Timed out waiting for response after ${timeoutMs}ms.`,
      });
    }, timeoutMs);

    if (instanceRole === "secondary") {
      secondaryResponseResolvers.set(id, resolveOnce);
      return;
    }
    httpResponseResolvers.set(id, resolveOnce);
  });
}

function SendArbitraryDataToClient(
  type: string,
  data: any,
  id: string | undefined = undefined,
  clientId: string | undefined = undefined,
) {
  if (instanceRole === "secondary") {
    // Secondaries relay everything through
    if (!relaySocket || relaySocket.readyState !== WebSocket.OPEN) return null;
    if (id === undefined) id = crypto.randomUUID();
    const message = { id, ...data, type, ...(clientId ? { targetClientId: clientId } : {}) };
    relaySocket.send(JSON.stringify(message));
    return id;
  }

  if (clientId !== undefined) {
    const target = resolveTargetClient(clientId);
    if (!target) return "INVALID_CLIENT";

    if (id === undefined) id = crypto.randomUUID();

    const message = { id, ...data, type };
    requestToClientId.set(id, target.clientId);
    SendToClient(target, JSON.stringify(message));

    return id;
  }

  // If clientId is undefined, replicate to all active clients
  const activeClients = getActiveClients();
  if (activeClients.length === 0) return null;

  if (id === undefined) id = crypto.randomUUID();
  const message = { id, ...data, type };

  for (const target of activeClients) {
    // We only track the last one for routing, but the primary broadcasts to all
    requestToClientId.set(id, target.clientId);
    SendToClient(target, JSON.stringify(message));
  }

  return id;
}

// ─── Primary mode ───────────────────────────────────────────────────────────────

function startAsPrimary(): Promise<void> {
  return new Promise((resolve, reject) => {
    instanceRole = "primary";

    // Reset primary state
    clientRegistry = new Map();
    wsToClientId = new Map();
    httpResponseResolvers = new Map();
    requestToClientId = new Map();
    relayClients = new Set();
    relayRequestOrigin = new Map();

    httpServer = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || "/", `http://localhost:${WS_PORT}`);

        // ── Root status page ──
        if (url.pathname === "/" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(STATUS_PAGE_HTML);
          return;
        }

        // ── API Status ──
        if (url.pathname === "/api/status" && req.method === "GET") {
          const active = getActiveClients();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              connected: active.length > 0,
              clientCount: active.length,
              role: "Primary",
              relayClients: relayClients.size,
              clients: active.map((c) => ({
                clientId: c.clientId,
                username: c.username,
                userId: c.userId,
                placeId: c.placeId,
                jobId: c.jobId,
                placeName: c.placeName,
                transport: c.transport,
              })),
            })
          );
          return;
        }

        // ── Avatar thumbnail proxy ──
        if (url.pathname === "/api/avatar" && req.method === "GET") {
          const userId = url.searchParams.get("userId");
          if (!userId) {
            res.writeHead(400);
            res.end("Missing userId");
            return;
          }

          try {
            const robloxRes = await fetch(
              `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(userId)}&size=150x150&format=Png&isCircular=false`
            );
            const json = await robloxRes.json() as { data?: { imageUrl?: string }[] };
            const imageUrl = json.data?.[0]?.imageUrl;
            if (imageUrl) {
              res.writeHead(302, { Location: imageUrl, "Cache-Control": "public, max-age=300" });
              res.end();
            } else {
              res.writeHead(404);
              res.end("No thumbnail found");
            }
          } catch {
            res.writeHead(502);
            res.end("Failed to fetch thumbnail");
          }
          return;
        }

        // ── HTTP client registration ──
        if (url.pathname === "/register" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => { body += chunk.toString(); });
          req.on("end", () => {
            try {
              const info = JSON.parse(body);
              const clientId = registerClient({
                username: info.username || "Unknown",
                userId: info.userId || 0,
                placeId: info.placeId || 0,
                jobId: info.jobId || "",
                placeName: info.placeName || "Unknown",
                transport: "http",
              });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ clientId }));
            } catch {
              res.writeHead(400);
              res.end("Invalid JSON");
            }
          });
          return;
        }

        // ── HTTP polling — return pending command ──
        if (url.pathname === "/poll" && req.method === "GET") {
          const clientId = url.searchParams.get("clientId");
          if (!clientId) {
            res.writeHead(400);
            res.end("Missing clientId query parameter");
            return;
          }

          const client = clientRegistry.get(clientId);
          if (!client) {
            res.writeHead(404);
            res.end("Unknown clientId");
            return;
          }

          client.lastHttpPoll = Date.now();

          if (client.pendingHttpCommand) {
            const cmd = client.pendingHttpCommand;
            client.pendingHttpCommand = null;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(cmd);
          } else {
            res.writeHead(204);
            res.end();
          }
          return;
        }

        // ── HTTP polling — receive response from client ──
        if (url.pathname === "/respond" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => { body += chunk.toString(); });
          req.on("end", () => {
            try {
              const data = JSON.parse(body);
              handleRobloxResponse(data);
              res.writeHead(200);
              res.end("OK");
            } catch {
              res.writeHead(400);
              res.end("Invalid JSON");
            }
          });
          return;
        }

        // ── Screenshot API (used by secondary relay) ──
        if (url.pathname === "/api/screenshot" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", () => {
            try {
              if (process.platform !== "win32") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Screenshots are only supported on Windows." }));
                return;
              }
              const params = body ? JSON.parse(body) : {};
              const pid: number | undefined = params.pid;
              const result = performScreenshot(pid);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
            } catch (err: any) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `Screenshot failed: ${err.message || err}` }));
            }
          });
          return;
        }

        // ── Windows list API (used by secondary relay) ──
        if (url.pathname === "/api/windows" && req.method === "GET") {
          try {
            if (process.platform !== "win32") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Window enumeration is only supported on Windows." }));
              return;
            }
            const windows = enumRobloxWindows();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ windows }));
          } catch (err: any) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Window enumeration failed: ${err.message || err}` }));
          }
          return;
        }

        res.writeHead(200);
        res.end("MCP Server Running");
      }
    );

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(err);
      } else {
        console.error("[Primary] HTTP server error:", err);
        reject(err);
      }
    });

    httpServer.listen(WS_PORT, () => {
      console.error(
        `[Primary] MCP Bridge listening on port ${WS_PORT} (WebSocket + HTTP)`
      );

      wss = new WebSocketServer({ server: httpServer! });

      wss.on("connection", (ws, req) => {
        const urlPath = req.url || "/";

        if (urlPath === "/mcp-relay") {
          // ── Secondary MCP instance connecting as relay ──
          console.error(`[Primary] Relay client connected. Total: ${relayClients.size + 1}`);
          relayClients.add(ws);

          ws.on("message", (rawData) => {
            try {
              const message = JSON.parse(rawData.toString());

              // Relay-level request handled directly by the primary.
              if (message.type === "list-clients" && message.id) {
                ws.send(
                  JSON.stringify({
                    id: message.id,
                    output: formatActiveClientListForTool(),
                  })
                );
                return;
              }

              if (message.id) {
                relayRequestOrigin.set(message.id, ws);
              }

              // If the secondary specified a target client, route to it
              const targetClientId = message.targetClientId;
              if (targetClientId) {
                delete message.targetClientId;
              }

              const target = resolveTargetClient(targetClientId);
              if (target) {
                requestToClientId.set(message.id, target.clientId);
                SendToClient(target, JSON.stringify(message));
              } else if (message.id) {
                relayRequestOrigin.delete(message.id);
                ws.send(
                  JSON.stringify({
                    id: message.id,
                    output: undefined,
                    error: "No active Roblox client connected.",
                  })
                );
              }
            } catch (e) {
              console.error("[Primary] Error parsing relay message:", e);
            }
          });

          ws.on("close", () => {
            relayClients.delete(ws);
            console.error(`[Primary] Relay client disconnected. Total: ${relayClients.size}`);
            for (const [id, origin] of relayRequestOrigin.entries()) {
              if (origin === ws) relayRequestOrigin.delete(id);
            }
          });

          ws.on("error", (err) => {
            console.error("[Primary] Relay client error:", err.message);
            relayClients.delete(ws);
          });

          return;
        }

        // ── Regular Roblox game client ──
        // Client must send a { type: "register", ... } message first.
        // Until registered, messages are buffered.
        console.error("[Primary] Roblox client connected via WebSocket (awaiting registration).");

        ws.on("message", (rawData) => {
          try {
            const data = JSON.parse(rawData.toString());

            // Handle registration
            if (data.type === "register") {
              const clientId = registerClient({
                username: data.username || "Unknown",
                userId: data.userId || 0,
                placeId: data.placeId || 0,
                jobId: data.jobId || "",
                placeName: data.placeName || "Unknown",
                transport: "ws",
                ws,
              });
              // Send the clientId back
              ws.send(JSON.stringify({ type: "registered", clientId }));
              return;
            }

            handleRobloxResponse(data);
          } catch (e) {
            console.error("[Primary] Error parsing Roblox WS message:", e);
          }
        });

        ws.on("close", () => {
          const clientId = wsToClientId.get(ws);
          if (clientId) {
            unregisterClient(clientId);
          }
          console.error("[Primary] Roblox client disconnected.");
        });
      });

      resolve();
    });
  });
}

/**
 * Route a response from a Roblox client.
 * If the request originated from a relay secondary, forward it back.
 * Otherwise resolve the local promise.
 */
function handleRobloxResponse(data: any) {
  if (!data.id) return;

  // Check if this response belongs to a relayed secondary request
  const originRelay = relayRequestOrigin.get(data.id);
  if (originRelay && originRelay.readyState === WebSocket.OPEN) {
    originRelay.send(JSON.stringify(data));
    relayRequestOrigin.delete(data.id);
    requestToClientId.delete(data.id);
    return;
  }
  relayRequestOrigin.delete(data.id);

  // Otherwise it's a local primary request
  if (httpResponseResolvers.has(data.id)) {
    httpResponseResolvers.get(data.id)?.(data);
    httpResponseResolvers.delete(data.id);
  }
  requestToClientId.delete(data.id);
}

// ─── Secondary mode ─────────────────────────────────────────────────────────────

/**
 * Start this instance as a secondary relay.
 * @param relayUrl  Full WebSocket URL to connect to (e.g. "ws://host:16384/mcp-relay").
 *                  Defaults to localhost when called from the EADDRINUSE fallback path.
 * @param onFailed  Optional callback invoked when the initial connection attempt fails
 *                  (used by --baseurl path to fall back to primary instead of promoting).
 */
function startAsSecondary(
  relayUrl: string = `ws://localhost:${WS_PORT}/mcp-relay`,
  onFailed?: () => void
): void {
  instanceRole = "secondary";
  secondaryResponseResolvers = new Map();

  console.error(`[Secondary] Connecting to primary relay at ${relayUrl} ...`);

  relaySocket = new WebSocket(relayUrl);

  // Track whether we successfully opened at least once
  let everConnected = false;

  relaySocket.on("open", () => {
    everConnected = true;
    console.error("[Secondary] Connected to primary via relay.");
  });

  relaySocket.on("message", (rawData) => {
    try {
      const data = JSON.parse(rawData.toString());
      if (data.id && secondaryResponseResolvers.has(data.id)) {
        secondaryResponseResolvers.get(data.id)!(data);
        secondaryResponseResolvers.delete(data.id);
      }
    } catch (e) {
      console.error("[Secondary] Error parsing relay response:", e);
    }
  });

  relaySocket.on("close", () => {
    relaySocket = null;
    // Reject all pending resolvers so tool calls don't hang forever
    for (const [id, resolver] of secondaryResponseResolvers.entries()) {
      resolver({ id, output: undefined });
    }
    secondaryResponseResolvers.clear();

    if (!everConnected && onFailed) {
      console.error("[Secondary] Never connected — remote unreachable. Falling back to primary mode.");
      onFailed();
    } else if (everConnected) {
      console.error("[Secondary] Lost connection to primary. Attempting promotion...");
      tryPromote();
    }
  });

  relaySocket.on("error", (err) => {
    console.error("[Secondary] Relay socket error:", err.message);
    // "error" is always followed by "close", so we handle fallback there.
  });
}

// ─── Promotion / Boot ───────────────────────────────────────────────────────────

function tryPromote() {
  // Random jitter to avoid multiple secondaries racing
  const jitter = Math.floor(Math.random() * PROMOTION_JITTER_MAX);
  console.error(`[Promote] Waiting ${jitter}ms before attempting promotion...`);

  setTimeout(async () => {
    try {
      await startAsPrimary();
      console.error("[Promote] Successfully promoted to primary!");
    } catch {
      console.error(
        "[Promote] Another instance already claimed primary. Reconnecting as secondary..."
      );
      // Small delay before reconnecting to let the new primary fully start
      setTimeout(() => startAsSecondary(), 200);
    }
  }, jitter);
}

async function boot() {
  // ── --baseurl path: try to connect as secondary to remote; fall back to primary ──
  if (BASE_URL) {
    const relayUrl = BASE_URL.replace(/\/$/, "") + "/mcp-relay";
    console.error(`[Boot] --baseurl mode: targeting relay at ${relayUrl}`);

    startAsSecondary(relayUrl, async () => {
      // The remote was unreachable — start as primary instead
      console.error("[Boot] Remote unreachable — starting as primary (fallback).");
      try {
        await startAsPrimary();
        console.error("[Boot] Primary started successfully (fallback from --baseurl).");
      } catch (err: any) {
        if (err?.code === "EADDRINUSE") {
          // A local primary is already running; become its secondary
          console.error("[Boot] Port in use locally too — becoming secondary to localhost.");
          startAsSecondary();
        } else {
          console.error("[Boot] Fatal error during fallback primary start:", err);
          process.exit(1);
        }
      }
    });
    return;
  }

  // ── Normal path: try primary, fall back to localhost secondary ──
  try {
    await startAsPrimary();
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      startAsSecondary();
    } else {
      console.error("[Boot] Fatal error:", err);
      process.exit(1);
    }
  }
}

// ─── Shared schema ──────────────────────────────────────────────────────────────

const clientIdSchema = z
  .string()
  .describe(
    "Target a specific Roblox client by its clientId. Use the list-clients tool to discover connected clients. If omitted, the most recently active client is used."
  )
  .optional();

// ─── Screenshot helpers (Windows-only, uses PowerShell + GDI PrintWindow) ───────

interface RobloxWindowInfo {
  pid: number;
  hwnd: string; // decimal string — avoids JS number precision issues with large HWNDs
  title: string;
}

interface ScreenshotResult {
  error?: string;
  needsDisambiguation?: boolean;
  windows?: RobloxWindowInfo[];
  imageBase64?: string;
}

function enumRobloxWindows(): RobloxWindowInfo[] {
  // PowerShell script that enumerates all visible windows whose owning process
  // is a Roblox player executable, returning JSON [{pid, hwnd, title}, …].
  const ps = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int maxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    public static List<object[]> GetVisibleWindows() {
        var result = new List<object[]>();
        EnumWindows((hWnd, _) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            if (string.IsNullOrEmpty(title)) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            result.Add(new object[] { pid, hWnd.ToString(), title });
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

$robloxPids = @(Get-Process -Name 'RobloxPlayerBeta' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
if ($robloxPids.Count -eq 0) {
    Write-Output '[]'
    exit
}
$allWindows = [WinEnum]::GetVisibleWindows()
$found = @()
foreach ($w in $allWindows) {
    if ($robloxPids -contains [int]$w[0]) {
        $found += [PSCustomObject]@{ pid=[int]$w[0]; hwnd=$w[1]; title=$w[2] }
    }
}
if ($found.Count -eq 0) {
    Write-Output '[]'
} else {
    $found | ConvertTo-Json -Compress
}
`;

  const tmpFile = path.join(os.tmpdir(), `roblox_enum_${Date.now()}.ps1`);
  try {
    fs.writeFileSync(tmpFile, ps, "utf-8");
    const raw = execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { encoding: "utf-8", timeout: 15000, windowsHide: true }
    ).trim();
    if (!raw || raw === "" || raw === "null") return [];
    const parsed = JSON.parse(raw);
    // PowerShell returns a single object (not array) when there's exactly one result
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err: any) {
    console.error("[Screenshot] enumRobloxWindows failed:", err.message);
    return [];
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { }
  }
}

function captureWindowPNG(hwnd: string): string {
  // Returns base64-encoded PNG of the window contents.
  // Uses PrintWindow with PW_RENDERFULLCONTENT (0x2) for best compatibility.
  // Writes base64 to a temp output file to avoid stdout buffer limits (ENOBUFS).
  const outFile = path.join(os.tmpdir(), `roblox_screenshot_${Date.now()}.b64`);
  const ps = `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCapture {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hDC, uint nFlags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$hwnd = [IntPtr]::new([long]${hwnd})

if ([WinCapture]::IsIconic($hwnd)) {
    [WinCapture]::ShowWindow($hwnd, 9) | Out-Null  # SW_RESTORE
    Start-Sleep -Milliseconds 200
}

$rect = New-Object WinCapture+RECT
[WinCapture]::GetClientRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) {
    Write-Error "Window has zero size"
    exit 1
}

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $gfx.GetHdc()
[WinCapture]::PrintWindow($hwnd, $hdc, 2) | Out-Null  # PW_RENDERFULLCONTENT
$gfx.ReleaseHdc($hdc)
$gfx.Dispose()

$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$bytes = $ms.ToArray()
$ms.Dispose()
$b64 = [Convert]::ToBase64String($bytes)
[System.IO.File]::WriteAllText('${outFile.replace(/\\/g, "\\\\")}', $b64)
Write-Output 'OK'
`;

  const tmpFile = path.join(os.tmpdir(), `roblox_capture_${Date.now()}.ps1`);
  try {
    fs.writeFileSync(tmpFile, ps, "utf-8");
    execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { encoding: "utf-8", timeout: 15000, windowsHide: true }
    );

    if (!fs.existsSync(outFile)) throw new Error("PrintWindow did not produce output file");
    const result = fs.readFileSync(outFile, "utf-8").trim();
    if (!result) throw new Error("PrintWindow returned empty output");
    return result;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { }
    try { fs.unlinkSync(outFile); } catch { }
  }
}

function performScreenshot(pid?: number): ScreenshotResult {
  const windows = enumRobloxWindows();

  if (windows.length === 0) {
    return { error: "No visible Roblox windows found. Make sure Roblox is running and not minimized." };
  }

  let targets = windows;
  if (pid !== undefined) {
    targets = windows.filter((w) => w.pid === pid);
    if (targets.length === 0) {
      return {
        error: `No Roblox window found for PID ${pid}. Available windows:\n` +
          windows.map((w) => `  PID ${w.pid} — "${w.title}"`).join("\n"),
      };
    }
  }

  if (targets.length > 1 && pid === undefined) {
    return {
      needsDisambiguation: true,
      windows: targets,
    };
  }

  // Capture the first (or only) matching window
  const target = targets[0];
  const imageBase64 = captureWindowPNG(target.hwnd);
  return { imageBase64 };
}

// ─── Tool registrations (work in both primary & secondary mode) ─────────────────

server.registerTool(
  "set-active-client",
  {
    title: "Set active Roblox client",
    description: "Sets the active Roblox client to the provided clientId. Future tool calls will be routed to this client.",
    inputSchema: z.object({
      clientId: z.string().describe("The client ID to set as active. Use list-clients to get available client IDs."),
    }),
  },
  async ({ clientId }) => {
    activeClientId = clientId;
    return {
      content: [
        {
          type: "text" as const,
          text: `Active client set to ${clientId}.`,
        },
      ],
    };
  }
);

server.registerTool(
  "list-clients",
  {
    title: "List connected Roblox clients",
    description:
      "Returns a list of all Roblox game clients currently connected to the MCP bridge, including their clientId, username, placeId, jobId, and placeName. Use the clientId from this list to target specific clients in other tools.",
  },
  async () => {
    if (instanceRole === "secondary") {
      // Secondaries ask the primary for client list
      const id = crypto.randomUUID();
      if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
        relaySocket.send(JSON.stringify({ id, type: "list-clients" }));
        const response = await GetResponseOfIdFromClient(id);
        return {
          content: [
            {
              type: "text",
              text: response?.output ?? response?.error ?? "Failed to list clients.",
            },
          ],
        };
      }
      return NO_CLIENT_ERROR;
    }

    return {
      content: [
        {
          type: "text",
          text: formatActiveClientListForTool(),
        },
      ],
    };
  }
);

server.registerTool(
  "execute",
  {
    title: "Execute Code in the Roblox Game Client",
    inputSchema: z.object({
      code: z
        .string()
        .describe(
          "The code to execute in the Roblox Game Client. This tool does NOT return output - use get-data-by-code if you need to retrieve data."
        ),
      threadContext: z
        .number()
        .describe(
          "The thread identity to execute the code in (default: 8, normal game scripts run on 2)"
        )
        .optional()
        .default(8),
    }),
  },
  async ({ code, threadContext }) => {
    console.error(`Executing code in thread ${threadContext}...`);

    const result = SendArbitraryDataToClient("execute", {
      source: `setthreadidentity(${threadContext})\n${code}`,
    }, undefined, activeClientId);

    if (result === null) {
      return NO_CLIENT_ERROR;
    } else if (result === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    return {
      content: [
        {
          type: "text",
          text: `Code has been scheduled to be run in thread context ${threadContext}.`,
        },
      ],
    };
  }
);

server.registerTool(
  "execute-file",
  {
    title: "Execute a Luau file in the Roblox Game Client",
    description:
      "Reads a local .luau or .lua file from disk and executes its contents in the Roblox Game Client. This tool does NOT return output - use get-data-by-code if you need to retrieve data.",
    inputSchema: z.object({
      filePath: z
        .string()
        .describe(
          "The absolute path to the .luau or .lua file to execute"
        ),
      threadContext: z
        .number()
        .describe(
          "The thread identity to execute the code in (default: 8, normal game scripts run on 2)"
        )
        .optional()
        .default(8),
    }),
  },
  async ({ filePath, threadContext }) => {
    if (!fs.existsSync(filePath)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `File not found: ${filePath}`,
          },
        ],
      };
    }

    const code = fs.readFileSync(filePath, "utf-8");
    console.error(`Executing file ${filePath} in thread ${threadContext}...`);

    const result = SendArbitraryDataToClient("execute", {
      source: `setthreadidentity(${threadContext})\n${code}`,
    }, undefined, activeClientId);

    if (result === null) {
      return NO_CLIENT_ERROR;
    } else if (result === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `File executed: ${filePath} (thread context ${threadContext})`,
        },
      ],
    };
  }
);

server.registerTool(
  "get-script-content",
  {
    title: "Get the content of a script in the Roblox Game Client",
    description: "Get the content of a script in the Roblox Game Client",
    inputSchema: z.object({
      scriptGetterSource: z
        .string()
        .describe(
          "The code that fetches the script object from the game (should return a script object, and MUST be client-side only, will not work on Scripts with RunContext set to Server)"
        )
        .optional(),
      scriptPath: z
        .string()
        .describe("The path to the script to get the content of. If passing a GC'd script proxy (e.g. <ScriptProxy: 1_316566>), use the literal angle brackets < > — do NOT HTML-encode them as &lt; or &gt;.")
        .optional(),
      startLine: z
        .number()
        .describe("Optional start line number (1-based) to return only a range of lines from the decompiled script. If omitted, returns the full script.")
        .optional(),
      endLine: z
        .number()
        .describe("Optional end line number (1-based, inclusive) to return only a range of lines. Defaults to end of script if startLine is set but endLine is omitted.")
        .optional(),
    }),
  },
  async ({ scriptGetterSource, scriptPath, startLine, endLine }) => {
    if (scriptGetterSource === undefined && scriptPath === undefined) {
      return {
        success: false,
        content: [
          {
            type: "text",
            text: "Must provide either scriptGetterSource or scriptPath.",
          },
        ],
      };
    } else if (scriptGetterSource !== undefined && scriptPath !== undefined) {
      return {
        success: false,
        content: [
          {
            type: "text",
            text: "Must provide either scriptGetterSource or scriptPath, not both.",
          },
        ],
      };
    }

    const scriptProxyMatch = (scriptPath ?? scriptGetterSource ?? "").match(/^<ScriptProxy: (.+)>$/);

    const toolCallId = SendArbitraryDataToClient("get-script-content", scriptProxyMatch
      ? { debugId: scriptProxyMatch[1], startLine, endLine }
      : {
        source:
          scriptGetterSource === undefined
            ? `return ${scriptPath}`
            : scriptGetterSource,
        startLine,
        endLine,
      }, undefined, activeClientId);

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    } else if (toolCallId === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | {
        output: string;
      }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        success: false,
        content: [{ type: "text", text: "Failed to get script content." }],
      };
    }

    return {
      success: true,
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

server.registerTool(
  "get-data-by-code",
  {
    title: "Get data by code",
    description:
      "Query data from the Roblox Game Client by executing code, note that the code MUST return one or more values. IMPORTANT: Do NOT serialize/encode the return value yourself (no HttpService:JSONEncode, no custom table-to-string) - just return raw Lua values directly. The connector automatically serializes all returned data.",

    inputSchema: z.object({
      code: z
        .string()
        .describe(
          "The code to execute in the Roblox Game Client (MUST return one or more values). Return raw Lua values - do NOT manually serialize tables or use JSONEncode, the connector handles serialization automatically."
        ),
      threadContext: z
        .number()
        .describe(
          "The thread identity to execute the code in (default: 8, normal game scripts run on 2)"
        )
        .optional()
        .default(8),
      timeout: z
        .number()
        .describe(
          "Timeout in milliseconds for the response (default: 15000, max: 120000). Increase for long-running operations like decompiling many modules."
        )
        .optional()
        .default(15000),
    }),
  },
  async ({ code, threadContext, timeout }) => {
    console.error(`Executing code in thread ${threadContext}...`);

    const clampedTimeout = Math.min(Math.max(timeout, 1000), 120000);

    const toolCallId = SendArbitraryDataToClient("get-data-by-code", {
      source: `setthreadidentity(${threadContext});${code}`,
    }, undefined, activeClientId);

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    } else if (toolCallId === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId, clampedTimeout)) as
      | {
        output: string;
      }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [
          {
            type: "text",
            text:
              "Failed to get data by code. Response: " +
              JSON.stringify(response),
          },
        ],
      };
    }

    return {
      success: true,
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

server.registerTool(
  "get-console-output",
  {
    title:
      "Get the roblox developer console output from the Roblox Game Client",
    inputSchema: z.object({
      limit: z
        .number()
        .describe(
          "Maximum number of results to return (default: 50, to avoid overwhelming output)"
        )
        .optional()
        .default(50),
      logsOrder: z
        .enum(["NewestFirst", "OldestFirst"])
        .describe("The order of the logs to return (default: NewestFirst)")
        .optional()
        .default("NewestFirst"),
    }),
  },
  async ({ limit, logsOrder }) => {
    const toolCallId = SendArbitraryDataToClient("get-console-output", {
      limit,
      logsOrder,
    }, undefined, activeClientId);

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    } else if (toolCallId === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | {
        output: string;
      }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [{ type: "text", text: "Failed to get console output." }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

server.registerTool(
  "search-instances",
  {
    title: "Search for instances in the game",
    description: `Search for instances in the Roblox game using QueryDescendants with a CSS-like selector syntax. Supports class names (Part), tags (.Tag), names (#Name), properties ([Property = value]), attributes ([$Attribute = value]), combinators (>, >>), and pseudo-classes (:not(), :has()).

SELECTOR SYNTAX:
- ClassName: Matches instances of a class (uses IsA, so 'BasePart' matches Part, MeshPart, etc.). Example: Part, SpotLight, Model
- .Tag: Matches instances with a CollectionService tag. Example: .Fruit, .Enemy, .Interactable
- #Name: Matches instances by their Name property. Example: #HumanoidRootPart, #Head, #Torso
- [Property = value]: Matches instances where a property equals a value (boolean, number, string). Example: [CanCollide = false], [Transparency = 1], [Name = Folder10]
- [$Attribute = value]: Matches instances with a specific attribute value. Example: [$Health = 100], [$IsEnemy = true]
- [$Attribute]: Matches instances that have the attribute set (any value). Example: [$QuestId]

COMBINATORS:
- > : Direct children only. Example: Model > Part (Parts that are direct children of a Model)
- >> : All descendants (default). Example: Model >> Part (Parts anywhere inside a Model)
- , : Multiple selectors (OR). Example: Part, MeshPart (matches either)

PSEUDO-CLASSES:
- :not(selector): Excludes matches. Example: BasePart:not([CanCollide = true]) - parts with CanCollide false
- :has(selector): Matches if containing a descendant. Example: Model:has(> Humanoid) - Models with a Humanoid child

COMBINING SELECTORS: Chain selectors for AND logic. Example: Part.Tagged[Anchored = false] - Parts with tag "Tagged" that are unanchored`,
    inputSchema: z.object({
      selector: z
        .string()
        .describe(
          "The selector string to filter instances (e.g., 'Part', '.Tagged', '#InstanceName', '[CanCollide = false]', 'Model >> Part.Glowing')"
        ),
      root: z
        .string()
        .describe(
          "The root instance to search from (e.g., 'game.Workspace', 'game.ReplicatedStorage'). Defaults to 'game' if not specified."
        )
        .optional()
        .default("game"),
      limit: z
        .number()
        .describe(
          "Maximum number of results to return (default: 50, to avoid overwhelming output)"
        )
        .optional()
        .default(50),
    }),
  },
  async ({ selector, root, limit }) => {
    const toolCallId = SendArbitraryDataToClient("search-instances", {
      selector,
      root,
      limit,
    }, undefined, activeClientId);

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    } else if (toolCallId === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | {
        output: string;
      }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [
          {
            type: "text",
            text:
              "Failed to search instances. Response: " +
              JSON.stringify(response),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

server.registerTool(
  "script-grep",
  {
    title: "Grep across all scripts in the game",
    description:
      'Search across all decompiled scripts in the game using standard regex syntax (Perl/PCRE2). Supports patterns like \\bRemoteEvent\\b, \\w+Service, function\\s+\\w+, lookaheads, alternation (foo|bar), etc. Use the literal flag for plain string matching. IMPORTANT: If a script instance has already been garbage collected, a "<ScriptProxy: DebugId>" string will be returned instead of the script instance path.',
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "The search pattern. Supports standard regex syntax (Perl/PCRE2): \\d, \\w, \\s, \\b, character classes [a-z], alternation (foo|bar), quantifiers (+, *, ?), groups, lookaheads, etc. Use the literal flag for exact string matching."
        ),
      limit: z
        .number()
        .describe(
          "Maximum number of scripts to return results from (default: 50)"
        )
        .optional()
        .default(50),
      contextLines: z
        .number()
        .describe(
          "Number of lines of context to show before and after each match (default: 2)"
        )
        .optional()
        .default(2),
      maxMatchesPerScript: z
        .number()
        .describe(
          "Maximum number of matches to return per script (default: 20)"
        )
        .optional()
        .default(20),
      maxResults: z
        .number()
        .describe(
          "Maximum total number of matches across ALL scripts (default: unlimited). Use this to cap total matches, e.g. maxResults=1 to find just the first match."
        )
        .optional(),
      literal: z
        .boolean()
        .describe(
          "When true, treats the query as a plain literal string — no regex interpretation. Equivalent to grep -F / ripgrep -F. (default: false)"
        )
        .optional()
        .default(false),
      caseSensitive: z
        .boolean()
        .describe(
          "When false, matches case-insensitively. Equivalent to grep -i. (default: true)"
        )
        .optional()
        .default(true),
    }),
  },
  async ({ query, limit, contextLines, maxMatchesPerScript, maxResults, literal, caseSensitive }) => {
    const toolCallId = SendArbitraryDataToClient("script-grep", {
      query,
      limit,
      contextLines,
      maxMatchesPerScript,
      maxResults,
      literal,
      caseSensitive,
    }, undefined, activeClientId);

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    } else if (toolCallId === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | {
        output: string;
      }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [
          {
            type: "text",
            text:
              "Failed to grep scripts (error occured? Response: " +
              JSON.stringify(response) +
              ")",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

server.registerTool(
  "get-game-info",
  {
    title: "Get information about the current Roblox game",
    description:
      "Retrieves basic information about the current game including PlaceId, GameId, PlaceVersion, and other metadata.",
    inputSchema: z.object({
    }),
  },
  async () => {
    const toolCallId = SendArbitraryDataToClient("get-game-info", {}, undefined, activeClientId);

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    } else if (toolCallId === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | {
        output: string;
      }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [{ type: "text", text: "Failed to get game info." }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

server.registerTool(
  "get-descendants-tree",
  {
    title: "Get the descendants tree of a Roblox instance",
    description:
      "Returns a structured hierarchy tree of an instance's descendants, showing names, class types, and nesting. Useful for exploring game structure without writing custom Lua. Results are depth-limited and optionally filtered by class.",
    inputSchema: z.object({
      root: z
        .string()
        .describe(
          "The instance path to get the tree from (e.g., 'game.Workspace', 'game.Workspace.CurrentRooms')"
        ),
      maxDepth: z
        .number()
        .describe(
          "Maximum depth to traverse (default: 3). Higher values return more detail but larger output."
        )
        .optional()
        .default(3),
      classFilter: z
        .string()
        .describe(
          "Optional class name filter — only show instances that IsA this class (e.g., 'BasePart', 'Model'). Leave empty to show all."
        )
        .optional(),
      maxChildren: z
        .number()
        .describe(
          "Maximum number of children to show per node (default: 50). Prevents overwhelming output for large containers."
        )
        .optional()
        .default(50),
    }),
  },
  async ({ root, maxDepth, classFilter, maxChildren }) => {
    const toolCallId = SendArbitraryDataToClient("get-descendants-tree", {
      root,
      maxDepth,
      classFilter: classFilter || "",
      maxChildren,
    }, undefined, activeClientId);

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    } else if (toolCallId === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | {
        output: string;
      }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [
          {
            type: "text",
            text:
              "Failed to get descendants tree. Response: " +
              JSON.stringify(response),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

server.registerTool(
  "ensure-remote-spy",
  {
    title: "Ensure the Cobalt remote spy is loaded",
    description:
      "Loads the Cobalt remote spy if it is not already running. Cobalt hooks all RemoteEvents, RemoteFunctions, BindableEvents, BindableFunctions (both incoming and outgoing, including Actors) and logs their calls. Must be called before using get-remote-spy-logs. Returns the current status of Cobalt.",
    inputSchema: z.object({
    }),
  },
  async () => {
    const toolCallId = SendArbitraryDataToClient(
      "ensure-remote-spy",
      {},
      undefined,
      activeClientId
    );

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    } else if (toolCallId === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | {
        output: string;
      }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [
          {
            type: "text",
            text:
              "Failed to ensure remote spy. Response: " +
              JSON.stringify(response),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

server.registerTool(
  "get-remote-spy-logs",
  {
    title: "Get captured remote spy logs from Cobalt",
    description:
      'Retrieves captured remote/bindable call logs from the Cobalt remote spy. Returns remote name, class, direction (Incoming/Outgoing), call count, and recent call arguments. Cobalt must be loaded first via ensure-remote-spy.',
    inputSchema: z.object({
      direction: z
        .enum(["Incoming", "Outgoing", "Both"])
        .describe("Filter by call direction (default: Both)")
        .optional()
        .default("Both"),
      remoteNameFilter: z
        .string()
        .describe(
          "Optional filter — only return logs for remotes whose name contains this string (case-insensitive)"
        )
        .optional(),
      limit: z
        .number()
        .describe(
          "Maximum number of remote logs to return (default: 50)"
        )
        .optional()
        .default(50),
      maxCallsPerRemote: z
        .number()
        .describe(
          "Maximum number of recent calls to return per remote (default: 5)"
        )
        .optional()
        .default(5),
    }),
  },
  async ({ direction, remoteNameFilter, limit, maxCallsPerRemote }) => {
    const toolCallId = SendArbitraryDataToClient(
      "get-remote-spy-logs",
      {
        direction,
        remoteNameFilter: remoteNameFilter || "",
        limit,
        maxCallsPerRemote,
      },
      undefined,
      activeClientId
    );

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    } else if (toolCallId === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | {
        output: string;
      }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [
          {
            type: "text",
            text:
              "Failed to get remote spy logs. Response: " +
              JSON.stringify(response),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: response.output,
        },
      ],
    };
  }
);

server.registerTool(
  "clear-remote-spy-logs",
  {
    title: "Clear all remote spy logs",
    description:
      "Clears all captured remote spy logs from Cobalt. This removes all logged calls for every remote. Cobalt must be loaded first via ensure-remote-spy.",
    inputSchema: z.object({
    }),
  },
  async () => {
    const toolCallId = SendArbitraryDataToClient(
      "clear-remote-spy-logs",
      {},
      undefined,
      activeClientId
    );

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    } else if (toolCallId === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | { output: string }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [
          { type: "text", text: "Failed to clear remote spy logs. Response: " + JSON.stringify(response) },
        ],
      };
    }

    return {
      content: [{ type: "text", text: response.output }],
    };
  }
);

server.registerTool(
  "block-remote",
  {
    title: "Block or unblock a remote",
    description:
      "Block or unblock a specific remote event/function in the Cobalt remote spy. Blocked remotes will have their calls prevented from reaching the server/client. Cobalt must be loaded first via ensure-remote-spy.",
    inputSchema: z.object({
      remoteName: z
        .string()
        .describe("The exact name of the remote to block/unblock"),
      direction: z
        .enum(["Incoming", "Outgoing"])
        .describe("Whether the remote is Incoming or Outgoing"),
      shouldBlock: z
        .boolean()
        .describe("true to block, false to unblock")
        .optional()
        .default(true),
    }),
  },
  async ({ remoteName, direction, shouldBlock }) => {
    const toolCallId = SendArbitraryDataToClient(
      "block-remote",
      { remoteName, direction, shouldBlock },
      undefined,
      activeClientId
    );

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    } else if (toolCallId === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | { output: string }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [
          { type: "text", text: "Failed to block/unblock remote. Response: " + JSON.stringify(response) },
        ],
      };
    }

    return {
      content: [{ type: "text", text: response.output }],
    };
  }
);

server.registerTool(
  "ignore-remote",
  {
    title: "Ignore or unignore a remote",
    description:
      "Ignore or unignore a specific remote event/function in the Cobalt remote spy. Ignored remotes will still fire but their calls won't be logged. Cobalt must be loaded first via ensure-remote-spy.",
    inputSchema: z.object({
      remoteName: z
        .string()
        .describe("The exact name of the remote to ignore/unignore"),
      direction: z
        .enum(["Incoming", "Outgoing"])
        .describe("Whether the remote is Incoming or Outgoing"),
      shouldIgnore: z
        .boolean()
        .describe("true to ignore, false to unignore")
        .optional()
        .default(true),
    }),
  },
  async ({ remoteName, direction, shouldIgnore }) => {
    const toolCallId = SendArbitraryDataToClient(
      "ignore-remote",
      { remoteName, direction, shouldIgnore },
      undefined,
      activeClientId
    );

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    } else if (toolCallId === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | { output: string }
      | undefined;

    if (response === undefined || response.output === undefined) {
      return {
        content: [
          { type: "text", text: "Failed to ignore/unignore remote. Response: " + JSON.stringify(response) },
        ],
      };
    }

    return {
      content: [{ type: "text", text: response.output }],
    };
  }
);

server.registerTool(
  "screenshot-window",
  {
    title: "Take a screenshot of a Roblox window",
    description:
      "Captures a screenshot of the Roblox game window using the Windows API (PrintWindow/GDI). " +
      "Does NOT use any Lua/Roblox API — it captures the actual OS window contents. " +
      "If multiple Roblox windows are open, specify the pid to target a specific one. " +
      "Only works on Windows. " +
      "If the MCP server is running as a secondary (with BASE_URL set), the screenshot request is relayed to the primary server — " +
      "so the primary's machine (which may be a remote Windows host) performs the actual capture, even if roblox isn't running on the machine the MCP client is on.",
    inputSchema: z.object({
      pid: z
        .number()
        .describe(
          "The PID (process ID) of the Roblox window to capture. If omitted and only one Roblox window exists, it is captured automatically. If multiple windows exist and no pid is provided, the tool returns a list of windows for disambiguation."
        )
        .optional(),
    }),
  },
  async ({ pid }) => {
    // ── Secondary mode: relay to primary via HTTP ──
    // Do this BEFORE the platform guard — a non-Windows secondary can still
    // forward to a Windows primary that does the actual capture.
    if (instanceRole === "secondary" && BASE_URL) {
      try {
        const targetUrl = BASE_URL.replace(/\/$/, "") + "/api/screenshot";
        const body = JSON.stringify({ pid });
        const resp = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const result: ScreenshotResult = await resp.json() as ScreenshotResult;

        if (result.error) {
          return {
            content: [{ type: "text" as const, text: result.error }],
            isError: true,
          };
        }

        if (result.needsDisambiguation && result.windows) {
          const listing = result.windows
            .map((w) => `  • PID ${w.pid} — "${w.title}"`)
            .join("\n");
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "Multiple Roblox windows were found. Please re-call this tool with the `pid` parameter set to the correct process:\n\n" +
                  listing,
              },
            ],
          };
        }

        if (result.imageBase64) {
          return {
            content: [
              {
                type: "image" as const,
                data: result.imageBase64,
                mimeType: "image/png",
              },
            ],
          };
        }

        return {
          content: [{ type: "text" as const, text: "Screenshot failed: unexpected response from primary." }],
          isError: true,
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to relay screenshot to primary: ${err.message || err}`,
            },
          ],
          isError: true,
        };
      }
    }

    // ── Primary mode: capture locally ──
    // If we're here without a BASE_URL relay, the platform must be Windows.
    if (process.platform !== "win32") {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: The screenshot-window tool is only available on Windows. The current platform is: " + process.platform,
          },
        ],
        isError: true,
      };
    }
    try {
      const result = performScreenshot(pid);

      if (result.error) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }

      if (result.needsDisambiguation && result.windows) {
        const listing = result.windows
          .map((w) => `  • PID ${w.pid} — "${w.title}"`)
          .join("\n");
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Multiple Roblox windows were found. Please re-call this tool with the `pid` parameter set to the correct process:\n\n" +
                listing,
            },
          ],
        };
      }

      if (result.imageBase64) {
        return {
          content: [
            {
              type: "image" as const,
              data: result.imageBase64,
              mimeType: "image/png",
            },
          ],
        };
      }

      return {
        content: [{ type: "text" as const, text: "Screenshot failed: unexpected result." }],
        isError: true,
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Screenshot failed: ${err.message || err}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "list-roblox-windows",
  {
    title: "List visible Roblox windows",
    description:
      "Returns all visible Roblox game windows and their PIDs. Useful for disambiguating which PID to pass to the screenshot-window tool when multiple instances of Roblox are running. " +
      "If the MCP server is running as a secondary (with BASE_URL set), the request is relayed to the primary server.",
    inputSchema: z.object({}),
  },
  async () => {
    // ── Secondary mode: relay to primary via HTTP ──
    if (instanceRole === "secondary" && BASE_URL) {
      try {
        const targetUrl = BASE_URL.replace(/\/$/, "") + "/api/windows";
        const resp = await fetch(targetUrl);
        const result = await resp.json() as { windows?: RobloxWindowInfo[]; error?: string };

        if (result.error) {
          return { content: [{ type: "text" as const, text: result.error }], isError: true };
        }

        const wins = result.windows ?? [];
        if (wins.length === 0) {
          return { content: [{ type: "text" as const, text: "No visible Roblox windows found on the primary host." }] };
        }

        const listing = wins.map((w) => `PID ${w.pid} — "${w.title}"`).join("\n");
        return { content: [{ type: "text" as const, text: listing }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to relay to primary: ${err.message || err}` }],
          isError: true,
        };
      }
    }

    // ── Primary mode ──
    if (process.platform !== "win32") {
      return {
        content: [{ type: "text" as const, text: "Window enumeration is only supported on Windows. Current platform: " + process.platform }],
        isError: true,
      };
    }

    const wins = enumRobloxWindows();
    if (wins.length === 0) {
      return { content: [{ type: "text" as const, text: "No visible Roblox windows found." }] };
    }

    const listing = wins.map((w) => `PID ${w.pid} — "${w.title}"`).join("\n");
    return { content: [{ type: "text" as const, text: listing }] };
  }
);

server.registerTool(
  "type-text-box",
  {
    title: "Type into a TextBox",
    description: "Types text into a TextBox instance, with optional physical key press simulation.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("The instance path to the TextBox"),
      text: z
        .string()
        .describe("The string to type into the TextBox"),
      enter: z
        .boolean()
        .describe("Whether to press Enter after typing")
        .optional()
        .default(false),
      useKeyPress: z
        .boolean()
        .describe("If true, simulates real keystrokes using VirtualInputManager / keypress. If false, directly sets the Text property.")
        .optional()
        .default(true),
    }),
  },
  async ({ path, text, enter, useKeyPress }) => {
    const toolCallId = SendArbitraryDataToClient(
      "type-text-box",
      { path, text, string: text, enter, useKeyPress },
      undefined,
      activeClientId
    );

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    } else if (toolCallId === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | { output: string; error?: string }
      | undefined;

    if (response === undefined || response.error !== undefined) {
      return {
        content: [
          { type: "text", text: "Failed to type into TextBox. Response: " + JSON.stringify(response) },
        ],
      };
    }

    return {
      content: [{ type: "text", text: response.output || "Successfully typed into TextBox." }],
    };
  }
);

server.registerTool(
  "click-button",
  {
    title: "Click a GuiButton",
    description: "Simulates clicks on a TextButton or ImageButton by firing its signals via firesignal.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("The instance path to the Button"),
      action: z
        .string()
        .describe("The specific signal to fire (e.g., 'Activated', 'MouseButton1Click'). If omitted, fires all standard click signals.")
        .optional(),
    }),
  },
  async ({ path, action }) => {
    const toolCallId = SendArbitraryDataToClient(
      "click-button",
      { path, action },
      undefined,
      activeClientId
    );

    if (toolCallId === null) {
      return NO_CLIENT_ERROR;
    } else if (toolCallId === "INVALID_CLIENT") {
      return INVALID_CLIENT_ERROR;
    }

    const response = (await GetResponseOfIdFromClient(toolCallId)) as
      | { output: string; error?: string }
      | undefined;

    if (response === undefined || response.error !== undefined) {
      return {
        content: [
          { type: "text", text: "Failed to click Button. Response: " + JSON.stringify(response) },
        ],
      };
    }

    return {
      content: [{ type: "text", text: response.output || "Successfully fired click signals on Button." }],
    };
  }
);

// ─── Start everything ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport);
console.error("MCP Server started and connected via stdio.");

boot();
