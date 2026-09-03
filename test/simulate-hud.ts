/**
 * test/simulate-hud.ts — HUD 双运行时行为仿真。
 *
 * 用法: bun --preload ./test/preload-hud-stubs.ts test/simulate-hud.ts
 * (exit 0 = 全过)。不触网、不碰真实会话、不加载 bubble/overlay（它们依赖真实
 * CustomEditor/TUI 组件，属于端到端面，由真机验证）。
 *
 * 验证两条交付路径共用一个渲染体：
 *   - pi : ctx.ui.setFooter 捕获到组件，render(width) 产出各行；
 *   - omp: ctx.ui.setStatus 收到 hud-row-N 行（组件行被推到内建状态栏）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHudFooter } from "../extensions/agent-hud/hud-footer.ts";
import { QuotaService } from "../extensions/agent-hud/quota.ts";
import { setDetectedRuntime } from "../extensions/agent-hud/runtime.ts";
import { SessionState } from "../extensions/agent-hud/state.ts";

type HudApi = Parameters<typeof createHudFooter>[0];
type HudCtx = Parameters<typeof createHudFooter>[1];

// ---------------------------------------------------------------------------
// 迷你 fake 运行时
// ---------------------------------------------------------------------------

interface FakeFooterComponent {
	render(width: number): string[];
	dispose(): void;
	invalidate(): void;
}

interface FakeSessionEntry {
	type: string;
	message?: { role: string; content?: unknown; usage?: unknown };
}

function makeSessionEntries(): FakeSessionEntry[] {
	return [];
}

/** 事件处理器注册表（pi.on 的最小面）。 */
function makeHandlers(): Map<string, Array<(event: unknown, ctx?: unknown) => unknown>> {
	return new Map();
}

function emit(handlers: Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>, name: string): void {
	for (const handler of handlers.get(name) ?? []) void handler({}, undefined);
}

/** 共享的 ExtensionAPI 假面（渲染用到的最小方法集）。 */
function makeApi(handlers: ReturnType<typeof makeHandlers>): HudApi {
	return {
		on(event: string, handler: (event: unknown, ctx?: unknown) => unknown): void {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getAllTools: () => [],
		getCommands: () => [],
		getThinkingLevel: () => undefined,
	} as HudApi;
}

/** 共享的 ExtensionContext 假面（渲染用到的最小字段）。 */
function makeCtx(cwd: string, ui: unknown): HudCtx {
	const base = {
		cwd,
		hasUI: true,
		model: { id: "claude-test", provider: "anthropic", reasoning: false },
		getContextUsage: () => ({ percent: 39 }),
		sessionManager: {
			getCwd: () => cwd,
			getEntries: (): FakeSessionEntry[] => makeSessionEntries(),
		},
	};
	return { ...base, ui } as HudCtx;
}

function seedState(state: SessionState): void {
	state.toolCounts.set("Grep", 2);
	state.toolCounts.set("Bash", 1);
	state.runningTools.set("tool-1", { name: "Edit", startTime: Date.now() - 12_000 });
	state.lastUserInput = "how to build a REST API with auth?";
	state.inputHistory.push("how to build a REST API with auth?", "check docs");
	state.turnCount = 3;
	state.planSteps = [{ text: "read project", done: true }, { text: "implement api", done: false }];
	state.agentEntries.push({ id: "agent-1", status: "running", startTime: Date.now() - 5_000 });
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) {
		console.log(`  ok - ${name}`);
	} else {
		failures += 1;
		console.error(`  FAIL - ${name}${detail ? ` (${detail})` : ""}`);
	}
}

function stripMarkup(text: string): string {
	return text.replace(/<[^>]*>/g, "");
}

// ---------------------------------------------------------------------------
// 场景 1: pi 运行时 — setFooter 捕获组件,render 产出 3 行
// ---------------------------------------------------------------------------

{
	const cwd = mkdtempSync(join(tmpdir(), "hud-sim-pi-"));
	setDetectedRuntime("pi");

	let captured: FakeFooterComponent | undefined;
	const theme = { fg: (_color: string, text: string) => text };
	const tui = { requestRender: () => {} };
	const footerData = { getGitBranch: () => "main", onBranchChange: () => () => {} };
	const ui = {
		setFooter(factory: (t: unknown, th: unknown, fd: unknown) => FakeFooterComponent): void {
			captured = factory(tui, theme, footerData) as FakeFooterComponent;
		},
	};

	const handlers = makeHandlers();
	const api = makeApi(handlers);
	const ctx = makeCtx(cwd, ui);
	const state = new SessionState();
	seedState(state);
	const quota = new QuotaService();

	createHudFooter(api, ctx, state, quota);

	check("pi: setFooter 捕获到组件", captured !== undefined);
	if (!captured) process.exit(1);

	const lines = captured.render(120).map(stripMarkup);
	const joined = lines.join("\n");
	check("pi: 输出 ≥2 行", lines.length >= 2, `got ${lines.length} line(s)`);
	check("pi: Line1 含 context 39%", /39%/.test(joined));
	check("pi: Line1 含 3 turn", joined.includes("3 turn"));
	check("pi: Line2 含 Grep ×2", joined.includes("Grep") && joined.includes("×2"));
	check("pi: Line3 含最近输入", lines.at(-1)?.includes("REST API") === true);
	check("pi: Line2 含运行中 Edit", joined.includes("Edit"));
}

// ---------------------------------------------------------------------------
// 场景 2: omp 运行时 — setFooter 是 noop,行被推到 setStatus(hud-row-N)
// ---------------------------------------------------------------------------

{
	const cwd = mkdtempSync(join(tmpdir(), "hud-sim-omp-"));
	setDetectedRuntime("omp");

	let capturedByFooter: unknown = undefined;
	const statuses = new Map<string, string>();
	const theme = { fg: (_color: string, text: string) => text };
	const ui = {
		setFooter: () => {
			capturedByFooter = "called"; // omp 下真实现是 noop;假面记下是否被调用(应为否)
		},
		setStatus(key: string, text: string | undefined): void {
			if (text === undefined) {
				statuses.delete(key);
			} else {
				statuses.set(key, text);
			}
		},
		theme,
	};

	const handlers = makeHandlers();
	const api = makeApi(handlers);
	const ctx = makeCtx(cwd, ui);
	const state = new SessionState();
	seedState(state);
	const quota = new QuotaService();

	createHudFooter(api, ctx, state, quota);

	check("omp: 未调用假 setFooter(真身 noop 语义)", capturedByFooter === undefined);
	const keys = [...statuses.keys()].sort();
	check("omp: 状态行键为 hud-row-N", keys.length >= 2 && keys.every((k) => /^hud-row-\d+$/.test(k)),
		`keys=${JSON.stringify(keys)}`);
	const joined = [...statuses.values()].join("\n");
	check("omp: 行内容含 context 39%", /39%/.test(joined));
	check("omp: 行内容含 Grep", joined.includes("Grep"));
	check("omp: 行内容含最近输入", joined.includes("REST API"));
	check("omp: 行内容含运行中 Edit", joined.includes("Edit"));

	// 触发 session_shutdown:清理应清空 hud-row 键
	emit(handlers, "session_shutdown");
	check("omp: shutdown 后状态行清空", statuses.size === 0, `leftover=${JSON.stringify([...statuses.keys()])}`);
}

setDetectedRuntime(null);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
