/**
 * test/hud-stubs/pi-tui.ts — 仿真测试用 "@mariozechner/pi-tui" 最小替代。
 *
 * hud-footer/layout 运行期只用 truncateToWidth / visibleWidth 两个纯函数；
 * 用 bun plugin（test/preload-hud-stubs.ts）把该包名解析到本文件，
 * 避免测试进程引入真实的 pi-tui（双端 npm scope 不同）。
 */

function charWidth(ch: string): number {
	const code = ch.codePointAt(0) ?? 0;
	if (code === 0) return 0;
	// 宽字符近似：CJK / 全角符号 / 制表绘图符等（█░│… 等均在此）
	if (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
		|| (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
		|| (code >= 0xac00 && code <= 0xd7a3)
		|| (code >= 0xf900 && code <= 0xfaff)
		|| (code >= 0xfe10 && code <= 0xfe19)
		|| (code >= 0xfe30 && code <= 0xfe6f)
		|| (code >= 0xff00 && code <= 0xff60)
		|| (code >= 0xffe0 && code <= 0xffe6)
		|| (code >= 0x1f300 && code <= 0x1faff)
		|| (code >= 0x20000 && code <= 0x3fffd))) {
		return 2;
	}
	return 1;
}

/** ANSI 感知的可见宽度（真实 pi-tui 的同构近似）。 */
export function visibleWidth(text: string): number {
	let width = 0;
	let inEscape = false;
	for (const ch of text) {
		if (ch === "\x1b") {
			inEscape = true;
			continue;
		}
		if (inEscape) {
			if (ch === "m") inEscape = false;
			continue;
		}
		width += charWidth(ch);
	}
	return width;
}

/** ANSI 感知的按宽度截断（ellipsis 追加不计入宽度预算，与真实实现近似）。 */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = ""): string {
	if (visibleWidth(text) <= maxWidth) return text;
	let out = "";
	let width = 0;
	let inEscape = false;
	for (const ch of text) {
		if (ch === "\x1b") {
			inEscape = true;
			out += ch;
			continue;
		}
		if (inEscape) {
			out += ch;
			if (ch === "m") inEscape = false;
			continue;
		}
		const cw = charWidth(ch);
		if (width + cw > maxWidth) {
			return ellipsis ? out + ellipsis : out;
		}
		out += ch;
		width += cw;
	}
	return out;
}
