/**
 * overlay.ts — 历史/计划统一 overlay 组件
 *
 * Ctrl+H 打开（History 标签页，可选中历史输入回填编辑器），
 * Tab 切换到 Plan 标签页（任务、计划步骤、工具时间线、子代理、turn 日志）。
 */

import type { Component, TUI } from "@mariozechner/pi-tui";
import { getKeybindings, truncateToWidth } from "@mariozechner/pi-tui";
import { formatDuration, padToWidth } from "./layout.ts";
import type { PlanStep, SubagentTask, ToolLogEntry, TurnLogEntry } from "./state.ts";

export class UnifiedHudOverlay implements Component {
	private historyItems: string[];
	private task: string;
	private planSteps: PlanStep[];
	private subagents: SubagentTask[];
	private turnCount: number;
	private toolLog: ToolLogEntry[];
	private toolCatCounts: Record<string, number>;
	private turnLogView: TurnLogEntry[];
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
		toolLog: ToolLogEntry[],
		toolCatCounts: Record<string, number>,
		turnLogView: TurnLogEntry[],
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

		// 标题栏 + 标签页指示
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

		// 标题栏 + 标签页指示
		const historyTab = this.theme.fg("dim", " History (Tab) ");
		const planTab = this.theme.fg("accent", "[ Plan ]");
		const titleBase = `${historyTab}${planTab}`;
		const titlePadLen = Math.max(0, innerW - titleBase.length);
		lines.push(
			this.theme.fg("dim", "┌") +
			titleBase +
			this.theme.fg("dim", "─".repeat(titlePadLen) + "┐"),
		);

		// 任务
		const taskDisplay = truncateToWidth(this.task, innerW - 7, "…");
		lines.push(
			this.theme.fg("dim", "│ ") +
			this.theme.fg("accent", "🎯 ") +
			this.theme.fg("text", padToWidth(taskDisplay, innerW - 4)) +
			this.theme.fg("dim", " │"),
		);

		// 统计
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

		// 步骤 / 内容区
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
			// 分类汇总
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
			// 工具日志
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

		// 子代理区
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

		// Turn 日志
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

		// Tab 在历史/计划间切换
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
