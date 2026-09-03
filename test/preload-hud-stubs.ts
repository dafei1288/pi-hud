/**
 * test/preload-hud-stubs.ts — bun preload：把 "@mariozechner/pi-tui" 解析到
 * test/hud-stubs/pi-tui.ts（运行期只用到 truncateToWidth/visibleWidth）。
 *
 * 用法：bun --preload ./test/preload-hud-stubs.ts test/simulate-hud.ts
 */
import { plugin } from "bun";
import { resolve } from "node:path";

plugin({
	name: "hud-test-stubs",
	setup(build) {
		build.onResolve({ filter: /^@mariozechner\/pi-tui$/ }, () => ({
			path: resolve(import.meta.dir, "hud-stubs", "pi-tui.ts"),
		}));
	},
});
