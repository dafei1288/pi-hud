/**
 * pi-agent-hud Extension — claude-hud inspired status bar
 *
 * Line 1: [model] project git:(main* ↑2)    [████████░░] 39%    ⏱ 21m
 * Line 2: AGENTS.md · skills x5 · ext x2 · ↑12.5k ↓3.2k · $0.042 · ✓ Grep x10
 * Line 3: ▸ how to build a REST API with authentication?
 *
 * Ctrl+H: Open session input history overlay
 * Ctrl+J: Show agent execution plan overlay
 *
 * Configuration: .pi/pi-agent-hud.json or ~/.pi/agent/pi-agent-hud.json
 * Extensible: users can register custom HUD items via pi-agent-hud-plugins/
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { getKeybindings } from "@mariozechner/pi-tui";

// ============================================================================
// Types
// ============================================================================

/** A single HUD display element that can be toggled on/off */
type HudElement =
	| "model"          // Line 1: [model-name]
	| "project"        // Line 1: project directory name
	| "git"            // Line 1: git:(branch)
	| "thinking"       // Line 1: · medium
	| "contextBar"     // Line 1: [████░░] 39%
	| "elapsed"        // Line 1: ⏱ 21m
	| "contextFiles"   // Line 2: AGENTS.md
	| "skills"         // Line 2: skills x5
	| "extTools"       // Line 2: ext.tools x2
	| "extCmds"        // Line 2: cmds x3
	| "tokens"         // Line 2: ↑12.5k ↓3.2k
	| "cost"           // Line 2: $0.042
	| "rateLimit"      // Line 2: ⚡ 85% (Anthropic/OpenAI rate limit)
	| "plan5h"         // Line 2: ⏳5h 42% ↻2h15m (coding plan 5-hour window)
	| "planWeek"       // Line 2: 📅wk 18% ↻3d (coding plan weekly window)
	| "toolStats"      // Line 2: ✓ Grep ×10
	| "runningTools"   // Line 2: ◐ Edit (12s)
	| "runningAgents"  // Line 2: ◐ agent (2m 15s)
	| "agentPlan"     // Line 2: 📋 3/5 steps · 2 subagents
	| "lastInput"      // Line 3: ▸ last user input
	| "historyHint";   // Line 3: Ctrl+H:5

/** Pin an element to a specific cell in the grid */
interface Placement {
	/** 0-indexed line number (0-4) */
	line: number;
	/** 0-indexed column number */
	col: number;
}

/** User configuration for pi-agent-hud */
interface HudConfig {
	/** Which elements to show. Defaults to all. */
	enabled?: HudElement[];
	/** Which elements to hide. Takes precedence over enabled. */
	disabled?: HudElement[];
	/** Token display mode: "always" | "highContext" (85%+). Default: "always". */
	tokenMode?: "always" | "highContext";
	/** Token display threshold when tokenMode is "highContext". Default: 85. */
	tokenThreshold?: number;
	/**
	 * Layout: array of column counts per line. Max 5 lines, each 1/2/4 columns.
	 * Undefined = classic single-column mode (current behavior).
	 * Example: [1, 2, 2] means Line1=full, Line2=2-col, Line3=2-col.
	 */
	layout?: [number, ...number[]];
	/**
	 * Pin elements to specific cells. Only effective when layout is set.
	 * Key = element id or plugin name, value = { line, col }.
	 * Elements not listed here auto-distribute left-to-right, top-to-bottom.
	 */
	placement?: Record<string, Placement>;
	/**
	 * Dump rate-limit related response headers to
	 * ~/.pi/agent/pi-agent-hud-headers.jsonl for discovery.
	 * Can also be enabled via env PI_HUD_DEBUG_HEADERS=1. Default: false.
	 */
	debugDumpHeaders?: boolean;
}

/** Context data passed to custom HUD plugins */
interface HudContext {
	model: { id: string; reasoning: boolean } | undefined;
	branch: string | undefined;
	ctxPercent: number;
	projectName: string;
	totalInput: number;
	totalOutput: number;
	totalCost: number;
	skillCount: number;
	extToolCount: number;
	extCmdCount: number;
	thinking: string;
	elapsed: string;
	toolCounts: Map<string, number>;
	runningTools: Map<string, RunningTool>;
	runningAgents: Array<{ id: string; status: string; startTime: number }>;
	inputHistory: string[];
	lastUserInput: string;
	cwd: string;
	sessionStart: number;
	rateLimitInfo?: { provider: string; tokenRemaining: number; tokenLimit: number; requestRemaining: number; requestLimit: number; capturedAt: number };
	/** Coding plan (subscription) quota usage: 5-hour and weekly windows */
	planUsage?: PlanUsageInfo;
	/** Agent plan: parsed steps from assistant plan message */
	planSteps: Array<{ text: string; done: boolean; toolName?: string }>;
	/** Number of agent turns completed */
	turnCount: number;
	/** Active subagent tasks (delegated via subagent tool) */
	subagentTasks: Array<{ task: string; status: "running" | "completed"; startTime: number }>;
}

/** A plugin that contributes custom content to HUD cells */
interface HudPlugin {
	/** Unique name for the plugin */
	name: string;
	/**
	 * Render custom content for a HUD cell.
	 * Return a string to display, or undefined to skip.
	 * Plugins are called for every render cycle — keep it fast.
	 */
	render(ctx: HudContext, theme: HudTheme, width: number): string | undefined;
	/** Which line to target: "line1" | ... | "line5". Default: "line2". */
	target?: "line1" | "line2" | "line3" | "line4" | "line5";
	/** Sort order within the line. Lower = earlier. Default: 100. */
	order?: number;
	/**
	 * Column index (0-based) when layout mode is active.
	 * If omitted, auto-distributes.
	 */
	col?: number;
}

/** Subset of theme API passed to plugins */
interface HudTheme {
	fg(color: "text" | "dim" | "accent" | "success" | "warning" | "error", text: string): string;
}

// ============================================================================
// Helpers
// ============================================================================

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}

function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function progressBar(percent: number, barWidth: number): string {
	const filled = Math.round((percent / 100) * barWidth);
	const empty = barWidth - filled;
	return `[${"█".repeat(Math.max(0, filled))}${"░".repeat(Math.max(0, empty))}]`;
}

function ctxColor(theme: HudTheme, pct: number, text: string): string {
	if (pct > 90) return theme.fg("error", text);
	if (pct > 70) return theme.fg("warning", text);
	return theme.fg("success", text);
}

/** Detect AGENTS.md / CLAUDE.md from global + project dirs */
function detectContextFiles(cwd: string): string[] {
	const found: string[] = [];
	const candidates = ["AGENTS.md", "CLAUDE.md"];
	const seen = new Set<string>();

	const home = process.env.HOME || process.env.USERPROFILE;
	if (home) {
		for (const name of candidates) {
			if (existsSync(join(home, ".pi", "agent", name))) {
				found.push(`~/.pi/agent/${name}`);
				seen.add(name);
			}
		}
	}

	let dir = cwd;
	for (let i = 0; i < 20; i++) {
		for (const name of candidates) {
			if (seen.has(name)) continue;
			if (existsSync(join(dir, name))) {
				found.push(dir === cwd ? name : `${dir.split(/[/\\]/).pop()}/${name}`);
				seen.add(name);
			}
		}
		const parent = join(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return found;
}

/** Pad a string with spaces to reach a target visual width (CJK-aware) */
function padToWidth(text: string, targetWidth: number): string {
	const vw = visibleWidth(text);
	const gap = targetWidth - vw;
	return gap > 0 ? text + " ".repeat(gap) : text;
}

/** Strip ANSI escape sequences and return visible length */
function ansiVisibleLen(s: string): number {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b[^\x1b]*\x07/g, "").length;
}

/** Load and merge config from .pi/pi-agent-hud.json (project) and ~/.pi/agent/pi-agent-hud.json (global) */
function loadConfig(cwd: string): HudConfig {
	const result: HudConfig = {
		tokenMode: "always",
		tokenThreshold: 85,
	};

	const paths = [
		join((process.env.HOME || process.env.USERPROFILE) || "", ".pi", "agent", "pi-agent-hud.json"),
		join(cwd, ".pi", "pi-agent-hud.json"),
	];

	for (const p of paths) {
		if (existsSync(p)) {
			try {
				const merged = { ...result, ...JSON.parse(readFileSync(p, "utf-8")) };
				Object.assign(result, merged);
			} catch {
				// ignore bad config
			}
		}
	}

	return result;
}

/** Load user plugins from .pi/pi-agent-hud-plugins/*.ts or ~/.pi/agent/pi-agent-hud-plugins/*.js */
function loadPlugins(cwd: string): HudPlugin[] {
	const plugins: HudPlugin[] = [];
	const dirs = [
		join((process.env.HOME || process.env.USERPROFILE) || "", ".pi", "agent", "pi-agent-hud-plugins"),
		join(cwd, ".pi", "pi-agent-hud-plugins"),
	];

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (file.endsWith(".js") || file.endsWith(".ts")) {
					try {
						// eslint-disable-next-line @typescript-eslint/no-require-imports
						const mod = require(join(dir, file));
						const plugin: HudPlugin = mod.default || mod;
						if (plugin.name && typeof plugin.render === "function") {
							plugins.push(plugin);
						}
					} catch {
						// ignore bad plugin
					}
				}
			}
		} catch {
			// ignore unreadable dir
		}
	}

	return plugins;
}

// ============================================================================
// History Overlay Component
// ============================================================================

class UnifiedHudOverlay implements Component {
	private historyItems: string[];
	private task: string;
	private planSteps: PlanStep[];
	private subagents: SubagentTask[];
	private turnCount: number;
	private toolLog: Array<{ icon: string; name: string; detail: string; elapsed: string; status: "done" | "running" }>;
	private toolCatCounts: Record<string, number>;
	private turnLogView: Array<{ turn: number; summary: string }>;
	private tab: "history" | "plan";
	private selected: number;
	private scrollOffset: number;
	private maxVisible: number;
	private theme: any;
	private tui: TUI;
	private done: (result: string | undefined) => void;

	constructor(
		historyItems: string[],
		task: string,
		planSteps: PlanStep[],
		subagents: SubagentTask[],
		turnCount: number,
		toolLog: Array<{ icon: string; name: string; detail: string; elapsed: string; status: "done" | "running" }>,
		toolCatCounts: Record<string, number>,
		turnLogView: Array<{ turn: number; summary: string }>,
		theme: any,
		tui: TUI,
		done: (result: string | undefined) => void,
	) {
		this.historyItems = historyItems;
		this.task = task;
		this.planSteps = planSteps;
		this.subagents = subagents;
		this.turnCount = turnCount;
		this.toolLog = toolLog;
		this.toolCatCounts = toolCatCounts;
		this.turnLogView = turnLogView;
		this.tab = "history";
		this.theme = theme;
		this.tui = tui;
		this.done = done;
		this.selected = 0;
		this.scrollOffset = 0;
		this.maxVisible = Math.min(historyItems.length, 10);
	}

	render(width: number): string[] {
		return this.tab === "history"
			? this.renderHistory(width)
			: this.renderPlan(width);
	}

	private renderHistory(width: number): string[] {
		const lines: string[] = [];
		const innerW = width - 2;

		// Title bar with tab indicators
		const historyTab = this.theme.fg("accent", "[ History ]");
		const planTab = this.theme.fg("dim", " Plan (Tab) ");
		const titleBase = `${historyTab}${planTab}`;
		const titlePadLen = Math.max(0, innerW - titleBase.length);
		lines.push(
			this.theme.fg("dim", "┌") +
			titleBase +
			this.theme.fg("dim", "─".repeat(titlePadLen) + "┐"),
		);

		const prefixW = 3;
		const itemContentW = innerW - prefixW;
		const end = Math.min(this.scrollOffset + this.maxVisible, this.historyItems.length);

		for (let i = this.scrollOffset; i < end; i++) {
			const raw = this.historyItems[i].replace(/\n/g, " ").replace(/\s+/g, " ").trim();
			const isSel = i === this.selected;

			const display = truncateToWidth(raw, itemContentW, "..");
			const padded = padToWidth(display, itemContentW);

			const prefix = isSel ? this.theme.fg("accent", " ▸ ") : "   ";
			const content = isSel ? this.theme.fg("text", padded) : this.theme.fg("dim", padded);

			lines.push(
				this.theme.fg("dim", "│") + prefix + content + this.theme.fg("dim", " │"),
			);
		}

		const footerText = " ↑↓ scroll · Enter select · Tab plan · Esc close ";
		const footerPadLen = Math.max(0, innerW - footerText.length);
		lines.push(
			this.theme.fg("dim", "├") +
			this.theme.fg("dim", footerText) +
			this.theme.fg("dim", "─".repeat(footerPadLen) + "┘"),
		);

		return lines;
	}

	private renderPlan(width: number): string[] {
		const lines: string[] = [];
		const innerW = width - 2;

		// Title bar with tab indicators
		const historyTab = this.theme.fg("dim", " History (Tab) ");
		const planTab = this.theme.fg("accent", "[ Plan ]");
		const titleBase = `${historyTab}${planTab}`;
		const titlePadLen = Math.max(0, innerW - titleBase.length);
		lines.push(
			this.theme.fg("dim", "┌") +
			titleBase +
			this.theme.fg("dim", "─".repeat(titlePadLen) + "┐"),
		);

		// Task
		const taskDisplay = truncateToWidth(this.task, innerW - 7, "…");
		lines.push(
			this.theme.fg("dim", "│ ") +
			this.theme.fg("accent", "🎯 ") +
			this.theme.fg("text", padToWidth(taskDisplay, innerW - 4)) +
			this.theme.fg("dim", " │"),
		);

		// Stats
		const doneCount = this.planSteps.filter((s) => s.done).length;
		const runningCount = this.subagents.filter((s) => s.status === "running").length;
		const completedSA = this.subagents.filter((s) => s.status === "completed").length;
		let statsText = "";
		if (this.planSteps.length > 0) {
			statsText = `📊 ${doneCount}/${this.planSteps.length} steps · ${this.turnCount} turns`;
			if (runningCount > 0) statsText += ` · ⚡ ${runningCount} subagent${runningCount > 1 ? "s" : ""}`;
		} else if (this.subagents.length > 0) {
			statsText = `⚡ ${completedSA}/${this.subagents.length} subagents · ${this.turnCount} turns`;
		} else {
			statsText = `📋 ${this.turnCount} turn${this.turnCount > 1 ? "s" : ""}`;
		}
		lines.push(
			this.theme.fg("dim", "│  ") +
			this.theme.fg("dim", padToWidth(statsText, innerW - 4)) +
			this.theme.fg("dim", " │"),
		);

		// Steps / content section
		const maxStepW = innerW - 8;
		if (this.planSteps.length > 0) {
			lines.push(this.theme.fg("dim", "├" + "─".repeat(innerW) + "┤"));
			for (const step of this.planSteps) {
				const icon = step.done ? this.theme.fg("success", "✓") : this.theme.fg("dim", "○");
				const stepText = truncateToWidth(step.text, maxStepW, "…");
				const style = step.done ? "dim" : "text";
				lines.push(
					this.theme.fg("dim", "│  ") +
					icon + " " +
					this.theme.fg(style, padToWidth(stepText, maxStepW - 2)) +
					this.theme.fg("dim", " │"),
				);
			}
		} else if (this.subagents.length === 0) {
			// Category summary
			const cats = Object.entries(this.toolCatCounts)
				.filter(([, c]) => c > 0)
				.sort(([, a], [, b]) => b - a);
			if (cats.length > 0) {
				const catStr = cats.map(([icon, count]) => `${icon}×${count}`).join("  ");
				lines.push(this.theme.fg("dim", "├" + "─".repeat(innerW) + "┤"));
				lines.push(
					this.theme.fg("dim", "│  ") +
					this.theme.fg("text", `📊 ${catStr}`) +
					this.theme.fg("dim", " │"),
				);
			}
			// Tool log
			if (this.toolLog.length > 0) {
				if (cats.length === 0) lines.push(this.theme.fg("dim", "├" + "─".repeat(innerW) + "┤"));
				lines.push(
					this.theme.fg("dim", "│  ") +
					this.theme.fg("dim", "🕐 Tool call timeline") +
					this.theme.fg("dim", " │"),
				);
				for (const entry of this.toolLog.slice(0, 10)) {
					const marker = entry.status === "running"
						? this.theme.fg("warning", "◐")
						: this.theme.fg("success", "✓");
					const detail = entry.detail ? " · " + this.theme.fg("dim", entry.detail) : "";
					const time = entry.status === "running"
						? this.theme.fg("dim", ` (${entry.elapsed})`)
						: "";
					lines.push(
						this.theme.fg("dim", "│   ") +
						marker + " " + entry.icon + detail + time +
						this.theme.fg("dim", " │"),
					);
				}
			} else {
				if (cats.length === 0) lines.push(this.theme.fg("dim", "├" + "─".repeat(innerW) + "┤"));
				lines.push(
					this.theme.fg("dim", "│  ") +
					this.theme.fg("dim", padToWidth("📋 Waiting for tool activity…", innerW - 4)) +
					this.theme.fg("dim", " │"),
				);
			}
		}

		// Subagents section
		if (this.subagents.length > 0) {
			const agentTitle = " Subagent Deployments ";
			const agentPadLen = Math.max(0, innerW - agentTitle.length - 2);
			lines.push(
				this.theme.fg("dim", "├") +
				this.theme.fg("warning", agentTitle) +
				this.theme.fg("dim", "─".repeat(agentPadLen) + "┤"),
			);
			for (const sa of this.subagents) {
				const icon = sa.status === "completed"
					? this.theme.fg("success", "✓")
					: this.theme.fg("warning", "◐");
				const elapsed = formatDuration(Date.now() - sa.startTime);
				const saText = truncateToWidth(`${sa.task}`, maxStepW - elapsed.length - 4, "…");
				lines.push(
					this.theme.fg("dim", "│  ") +
					icon + " " +
					this.theme.fg(sa.status === "running" ? "text" : "dim", padToWidth(saText, maxStepW - elapsed.length - 4)) +
					" " + this.theme.fg("dim", elapsed) +
					this.theme.fg("dim", " │"),
				);
			}
		}

		// Turn log
		if (this.turnLogView.length > 0) {
			lines.push(this.theme.fg("dim", "├" + "─".repeat(innerW) + "┤"));
			lines.push(
				this.theme.fg("dim", "│  ") +
				this.theme.fg("text", "💬 Turn log") +
				this.theme.fg("dim", " │"),
			);
			for (const t of this.turnLogView.slice(-10)) {
				const turnLabel = this.theme.fg("dim", `T${String(t.turn).padStart(2, "0")}`);
				const summary = t.summary || "(thinking…)";
				const display = truncateToWidth(summary, innerW - 10, "…");
				lines.push(
					this.theme.fg("dim", "│  ") +
					turnLabel + " " +
					this.theme.fg("dim", display) +
					this.theme.fg("dim", " │"),
				);
			}
		}

		const footerText = " Esc close ";
		const footerPadLen = Math.max(0, innerW - footerText.length);
		lines.push(
			this.theme.fg("dim", "└") +
			this.theme.fg("dim", footerText) +
			this.theme.fg("dim", "─".repeat(footerPadLen) + "┘"),
		);

		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Tab toggles between history and plan
		if (data === "\t" || data === "tab" || kb.matches(data, "tui.input.tab")) {
			this.tab = this.tab === "history" ? "plan" : "history";
			this.tui.requestRender();
			return;
		}

		if (this.tab === "history") {
			this.handleHistoryInput(data, kb);
		} else {
			this.handlePlanInput(data, kb);
		}
	}

	private handleHistoryInput(data: string, kb: any): void {
		if (kb.matches(data, "tui.select.up") || data === "k") {
			if (this.selected > 0) {
				this.selected--;
				if (this.selected < this.scrollOffset) this.scrollOffset--;
				this.tui.requestRender();
			}
		} else if (kb.matches(data, "tui.select.down") || data === "j") {
			if (this.selected < this.historyItems.length - 1) {
				this.selected++;
				if (this.selected >= this.scrollOffset + this.maxVisible) this.scrollOffset++;
				this.tui.requestRender();
			}
		} else if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			this.done(this.historyItems[this.selected]);
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.done(undefined);
		}
	}

	private handlePlanInput(data: string, kb: any): void {
		if (kb.matches(data, "tui.select.cancel")) {
			this.done(undefined);
		}
	}

	invalidate() {}
	dispose() {}
}

// ============================================================================
// Plan Overlay Component
// ============================================================================

interface PlanStep {
	text: string;
	done: boolean;
	toolName?: string;
}

interface SubagentTask {
	task: string;
	status: "running" | "completed";
	startTime: number;
}

// ============================================================================
// Cell-based layout renderer
// ============================================================================

/**
 * A renderable item — either a built-in element or a plugin.
 * Produces one chunk of styled text for a single cell.
 */
interface CellItem {
	/** Unique key for placement lookup */
	key: string;
	/** Which line index this targets by default (0-based) */
	defaultLine: number;
	/** Sort order within a line */
	order: number;
	/** Explicit column from plugin or placement, or undefined for auto */
	fixedCol: number | undefined;
	/** Render this item's content */
	render(): string | undefined;
}

/**
 * Render a grid of cells into output lines.
 *
 * @param layout   Column counts per row, e.g. [1, 2, 2]
 * @param cellItems Items to distribute into cells
 * @param totalWidth Terminal width
 * @param sep     Column separator string (ANSI-safe)
 * @returns Array of rendered line strings
 */
function renderGrid(
	layout: number[],
	cellItems: CellItem[],
	totalWidth: number,
	sep: string,
): string[] {
	const numCols = layout.reduce((a, b) => Math.max(a, b), 0);
	const sepW = visibleWidth(sep);
	// Each column gets equal width; separators take space between columns
	const colW = Math.floor((totalWidth - (numCols - 1) * sepW) / numCols);

	// Build a grid: grid[line][col] = rendered content or ""
	const grid: string[][] = [];
	for (let i = 0; i < layout.length; i++) {
		grid.push(new Array(layout[i]).fill(""));
	}

	// Track which cells are occupied (for placement)
	const occupied = new Set<string>();
	const cellKey = (line: number, col: number) => `${line}:${col}`;

	// First pass: items with fixed placement
	for (const item of cellItems) {
		const place = item.fixedCol;
		if (place === undefined) continue;

		// Determine target line
		let targetLine = item.defaultLine;
		if (targetLine >= layout.length) targetLine = layout.length - 1;

		const targetCol = Math.min(place, layout[targetLine] - 1);
		const key = cellKey(targetLine, targetCol);

		if (!occupied.has(key)) {
			const content = item.render();
			if (content != null) {
				grid[targetLine][targetCol] = content;
				occupied.add(key);
			}
		}
	}

	// Second pass: auto-distribute remaining items
	for (const item of cellItems) {
		if (item.fixedCol !== undefined) continue; // already placed

		const content = item.render();
		if (content == null) continue;

		let targetLine = item.defaultLine;
		if (targetLine >= layout.length) targetLine = layout.length - 1;

		// Find first empty cell in this line, then overflow to next lines
		let placed = false;
		for (let l = targetLine; l < layout.length && !placed; l++) {
			for (let c = 0; c < layout[l] && !placed; c++) {
				if (!occupied.has(cellKey(l, c))) {
					// For multi-col items in a single-col line, truncate to full width
					const availW = layout[l] === 1 ? totalWidth : colW;
					const truncated = truncateToWidth(content, availW, "…");
					grid[l][c] = layout[l] === 1 ? padToWidth(truncated, totalWidth) : padToWidth(truncated, colW);
					occupied.add(cellKey(l, c));
					placed = true;
				}
			}
		}

		// If all lines full, append to last cell of last line
		if (!placed) {
			const lastLine = layout.length - 1;
			const lastCol = layout[lastLine] - 1;
			const existing = grid[lastLine][lastCol];
			const availW = layout[lastLine] === 1 ? totalWidth : colW;
			const combined = existing ? existing + " · " + content : content;
			grid[lastLine][lastCol] = truncateToWidth(padToWidth(combined, availW), availW, "…");
		}
	}

	// Render each row
	const lines: string[] = [];
	for (let l = 0; l < layout.length; l++) {
		const cols = layout[l];
		if (cols === 1) {
			// Full-width line — truncate to totalWidth
			const raw = grid[l][0] || "";
			lines.push(truncateToWidth(padToWidth(raw, totalWidth), totalWidth));
		} else {
			// Multi-column line — join with separator
			const rendered: string[] = [];
			for (let c = 0; c < cols; c++) {
				const raw = grid[l][c] || "";
				rendered.push(truncateToWidth(padToWidth(raw, colW), colW));
			}
			lines.push(rendered.join(sep));
		}
	}

	return lines;
}

// ============================================================================
// Main Extension
// ============================================================================

interface RunningTool {
	name: string;
	startTime: number;
}

/** Rate limit info parsed from provider response headers */
interface RateLimitInfo {
	/** Provider that returned this info */
	provider: string;
	/** Token rate limit: remaining / limit */
	tokenRemaining: number;
	tokenLimit: number;
	/** Request rate limit: remaining / limit */
	requestRemaining: number;
	requestLimit: number;
	/** When the rate limit resets (Unix ms, if available) */
	tokenResetAt?: number;
	requestResetAt?: number;
	/** Timestamp when this info was captured */
	capturedAt: number;
}

/** Usage of one coding-plan quota window (e.g. 5-hour or weekly) */
interface PlanWindowUsage {
	/** Used percent 0-100 */
	usedPercent: number;
	/** Window length in minutes, if reported by the server */
	windowMinutes?: number;
	/** When the window resets (Unix ms), if reported */
	resetAt?: number;
}

/** Coding plan (subscription) quota usage, parsed from response headers */
interface PlanUsageInfo {
	/** Header source: "codex" (ChatGPT OAuth) or "anthropic" (Claude subscription) */
	source: string;
	fiveHour?: PlanWindowUsage;
	weekly?: PlanWindowUsage;
	capturedAt: number;
}

/** Parse a reset header: epoch seconds/ms or ISO date string → Unix ms */
function parseResetHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number(value);
	if (Number.isFinite(n) && n > 0) {
		return n < 1e12 ? n * 1000 : n; // epoch seconds vs ms
	}
	const t = Date.parse(value);
	return Number.isNaN(t) ? undefined : t;
}

/** Parse a utilization header: fraction (0-1) or percent (0-100) → percent */
function parseUtilizationHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0) return undefined;
	return n <= 1 ? n * 100 : n;
}

/** Human label for a window length in minutes: 300 → "5h", 10080 → "wk" */
function formatWindowLabel(minutes: number): string {
	if (minutes % (7 * 24 * 60) === 0) return "wk";
	if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

// ============================================================================
// Coding plan (subscription) quota providers
// ============================================================================
// Data-driven registry: adding support for a new provider = one entry below.
// Each entry declares where to find the API key, which endpoint to poll, and
// how to normalize the response into 5h / weekly windows.
//
// NOTE: Kimi (kimi-code / moonshot) is intentionally NOT listed — its plan
// quota is only rendered in Kimi's own web console; there is no public API
// to query it (as of 2026-07). Add an entry here once an endpoint exists.

/** Declarative spec for one coding-plan quota provider */
interface PlanProviderSpec {
	/** pi provider id(s) this spec handles (ctx.model.provider) */
	providers: string[];
	/** Environment variables tried first for the API key, in order */
	envKeys: string[];
	/** Provider names in ~/.pi/agent/auth.json tried after env */
	authNames: string[];
	/** Quota endpoint URL */
	url: string;
	/** Request headers given the resolved API key */
	headers: (key: string) => Record<string, string>;
	/** Normalize response JSON → 5h/weekly windows; undefined = no usable data */
	parse: (json: any) => { fiveHour?: PlanWindowUsage; weekly?: PlanWindowUsage } | undefined;
}

/** Resolve a plan provider's API key: env first, then ~/.pi/agent/auth.json */
function resolvePlanKey(spec: PlanProviderSpec): string | undefined {
	for (const env of spec.envKeys) {
		if (process.env[env]) return process.env[env];
	}
	try {
		const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
		for (const name of spec.authNames) {
			const entry = auth[name];
			if (entry?.type === "api_key" && entry.key) return entry.key;
		}
	} catch { /* ignore */ }
	return undefined;
}

/** Registered coding-plan quota providers */
const PLAN_PROVIDERS: PlanProviderSpec[] = [
	{
		// GLM Coding Plan (z.ai 国内版): GET /api/monitor/usage/quota/limit
		// TOKENS_LIMIT entries: unit 3 = hour-window (number = hours, e.g. 5h), unit 6 = day-window (number = days, e.g. 7d)
		providers: ["zai-coding-cn"],
		envKeys: ["ZAI_CODING_CN_API_KEY"],
		authNames: ["zai-coding-cn"],
		url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			const limits = json?.data?.limits;
			if (!Array.isArray(limits)) return undefined;
			let fiveHour: PlanWindowUsage | undefined;
			let weekly: PlanWindowUsage | undefined;
			for (const l of limits) {
				if (l?.type !== "TOKENS_LIMIT") continue;
				const w: PlanWindowUsage = {
					usedPercent: typeof l.percentage === "number" ? l.percentage : 0,
					resetAt: typeof l.nextResetTime === "number" ? l.nextResetTime : undefined,
				};
				if (l.unit === 3) {
					fiveHour = { ...w, windowMinutes: (l.number || 5) * 60 };
				} else if (l.unit === 6) {
					weekly = { ...w, windowMinutes: (l.number || 1) * 7 * 24 * 60 };
				}
			}
			return fiveHour || weekly ? { fiveHour, weekly } : undefined;
		},
	},
	{
		// MiniMax Coding Plan: GET /v1/api/openplatform/coding_plan/remains
		// Uses the "general" model entry: current_interval = 5h window, current_weekly = weekly window.
		// Percentages are REMAINING, converted to used.
		providers: ["minimax", "minimax-cn"],
		envKeys: ["MINIMAX_API_KEY", "MINIMAX_CN_API_KEY"],
		authNames: ["minimax", "minimax-cn"],
		url: "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			const general = json?.model_remains?.find((m: any) => m?.model_name === "general") ?? json?.model_remains?.[0];
			if (!general) return undefined;
			const fiveHour: PlanWindowUsage | undefined = typeof general.current_interval_remaining_percent === "number" ? {
				usedPercent: 100 - general.current_interval_remaining_percent,
				windowMinutes: 300,
				resetAt: typeof general.end_time === "number" ? general.end_time : undefined,
			} : undefined;
			const weekly: PlanWindowUsage | undefined = typeof general.current_weekly_remaining_percent === "number" ? {
				usedPercent: 100 - general.current_weekly_remaining_percent,
				windowMinutes: 7 * 24 * 60,
				resetAt: typeof general.weekly_end_time === "number" ? general.weekly_end_time : undefined,
			} : undefined;
			return fiveHour || weekly ? { fiveHour, weekly } : undefined;
		},
	},
];

/** Find the plan provider spec handling a pi provider id */
function findPlanProvider(provider: string | undefined): PlanProviderSpec | undefined {
	return provider ? PLAN_PROVIDERS.find((p) => p.providers.includes(provider)) : undefined;
}

/** Poll a plan provider's quota endpoint; `source` is normalized by the caller */
async function pollPlanProvider(spec: PlanProviderSpec): Promise<PlanUsageInfo | undefined> {
	const key = resolvePlanKey(spec);
	if (!key) return undefined;
	try {
		const res = await fetch(spec.url, {
			headers: spec.headers(key),
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return undefined;
		const windows = spec.parse(await res.json());
		if (windows) {
			return { source: spec.providers[0], ...windows, capturedAt: Date.now() };
		}
	} catch { /* network best-effort */ }
	return undefined;
}

/** Countdown until a reset timestamp: "2h15m", "3d4h", "now" if past */
function formatResetCountdown(resetAt: number): string {
	const ms = resetAt - Date.now();
	if (ms <= 0) return "now";
	const d = Math.floor(ms / 86_400_000);
	if (d >= 1) return `${d}d${Math.floor((ms % 86_400_000) / 3_600_000)}h`;
	return formatDuration(ms);
}

/** Normalize header names to lowercase for case-insensitive lookup */
function getHeader(headers: Record<string, string>, name: string): string | undefined {
	// Try exact match first, then case-insensitive
	if (headers[name] !== undefined) return headers[name];
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) return headers[key];
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let sessionStart = Date.now();
	let cachedCwd = "";
	let cachedContextFiles: string[] = [];
	let config: HudConfig = {};

	const toolCounts = new Map<string, number>();
	const runningTools = new Map<string, RunningTool>();

	const agentEntries: Array<{
		id: string;
		status: "running" | "completed";
		startTime: number;
		endTime?: number;
	}> = [];

	let lastUserInput = "";
	const inputHistory: string[] = [];

	// Agent plan tracking
	let planSteps: PlanStep[] = [];
	const subagentTasks: SubagentTask[] = [];
	let turnCount = 0;
	let hasPlanMessage = false; // Set after first assistant message

	/** Map tool name to a compact icon */
	function toolIcon(name: string): string {
		const lower = name.toLowerCase();
		if (lower.includes("read") || lower.includes("cat") || lower.includes("list")) return "📖";
		if (lower.includes("grep") || lower.includes("rg") || lower.includes("search") || lower.includes("find")) return "🔍";
		if (lower.includes("bash") || lower.includes("exec") || lower.includes("run")) return "⚙";
		if (lower.includes("edit") || lower.includes("write") || lower.includes("patch")) return "✎";
		if (lower.includes("subagent") || lower.includes("task") || lower.includes("agent")) return "🤖";
		if (lower.includes("web") || lower.includes("http") || lower.includes("fetch")) return "🌐";
		return "🔧";
	}

	/** Extract meaningful detail from tool args for display */
	function extractToolDetail(toolName: string, args: unknown): string {
		if (!args || typeof args !== "object") return "";
		const a = args as Record<string, unknown>;
		const lower = toolName.toLowerCase();
		// File-oriented tools: show path
		if (lower.includes("read") || lower.includes("edit") || lower.includes("write")) {
			const p = a.path || a.filePath || a.file || a.filename || "";
			if (typeof p === "string" && p) {
				// Show just the filename from path
				const parts = p.replace(/\\/g, "/").split("/");
				return parts.slice(-2).join("/");
			}
			return "";
		}
		// Bash/exec: show command
		if (lower.includes("bash") || lower.includes("exec") || lower.includes("run")) {
			const c = a.command || a.cmd || a.script || "";
			if (typeof c === "string" && c) {
				return c.length > 30 ? c.slice(0, 27) + "…" : c;
			}
			return "";
		}
		// Search tools
		if (lower.includes("grep") || lower.includes("search") || lower.includes("find") || lower.includes("rg")) {
			const p = a.pattern || a.query || a.term || "";
			if (typeof p === "string" && p) {
				return p.length > 25 ? p.slice(0, 22) + "…" : p;
			}
			return "";
		}
		// Subagent
		if (lower.includes("subagent") || lower.includes("agent")) {
			const t = a.task || a.prompt || a.description || a.agent || "";
			if (typeof t === "string" && t) {
				return t.length > 30 ? t.slice(0, 27) + "…" : t;
			}
			return "";
		}
		// Web tools
		if (lower.includes("web") || lower.includes("fetch") || lower.includes("http")) {
			const u = a.url || a.query || a.prompt || "";
			if (typeof u === "string" && u) {
				return u.length > 35 ? u.slice(0, 32) + "…" : u;
			}
			return "";
		}
		return "";
	}

	const recentTools: string[] = [];
	const toolLog: Array<{ icon: string; name: string; detail: string; elapsed: string; status: "done" | "running"; startTime: number }> = [];
	const toolCatCounts: Record<string, number> = {};
	const turnLog: Array<{ turn: number; summary: string; startedAt: number }> = [];

	// Rate limit tracking — updated from after_provider_response headers
	let rateLimitInfo: RateLimitInfo | undefined;
	// Coding plan (subscription) quota tracking — 5h / weekly windows
	let planUsage: PlanUsageInfo | undefined;
	// Current model provider (tracked for provider-specific quota polling)
	let currentProvider: string | undefined;
	let planPollInFlight = false;

	let plugins: HudPlugin[] = [];

	function refreshContextFiles(cwd: string) {
		if (cwd !== cachedCwd) {
			cachedCwd = cwd;
			cachedContextFiles = detectContextFiles(cwd);
			config = loadConfig(cwd);
			plugins = loadPlugins(cwd);
		}
	}

	function isEnabled(el: HudElement): boolean {
		if (config.disabled?.includes(el)) return false;
		if (config.enabled && config.enabled.length > 0) {
			return config.enabled.includes(el);
		}
		return true;
	}

	/** Map target string to 0-based line index */
	function targetToLine(target: string | undefined): number {
		switch (target ?? "line2") {
			case "line1": return 0;
			case "line2": return 1;
			case "line3": return 2;
			case "line4": return 3;
			case "line5": return 4;
			default: return 1;
		}
	}

	// ---- Register Ctrl+H shortcut (History + Plan tabs) ----
	pi.registerShortcut("ctrl+h", {
		description: "Browse session history and agent plan",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			if (inputHistory.length === 0 && planSteps.length === 0 && subagentTasks.length === 0 && turnCount === 0) {
				ctx.ui.notify("No history or plan data yet", "info");
				return;
			}

			const history = [...inputHistory].reverse();
			const task = lastUserInput || inputHistory[inputHistory.length - 1] || "(no task)";

			const selected = await ctx.ui.custom<string | undefined>(
				(tui, theme, _keybindings, done) => {
					return new UnifiedHudOverlay(history, task, planSteps, subagentTasks, turnCount,
					toolLog, toolCatCounts, turnLog, theme, tui, done);
				},
				{
					overlay: true,
					overlayOptions: {
						width: "80%",
						maxHeight: "60%",
						anchor: "bottom-center",
						offsetY: -3,
					},
				},
			);

			if (selected) {
				ctx.ui.setEditorText(selected);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionStart = Date.now();
		toolCounts.clear();
		runningTools.clear();
		agentEntries.length = 0;
		lastUserInput = "";
		inputHistory.length = 0;
		planSteps = [];
		subagentTasks.length = 0;
		turnCount = 0;
		hasPlanMessage = false;
		recentTools.length = 0;
		toolLog.length = 0;
		for (const k of Object.keys(toolCatCounts)) delete toolCatCounts[k];
		turnLog.length = 0;
		rateLimitInfo = undefined;
	planUsage = undefined;
		cachedCwd = "";
		refreshContextFiles(ctx.cwd);

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
			const timer = setInterval(() => tui.requestRender(), 30_000);

			const hudTheme: HudTheme = {
				fg: (color, text) => theme.fg(color, text),
			};

			return {
				dispose() {
					unsubBranch();
					clearInterval(timer);
				},
				invalidate() {},
				render(width: number): string[] {
					refreshContextFiles(ctx.cwd);

					// ---- Data collection ----
					const model = ctx.model;
					const modelId = model?.id || "no-model";
					const branch = footerData.getGitBranch();

					// Provider switched (e.g. via /model): drop stale plan quota info
					const provider = (model as { provider?: string } | undefined)?.provider;
					if (provider !== currentProvider) {
						currentProvider = provider;
						planUsage = undefined;
					}

					// Coding plan quota endpoints (GLM / MiniMax): poll every 5 min (headers carry nothing)
					const planSpec = findPlanProvider(currentProvider);
					if (planSpec) {
						const stale = !planUsage || planUsage.source !== currentProvider || Date.now() - planUsage.capturedAt > 5 * 60_000;
						if (stale && !planPollInFlight) {
							planPollInFlight = true;
							pollPlanProvider(planSpec).then((info) => {
								if (info && currentProvider && findPlanProvider(currentProvider)) {
									planUsage = { ...info, source: currentProvider };
								}
							}).finally(() => { planPollInFlight = false; });
						}
					}
					const ctxUsage = ctx.getContextUsage();
					const ctxPercent = ctxUsage?.percent ?? 0;

					const cwd = ctx.sessionManager.getCwd();
					const projectName = cwd.split(/[/\\]/).pop() || cwd;

					let totalInput = 0;
					let totalOutput = 0;
					let totalCost = 0;
					for (const e of ctx.sessionManager.getEntries()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							totalInput += m.usage.input;
							totalOutput += m.usage.output;
							totalCost += m.usage.cost.total;
						}
					}

					const allTools = pi.getAllTools();
					const commands = pi.getCommands();
					const builtinToolNames = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);
					const extTools = allTools.filter((t) => !builtinToolNames.has(t.name));
					const skillCmds = commands.filter((c) => c.source === "skill");
					const extCmds = commands.filter((c) => c.source === "extension");
					const thinking = pi.getThinkingLevel();

					const elapsed = formatDuration(Date.now() - sessionStart);

					const hudCtx: HudContext = {
						model: model ? { id: modelId, reasoning: model.reasoning } : undefined,
						branch: branch ?? undefined,
						ctxPercent,
						projectName,
						totalInput,
						totalOutput,
						totalCost,
						skillCount: skillCmds.length,
						extToolCount: extTools.length,
						extCmdCount: extCmds.length,
						thinking,
						elapsed,
						toolCounts,
						runningTools,
						runningAgents: agentEntries,
						inputHistory,
						lastUserInput,
						cwd,
						sessionStart,
						planSteps,
						turnCount,
						subagentTasks,
						planUsage,
					};

					// ================================================================
					// Build all renderable items
					// ================================================================
					const sep = theme.fg("dim", "│");

					// --- Line 1 elements ---
					const line1Parts: string[] = [];
					if (isEnabled("model")) line1Parts.push(theme.fg("accent", `[${modelId}]`));
					// Rate limit after model, before project
					if (isEnabled("rateLimit") && rateLimitInfo) {
						const rl = rateLimitInfo;
						const tokenPct = rl.tokenLimit > 0 ? Math.round((rl.tokenRemaining / rl.tokenLimit) * 100) : -1;
						const reqPct = rl.requestLimit > 0 ? Math.round((rl.requestRemaining / rl.requestLimit) * 100) : -1;
						const worstPct = tokenPct >= 0 && reqPct >= 0 ? Math.min(tokenPct, reqPct) : Math.max(tokenPct, reqPct);
						if (worstPct >= 0) {
							const pctStr = worstPct >= 100 ? "∞" : `${worstPct}%`;
							const icon = worstPct > 50 ? "⚡" : worstPct > 20 ? "⚡" : "🪫";
							const color: "success" | "warning" | "error" = worstPct > 50 ? "success" : worstPct > 20 ? "warning" : "error";
							const detail = rl.tokenLimit > 0 ? `${formatTokens(rl.tokenRemaining)}/${formatTokens(rl.tokenLimit)}` : "";
							const ageMs = Date.now() - rl.capturedAt;
							const ageStr = ageMs < 60_000 ? `${Math.round(ageMs / 1000)}s ago` : ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)}m ago` : `${Math.round(ageMs / 3_600_000)}h ago`;
							line1Parts.push(`${theme.fg(color, `${icon} ${pctStr}`)}${detail ? theme.fg("dim", ` ${detail}`) : ""}${theme.fg("dim", ` ${ageStr}`)}`);
						}
					}
					if (isEnabled("project")) line1Parts.push(theme.fg("text", projectName));
					if (isEnabled("git") && branch) line1Parts.push(theme.fg("dim", `git:(${branch})`));
					if (isEnabled("thinking") && model?.reasoning && thinking !== "off") {
						line1Parts.push(theme.fg("dim", thinking));
					}
					const line1Left = line1Parts.join(" ");

					let ctxBar = "";
					if (isEnabled("contextBar")) {
						const line1RightStr = isEnabled("elapsed") ? theme.fg("dim", `⏱ ${elapsed}`) : "";
						const leftW = visibleWidth(line1Left);
						const rightW = visibleWidth(line1RightStr);
						const barAvail = width - leftW - rightW - 6;
						if (barAvail > 20 && ctxPercent != null) {
							const barW = Math.min(barAvail - 6, 20);
							ctxBar = ctxColor(theme, ctxPercent, `${progressBar(ctxPercent, barW)} ${Math.round(ctxPercent)}%`);
						} else if (ctxPercent != null) {
							ctxBar = ctxColor(theme, ctxPercent, `${Math.round(ctxPercent)}%`);
						} else {
							ctxBar = theme.fg("dim", "?%");
						}
					}
					const line1Right = isEnabled("elapsed") ? theme.fg("dim", `⏱ ${elapsed}`) : "";

					// Line 1 has special center-aligned layout
					const line1Items: CellItem[] = [{
						key: "_line1_main",
						defaultLine: 0,
						order: 0,
						fixedCol: config.placement?._line1_main?.col,
						render: () => {
							const leftW = visibleWidth(line1Left);
							const centerW = visibleWidth(ctxBar);
							const rightW = visibleWidth(line1Right);
							const gap = width - leftW - centerW - rightW;
							if (gap >= 2) {
								const lp = Math.floor(gap / 2);
								const rp = gap - lp;
								return line1Left + " ".repeat(lp) + ctxBar + " ".repeat(rp) + line1Right;
							}
							return truncateToWidth(line1Left + "  " + ctxBar + "  " + line1Right, width);
						},
					}];

					// --- Line 2 elements ---
					const line2Items: CellItem[] = [];

					if (isEnabled("contextFiles")) {
						for (const f of cachedContextFiles) {
							line2Items.push({
								key: `ctxFile:${f}`,
								defaultLine: 1, order: 0,
								fixedCol: config.placement?.[`ctxFile:${f}`]?.col,
								render: () => theme.fg("success", f),
							});
						}
					}
					if (isEnabled("skills") && skillCmds.length > 0) {
						line2Items.push({
							key: "skills", defaultLine: 1, order: 1,
							fixedCol: config.placement?.skills?.col,
							render: () => theme.fg("dim", `skills x${skillCmds.length}`),
						});
					}
					if (isEnabled("extTools") && extTools.length > 0) {
						line2Items.push({
							key: "extTools", defaultLine: 1, order: 2,
							fixedCol: config.placement?.extTools?.col,
							render: () => theme.fg("dim", `ext.tools x${extTools.length}`),
						});
					}
					if (isEnabled("extCmds") && extCmds.length > 0) {
						line2Items.push({
							key: "extCmds", defaultLine: 1, order: 3,
							fixedCol: config.placement?.extCmds?.col,
							render: () => theme.fg("dim", `cmds x${extCmds.length}`),
						});
					}
					if (isEnabled("tokens") && totalInput > 0) {
						const threshold = config.tokenThreshold ?? 85;
						const showTokens = config.tokenMode === "always" || ctxPercent >= threshold;
						if (showTokens) {
							line2Items.push({
								key: "tokens", defaultLine: 1, order: 4,
								fixedCol: config.placement?.tokens?.col,
								render: () => theme.fg("dim", `↑${formatTokens(totalInput)} ↓${formatTokens(totalOutput)}`),
							});
						}
					}
					if (isEnabled("cost") && totalCost > 0) {
						line2Items.push({
							key: "cost", defaultLine: 1, order: 5,
							fixedCol: config.placement?.cost?.col,
							render: () => theme.fg("dim", `$${totalCost.toFixed(3)}`),
						});
					}

					if (isEnabled("plan5h") && planUsage?.fiveHour) {
						const w = planUsage.fiveHour;
						const label = w.windowMinutes ? formatWindowLabel(w.windowMinutes) : "5h";
						line2Items.push({
							key: "plan5h", defaultLine: 1, order: 6,
							fixedCol: config.placement?.plan5h?.col,
							render: () => {
								const reset = w.resetAt ? formatResetCountdown(w.resetAt) : "";
								return `${ctxColor(theme, w.usedPercent, `⏳${label} ${Math.round(w.usedPercent)}%`)}${reset ? theme.fg("dim", ` ↻${reset}`) : ""}`;
							},
						});
					}
					if (isEnabled("planWeek") && planUsage?.weekly) {
						const w = planUsage.weekly;
						const label = w.windowMinutes ? formatWindowLabel(w.windowMinutes) : "wk";
						line2Items.push({
							key: "planWeek", defaultLine: 1, order: 7,
							fixedCol: config.placement?.planWeek?.col,
							render: () => {
								const reset = w.resetAt ? formatResetCountdown(w.resetAt) : "";
								return `${ctxColor(theme, w.usedPercent, `📅${label} ${Math.round(w.usedPercent)}%`)}${reset ? theme.fg("dim", ` ↻${reset}`) : ""}`;
							},
						});
					}

					if (isEnabled("toolStats")) {
						const sortedTools = Array.from(toolCounts.entries()).sort(([, a], [, b]) => b - a);
						for (const [name, count] of sortedTools) {
							line2Items.push({
								key: `tool:${name}`, defaultLine: 1, order: 10,
								fixedCol: config.placement?.[`tool:${name}`]?.col,
								render: () => `${theme.fg("success", "✓")} ${theme.fg("dim", `${name} ×${count}`)}`,
							});
						}
					}
					if (isEnabled("runningTools")) {
						for (const tool of Array.from(runningTools.values())) {
							line2Items.push({
								key: `running:${tool.name}`, defaultLine: 1, order: 20,
								fixedCol: config.placement?.[`running:${tool.name}`]?.col,
								render: () => `${theme.fg("warning", "◐")} ${theme.fg("text", `${tool.name} (${formatDuration(Date.now() - tool.startTime)})`)}`,
							});
						}
					}
					if (isEnabled("runningAgents")) {
						const running = agentEntries.filter((a) => a.status === "running");
						for (const agent of running.slice(-2)) {
							line2Items.push({
								key: "runningAgent", defaultLine: 1, order: 21,
								fixedCol: config.placement?.runningAgent?.col,
								render: () => `${theme.fg("warning", "◐")} ${theme.fg("accent", `agent (${formatDuration(Date.now() - agent.startTime)})`)}`,
							});
						}
					}

				if (isEnabled("agentPlan") && (turnCount > 0 || subagentTasks.length > 0)) {
					const doneCount = planSteps.filter((s) => s.done).length;
					const runningSA = subagentTasks.filter((s) => s.status === "running").length;
					let planText = "";
					if (planSteps.length > 0) {
						planText += theme.fg("accent", `📋 ${doneCount}/${planSteps.length}`);
						if (runningSA > 0) planText += theme.fg("warning", ` ⚡${runningSA}`);
						planText += theme.fg("dim", ` · ${turnCount}t`);
					} else if (runningSA > 0) {
						planText += theme.fg("warning", `⚡ ${runningSA} subagent${runningSA > 1 ? "s" : ""}`);
						planText += theme.fg("dim", ` · ${turnCount}t`);
					} else {
						// No plan, no subagents: show turn count + recent tool icons
						planText += theme.fg("accent", `📋 ${turnCount}t`);
						const seen = new Set<string>();
						const recentIcons: string[] = [];
						for (const t of recentTools.slice(0, 8)) {
							const ic = toolIcon(t);
							if (!seen.has(ic)) {
								seen.add(ic);
								recentIcons.push(ic);
								if (recentIcons.length >= 3) break;
							}
						}
						if (recentIcons.length > 0) {
							planText += theme.fg("dim", ` ${recentIcons.join("")}`);
						}
					}
					line2Items.push({
						key: "agentPlan", defaultLine: 1, order: 22,
						fixedCol: config.placement?.agentPlan?.col,
						render: () => planText,
					});
				}
						// --- Line 3 elements ---
					const line3Items: CellItem[] = [];
					if (isEnabled("lastInput") && lastUserInput) {
						line3Items.push({
							key: "lastInput", defaultLine: 2, order: 0,
							fixedCol: config.placement?.lastInput?.col,
							render: () => {
								const truncated = lastUserInput.length > 200 ? lastUserInput.slice(0, 197) + "..." : lastUserInput;
								const display = truncated.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
								const parts = [theme.fg("accent", "▸"), theme.fg("dim", display)];
								if (isEnabled("historyHint") && inputHistory.length > 1) {
									parts.push(theme.fg("dim", `Ctrl+H:${inputHistory.length}`));
								}
								return parts.join(" ");
							},
						});
					}

					// --- Plugin items ---
					const pluginItems: CellItem[] = plugins
						.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
						.map((p) => ({
							key: `plugin:${p.name}`,
							defaultLine: targetToLine(p.target),
							order: p.order ?? 100,
							fixedCol: p.col ?? config.placement?.[`plugin:${p.name}`]?.col,
							render: () => p.render(hudCtx, hudTheme, width),
						}));

					// All items sorted
					const allItems = [...line1Items, ...line2Items, ...line3Items, ...pluginItems];

					// ================================================================
					// Layout mode branch
					// ================================================================
					const layout = config.layout;

					if (layout && layout.length > 0) {
						// === Grid layout mode ===
						return renderGrid(layout, allItems, width, sep);
					}

					// === Classic single-column mode (default, unchanged) ===

					// Line 1
					const l1Content = line1Items[0]?.render();
					const pluginLine1 = pluginItems
						.filter((p) => p.defaultLine === 0)
						.sort((a, b) => a.order - b.order)
						.map((p) => p.render())
						.filter((s): s is string => s != null);
					let line1 = l1Content || "";
					if (pluginLine1.length > 0) line1 += " " + pluginLine1.join(" ");
					line1 = truncateToWidth(line1, width);

					// Line 2
					const l2Parts = line2Items
						.sort((a, b) => a.order - b.order)
						.map((item) => item.render())
						.filter((s): s is string => s != null);
					const pluginLine2 = pluginItems
						.filter((p) => p.defaultLine === 1)
						.sort((a, b) => a.order - b.order)
						.map((p) => p.render())
						.filter((s): s is string => s != null);
					l2Parts.push(...pluginLine2);
					const line2 = truncateToWidth(
						l2Parts.join(theme.fg("dim", " · ")),
						width,
						theme.fg("dim", "..."),
					);

					// Line 3
					let line3 = "";
					if (lastUserInput && isEnabled("lastInput")) {
						const inputParts = line3Items
							.sort((a, b) => a.order - b.order)
							.map((item) => item.render())
							.filter((s): s is string => s != null);
						const pluginLine3 = pluginItems
							.filter((p) => p.defaultLine === 2)
							.sort((a, b) => a.order - b.order)
							.map((p) => p.render())
							.filter((s): s is string => s != null);
						inputParts.push(...pluginLine3);
						if (inputParts.length > 0) {
							line3 = truncateToWidth(
								inputParts.join(" "),
								width,
								theme.fg("dim", "..."),
							);
						}
					}

					return line3 ? [line1, line2, line3] : [line1, line2];
				},
			};
		});
	});

	// ---- Track plan from assistant messages ----
	// Parse numbered or bulleted lists from the first assistant message as plan steps
	function parsePlanFromText(text: string): string[] {
		const steps: string[] = [];
		const lines = text.split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			// Match numbered steps: "1.", "Step 1:", "1)", "Task 1:"
			const numMatch = trimmed.match(/^(?:Step\s*)?(\d+)[.)]\s+(.+)/i);
			if (numMatch) {
				steps.push(numMatch[2].trim());
				continue;
			}
			// Match bullet points: "- ", "* ", "• "
			const bulletMatch = trimmed.match(/^[-*•]\s+(.+)/);
			if (bulletMatch && steps.length > 0) { // Only capture bullets after we've seen numbered items
				steps.push(bulletMatch[1].trim());
			}
		}
		return steps;
	}

	pi.on("turn_start", async () => {
		turnCount++;
		turnLog.push({ turn: turnCount, summary: "", startedAt: Date.now() });
		if (turnLog.length > 30) turnLog.shift();
	});

	pi.on("message_end", async (event) => {
		// Parse plan from first assistant message
		if (!hasPlanMessage && event.message.role === "assistant") {
			const content = event.message.content;
			if (content && Array.isArray(content)) {
				const textParts = content
					.filter((b): b is { type: "text"; text: string } => b.type === "text" && "text" in b)
					.map((b) => b.text)
					.join("\n");
				const parsed = parsePlanFromText(textParts);
				if (parsed.length >= 2) { // At least 2 steps to count as a plan
					planSteps = parsed.map((text) => ({ text, done: false }));
					hasPlanMessage = true;
				}
			}
		}
		// Capture assistant message as turn summary
		if (event.message.role === "assistant" && turnLog.length > 0) {
			const lastTurn = turnLog[turnLog.length - 1];
			if (!lastTurn.summary) {
				const content = event.message.content;
				if (content && Array.isArray(content)) {
					const text = content
						.filter((b): b is { type: "text"; text: string } => b.type === "text" && "text" in b)
						.map((b) => b.text)
						.join(" ");
					lastTurn.summary = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
				}
			}
		}
	});

	// ---- Track subagent delegations and plan step completion ----
	pi.on("tool_execution_start", async (event) => {
		runningTools.set(event.toolCallId, { name: event.toolName, startTime: Date.now() });

		// Add to tool log for plan overlay
		if (event.toolName) {
			const icon = toolIcon(event.toolName);
			const detail = extractToolDetail(event.toolName, event.args);
			toolLog.unshift({ icon, name: event.toolName, detail, elapsed: "0s", status: "running", startTime: Date.now() });
			if (toolLog.length > 50) toolLog.length = 50;
		}

		// Track subagent tool calls
		if (event.toolName === "subagent" || event.toolName === "task") {
			const args = event.args as any;
			const taskDesc = args?.task || args?.description || args?.prompt || event.toolName;
			const shortTask = typeof taskDesc === "string"
				? taskDesc.replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)
				: event.toolName;
			subagentTasks.push({ task: shortTask, status: "running", startTime: Date.now() });
		}

		// Mark matching plan step as in-progress
		if (planSteps.length > 0 && event.toolName) {
			const lowerTool = event.toolName.toLowerCase();
			for (const step of planSteps) {
				if (!step.done) {
					const lowerStep = step.text.toLowerCase();
					// Match if step mentions the tool or vice versa (simple keyword match)
					if (lowerStep.includes(lowerTool) || lowerTool.includes(lowerStep.slice(0, 8))) {
						step.toolName = event.toolName;
						break;
					}
				}
			}
		}
	});

	pi.on("tool_execution_end", async (event) => {
		runningTools.delete(event.toolCallId);
		if (event.toolName) {
			toolCounts.set(event.toolName, (toolCounts.get(event.toolName) || 0) + 1);

			// Track recent tools for Line 2 plan display
			recentTools.unshift(event.toolName);
			if (recentTools.length > 8) recentTools.length = 8;

			// Update tool log: mark running entry as done
			const icon = toolIcon(event.toolName);
			toolCatCounts[icon] = (toolCatCounts[icon] || 0) + 1;
			for (const entry of toolLog) {
				if (entry.status === "running" && entry.name === event.toolName) {
					entry.status = "done";
					entry.elapsed = formatDuration(Date.now() - entry.startTime);
					break;
				}
			}

			// Mark plan step as done when tool completes
			for (const step of planSteps) {
				if (!step.done && step.toolName === event.toolName) {
					step.done = true;
					break;
				}
			}

			// Mark subagent as completed
			if (event.toolName === "subagent" || event.toolName === "task") {
				const running = subagentTasks.filter((s) => s.status === "running");
				if (running.length > 0) {
					running[running.length - 1].status = "completed";
				}
			}
		}

		// Auto-complete plan steps that have no matching tool after a batch
		if (planSteps.length > 0 && runningTools.size === 0 && agentEntries.filter((a) => a.status === "running").length === 0) {
			for (const step of planSteps) {
				if (!step.done && !step.toolName) {
					step.done = true; // Auto-complete unassigned steps when agent is idle
				}
			}
		}
	});

	// ---- Track agent loops ----
	pi.on("agent_start", async () => {
		agentEntries.push({ id: `agent-${Date.now()}`, status: "running", startTime: Date.now() });
	});

	pi.on("agent_end", async () => {
		const running = agentEntries.filter((a) => a.status === "running");
		if (running.length > 0) {
			const last = running[running.length - 1];
			last.status = "completed";
			last.endTime = Date.now();
		}
	});

	// ---- Track provider rate limits from response headers ----
	pi.on("after_provider_response", async (event) => {
		const headers = event.headers;

		// Debug: dump rate-limit related headers for discovery
		// (enabled via config.debugDumpHeaders or env PI_HUD_DEBUG_HEADERS=1)
		if (headers && (config.debugDumpHeaders || process.env.PI_HUD_DEBUG_HEADERS)) {
			try {
				const dir = join(homedir(), ".pi", "agent");
				mkdirSync(dir, { recursive: true });
				appendFileSync(
					join(dir, "pi-agent-hud-headers.jsonl"),
					JSON.stringify({ ts: new Date().toISOString(), status: event.status, headers }) + "\n",
				);
			} catch { /* best-effort debug logging */ }
		}

		if (!headers || event.status >= 400) return;

		const isAnthropic = !!getHeader(headers, "anthropic-ratelimit-tokens-limit");
		const isOpenAI = !isAnthropic && !!getHeader(headers, "x-ratelimit-limit-tokens");

		if (isAnthropic) {
			const tokenLimit = parseInt(getHeader(headers, "anthropic-ratelimit-tokens-limit") || "0", 10);
			const tokenRemaining = parseInt(getHeader(headers, "anthropic-ratelimit-tokens-remaining") || "0", 10);
			const requestLimit = parseInt(getHeader(headers, "anthropic-ratelimit-requests-limit") || "0", 10);
			const requestRemaining = parseInt(getHeader(headers, "anthropic-ratelimit-requests-remaining") || "0", 10);
			if (tokenLimit > 0 || requestLimit > 0) {
				rateLimitInfo = { provider: "anthropic", tokenRemaining, tokenLimit, requestRemaining, requestLimit, capturedAt: Date.now() };
			}
		} else if (isOpenAI) {
			const tokenLimit = parseInt(getHeader(headers, "x-ratelimit-limit-tokens") || "0", 10);
			const tokenRemaining = parseInt(getHeader(headers, "x-ratelimit-remaining-tokens") || "0", 10);
			const requestLimit = parseInt(getHeader(headers, "x-ratelimit-limit-requests") || "0", 10);
			const requestRemaining = parseInt(getHeader(headers, "x-ratelimit-remaining-requests") || "0", 10);
			if (tokenLimit > 0 || requestLimit > 0) {
				rateLimitInfo = { provider: "openai", tokenRemaining, tokenLimit, requestRemaining, requestLimit, capturedAt: Date.now() };
			}
		}

		// ---- Coding plan (subscription) quota windows: 5h / weekly ----
		// Codex via ChatGPT OAuth: x-codex-primary-* (~5h) and x-codex-secondary-* (weekly)
		const codexPrimaryUsed = parseUtilizationHeader(getHeader(headers, "x-codex-primary-used-percent"));
		const codexSecondaryUsed = parseUtilizationHeader(getHeader(headers, "x-codex-secondary-used-percent"));
		if (codexPrimaryUsed !== undefined || codexSecondaryUsed !== undefined) {
			planUsage = {
				source: "codex",
				fiveHour: codexPrimaryUsed !== undefined ? {
					usedPercent: codexPrimaryUsed,
					windowMinutes: Number(getHeader(headers, "x-codex-primary-window-minutes")) || undefined,
					resetAt: parseResetHeader(getHeader(headers, "x-codex-primary-reset-at")),
				} : undefined,
				weekly: codexSecondaryUsed !== undefined ? {
					usedPercent: codexSecondaryUsed,
					windowMinutes: Number(getHeader(headers, "x-codex-secondary-window-minutes")) || undefined,
					resetAt: parseResetHeader(getHeader(headers, "x-codex-secondary-reset-at")),
				} : undefined,
				capturedAt: Date.now(),
			};
		} else {
			// Claude subscription (OAuth): anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}
			const a5h = parseUtilizationHeader(getHeader(headers, "anthropic-ratelimit-unified-5h-utilization"));
			const a7d = parseUtilizationHeader(getHeader(headers, "anthropic-ratelimit-unified-7d-utilization"));
			if (a5h !== undefined || a7d !== undefined) {
				planUsage = {
					source: "anthropic",
					fiveHour: a5h !== undefined ? {
						usedPercent: a5h,
						windowMinutes: 300,
						resetAt: parseResetHeader(getHeader(headers, "anthropic-ratelimit-unified-5h-reset")),
					} : undefined,
					weekly: a7d !== undefined ? {
						usedPercent: a7d,
						windowMinutes: 7 * 24 * 60,
						resetAt: parseResetHeader(getHeader(headers, "anthropic-ratelimit-unified-7d-reset")),
					} : undefined,
					capturedAt: Date.now(),
				};
			}
		}
	});

		// ---- Track user input history ----
	pi.on("input", async (event) => {
		const text = event.text?.trim();
		if (text) {
			lastUserInput = text;
			inputHistory.push(text);
		}
	});
}

// Re-export types for plugin authors
export type { HudPlugin, HudContext, HudTheme };
