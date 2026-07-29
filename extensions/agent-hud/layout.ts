/**
 * layout.ts — 纯渲染辅助函数 + 网格布局引擎
 *
 * 不依赖 pi 扩展 API，只依赖 pi-tui 的宽度/截断工具。
 * 被 hud-footer / bubble-editor / overlay 共同使用。
 */

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/** 最小主题接口（hud-footer 的 HudTheme 与之结构一致） */
export interface FgTheme {
	fg(color: "text" | "dim" | "accent" | "success" | "warning" | "error", text: string): string;
}

// ============================================================================
// 格式化
// ============================================================================

export function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}

export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 窗口长度（分钟）→ 人类标签: 300 → "5h", 10080 → "wk" */
export function formatWindowLabel(minutes: number): string {
	if (minutes % (7 * 24 * 60) === 0) return "wk";
	if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

/** 距离重置时间戳的倒计时: "2h15m", "3d4h", 过期则 "now" */
export function formatResetCountdown(resetAt: number): string {
	const ms = resetAt - Date.now();
	if (ms <= 0) return "now";
	const d = Math.floor(ms / 86_400_000);
	if (d >= 1) return `${d}d${Math.floor((ms % 86_400_000) / 3_600_000)}h`;
	return formatDuration(ms);
}

// ============================================================================
// 绘制
// ============================================================================

export function progressBar(percent: number, barWidth: number): string {
	const filled = Math.round((percent / 100) * barWidth);
	const empty = barWidth - filled;
	return `[${"█".repeat(Math.max(0, filled))}${"░".repeat(Math.max(0, empty))}]`;
}

export function ctxColor(theme: FgTheme, pct: number, text: string): string {
	if (pct > 90) return theme.fg("error", text);
	if (pct > 70) return theme.fg("warning", text);
	return theme.fg("success", text);
}

/** 用空格补齐到目标视觉宽度（CJK 感知） */
export function padToWidth(text: string, targetWidth: number): string {
	const vw = visibleWidth(text);
	const gap = targetWidth - vw;
	return gap > 0 ? text + " ".repeat(gap) : text;
}

/** 去除 ANSI 转义序列后的可见长度 */
export function ansiVisibleLen(s: string): number {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b[^\x1b]*\x07/g, "").length;
}

// ============================================================================
// 网格布局
// ============================================================================

/**
 * 一个可渲染单元 —— 内置元素或插件。
 * 为单个格子产出一段带样式的文本。
 */
export interface CellItem {
	/** placement 查找用的唯一 key */
	key: string;
	/** 默认目标行（0 起） */
	defaultLine: number;
	/** 行内排序 */
	order: number;
	/** 显式列（来自插件或 placement），undefined = 自动分配 */
	fixedCol: number | undefined;
	/** 渲染该格内容 */
	render(): string | undefined;
}

/**
 * 把一组格子渲染成输出行。
 *
 * @param layout    每行列数，例如 [1, 2, 2]
 * @param cellItems 待分配的格子
 * @param totalWidth 终端宽度
 * @param sep       列分隔符（ANSI 安全）
 */
export function renderGrid(
	layout: number[],
	cellItems: CellItem[],
	totalWidth: number,
	sep: string,
): string[] {
	const numCols = layout.reduce((a, b) => Math.max(a, b), 0);
	const sepW = visibleWidth(sep);
	// 每列等宽；分隔符占列间空间
	const colW = Math.floor((totalWidth - (numCols - 1) * sepW) / numCols);

	// grid[line][col] = 渲染内容或 ""
	const grid: string[][] = [];
	for (let i = 0; i < layout.length; i++) {
		grid.push(new Array(layout[i]).fill(""));
	}

	const occupied = new Set<string>();
	const cellKey = (line: number, col: number) => `${line}:${col}`;

	// 第一遍：有固定位置的
	for (const item of cellItems) {
		const place = item.fixedCol;
		if (place === undefined) continue;

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

	// 第二遍：自动分配剩余的
	for (const item of cellItems) {
		if (item.fixedCol !== undefined) continue;

		const content = item.render();
		if (content == null) continue;

		let targetLine = item.defaultLine;
		if (targetLine >= layout.length) targetLine = layout.length - 1;

		let placed = false;
		for (let l = targetLine; l < layout.length && !placed; l++) {
			for (let c = 0; c < layout[l] && !placed; c++) {
				if (!occupied.has(cellKey(l, c))) {
					const availW = layout[l] === 1 ? totalWidth : colW;
					const truncated = truncateToWidth(content, availW, "…");
					grid[l][c] = layout[l] === 1 ? padToWidth(truncated, totalWidth) : padToWidth(truncated, colW);
					occupied.add(cellKey(l, c));
					placed = true;
				}
			}
		}

		// 全部满了就追加到最后一行最后一格
		if (!placed) {
			const lastLine = layout.length - 1;
			const lastCol = layout[lastLine] - 1;
			const existing = grid[lastLine][lastCol];
			const availW = layout[lastLine] === 1 ? totalWidth : colW;
			const combined = existing ? existing + " · " + content : content;
			grid[lastLine][lastCol] = truncateToWidth(padToWidth(combined, availW), availW, "…");
		}
	}

	// 渲染每一行
	const lines: string[] = [];
	for (let l = 0; l < layout.length; l++) {
		const cols = layout[l];
		if (cols === 1) {
			const raw = grid[l][0] || "";
			lines.push(truncateToWidth(padToWidth(raw, totalWidth), totalWidth));
		} else {
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
