import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PATHS, Utils } from "electrobun/bun";
import type { ChangelogEntry, ExternalApp, Project, TipState } from "../../shared/types";
import { DEFAULT_EXTERNAL_APPS, extractRepoName } from "../../shared/types";
import * as data from "../data";
import * as git from "../git";
import * as pty from "../pty-server";
import { loadSettings } from "../settings";
import { BUNDLED_CHANGELOG } from "../changelog-bundled";
import * as repoConfig from "../repo-config";
import { DEV3_HOME } from "../paths";
import { spawn, spawnSync } from "../spawn";
import { getUploadedImageExtension, hideAppNative, log, logRendererError } from "./shared";

async function quitApp(): Promise<void> {
	log.info("→ quitApp (Cmd+Q from renderer)");
	const { shutdownCaffeinate } = await import("../caffeinate");
	shutdownCaffeinate();
	Utils.quit();
}

async function hideApp(): Promise<void> {
	log.info("→ hideApp (Cmd+H from renderer)");
	hideAppNative();
}

async function showConfirm(params: { title: string; message: string }): Promise<boolean> {
	const { response } = await Utils.showMessageBox({
		type: "question",
		title: params.title,
		message: params.message,
		buttons: ["OK", "Cancel"],
		defaultId: 1,
		cancelId: 1,
	});
	return response === 0;
}

async function getProjects(): Promise<Project[]> {
	log.info("→ getProjects");
	const rawProjects = await data.loadProjects();
	await Promise.all(rawProjects.map((project) => repoConfig.migrateProjectConfig(project)));
	const projects = await Promise.all(rawProjects.map((project) => repoConfig.resolveProjectConfig(project)));
	log.info(`← getProjects: ${projects.length} project(s)`);
	return projects;
}

async function pickFolder(): Promise<string | null> {
	log.info("→ pickFolder (opening native dialog)");
	try {
		const startingFolder = homedir();
		log.info("pickFolder starting from", { startingFolder });

		const paths = await Utils.openFileDialog({
			startingFolder,
			canChooseFiles: false,
			canChooseDirectory: true,
			allowsMultipleSelection: false,
		});
		log.info("← pickFolder", { paths });
		if (!paths || paths.length === 0) return null;

		return paths[0];
	} catch (err) {
		log.error("pickFolder failed", { error: String(err) });
		throw err;
	}
}

async function addProjectImpl(params: { path: string; name: string }): Promise<{ ok: true; project: Project } | { ok: false; error: string }> {
	log.info("→ addProject", params);
	try {
		const isRepo = await git.isGitRepo(params.path);
		if (!isRepo) {
			log.warn("Not a git repo", { path: params.path });
			return { ok: false, error: "Selected folder is not a git repository" };
		}
		const project = await data.addProject(params.path, params.name);
		try {
			const defaultBranch = await git.getDefaultBranch(params.path);
			await data.updateProject(project.id, { defaultBaseBranch: defaultBranch });
			project.defaultBaseBranch = defaultBranch;
		} catch (err) {
			log.warn("Could not detect default branch, keeping 'main'", { error: String(err) });
		}
		log.info("← addProject OK", { projectId: project.id, name: project.name });
		return { ok: true, project };
	} catch (err) {
		log.error("addProject failed", { error: String(err), params });
		return { ok: false, error: String(err) };
	}
}

async function cloneAndAddProject(params: { url: string; baseDir: string; repoName?: string }): Promise<{ ok: true; project: Project } | { ok: false; error: string }> {
	log.info("→ cloneAndAddProject", params);
	try {
		const name = params.repoName || extractRepoName(params.url);
		const targetDir = `${params.baseDir}/${name}`;

		if (existsSync(targetDir)) {
			const isRepo = await git.isGitRepo(targetDir);
			if (isRepo) {
				log.info("Directory already exists and is a git repo, adding as project", { targetDir });
				return addProjectImpl({ path: targetDir, name });
			}
			return { ok: false, error: `Directory already exists: ${targetDir}` };
		}

		const cloneResult = await git.cloneRepo(params.url, targetDir);
		if (!cloneResult.ok) {
			return { ok: false, error: `Clone failed: ${cloneResult.error}` };
		}

		return addProjectImpl({ path: targetDir, name });
	} catch (err) {
		log.error("cloneAndAddProject failed", { error: String(err), params });
		return { ok: false, error: String(err) };
	}
}

async function removeProject(params: { projectId: string }): Promise<void> {
	log.info("→ removeProject", params);
	const projectSessionKey = `project-${params.projectId}`;
	if (pty.hasSession(projectSessionKey)) {
		pty.destroySession(projectSessionKey);
	}
	try {
		const project = await data.getProject(params.projectId);
		git.removeFetchCache(project.path);
	} catch {}
	await data.removeProject(params.projectId);
	log.info("← removeProject done");
}

async function detectClonePaths(params: { projectId: string }): Promise<string[]> {
	log.info("→ detectClonePaths", { projectId: params.projectId });
	const project = await data.getProject(params.projectId);
	const { detectClonePaths: detect } = await import("../cow-clone");
	const paths = await detect(project.path);
	log.info("← detectClonePaths", { count: paths.length });
	return paths;
}

async function resolveFilename(params: { filename: string; size: number; lastModified: number }): Promise<string | null> {
	const home = homedir();
	const searchDirs = [
		`${home}/Desktop`,
		`${home}/Downloads`,
		`${home}/Documents`,
		`${home}/Projects`,
		`${home}/src`,
		`${home}/dev`,
		`${home}/work`,
		`${home}/code`,
		"/tmp",
	].filter((dir) => {
		try { return statSync(dir).isDirectory(); } catch { return false; }
	});

	const query = `kMDItemFSName == "${params.filename}"`;
	const candidates: string[] = [];
	for (const dir of searchDirs) {
		const proc = spawnSync(["mdfind", "-onlyin", dir, query]);
		const out = proc.stdout.toString().trim();
		if (out) candidates.push(...out.split("\n"));
	}
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0];

	const sizeMatches: string[] = [];
	for (const path of candidates) {
		try {
			const file = Bun.file(path);
			if (file.size === params.size) {
				sizeMatches.push(path);
			}
		} catch {}
	}

	if (sizeMatches.length === 1) return sizeMatches[0];

	const pool = sizeMatches.length > 0 ? sizeMatches : candidates;
	for (const path of pool) {
		try {
			const file = Bun.file(path);
			if (file.lastModified === params.lastModified) {
				return path;
			}
		} catch {}
	}

	return sizeMatches[0] ?? candidates[0];
}

async function getChangelogs(): Promise<ChangelogEntry[]> {
	log.info("-> getChangelogs");

	let root = import.meta.dir ?? "";
	for (let i = 0; i < 20 && root; i++) {
		if (existsSync(join(root, "vite.config.ts"))) break;
		const parent = dirname(root);
		if (parent === root) break;
		root = parent;
	}

	const changeLogsDir = join(root, "change-logs");
	if (!existsSync(changeLogsDir)) {
		const prodJson = PATHS.VIEWS_FOLDER ? join(PATHS.VIEWS_FOLDER, "..", "changelog.json") : "";
		const metaDir = import.meta.dir ?? "";
		const devJson = metaDir ? join(metaDir, "..", "changelog.json") : "";
		const jsonPath = (prodJson && existsSync(prodJson)) ? prodJson : devJson;
		if (existsSync(jsonPath)) {
			const entries: ChangelogEntry[] = JSON.parse(await Bun.file(jsonPath).text());
			log.info("<- getChangelogs (from bundled JSON)", { count: entries.length });
			return entries;
		}
		if (BUNDLED_CHANGELOG.length > 0) {
			log.info("<- getChangelogs (from bundled TS data)", { count: BUNDLED_CHANGELOG.length });
			return BUNDLED_CHANGELOG;
		}
		log.info("<- getChangelogs (no change-logs dir, no bundled data)");
		return [];
	}

	const entries: ChangelogEntry[] = [];
	for (const year of readdirSync(changeLogsDir)) {
		const yearPath = join(changeLogsDir, year);
		if (!/^\d{4}$/.test(year)) continue;
		for (const month of readdirSync(yearPath)) {
			const monthPath = join(yearPath, month);
			if (!/^\d{2}$/.test(month)) continue;
			for (const day of readdirSync(monthPath)) {
				const dayPath = join(monthPath, day);
				if (!/^\d{2}$/.test(day)) continue;
				for (const file of readdirSync(dayPath)) {
					if (!file.endsWith(".md") || file === "README.md") continue;
					const basename = file.replace(/\.md$/, "");
					const dashIdx = basename.indexOf("-");
					if (dashIdx === -1) continue;
					const type = basename.slice(0, dashIdx);
					const slug = basename.slice(dashIdx + 1);
					const content = await Bun.file(join(dayPath, file)).text();

					let suggestedBy: string | undefined;
					let issueUrl: string | undefined;
					let issueRef: string | undefined;
					const creditMatch = content.match(/Suggested by @(\S+)\s+\(([^)]+)\)/);
					if (creditMatch) {
						suggestedBy = creditMatch[1];
						const ref = creditMatch[2];
						const refMatch = ref.match(/^(.+?)#(\d+)$/);
						if (refMatch) {
							issueRef = `#${refMatch[2]}`;
							issueUrl = `https://github.com/${refMatch[1]}/issues/${refMatch[2]}`;
						}
					}

					const cleanContent = content.replace(/\n*Suggested by @\S+\s+\([^)]+\)\s*$/, "").trim();
					const firstSentence = cleanContent.split(/\.(?:\s|$)/)[0]?.trim() ?? slug;
					const title = firstSentence.length > 120
						? firstSentence.slice(0, 117) + "..."
						: firstSentence;

					entries.push({
						date: `${year}-${month}-${day}`,
						type,
						slug,
						title: title || slug,
						...(suggestedBy && { suggestedBy }),
						...(issueUrl && { issueUrl }),
						...(issueRef && { issueRef }),
					});
				}
			}
		}
	}

	entries.sort((a, b) => b.date.localeCompare(a.date));
	log.info("<- getChangelogs", { count: entries.length });
	return entries;
}

async function saveUploadedImage(
	projectId: string,
	imageData: Buffer | Uint8Array,
	opts?: { filename?: string; mimeType?: string },
): Promise<{ path: string }> {
	const project = await data.getProject(projectId);
	const slug = project.path.replace(/^\//, "").replaceAll("/", "-");
	const uploadsDir = `${DEV3_HOME}/worktrees/${slug}/uploads`;
	const mkdirProc = spawn(["mkdir", "-p", uploadsDir]);
	await mkdirProc.exited;
	const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
	const extension = getUploadedImageExtension(opts?.filename, opts?.mimeType);
	const filename = `img-${Date.now()}-${hex}${extension}`;
	const fullPath = `${uploadsDir}/${filename}`;
	await Bun.write(fullPath, imageData);
	log.info("Image saved", { path: fullPath, size: imageData.length });
	return { path: fullPath };
}

async function pasteClipboardImage(params: { projectId: string }): Promise<{ path: string } | null> {
	log.info("→ pasteClipboardImage", { projectId: params.projectId.slice(0, 8) });
	const formats = Utils.clipboardAvailableFormats();
	if (!formats.includes("image")) {
		log.info("← pasteClipboardImage: no image in clipboard");
		return null;
	}
	const pngData = Utils.clipboardReadImage();
	if (!pngData || pngData.length === 0) {
		log.warn("← pasteClipboardImage: clipboardReadImage returned empty");
		return null;
	}
	return saveUploadedImage(params.projectId, pngData);
}

async function uploadImageBase64(params: { projectId: string; base64: string; filename?: string; mimeType?: string }): Promise<{ path: string } | null> {
	const MAX_BASE64_SIZE = 10 * 1024 * 1024;
	if (params.base64.length > MAX_BASE64_SIZE) {
		log.warn("← uploadImageBase64: payload too large", { len: params.base64.length });
		throw new Error("Image too large (max 10 MB)");
	}
	log.info("→ uploadImageBase64", { projectId: params.projectId.slice(0, 8), len: params.base64.length });
	const pngData = Buffer.from(params.base64, "base64");
	if (pngData.length === 0) {
		log.warn("← uploadImageBase64: empty image data");
		return null;
	}
	return saveUploadedImage(params.projectId, pngData, {
		filename: params.filename,
		mimeType: params.mimeType,
	});
}

async function readImageBase64(params: { path: string }): Promise<{ dataUrl: string } | null> {
	log.info("→ readImageBase64", { path: params.path });
	if (!params.path.startsWith("/") || params.path.includes("..")) {
		log.warn("← readImageBase64: invalid path, rejected");
		return null;
	}
	try {
		const file = Bun.file(params.path);
		if (!(await file.exists())) {
			log.warn("← readImageBase64: file not found");
			return null;
		}
		const buffer = await file.arrayBuffer();
		const base64 = Buffer.from(buffer).toString("base64");
		const ext = params.path.split(".").pop()?.toLowerCase() ?? "png";
		const mimeMap: Record<string, string> = {
			png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
			gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
		};
		const mime = mimeMap[ext] ?? "image/png";
		return { dataUrl: `data:${mime};base64,${base64}` };
	} catch (err) {
		log.error("readImageBase64 failed", { error: String(err) });
		return null;
	}
}

async function openImageFile(params: { path: string }): Promise<void> {
	log.info("→ openImageFile", { path: params.path });
	if (!params.path.startsWith("/") || params.path.includes("..")) {
		throw new Error("Invalid file path");
	}
	Utils.openPath(params.path);
}

async function openFolder(params: { path: string }): Promise<void> {
	log.info("→ openFolder", { path: params.path });
	if (!params.path.startsWith("/") || params.path.includes("..")) {
		throw new Error("Invalid folder path");
	}
	Utils.openPath(params.path);
}

async function openInApp(params: { appName: string; path: string }): Promise<void> {
	log.info("→ openInApp", { appName: params.appName, path: params.path });
	if (!params.path.startsWith("/") || params.path.includes("..")) {
		throw new Error("Invalid path");
	}
	if (!params.appName || params.appName.includes("/")) {
		throw new Error("Invalid app name");
	}
	if (params.appName === "Finder") {
		spawn(["open", params.path], { stdout: "ignore", stderr: "ignore" });
		return;
	}
	spawn(["open", "-a", params.appName, params.path], { stdout: "ignore", stderr: "ignore" });
}

async function getAvailableApps(): Promise<ExternalApp[]> {
	log.info("→ getAvailableApps");
	const settings = await loadSettings();
	const allApps = [...DEFAULT_EXTERNAL_APPS, ...(settings.externalApps ?? [])];

	const checks = allApps.map(async (app): Promise<ExternalApp | null> => {
		if (app.id === "finder" || app.id === "terminal") return app;
		if (!app.macAppName) return null;
		try {
			const proc = spawn(["open", "-Ra", app.macAppName], { stdout: "ignore", stderr: "ignore" });
			const code = await proc.exited;
			return code === 0 ? app : null;
		} catch {
			return null;
		}
	});
	const results = (await Promise.all(checks)).filter((app): app is ExternalApp => app !== null);
	log.info("← getAvailableApps", { count: results.length, apps: results.map((app) => app.name) });
	return results;
}

async function getTipState(): Promise<TipState> {
	return data.loadTipState();
}

async function updateTipState(params: Partial<TipState>): Promise<TipState> {
	return data.saveTipState(params);
}

async function resetTipState(): Promise<TipState> {
	return data.resetTipState();
}

async function checkCaffeinateAvailable(): Promise<{ available: boolean }> {
	log.info("→ checkCaffeinateAvailable");
	const { isCaffeinateAvailable } = await import("../caffeinate");
	const available = isCaffeinateAvailable();
	log.info("← checkCaffeinateAvailable", { available });
	return { available };
}

export const appHandlers = {
	logRendererError,
	quitApp,
	hideApp,
	showConfirm,
	getProjects,
	pickFolder,
	addProject: addProjectImpl,
	cloneAndAddProject,
	removeProject,
	detectClonePaths,
	resolveFilename,
	getChangelogs,
	pasteClipboardImage,
	uploadImageBase64,
	readImageBase64,
	openImageFile,
	openFolder,
	openInApp,
	getAvailableApps,
	getTipState,
	updateTipState,
	resetTipState,
	checkCaffeinateAvailable,
};
