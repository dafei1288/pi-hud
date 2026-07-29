/**
 * state.ts — 会话状态容器 + 事件追踪器
 *
 * SessionState 保存一次会话中追踪到的所有动态数据
 * （工具调用、计划步骤、子代理、输入历史、turn 日志等），
 * registerTrackers 把 pi 事件流写入 state / quota。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatDuration } from "./layout.ts";
import type { QuotaService } from "./quota.ts";

// ============================================================================
// 类型
// ============================================================================

export interface PlanStep {
	text: string;
	done: boolean;
	toolName?: string;
}

export interface SubagentTask {
	task: string;
	status: "running" | "completed";
	startTime: number;
}

export interface RunningTool {
	name: string;
	startTime: number;
}

export interface AgentEntry {
	id: string;
	status: "running" | "completed";
	startTime: number;
	endTime?: number;
}

export interface ToolLogEntry {
	icon: string;
	name: string;
	detail: string;
	elapsed: string;
	status: "done" | "running";
	startTime: number;
}

export interface TurnLogEntry {
	turn: number;
	summary: string;
	startedAt: number;
}

// ============================================================================
// 会话状态
// ============================================================================

export class SessionState {
	sessionStart = Date.now();

	readonly toolCounts = new Map<string, number>();
	readonly runningTools = new Map<string, RunningTool>();
	readonly agentEntries: AgentEntry[] = [];

	lastUserInput = "";
	readonly inputHistory: string[] = [];

	planSteps: PlanStep[] = [];
	readonly subagentTasks: SubagentTask[] = [];
	turnCount = 0;
	hasPlanMessage = false;

	readonly recentTools: string[] = [];
	readonly toolLog: ToolLogEntry[] = [];
	readonly toolCatCounts: Record<string, number> = {};
	readonly turnLog: TurnLogEntry[] = [];

	/** session_start 时重置全部追踪数据 */
	reset(): void {
		this.sessionStart = Date.now();
		this.toolCounts.clear();
		this.runningTools.clear();
		this.agentEntries.length = 0;
		this.lastUserInput = "";
		this.inputHistory.length = 0;
		this.planSteps = [];
		this.subagentTasks.length = 0;
		this.turnCount = 0;
		this.hasPlanMessage = false;
		this.recentTools.length = 0;
		this.toolLog.length = 0;
		for (const k of Object.keys(this.toolCatCounts)) delete this.toolCatCounts[k];
		this.turnLog.length = 0;
	}
}

// ============================================================================
// 工具展示辅助
// ============================================================================

/** 工具名 → 紧凑图标 */
export function toolIcon(name: string): string {
	const lower = name.toLowerCase();
	if (lower.includes("read") || lower.includes("cat") || lower.includes("list")) return "📖";
	if (lower.includes("grep") || lower.includes("rg") || lower.includes("search") || lower.includes("find")) return "🔍";
	if (lower.includes("bash") || lower.includes("exec") || lower.includes("run")) return "⚙";
	if (lower.includes("edit") || lower.includes("write") || lower.includes("patch")) return "✎";
	if (lower.includes("subagent") || lower.includes("task") || lower.includes("agent")) return "🤖";
	if (lower.includes("web") || lower.includes("http") || lower.includes("fetch")) return "🌐";
	return "🔧";
}

/** 从工具参数里提取有意义的展示细节 */
export function extractToolDetail(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const lower = toolName.toLowerCase();
	// 文件类工具：显示路径
	if (lower.includes("read") || lower.includes("edit") || lower.includes("write")) {
		const p = a.path || a.filePath || a.file || a.filename || "";
		if (typeof p === "string" && p) {
			const parts = p.replace(/\\/g, "/").split("/");
			return parts.slice(-2).join("/");
		}
		return "";
	}
	// Bash/exec：显示命令
	if (lower.includes("bash") || lower.includes("exec") || lower.includes("run")) {
		const c = a.command || a.cmd || a.script || "";
		if (typeof c === "string" && c) {
			return c.length > 30 ? c.slice(0, 27) + "…" : c;
		}
		return "";
	}
	// 搜索类
	if (lower.includes("grep") || lower.includes("search") || lower.includes("find") || lower.includes("rg")) {
		const p = a.pattern || a.query || a.term || "";
		if (typeof p === "string" && p) {
			return p.length > 25 ? p.slice(0, 22) + "…" : p;
		}
		return "";
	}
	// 子代理
	if (lower.includes("subagent") || lower.includes("agent")) {
		const t = a.task || a.prompt || a.description || a.agent || "";
		if (typeof t === "string" && t) {
			return t.length > 30 ? t.slice(0, 27) + "…" : t;
		}
		return "";
	}
	// Web 类
	if (lower.includes("web") || lower.includes("fetch") || lower.includes("http")) {
		const u = a.url || a.query || a.prompt || "";
		if (typeof u === "string" && u) {
			return u.length > 35 ? u.slice(0, 32) + "…" : u;
		}
		return "";
	}
	return "";
}

/** 从第一条 assistant 消息里解析编号/列表项作为计划步骤 */
export function parsePlanFromText(text: string): string[] {
	const steps: string[] = [];
	const lines = text.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		// 编号步骤："1.", "Step 1:", "1)", "Task 1:"
		const numMatch = trimmed.match(/^(?:Step\s*)?(\d+)[.)]\s+(.+)/i);
		if (numMatch) {
			steps.push(numMatch[2].trim());
			continue;
		}
		// 列表项："- ", "* ", "• "（只在见过编号项之后捕获）
		const bulletMatch = trimmed.match(/^[-*•]\s+(.+)/);
		if (bulletMatch && steps.length > 0) {
			steps.push(bulletMatch[1].trim());
		}
	}
	return steps;
}

// ============================================================================
// 事件追踪
// ============================================================================

/** 把 pi 事件流写入 state / quota */
export function registerTrackers(pi: ExtensionAPI, state: SessionState, quota: QuotaService): void {
	pi.on("turn_start", async () => {
		state.turnCount++;
		state.turnLog.push({ turn: state.turnCount, summary: "", startedAt: Date.now() });
		if (state.turnLog.length > 30) state.turnLog.shift();
	});

	pi.on("message_end", async (event) => {
		// 从第一条 assistant 消息解析计划
		if (!state.hasPlanMessage && event.message.role === "assistant") {
			const content = event.message.content;
			if (content && Array.isArray(content)) {
				const textParts = content
					.filter((b): b is { type: "text"; text: string } => b.type === "text" && "text" in b)
					.map((b) => b.text)
					.join("\n");
				const parsed = parsePlanFromText(textParts);
				if (parsed.length >= 2) { // 至少 2 步才算计划
					state.planSteps = parsed.map((text) => ({ text, done: false }));
					state.hasPlanMessage = true;
				}
			}
		}
		// 捕获 assistant 消息作为 turn 摘要
		if (event.message.role === "assistant" && state.turnLog.length > 0) {
			const lastTurn = state.turnLog[state.turnLog.length - 1];
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

	pi.on("tool_execution_start", async (event) => {
		state.runningTools.set(event.toolCallId, { name: event.toolName, startTime: Date.now() });

		// 加入计划 overlay 的工具日志
		if (event.toolName) {
			const icon = toolIcon(event.toolName);
			const detail = extractToolDetail(event.toolName, event.args);
			state.toolLog.unshift({ icon, name: event.toolName, detail, elapsed: "0s", status: "running", startTime: Date.now() });
			if (state.toolLog.length > 50) state.toolLog.length = 50;
		}

		// 追踪子代理调用
		if (event.toolName === "subagent" || event.toolName === "task") {
			const args = event.args as any;
			const taskDesc = args?.task || args?.description || args?.prompt || event.toolName;
			const shortTask = typeof taskDesc === "string"
				? taskDesc.replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)
				: event.toolName;
			state.subagentTasks.push({ task: shortTask, status: "running", startTime: Date.now() });
		}

		// 标记匹配的计划步骤为进行中
		if (state.planSteps.length > 0 && event.toolName) {
			const lowerTool = event.toolName.toLowerCase();
			for (const step of state.planSteps) {
				if (!step.done) {
					const lowerStep = step.text.toLowerCase();
					if (lowerStep.includes(lowerTool) || lowerTool.includes(lowerStep.slice(0, 8))) {
						step.toolName = event.toolName;
						break;
					}
				}
			}
		}
	});

	pi.on("tool_execution_end", async (event) => {
		state.runningTools.delete(event.toolCallId);
		if (event.toolName) {
			state.toolCounts.set(event.toolName, (state.toolCounts.get(event.toolName) || 0) + 1);

			state.recentTools.unshift(event.toolName);
			if (state.recentTools.length > 8) state.recentTools.length = 8;

			// 更新工具日志：标记 running 条目为 done
			const icon = toolIcon(event.toolName);
			state.toolCatCounts[icon] = (state.toolCatCounts[icon] || 0) + 1;
			for (const entry of state.toolLog) {
				if (entry.status === "running" && entry.name === event.toolName) {
					entry.status = "done";
					entry.elapsed = formatDuration(Date.now() - entry.startTime);
					break;
				}
			}

			// 工具完成时标记对应计划步骤为 done
			for (const step of state.planSteps) {
				if (!step.done && step.toolName === event.toolName) {
					step.done = true;
					break;
				}
			}

			// 标记子代理完成
			if (event.toolName === "subagent" || event.toolName === "task") {
				const running = state.subagentTasks.filter((s) => s.status === "running");
				if (running.length > 0) {
					running[running.length - 1].status = "completed";
				}
			}
		}

		// 一批工具结束后，自动完成没有匹配工具的步骤
		if (state.planSteps.length > 0 && state.runningTools.size === 0 && state.agentEntries.filter((a) => a.status === "running").length === 0) {
			for (const step of state.planSteps) {
				if (!step.done && !step.toolName) {
					step.done = true;
				}
			}
		}
	});

	pi.on("agent_start", async () => {
		state.agentEntries.push({ id: `agent-${Date.now()}`, status: "running", startTime: Date.now() });
	});

	pi.on("agent_end", async () => {
		const running = state.agentEntries.filter((a) => a.status === "running");
		if (running.length > 0) {
			const last = running[running.length - 1];
			last.status = "completed";
			last.endTime = Date.now();
		}
	});

	// provider rate limit / 订阅配额：从响应头解析
	pi.on("after_provider_response", async (event) => {
		quota.handleProviderHeaders(event.headers, event.status);
	});

	// 用户输入历史
	pi.on("input", async (event) => {
		const text = event.text?.trim();
		if (text) {
			state.lastUserInput = text;
			state.inputHistory.push(text);
		}
	});
}
