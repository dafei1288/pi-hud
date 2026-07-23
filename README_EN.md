# pi-agent-hud — Pi HUD Extension

pi-agent-hud is a status bar extension for [pi-coding-agent](https://github.com/nicholasgasior/pi) that displays real-time session information at the bottom of the terminal.

Inspired by [claude-hud](https://github.com/jarrodwatts/claude-hud).

![](docs/intro.png)

## Preview

```
[claude-sonnet-4-6] pi-mono git:(main) · medium    [████████░░░░░░░░░░░░] 39%    ⏱ 21m
AGENTS.md · skills x5 · ext.tools x2 · ✓ Grep ×10 · ✓ Bash ×3 · ◐ Edit (12s) · ◐ agent (2m 15s)
▸ how to build a REST API with authentication?
```

## Installation

### Option 1: Clone & Install (Recommended)

```bash
pi install npm:pi-agent-hud
```

### Option 2: Claude / Pi One-Click Install

In a Claude or Pi conversation, simply say:

```
Please install the pi-agent-hud extension to the current project
```

### Option 3: CLI Temporary Load

```bash
pi -e npm:pi-agent-hud
```

### Verify Installation

```bash
pi list
```

After installation, restart pi or type `/reload` in a session to activate.

## Display Content

### Line 1 — Session Overview

```
[Model] Project git:(Branch) · Thinking Level    [████░░░░] 39%    ⏱ 21m
```

| Element | Description |
|---------|-------------|
| `[Model]` | Current LLM model ID |
| Project | Current working directory name |
| `git:(Branch)` | Git branch; hidden if not a git repo |
| `· medium` | Thinking level; hidden when disabled |
| `[████░░░░] 39%` | Context window usage progress bar |
| `⏱ 21m` | Session elapsed time |

Progress bar colors: <font color="green">0–70% green</font> / <font color="orange">70–90% yellow</font> / <font color="red">90%+ red</font>

### Line 2 — Activity Details

```
AGENTS.md · skills x5 · ext.tools x2 · ✓ Grep ×10 · ◐ Edit (12s) · ◐ agent (2m 15s)
```

| Element | Description |
|---------|-------------|
| `AGENTS.md` | Detected context config file (green) |
| `skills x5` | Number of loaded skills |
| `ext.tools x2` | Number of tools registered by extensions |
| `cmds x3` | Number of slash commands registered by extensions |
| `↑12.5k ↓3.2k` | Token breakdown; shown by default, configurable |
| `$0.042` | Cumulative session cost |
| `✓ Grep ×10` | Completed tool call stats, sorted by count descending |
| `◐ Edit (12s)` | Running tool (yellow) |
| `◐ agent (2m 15s)` | Running agent loop (yellow) |

### Line 3 — Latest Input + History Hint

```
▸ how to build a REST API with authentication?  Ctrl+H:5
```

| Element | Description |
|---------|-------------|
| `▸` | Indicator |
| User text | Most recent user input |
| `Ctrl+H:5` | History count hint (shown when history ≥ 2) |

### Ctrl+H — Session History Overlay

Press `Ctrl+H` to open a scrollable history overlay:

```
┌ Session History ─────────────────────────────────────┐
│ ▸ how to build a REST API with authentication?      │
│   Please check the docs                              │
│   Commit the changes                                 │
├ ↑↓ scroll · Enter select · Esc close ───────────────┤
└──────────────────────────────────────────────────────┘
```

| Key | Action |
|-----|--------|
| `↑` / `k` | Move selection up |
| `↓` / `j` | Move selection down |
| `Enter` | Select and paste into editor |
| `Esc` / `Ctrl+C` | Close overlay |

For detailed documentation, see [docs/pi-agent-hud.md](docs/pi-agent-hud.md).

### Ctrl+Alt+P — Execution Plan Overlay

Press `Ctrl+Alt+P` to view the agent's execution plan:

```
┌ Agent Execution Plan ─────────────────────────────────┐
│ 🎯 how to build a REST API with authentication?       │
│ 📊 3/5 steps · 8 turns · 2 subagents                  │
├────────────────────────────────────────────────────────┤
│ ✓ Read project structure                               │
│ ✓ Design API endpoints                                 │
│ ○ Implement controllers                                │
│ ○ Add authentication middleware                        │
│ ○ Write tests                                          │
├ Subagent Deployments ─────────────────────────────────┤
│ ◐ design database schema                 1m 32s        │
│ ✓ implement auth middleware               45s           │
└ Esc / Ctrl+C close ────────────────────────────────────┘
```

| Key | Action |
|-----|--------|
| `Esc` / `Ctrl+C` | Close overlay |

## Configuration

Configure via `.pi/pi-agent-hud.json` (project) or `~/.pi/agent/pi-agent-hud.json` (global):

```jsonc
{
  // Token display: "always" | "highContext" (only when context is high)
  "tokenMode": "always",
  "tokenThreshold": 85,

  // Show/hide elements
  "disabled": ["extCmds", "cost"],

  // Debug: dump rate-limit related response headers to
  // ~/.pi/agent/pi-agent-hud-headers.jsonl (or set env PI_HUD_DEBUG_HEADERS=1)
  "debugDumpHeaders": false,

  // Or only show specified elements (mutually exclusive with disabled)
  // "enabled": ["model", "project", "git", "contextBar", "elapsed", "tokens"]
}
```

**Configurable elements:**

| Element | Description | Default |
|---------|-------------|----------|
| `model` | Model name | ✅ |
| `project` | Project directory name | ✅ |
| `git` | Git branch | ✅ |
| `thinking` | Thinking level | ✅ |
| `contextBar` | Context progress bar | ✅ |
| `elapsed` | Session elapsed time | ✅ |
| `contextFiles` | Context config files | ✅ |
| `skills` | Skill count | ✅ |
| `extTools` | Extension tools count | ✅ |
| `extCmds` | Extension commands count | ✅ |
| `tokens` | Token breakdown | ✅ |
| `cost` | Session cost | ✅ |
| `rateLimit` | ⚡ API rate limit remaining (Anthropic/OpenAI auto-detected) | ✅ |
| `plan5h` | ⏳ Coding plan 5-hour window usage (Claude subscription / Codex OAuth) | ✅ |
| `planWeek` | 📅 Coding plan weekly window usage (Claude subscription / Codex OAuth) | ✅ |
| `toolStats` | Completed tool stats | ✅ |
| `runningTools` | Running tools | ✅ |
| `runningAgents` | Running agents | ✅ |
| `lastInput` | Last user input | ✅ |
| `historyHint` | Ctrl+H history hint | ✅ |

See [examples/pi-agent-hud.json](examples/pi-agent-hud.json) for a full configuration example.

## Coding Plan Usage (5-hour / Weekly Limits)

When using subscription quotas (Claude Pro/Max, ChatGPT Codex OAuth), the HUD parses two quota windows from response headers and shows:

```
⏳5h 42% ↻2h15m · 📅wk 18% ↻3d4h
```

- **Claude subscription (OAuth)**: parses `anthropic-ratelimit-unified-5h-*` / `-7d-*` headers
- **Codex (ChatGPT OAuth)**: parses `x-codex-primary-*` (primary window) / `x-codex-secondary-*` (weekly) headers; window lengths come from the server and adapt automatically
- **GLM Coding Plan (zai-coding-cn)**: responses carry no quota headers, so the HUD polls `open.bigmodel.cn/api/monitor/usage/quota/limit` every 5 min (key from env `ZAI_CODING_CN_API_KEY` or `~/.pi/agent/auth.json`)
- **MiniMax Coding Plan (minimax / minimax-cn)**: same — polls `api.minimaxi.com/v1/api/openplatform/coding_plan/remains` every 5 min (key from env `MINIMAX_API_KEY` or `auth.json`)
- Color scales with usage: ≤70% green / >70% yellow / >90% red; `↻` shows the reset countdown
- Plain API keys (pay-as-you-go) have no 5h/weekly quotas — these elements stay hidden and only `rateLimit` is shown

Not sure which headers your account returns? Enable `"debugDumpHeaders": true` (or env `PI_HUD_DEBUG_HEADERS=1`) to log all rate-limit related headers to `~/.pi/agent/pi-agent-hud-headers.jsonl`.

## Grid Layout

Default single-column mode (no `layout`) behaves exactly like before. Set `layout` to enable multi-column grid:

```jsonc
{
  // Column counts per line, max 5 lines, each 1/2/4 columns
  "layout": [1, 2, 2],

  // Pin elements to specific cells { line: 0-based, col: 0-based }
  // Unlisted elements auto-distribute left-to-right, top-to-bottom
  "placement": {
    "tokens":   { "line": 1, "col": 0 },
    "cost":     { "line": 1, "col": 0 },
    "toolStats": { "line": 1, "col": 1 },
    "lastInput": { "line": 2, "col": 0 },
    "plugin:random-quote": { "line": 2, "col": 1 }
  }
}
```

**Rendered output** (`layout: [1, 2, 2]`):

```
Line 1 (full-width):
[claude-sonnet-4-6] pi-agent-hud git:(main) · medium    [████░░] 39%    ⏱ 21m

Line 2 (2 columns):
AGENTS.md · ↑12.5k ↓3.2k          │  ✓ Grep ×10 · ✓ Bash ×3

Line 3 (2 columns):
▸ how to build a REST API with auth? │  💬 The best way to predict the future...
```

**5-line dashboard** (`layout: [1, 2, 2, 2, 4]`, up to 4×5=20 cells):

```
Line 1: [full]   Model + Project + Progress + Elapsed
Line 2: [2-col]  Status info    │  Resource counts
Line 3: [2-col]  Tool stats     │  Running state
Line 4: [2-col]  Last input     │  💬 Quote
Line 5: [4-col]  col0 │ col1 │ col2 │ col3
```

**Layout demo files:**

| File | Description |
|------|-------------|
| [examples/layout-2col-demo.json](examples/layout-2col-demo.json) | 2-column layout |
| [examples/layout-dashboard-demo.json](examples/layout-dashboard-demo.json) | 5-line dashboard layout |

## Plugin System

Users can write custom plugins to add any content to the HUD.

Place plugins in `.pi/pi-agent-hud-plugins/*.js` (project) or `~/.pi/agent/pi-agent-hud-plugins/*.js` (global).

**Plugin interface:**

```js
module.exports = {
  name: "my-plugin",        // Unique name
  target: "line2",         // "line1" | "line2" | "line3" | "line4" | "line5"
  order: 100,              // Sort order, lower = earlier
  col: 0,                  // Optional: column index in grid mode

  render(ctx, theme, width) {
    // ctx: all HUD data
    // theme.fg(color, text): color, color = text|dim|accent|success|warning|error
    // width: terminal width
    // Return string to display, or undefined to skip
    return theme.fg("dim", `🔁 ${ctx.inputHistory.length} turns`);
  },
};
```

**Example plugins:**

| File | Description |
|------|-------------|
| [examples/turn-counter-plugin.js](examples/turn-counter-plugin.js) | Turn counter |
| [examples/clock-plugin.js](examples/clock-plugin.js) | Clock on Line 1 |
| [examples/context-emoji-plugin.js](examples/context-emoji-plugin.js) | Emoji context indicator |
| [examples/quote-plugin.js](examples/quote-plugin.js) | Random quote every 10s 💬 |

## Project Structure

```
pi-agent-hud/
├── extensions/
│   └── pi-agent-hud.ts            # Extension source code
├── scripts/
│   └── install.js                 # Installation script
├── examples/
│   ├── pi-agent-hud.json           # Config example (all fields)
│   ├── layout-2col-demo.json       # Layout Demo: 2-column
│   ├── layout-dashboard-demo.json  # Layout Demo: 5-line dashboard
│   ├── turn-counter-plugin.js      # Plugin: turn counter
│   ├── clock-plugin.js             # Plugin: clock
│   ├── context-emoji-plugin.js     # Plugin: emoji context
│   └── quote-plugin.js             # Plugin: random quote
├── docs/
│   └── pi-agent-hud.md             # Detailed documentation
├── tsconfig.json
├── package.json
├── README.md
└── README_EN.md
```

## Dependencies

Runtime depends on the pi-coding-agent Extension API:

- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-tui`

No additional npm packages are required — extensions are loaded directly by the pi runtime.

<a href="https://www.star-history.com/?repos=dafei1288%2Fpi-agent-hud&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=dafei1288/pi-agent-hud&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=dafei1288/pi-agent-hud&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=dafei1288/pi-agent-hud&type=date&legend=top-left" />
 </picture>
</a>

## License

MIT
