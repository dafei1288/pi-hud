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
import { formatWindowLabel } from "../extensions/agent-hud/layout.ts";
import { findPlanProvider, QuotaService } from "../extensions/agent-hud/quota.ts";
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
function makeCtx(cwd: string, ui: unknown, provider = "anthropic"): HudCtx {
	const base = {
		cwd,
		hasUI: true,
		model: { id: "claude-test", provider, reasoning: false },
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

// ---------------------------------------------------------------------------
// 场景 2b: omp 配额行 — 费用/余额/5h/周/月 单独成行(经典单列模式,quotaRow 自动开启)
// ---------------------------------------------------------------------------

{
	const cwd = mkdtempSync(join(tmpdir(), "hud-sim-omp-quota-"));
	setDetectedRuntime("omp");

	// HOME 指向空临时目录:resolveKey 找不到 key,quota 轮询不触网
	const savedHome = process.env.HOME;
	const savedProfile = process.env.USERPROFILE;
	process.env.HOME = cwd;
	process.env.USERPROFILE = cwd;
	try {
		const statuses = new Map<string, string>();
		const theme = { fg: (_color: string, text: string) => text };
		const ui = {
			setFooter: () => {},
			setStatus(key: string, text: string | undefined): void {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			theme,
		};

		const api = makeApi(makeHandlers());
		const entries: FakeSessionEntry[] = [
			{ type: "message", message: { role: "assistant", usage: { input: 1000, output: 500, cost: { total: 0.042 } } } },
		];
		const ctx = {
			...makeCtx(cwd, ui, "zhipu-coding-plan"),
			sessionManager: { getCwd: () => cwd, getEntries: () => entries },
		} as HudCtx;

		const state = new SessionState();
		seedState(state);
		const quota = new QuotaService();
		quota.setProvider("zhipu-coding-plan"); // 先定 provider,再种数据(同 provider 下 render 不再清空)
		quota.planUsage = {
			source: "zhipu-coding-plan",
			fiveHour: { usedPercent: 42, windowMinutes: 300, resetAt: Date.now() + 2 * 3600_000 },
			weekly: { usedPercent: 18, windowMinutes: 7 * 24 * 60, resetAt: Date.now() + 3 * 86400_000 },
			monthly: { usedPercent: 12, windowMinutes: 30 * 24 * 60, resetAt: Date.now() + 12 * 86400_000 },
			capturedAt: Date.now(),
		};
		quota.balanceInfo = { provider: "zhipu-coding-plan", label: "¥12.50", value: 12.5, currency: "CNY", capturedAt: Date.now() };

		createHudFooter(api, ctx, state, quota);

		const rows = [...statuses.keys()]
			.sort((a, b) => Number(a.slice("hud-row-".length)) - Number(b.slice("hud-row-".length)))
			.map((k) => stripMarkup(statuses.get(k) ?? ""));
		check("omp-quota: 输出 ≥3 行", rows.length >= 3, `got ${rows.length}`);
		const quotaRow = rows[1] ?? "";
		check("omp-quota: 配额行含费用 $0.042", quotaRow.includes("$0.042"), quotaRow);
		check("omp-quota: 配额行含余额 💰 ¥12.50", quotaRow.includes("💰 ¥12.50"), quotaRow);
		check("omp-quota: 配额行含 5h 用量", /⏳5h 42%/.test(quotaRow), quotaRow);
		check("omp-quota: 配额行含周用量", /📅wk 18%/.test(quotaRow), quotaRow);
		check("omp-quota: 配额行含月用量", /🗓mo 12%/.test(quotaRow), quotaRow);
		check("omp-quota: 统计行不含余额/用量", !/💰|⏳5h|📅wk|🗓mo/.test(rows[2] ?? ""));
		check("omp-quota: 配额行不含工具统计", !quotaRow.includes("Grep"));
		check("omp-quota: Line1 不含费用(已抽出)", !(rows[0] ?? "").includes("$0.042"));
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = savedProfile;
	}
}

// ---------------------------------------------------------------------------
// 场景 3: GLM Coding Plan — zhipu-coding-plan 匹配 + 月度窗口解析与渲染
// ---------------------------------------------------------------------------

{
	setDetectedRuntime("pi");
	const cwd = mkdtempSync(join(tmpdir(), "hud-sim-glm-"));

	// 3a. provider id 匹配：omp 的 GLM Coding Plan provider 是 zhipu-coding-plan
	const glmSpec = findPlanProvider("zhipu-coding-plan");
	check("glm: zhipu-coding-plan 命中 GLM 配额 spec", glmSpec?.url.includes("open.bigmodel.cn") === true);
	check("glm: zai-coding-cn 命中同一 spec", findPlanProvider("zai-coding-cn") === glmSpec);

	// 3b. 真实响应形状（2026-09 实测）：TIME_LIMIT 月窗 + TOKENS_LIMIT 5h/周窗
	const realJson = {
		data: {
			limits: [
				{ type: "TIME_LIMIT", unit: 5, number: 1, usage: 1000, currentValue: 30, remaining: 970, percentage: 3, nextResetTime: 1789880030997 },
				{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1, nextResetTime: 1788633382470 },
				{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 1, nextResetTime: 1789188830998 },
			],
		},
	};
	const parsed = glmSpec?.parse(realJson);
	check("glm: 解析出 5h 窗口", parsed?.fiveHour?.windowMinutes === 300 && parsed?.fiveHour?.usedPercent === 1);
	check("glm: 解析出周窗口（1 周）", parsed?.weekly?.windowMinutes === 7 * 24 * 60);
	check(
		"glm: 解析出月度窗口",
		parsed?.monthly?.windowMinutes === 30 * 24 * 60
			&& parsed?.monthly?.usedPercent === 3
			&& parsed?.monthly?.resetAt === 1789880030997,
	);
	check("glm: formatWindowLabel 月窗 → mo", formatWindowLabel(30 * 24 * 60) === "mo");
	check("glm: formatWindowLabel 周窗仍为 wk", formatWindowLabel(7 * 24 * 60) === "wk");

	// 3c. HUD 渲染三个窗口。HOME 指向空临时目录：resolveKey 找不到 key，测试不触网。
	const savedHome = process.env.HOME;
	const savedProfile = process.env.USERPROFILE;
	process.env.HOME = cwd;
	process.env.USERPROFILE = cwd;
	try {
		let captured: FakeFooterComponent | undefined;
		const theme = { fg: (_color: string, text: string) => text };
		const tui = { requestRender: () => {} };
		const footerData = { getGitBranch: () => "main", onBranchChange: () => () => {} };
		const ui = {
			setFooter(factory: (t: unknown, th: unknown, fd: unknown) => FakeFooterComponent): void {
				captured = factory(tui, theme, footerData) as FakeFooterComponent;
			},
		};

		const api = makeApi(makeHandlers());
		const ctx = makeCtx(cwd, ui, "zhipu-coding-plan");
		const state = new SessionState();
		seedState(state);
		const quota = new QuotaService();
		quota.setProvider("zhipu-coding-plan");
		quota.planUsage = {
			source: "zhipu-coding-plan",
			fiveHour: { usedPercent: 42, windowMinutes: 300, resetAt: Date.now() + 2 * 3600_000 },
			weekly: { usedPercent: 18, windowMinutes: 7 * 24 * 60, resetAt: Date.now() + 3 * 86400_000 },
			monthly: { usedPercent: 12, windowMinutes: 30 * 24 * 60, resetAt: Date.now() + 12 * 86400_000 },
			capturedAt: Date.now(),
		};

		createHudFooter(api, ctx, state, quota);
		check("glm: setFooter 捕获到组件", captured !== undefined);
		if (!captured) process.exit(1);
		const joined = captured.render(200).map(stripMarkup).join("\n");
		check("glm: HUD 显示 5h 用量", /⏳5h 42%/.test(joined), joined.slice(0, 200));
		check("glm: HUD 显示周用量", /📅wk 18%/.test(joined));
		check("glm: HUD 显示月用量", /🗓mo 12%/.test(joined));
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = savedProfile;
	}
}

setDetectedRuntime(null);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
