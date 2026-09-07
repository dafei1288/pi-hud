/**
 * quota.ts — LLM 计费/额度共享服务
 *
 * 唯一数据源（single source of truth）：
 *  - 编码计划（订阅）配额：5h / 每周 / 每月窗口（GLM / MiniMax / Kimi / Codex / Claude）
 *  - 按量付费余额（DeepSeek 等）
 *  - Provider 响应头里的 rate limit（Anthropic / OpenAI）
 *
 * hud-footer 和 bubble-editor 都只读取本服务，不各自发请求。
 *
 * 新增一个 provider = 在 PLAN_PROVIDERS / BALANCE_PROVIDERS 加一条声明式记录。
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentConfigRoot, agentConfigRoots } from "./runtime.ts";

// ============================================================================
// 类型
// ============================================================================

/** 从 provider 响应头解析出的 rate limit 信息 */
export interface RateLimitInfo {
	provider: string;
	tokenRemaining: number;
	tokenLimit: number;
	requestRemaining: number;
	requestLimit: number;
	tokenResetAt?: number;
	requestResetAt?: number;
	capturedAt: number;
}

/** 一个编码计划配额窗口（如 5 小时或每周）的使用情况 */
export interface PlanWindowUsage {
	/** 已用百分比 0-100 */
	usedPercent: number;
	/** 窗口长度（分钟），服务器报告时才有 */
	windowMinutes?: number;
	/** 窗口重置时间（Unix ms），服务器报告时才有 */
	resetAt?: number;
}

/** 编码计划（订阅）配额使用，解析自响应头或轮询接口 */
export interface PlanUsageInfo {
	/** 来源："codex" | "anthropic" | provider id */
	source: string;
	fiveHour?: PlanWindowUsage;
	weekly?: PlanWindowUsage;
	/** 月度窗口（GLM Coding Plan 的 TIME_LIMIT，按月工具/次数配额） */
	monthly?: PlanWindowUsage;
	capturedAt: number;
}

/** 按量付费 API 账户余额 */
export interface BalanceInfo {
	provider: string;
	/** 展示标签（如 "¥12.50"） */
	label: string;
	/** 原始数值，用于颜色阈值 */
	value: number;
	currency: string;
	capturedAt: number;
}

/** 编码计划配额 provider 的声明式描述 */
export interface PlanProviderSpec {
	/** pi provider id(s)（ctx.model.provider） */
	providers: string[];
	/** 依次尝试的环境变量 */
	envKeys: string[];
	/** 环境变量之后在 ~/.pi/agent/auth.json 里尝试的名字 */
	authNames: string[];
	/**
	 * 最后在 ~/.pi/agent/models.json 的 providers.{id}.apiKey 里尝试。
	 * Kimi 这类把 key 存在 models.json 的 provider 需要。
	 */
	modelsJsonProvider?: string;
	url: string;
	headers: (key: string) => Record<string, string>;
	/** 归一化响应 JSON → 5h/weekly/monthly 窗口；undefined = 无可用数据 */
	parse: (json: unknown) => { fiveHour?: PlanWindowUsage; weekly?: PlanWindowUsage; monthly?: PlanWindowUsage } | undefined;
}

/** 余额 provider 的声明式描述 */
export interface BalanceProviderSpec {
	providers: string[];
	envKeys: string[];
	authNames: string[];
	modelsJsonProvider?: string;
	url: string;
	headers: (key: string) => Record<string, string>;
	parse: (json: unknown) => BalanceInfo | undefined;
}

// ============================================================================
// 响应头解析辅助
// ============================================================================

/** 解析 reset 头：epoch 秒/毫秒或 ISO 日期串 → Unix ms */
export function parseResetHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number(value);
	if (Number.isFinite(n) && n > 0) {
		return n < 1e12 ? n * 1000 : n; // epoch 秒 vs 毫秒
	}
	const t = Date.parse(value);
	return Number.isNaN(t) ? undefined : t;
}

/** 解析 utilization 头：小数 (0-1) 或百分数 (0-100) → 百分数 */
export function parseUtilizationHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0) return undefined;
	return n <= 1 ? n * 100 : n;
}

/** 大小写不敏感的头查找 */
export function getHeader(headers: Record<string, string>, name: string): string | undefined {
	if (headers[name] !== undefined) return headers[name];
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) return headers[key];
	}
	return undefined;
}

/** 把 unknown JSON 收窄成可索引对象；非对象（含数组/null）返回 undefined。轮询响应形状由各 provider 自行探测。 */
function asRecord(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** 数值字段宽松转换（接口可能返回字符串数字）；无法解析 → undefined */
function num(v: unknown): number | undefined {
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

/** Kimi 窗口时长 + 时间单位 → 分钟数（如 300 MINUTES = 5h、7 DAYS = 1 周） */
function toMinutes(dur: number | undefined, unit: string | undefined): number | undefined {
	if (dur == null) return undefined;
	const u = (unit || "").toUpperCase();
	if (u.includes("DAY")) return dur * 1440;
	if (u.includes("HOUR")) return dur * 60;
	return dur; // MINUTES（默认）
}

// ============================================================================
// API key 解析：env → auth.json → models.json
// ============================================================================

function resolveKey(spec: { envKeys: string[]; authNames: string[]; modelsJsonProvider?: string }): string | undefined {
	for (const env of spec.envKeys) {
		if (process.env[env]) return process.env[env];
	}
	// ~/.omp/agent 与 ~/.pi/agent 都试（本运行时目录靠前）；任一目录命中即返回。
	for (const root of agentConfigRoots()) {
		try {
			const auth = JSON.parse(readFileSync(join(root, "auth.json"), "utf8"));
			for (const name of spec.authNames) {
				const entry = auth[name];
				if (entry?.type === "api_key" && entry.key) return entry.key;
			}
		} catch { /* ignore */ }
	}
	if (spec.modelsJsonProvider) {
		for (const root of agentConfigRoots()) {
			try {
				const models = JSON.parse(readFileSync(join(root, "models.json"), "utf8"));
				const key = models?.providers?.[spec.modelsJsonProvider]?.apiKey;
				if (typeof key === "string" && key) return key;
			} catch { /* ignore */ }
		}
	}
	return undefined;
}

// ============================================================================
// 编码计划配额 provider 注册表
// ============================================================================

export const PLAN_PROVIDERS: PlanProviderSpec[] = [

	{
		// GLM Coding Plan (智谱国内版): GET /api/monitor/usage/quota/limit
		// TOKENS_LIMIT: unit 3 = 小时窗（number = 小时数, e.g. 5h）、unit 6 = 周窗（number = 周数, e.g. 1 周）
		// TIME_LIMIT: unit 5 = 月窗（number = 月数）——search/zread 等工具的月度次数配额
		// provider id：pi 内置为 zai-coding-cn；omp 的 GLM Coding Plan 为 zhipu-coding-plan
		providers: ["zai-coding-cn", "zhipu-coding-plan"],
		envKeys: ["ZAI_CODING_CN_API_KEY", "ZHIPU_CODING_PLAN_API_KEY"],
		authNames: ["zai-coding-cn", "zhipu-coding-plan"],
		url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			const limits = asRecord(asRecord(json)?.data)?.limits;
			if (!Array.isArray(limits)) return undefined;
			let fiveHour: PlanWindowUsage | undefined;
			let weekly: PlanWindowUsage | undefined;
			let monthly: PlanWindowUsage | undefined;
			for (const item of limits) {
				const l = asRecord(item);
				if (!l) continue;
				const w: PlanWindowUsage = {
					usedPercent: typeof l.percentage === "number" ? l.percentage : 0,
					resetAt: typeof l.nextResetTime === "number" ? l.nextResetTime : undefined,
				};
				const number = typeof l.number === "number" ? l.number : undefined;
				if (l.type === "TOKENS_LIMIT" && l.unit === 3) {
					fiveHour = { ...w, windowMinutes: (number || 5) * 60 };
				} else if (l.type === "TOKENS_LIMIT" && l.unit === 6) {
					weekly = { ...w, windowMinutes: (number || 1) * 7 * 24 * 60 };
				} else if (l.type === "TIME_LIMIT" && l.unit === 5) {
					monthly = { ...w, windowMinutes: (number || 1) * 30 * 24 * 60 };
				}
			}
			return fiveHour || weekly || monthly ? { fiveHour, weekly, monthly } : undefined;
		},
	},
	{
		// MiniMax Coding Plan: GET /v1/api/openplatform/coding_plan/remains
		// 用 "general" 模型条目：current_interval = 5h 窗口，current_weekly = 每周窗口。
		// 百分比是【剩余】，转换为已用。
		providers: ["minimax", "minimax-cn"],
		envKeys: ["MINIMAX_API_KEY", "MINIMAX_CN_API_KEY"],
		authNames: ["minimax", "minimax-cn"],
		url: "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			const remains = asRecord(json)?.model_remains;
			if (!Array.isArray(remains)) return undefined;
			const general = asRecord(remains.find((m) => asRecord(m)?.model_name === "general")) ?? asRecord(remains[0]);
			if (!general) return undefined;
			const intervalPct = general.current_interval_remaining_percent;
			const fiveHour: PlanWindowUsage | undefined = typeof intervalPct === "number" ? {
				usedPercent: 100 - intervalPct,
				windowMinutes: 300,
				resetAt: typeof general.end_time === "number" ? general.end_time : undefined,
			} : undefined;
			const weeklyPct = general.current_weekly_remaining_percent;
			const weekly: PlanWindowUsage | undefined = typeof weeklyPct === "number" ? {
				usedPercent: 100 - weeklyPct,
				windowMinutes: 7 * 24 * 60,
				resetAt: typeof general.weekly_end_time === "number" ? general.weekly_end_time : undefined,
			} : undefined;
			return fiveHour || weekly ? { fiveHour, weekly } : undefined;
		},
	},
	{
		// Kimi Coding Plan: GET /coding/v1/usages
		// 顶层 `usage` = 每周汇总；limits[] 携带各窗口明细，
		// window.duration+timeUnit 标识窗口（300 MINUTES = 5h）。
		// 数值字段可能是字符串；resetTime 是 ISO8601。
		providers: ["kimi"],
		envKeys: ["KIMI_CODE_API_KEY", "KIMI_API_KEY"],
		authNames: ["kimi"],
		modelsJsonProvider: "kimi",
		url: "https://api.kimi.com/coding/v1/usages",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			const row = (d: Record<string, unknown> | undefined): PlanWindowUsage | undefined => {
				if (!d) return undefined;
				const limit = num(d.limit);
				const used = num(d.used)
					?? (limit != null ? (() => { const r = num(d.remaining); return r != null ? Math.max(0, limit - r) : undefined; })() : undefined);
				if (used == null && limit == null) return undefined;
				const resetRaw = d.reset_at ?? d.resetAt ?? d.reset_time ?? d.resetTime;
				const resetAt = typeof resetRaw === "string" ? (Date.parse(resetRaw) || undefined)
					: typeof resetRaw === "number" ? (Number.isFinite(resetRaw) ? resetRaw : undefined) : undefined;
				const usedPercent = limit && limit > 0 ? ((used ?? 0) / limit) * 100 : 0;
				return { usedPercent, resetAt };
			};
			let fiveHour: PlanWindowUsage | undefined;
			let weekly: PlanWindowUsage | undefined;
			const topUsage = row(asRecord(asRecord(json)?.usage));
			if (topUsage) weekly = { ...topUsage, windowMinutes: 7 * 24 * 60 };
			const limits = asRecord(json)?.limits;
			if (Array.isArray(limits)) {
				for (const item of limits) {
					const it = asRecord(item);
					const w = row(asRecord(it?.detail) ?? it);
					if (!w || !it) continue;
					const window = asRecord(it.window);
					const duration = window?.duration ?? it.duration;
					const timeUnit = window?.timeUnit ?? it.timeUnit;
					const mins = toMinutes(
						typeof duration === "number" ? duration : undefined,
						typeof timeUnit === "string" ? timeUnit : undefined,
					);
					if (mins && mins <= 24 * 60) {
						fiveHour ??= { ...w, windowMinutes: mins };
					} else {
						weekly ??= { ...w, windowMinutes: mins ?? 7 * 24 * 60 };
					}
				}
			}
			return fiveHour || weekly ? { fiveHour, weekly } : undefined;
		},
	},
];

// ============================================================================
// 余额 provider 注册表（按量付费 API 账户）
// ============================================================================

export const BALANCE_PROVIDERS: BalanceProviderSpec[] = [
	{
		// DeepSeek: GET /user/balance
		// Returns { is_available, balance_infos: [{ currency, total_balance, ... }] }
		providers: ["deepseek"],
		envKeys: ["DEEPSEEK_API_KEY"],
		authNames: ["deepseek"],
		url: "https://api.deepseek.com/user/balance",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			const root = asRecord(json);
			if (!root?.is_available) return undefined;
			const infos = root.balance_infos;
			const info = Array.isArray(infos) ? asRecord(infos[0]) : undefined;
			if (!info) return undefined;
			const total = typeof info.total_balance === "string" ? parseFloat(info.total_balance) : NaN;
			if (isNaN(total)) return undefined;
			const currencyRaw = typeof info.currency === "string" ? info.currency : "";
			const currency = currencyRaw === "CNY" ? "¥" : currencyRaw === "USD" ? "$" : currencyRaw;
			return {
				provider: "deepseek",
				label: `${currency}${total.toFixed(2)}`,
				value: total,
				currency: currencyRaw,
				capturedAt: Date.now(),
			};
		},
	},
];

/** 查找处理某个 pi provider id 的配额 spec */
export function findPlanProvider(provider: string | undefined): PlanProviderSpec | undefined {
	return provider ? PLAN_PROVIDERS.find((p) => p.providers.includes(provider)) : undefined;
}

/** 查找处理某个 pi provider id 的余额 spec */
export function findBalanceProvider(provider: string | undefined): BalanceProviderSpec | undefined {
	return provider ? BALANCE_PROVIDERS.find((p) => p.providers.includes(provider)) : undefined;
}

async function pollPlanProvider(spec: PlanProviderSpec): Promise<PlanUsageInfo | undefined> {
	const key = resolveKey(spec);
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
	} catch { /* 网络请求尽力而为 */ }
	return undefined;
}

async function pollBalanceProvider(spec: BalanceProviderSpec): Promise<BalanceInfo | undefined> {
	const key = resolveKey(spec);
	if (!key) return undefined;
	try {
		const res = await fetch(spec.url, {
			headers: spec.headers(key),
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return undefined;
		return spec.parse(await res.json());
	} catch { /* 网络请求尽力而为 */ }
	return undefined;
}

// ============================================================================
// QuotaService — 共享轮询 + 响应头解析 + 变更订阅
// ============================================================================

const POLL_INTERVAL_MS = 5 * 60_000;
const STALE_MS = 5 * 60_000;

export class QuotaService {
	rateLimitInfo: RateLimitInfo | undefined;
	planUsage: PlanUsageInfo | undefined;
	balanceInfo: BalanceInfo | undefined;

	/** 是否 dump rate-limit 响应头（由 config.debugDumpHeaders 设置） */
	debugDumpHeaders = false;

	private provider: string | undefined;
	private planPollInFlight = false;
	private balancePollInFlight = false;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private listeners = new Set<() => void>();

	/** 订阅数据变更（用于触发 UI 重绘）。返回退订函数。 */
	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => { this.listeners.delete(cb); };
	}

	private notify(): void {
		for (const cb of this.listeners) {
			try { cb(); } catch { /* 忽略订阅者错误 */ }
		}
	}

	get currentProvider(): string | undefined {
		return this.provider;
	}

	/** 切换 provider：丢弃旧数据并立即拉取新数据。provider 不变时是 no-op。 */
	setProvider(provider: string | undefined): void {
		if (provider === this.provider) return;
		this.provider = provider;
		this.planUsage = undefined;
		this.balanceInfo = undefined;
		this.notify();
		this.maybePoll(true);
	}

	/** 数据过期（>5min）时轮询配额/余额接口。render 里可放心每次调用。 */
	maybePoll(force = false): void {
		const provider = this.provider;

		const planSpec = findPlanProvider(provider);
		if (planSpec) {
			const stale = force
				|| !this.planUsage
				|| this.planUsage.source !== provider
				|| Date.now() - this.planUsage.capturedAt > STALE_MS;
			if (stale && !this.planPollInFlight) {
				this.planPollInFlight = true;
				pollPlanProvider(planSpec).then((info) => {
					if (info && this.provider && findPlanProvider(this.provider)) {
						this.planUsage = { ...info, source: this.provider };
						this.notify();
					}
				}).finally(() => { this.planPollInFlight = false; });
			}
		}

		const balSpec = findBalanceProvider(provider);
		if (balSpec) {
			const stale = force
				|| !this.balanceInfo
				|| this.balanceInfo.provider !== provider
				|| Date.now() - this.balanceInfo.capturedAt > STALE_MS;
			if (stale && !this.balancePollInFlight) {
				this.balancePollInFlight = true;
				pollBalanceProvider(balSpec).then((info) => {
					if (info && this.provider && findBalanceProvider(this.provider)) {
						this.balanceInfo = info;
						this.notify();
					}
				}).finally(() => { this.balancePollInFlight = false; });
			}
		}
	}

	/** 启动 5 分钟定时轮询（保持 idle 时数据新鲜） */
	startPolling(): void {
		if (this.pollTimer) return;
		this.pollTimer = setInterval(() => this.maybePoll(true), POLL_INTERVAL_MS);
	}

	stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	/**
	 * 处理 after_provider_response 的响应头：
	 * rate limit（Anthropic/OpenAI）+ 订阅配额窗口（Codex/Claude OAuth）。
	 */
	handleProviderHeaders(headers: Record<string, string> | undefined, status: number): void {
		// Debug: dump rate-limit 相关头用于发现新字段（写到本运行时的 agent 目录）
		if (headers && (this.debugDumpHeaders || process.env.PI_HUD_DEBUG_HEADERS)) {
			try {
				const dir = agentConfigRoot();
				mkdirSync(dir, { recursive: true });
				appendFileSync(
					join(dir, "pi-agent-hud-headers.jsonl"),
					JSON.stringify({ ts: new Date().toISOString(), status, headers }) + "\n",
				);
			} catch { /* 尽力而为的调试日志 */ }
		}

		if (!headers || status >= 400) return;
		let changed = false;

		const isAnthropic = !!getHeader(headers, "anthropic-ratelimit-tokens-limit");
		const isOpenAI = !isAnthropic && !!getHeader(headers, "x-ratelimit-limit-tokens");

		if (isAnthropic) {
			const tokenLimit = parseInt(getHeader(headers, "anthropic-ratelimit-tokens-limit") || "0", 10);
			const tokenRemaining = parseInt(getHeader(headers, "anthropic-ratelimit-tokens-remaining") || "0", 10);
			const requestLimit = parseInt(getHeader(headers, "anthropic-ratelimit-requests-limit") || "0", 10);
			const requestRemaining = parseInt(getHeader(headers, "anthropic-ratelimit-requests-remaining") || "0", 10);
			if (tokenLimit > 0 || requestLimit > 0) {
				this.rateLimitInfo = { provider: "anthropic", tokenRemaining, tokenLimit, requestRemaining, requestLimit, capturedAt: Date.now() };
				changed = true;
			}
		} else if (isOpenAI) {
			const tokenLimit = parseInt(getHeader(headers, "x-ratelimit-limit-tokens") || "0", 10);
			const tokenRemaining = parseInt(getHeader(headers, "x-ratelimit-remaining-tokens") || "0", 10);
			const requestLimit = parseInt(getHeader(headers, "x-ratelimit-limit-requests") || "0", 10);
			const requestRemaining = parseInt(getHeader(headers, "x-ratelimit-remaining-requests") || "0", 10);
			if (tokenLimit > 0 || requestLimit > 0) {
				this.rateLimitInfo = { provider: "openai", tokenRemaining, tokenLimit, requestRemaining, requestLimit, capturedAt: Date.now() };
				changed = true;
			}
		}

		// ---- 编码计划（订阅）配额窗口：5h / 每周 ----
		// Codex via ChatGPT OAuth: x-codex-primary-* (~5h) 和 x-codex-secondary-* (weekly)
		const codexPrimaryUsed = parseUtilizationHeader(getHeader(headers, "x-codex-primary-used-percent"));
		const codexSecondaryUsed = parseUtilizationHeader(getHeader(headers, "x-codex-secondary-used-percent"));
		if (codexPrimaryUsed !== undefined || codexSecondaryUsed !== undefined) {
			this.planUsage = {
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
			changed = true;
		} else {
			// Claude 订阅 (OAuth): anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}
			const a5h = parseUtilizationHeader(getHeader(headers, "anthropic-ratelimit-unified-5h-utilization"));
			const a7d = parseUtilizationHeader(getHeader(headers, "anthropic-ratelimit-unified-7d-utilization"));
			if (a5h !== undefined || a7d !== undefined) {
				this.planUsage = {
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
				changed = true;
			}
		}

		if (changed) this.notify();
	}
}
