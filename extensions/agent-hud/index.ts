/**
 * agent-hud — claude-hud 风格状态栏 + 气泡编辑器
 *
 * Footer:
 *   Line 1: [████████░░] 39%  ⚡85% · ↑12.5k ↓3.2k · $0.042 · 3 turn  ⏱ 21m
 *   Line 2: AGENTS.md · skills x5 · ext.tools x2 · 💰 ¥12.50 · ⏳5h 42% · ✓ Grep ×10
 *   Line 3: ▸ 最后一条用户输入  Ctrl+H:5
 *
 * 快捷键:
 *   Ctrl+H       历史/计划 overlay（Tab 切换，Enter 回填选中历史）
 *   Ctrl+Shift+J 执行计划 overlay（直接打开 Plan 标签页）
 *
 * 编辑器:
 *   config.editor = "bubble" 启用气泡编辑器，运行时可用 /bubble 切换
 *
 * 配置: .pi/pi-agent-hud.json 或 ~/.pi/agent/pi-agent-hud.json
 * 插件: .pi/pi-agent-hud-plugins/*.js|ts（见 hud-footer.ts 的 HudPlugin）
 *
 * 模块结构:
 *   config.ts       配置加载 + 元素开关 + 上下文文件探测
 *   quota.ts        LLM 计费/额度共享服务（唯一数据源）
 *   state.ts        会话状态 + 事件追踪
 *   layout.ts       纯渲染辅助 + 网格布局
 *   overlay.ts      历史/计划 overlay 组件
 *   hud-footer.ts   状态栏 + 插件系统
 *   bubble-editor.ts 气泡编辑器
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { KeyId } from "@mariozechner/pi-tui";
import { installBubbleEditor } from "./bubble-editor.ts";
import { loadConfig, type HudConfig } from "./config.ts";
import { createHudFooter } from "./hud-footer.ts";
import { UnifiedHudOverlay } from "./overlay.ts";
import { QuotaService } from "./quota.ts";
import { registerTrackers, SessionState } from "./state.ts";

export default function (pi: ExtensionAPI) {
	const state = new SessionState();
	const quota = new QuotaService();
	let config: HudConfig = {};
	let bubbleActive = false;
	let uninstallBubble: (() => void) | undefined;

	registerTrackers(pi, state, quota);

	// ---- Ctrl+H：历史/计划 overlay（History 标签页，选中历史回填编辑器） ----
	pi.registerShortcut("ctrl+h" as KeyId, {
		description: "历史/计划",
		handler: async (ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
			if (state.inputHistory.length === 0 && state.planSteps.length === 0 && state.subagentTasks.length === 0 && state.turnCount === 0) {
				ctx.ui.notify("No history or plan data yet", "info");
				return;
			}

			const history = [...state.inputHistory].reverse();
			const task = state.lastUserInput || state.inputHistory[state.inputHistory.length - 1] || "(no task)";

			const selected = await ctx.ui.custom<string | undefined>(
				(tui, theme, _keybindings, done) => {
					return new UnifiedHudOverlay(history, task, state.planSteps, state.subagentTasks, state.turnCount,
						state.toolLog, state.toolCatCounts, state.turnLog, theme, tui, done);
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

	// ---- Ctrl+Shift+J：执行计划 overlay（Plan 标签页） ----
	pi.registerShortcut("ctrl+shift+j" as KeyId, {
		description: "执行计划",
		handler: async (ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
			if (state.planSteps.length === 0 && state.subagentTasks.length === 0 && state.turnCount === 0) {
				ctx.ui.notify("No plan data yet", "info");
				return;
			}

			const history = [...state.inputHistory].reverse();
			const task = state.lastUserInput || state.inputHistory[state.inputHistory.length - 1] || "(no task)";

			await ctx.ui.custom<string | undefined>(
				(tui, theme, _keybindings, done) => {
					return new UnifiedHudOverlay(history, task, state.planSteps, state.subagentTasks, state.turnCount,
						state.toolLog, state.toolCatCounts, state.turnLog, theme, tui, done);
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
		},
	});

	// ---- /bubble：运行时切换气泡编辑器 ----
	pi.registerCommand("bubble", {
		description: "切换气泡编辑器 (bubble editor on/off)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (bubbleActive) {
				uninstallBubble?.();
				uninstallBubble = undefined;
				bubbleActive = false;
				ctx.ui.setEditorComponent(undefined);
				ctx.ui.notify("Bubble editor off", "info");
			} else {
				uninstallBubble = installBubbleEditor(pi, ctx, quota);
				bubbleActive = true;
				ctx.ui.notify("Bubble editor on", "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		state.reset();
		config = loadConfig(ctx.cwd);
		quota.debugDumpHeaders = !!config.debugDumpHeaders;
		quota.setProvider((ctx.model as { provider?: string } | undefined)?.provider);
		quota.startPolling();

		if (ctx.hasUI) {
			createHudFooter(pi, ctx, state, quota);

			// 配置启用气泡编辑器
			if (config.editor === "bubble" && !bubbleActive) {
				uninstallBubble = installBubbleEditor(pi, ctx, quota);
				bubbleActive = true;
			}
		}
	});

	pi.on("session_shutdown", async () => {
		quota.stopPolling();
		uninstallBubble?.();
		uninstallBubble = undefined;
		bubbleActive = false;
	});
}

// 为插件作者 re-export 类型
export type { HudPlugin, HudContext, HudTheme } from "./hud-footer.ts";
