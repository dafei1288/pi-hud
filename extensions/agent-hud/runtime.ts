/**
 * runtime.ts — 双端运行时探测 + 配置目录
 *
 * pi (@earendil-works/pi-coding-agent 0.84.x) 与 omp (@oh-my-pi/pi-coding-agent
 * 18.x) 共享同一套扩展 API，但有两个差异影响 HUD：
 *   1. omp 交互模式的 ctx.ui.setFooter()/setHeader() 是 noop（HUD 状态栏改用
 *      ctx.ui.setStatus() 行实现）；pi 的 setFooter 有完整实现。
 *   2. 配置文件/凭证/插件目录不同：pi 用 ~/.pi/agent 与 .pi/，
 *      omp 用 ~/.omp/agent 与 .omp/。
 *
 * 本模块只判断当前跑在哪个运行时。启发式与用户现有 orca-agent-status.ts
 * 一致（进程名/argv 含 "omp"），并支持环境变量 PI_HUD_RUNTIME=pi|omp
 * 覆盖（测试与边界场景用）。
 */

import { join } from "node:path";

export type HudRuntime = "pi" | "omp";

let cachedRuntime: HudRuntime | null = null;

/** 当前宿主运行时："omp" 或 "pi"。 */
export function detectRuntime(): HudRuntime {
	if (cachedRuntime) return cachedRuntime;
	const override = (process.env.PI_HUD_RUNTIME || "").toLowerCase();
	if (override === "pi" || override === "omp") {
		cachedRuntime = override;
		return cachedRuntime;
	}
	const names = [
		process.title,
		process.env._,
		process.argv[1],
		process.argv[0],
		process.execPath,
	]
		.filter((v): v is string => typeof v === "string" && v.length > 0)
		.map((v) => v.split(/[\\/]/).pop()?.toLowerCase() ?? "");
	cachedRuntime = names.some((n) => n === "omp" || n.startsWith("omp.")) ? "omp" : "pi";
	return cachedRuntime;
}

/** 是否运行在 omp (@oh-my-pi) 上。 */
export function isOmpRuntime(): boolean {
	return detectRuntime() === "omp";
}

/** 仅供测试覆盖运行时分支（等价于 PI_HUD_RUNTIME 环境变量；传 null 清除）。 */
export function setDetectedRuntime(runtime: HudRuntime | null): void {
	cachedRuntime = runtime;
}

/** 用户级 agent 配置根目录：~/.pi/agent 或 ~/.omp/agent */
export function agentConfigRoot(runtime: HudRuntime = detectRuntime()): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return join(home, `.${runtime}`, "agent");
}

/**
 * 用户级 agent 目录候选（omp 优先，其次 pi）。
 * omp 上继续读 pi 目录是为了让已存在的 pi 配置/凭证无缝生效。
 */
export function agentConfigRoots(): string[] {
	return [agentConfigRoot("omp"), agentConfigRoot("pi")];
}

/** 项目级配置目录候选：<cwd>/.omp 优先，其次 <cwd>/.pi */
export function projectConfigRoots(cwd: string): string[] {
	return [join(cwd, ".omp"), join(cwd, ".pi")];
}
