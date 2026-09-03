/**
 * git-info.ts — 纯 fs 的 git 信息读取（零依赖，双端通用）
 *
 * omp 的 setFooter 是 noop，没有 pi 的 footerData.getGitBranch()/onBranchChange()，
 * HUD 状态栏要显示分支只能自己读 .git。bubble 编辑器此前已内置同款逻辑
 * （worktree 感知），提到这里共享。
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GitInfo {
	/** 当前工作区（worktree 根目录） */
	project: string;
	branch: string;
	/** worktree 标识：主工作区为 "main"，linked worktree 为其名称；非 git 仓库为 null */
	worktree: string | null;
}

/** 从 cwd 向上查找最近的 git checkout，解析分支 + worktree 名。 */
export function readGitInfo(cwd: string): GitInfo {
	const info: GitInfo = { project: cwd, branch: "", worktree: null };
	let cur = cwd;
	for (let i = 0; i < 20; i++) {
		const gp = join(cur, ".git");
		try {
			const stat = statSync(gp);
			// 只要是 git checkout 就是一个 worktree：
			//  - .git 是目录 → 主工作区（git 的 main working tree）
			//  - .git 是文件 → linked worktree，内容 "gitdir: <repo>/.git/worktrees/<name>"
			let gitDir = gp;
			if (stat.isFile()) {
				gitDir = readFileSync(gp, "utf8").trim().replace(/^gitdir:\s*/, "");
				info.worktree = gitDir.split(/[\\/]/).filter(Boolean).pop() ?? null;
			} else {
				info.worktree = "main";
			}
			info.project = cur; // 找到 .git 的目录即当前 worktree 根（兼容从子目录启动）
			const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
			info.branch = head.startsWith("ref: refs/heads/") ? head.slice(16) : `[${head.slice(0, 8)}]`;
			return info;
		} catch { /* 不是 git 仓库，继续向上查找 */ }
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return info;
}
