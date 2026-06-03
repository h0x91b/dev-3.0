import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { PATHS, Utils } from "../electrobun-platform";
import type { ChangelogEntry, ExternalApp, FolderEntry, FolderListing, Project, TipState } from "../../shared/types";
import { DEFAULT_EXTERNAL_APPS, STUCK_PREPARATION_FETCH_THRESHOLD_MS, extractRepoName } from "../../shared/types";
import * as data from "../data";
import * as git from "../git";
import * as pty from "../pty-server";
import { loadSettings } from "../settings";
import { BUNDLED_CHANGELOG } from "../changelog-bundled";
import * as repoConfig from "../repo-config";
import { DEV3_HOME } from "../paths";
import { spawn } from "../spawn";
import { writeSystemClipboard } from "../system-clipboard";
import { getUploadedImageExtension, hideAppNative, log, logRendererError, logRendererEvent } from "./shared";
import { applyMenuContext, type MenuContext } from "../application-menu";

async function updateMenuContext(params: MenuContext): Promise<void> {
	applyMenuContext({
		hasTask: Boolean(params.hasTask),
		hasProject: Boolean(params.hasProject),
		hasTerminal: Boolean(params.hasTerminal),
	});
}

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

async function reorderProjects(params: { projectIds: string[] }): Promise<Project[]> {
	log.info("→ reorderProjects", { count: params.projectIds.length });
	const rawProjects = await data.reorderProjects(params.projectIds);
	const projects = await Promise.all(rawProjects.map((project) => repoConfig.resolveProjectConfig(project)));
	log.info("← reorderProjects", { count: projects.length });
	return projects;
}

/**
 * Normalize a requested directory path for the folder picker.
 *
 * Rules:
 *   - `null`, `undefined`, or empty → home directory
 *   - Leading `~` or `~/...` → expanded against home
 *   - Relative paths → resolved against home (defensive; picker should only
 *     ever send absolute paths back to us)
 */
function normalizeRequestedPath(requested: string | null | undefined): string {
	if (!requested || requested.trim() === "") return homedir();
	let p = requested.trim();
	if (p === "~") return homedir();
	if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	if (!isAbsolute(p)) p = resolvePath(homedir(), p);
	return resolvePath(p);
}

/**
 * List the contents of a directory for the custom folder picker.
 *
 * Called from both the Electrobun and browser transports — replaces the old
 * native `openFileDialog` which cannot work in headless/remote mode.
 */
async function listDirectory(params?: { path?: string | null; includeFiles?: boolean; showHidden?: boolean }): Promise<FolderListing> {
	const requestedPath = normalizeRequestedPath(params?.path);
	const includeFiles = params?.includeFiles === true;
	const showHidden = params?.showHidden === true;
	const home = homedir();
	log.info("→ listDirectory", { path: requestedPath, includeFiles, showHidden });

	const parentOf = (p: string): string | null => {
		const parent = dirname(p);
		return parent === p ? null : parent;
	};

	if (!existsSync(requestedPath)) {
		log.warn("listDirectory: path does not exist", { path: requestedPath });
		return {
			path: requestedPath,
			parent: parentOf(requestedPath),
			home,
			entries: [],
			error: "Path does not exist",
		};
	}

	try {
		const names = readdirSync(requestedPath);
		const entries: FolderEntry[] = [];
		for (const name of names) {
			if (!showHidden && name.startsWith(".")) continue;
			const fullPath = join(requestedPath, name);
			let isDir: boolean;
			try {
				// `statSync` follows symlinks — we want to list the target type so
				// directory symlinks still behave like directories for picking.
				isDir = statSync(fullPath).isDirectory();
			} catch {
				// Permission denied, broken symlink, etc. Skip silently.
				continue;
			}
			if (!includeFiles && !isDir) continue;
			entries.push({ name, path: fullPath, isDir });
		}
		// Directories first, then files, alphabetical (case-insensitive).
		entries.sort((a, b) => {
			if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
			return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
		});
		log.info("← listDirectory", { path: requestedPath, count: entries.length });
		return {
			path: requestedPath,
			parent: parentOf(requestedPath),
			home,
			entries,
		};
	} catch (err) {
		log.error("listDirectory failed", { path: requestedPath, error: String(err) });
		return {
			path: requestedPath,
			parent: parentOf(requestedPath),
			home,
			entries: [],
			error: String(err),
		};
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

/**
 * Create a new directory (used by the folder picker's "New Folder" button).
 *
 * Rejects names containing path separators or control characters. Does not
 * overwrite existing directories — returns an error instead.
 */
async function createDirectory(params: { parentPath: string; name: string }): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	log.info("→ createDirectory", params);
	try {
		const name = params.name.trim();
		if (!name) return { ok: false, error: "Folder name cannot be empty" };
		if (name === "." || name === "..") return { ok: false, error: "Invalid folder name" };
		// eslint-disable-next-line no-control-regex
		if (/[\x00-\x1f\x7f/\\]/.test(name)) {
			return { ok: false, error: "Folder name contains invalid characters" };
		}
		if (!isAbsolute(params.parentPath)) {
			return { ok: false, error: "Parent path must be absolute" };
		}
		if (!existsSync(params.parentPath)) {
			return { ok: false, error: "Parent folder does not exist" };
		}
		const fullPath = join(params.parentPath, name);
		if (existsSync(fullPath)) {
			return { ok: false, error: "A folder with that name already exists" };
		}
		mkdirSync(fullPath, { recursive: false });
		log.info("← createDirectory OK", { path: fullPath });
		return { ok: true, path: fullPath };
	} catch (err) {
		log.error("createDirectory failed", { error: String(err), params });
		return { ok: false, error: String(err) };
	}
}

/**
 * Treat a folder as "effectively empty" when it has no meaningful children.
 * We tolerate junk that macOS / editors routinely scatter around so the user
 * can pick a folder they just created via Finder without hitting the
 * "not empty" error for a `.DS_Store` file.
 */
function isEffectivelyEmpty(path: string): boolean {
	try {
		const entries = readdirSync(path);
		const IGNORED = new Set([".DS_Store", "Thumbs.db", ".localized"]);
		return entries.every((name) => IGNORED.has(name));
	} catch {
		return false;
	}
}

/**
 * Initialise an empty folder as a git repo (if needed), seed it with a
 * `.dev3/README.md` placeholder, commit it as "init", and register the
 * resulting repo as a project.
 *
 * - Already a git repo → skip init, register directly.
 * - Empty (or only macOS junk) → git init + placeholder commit + register.
 * - Non-empty and not a git repo → refuse (we don't want to silently add
 *   files into someone's unrelated folder).
 */
async function initAndAddProject(params: { path: string; name: string }): Promise<{ ok: true; project: Project } | { ok: false; error: string }> {
	log.info("→ initAndAddProject", params);
	try {
		if (!isAbsolute(params.path) || !existsSync(params.path)) {
			return { ok: false, error: "Folder does not exist" };
		}
		if (!statSync(params.path).isDirectory()) {
			return { ok: false, error: "Path is not a folder" };
		}

		const alreadyRepo = await git.isGitRepo(params.path);
		if (alreadyRepo) {
			log.info("initAndAddProject: folder is already a git repo — registering as-is");
			return addProjectImpl({ path: params.path, name: params.name });
		}

		if (!isEffectivelyEmpty(params.path)) {
			return {
				ok: false,
				error: "Folder is not empty and not a git repository. Pick an empty folder or an existing repo.",
			};
		}

		const initResult = await git.run(["git", "init"], params.path);
		if (!initResult.ok) {
			return { ok: false, error: `git init failed: ${initResult.stderr || "unknown error"}` };
		}

		const dev3Dir = join(params.path, ".dev3");
		mkdirSync(dev3Dir, { recursive: true });
		const readmePath = join(dev3Dir, "README.md");
		const readmeContent = [
			"# .dev3/",
			"",
			"This folder is used by [dev-3.0](https://github.com/h0x91b/dev-3.0) to",
			"store project-level config (setup / dev / cleanup scripts, clone paths,",
			"base branch, etc). Check it in so the whole team shares the same setup.",
			"",
			"Local overrides go into `.dev3/config.local.json` (git-ignored).",
			"",
		].join("\n");
		writeFileSync(readmePath, readmeContent, "utf8");

		const addResult = await git.run(["git", "add", "."], params.path);
		if (!addResult.ok) {
			return { ok: false, error: `git add failed: ${addResult.stderr || "unknown error"}` };
		}
		const commitResult = await git.run(
			["git", "commit", "-m", "init"],
			params.path,
		);
		if (!commitResult.ok) {
			// Most common failure: missing user.name / user.email. Surface it
			// clearly so the user can fix `git config` and retry.
			return {
				ok: false,
				error: `git commit failed: ${commitResult.stderr || "unknown error"}`,
			};
		}

		log.info("initAndAddProject: initial commit created, registering project");
		return addProjectImpl({ path: params.path, name: params.name });
	} catch (err) {
		log.error("initAndAddProject failed", { error: String(err), params });
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

function sanitizeUploadedFilename(filename?: string): string | null {
	if (!filename) return null;
	const baseName = filename.split(/[/\\]/).pop()?.trim() ?? "";
	const sanitized = baseName.replace(/[\0-\x1f\x7f]/g, "");
	if (!sanitized) return null;
	// Prefix "upload-<13digits>-<4hex>-" is ~26 ASCII bytes; NAME_MAX is 255 bytes.
	// Cap the suffix at 200 bytes to stay well within the limit on any OS/encoding.
	const MAX_BYTES = 200;
	if (Buffer.byteLength(sanitized, "utf8") <= MAX_BYTES) return sanitized;
	const buf = Buffer.from(sanitized, "utf8");
	// Walk back from the cut point to avoid slicing a multibyte UTF-8 sequence.
	let end = MAX_BYTES;
	while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
	return buf.subarray(0, end).toString("utf8") || null;
}

function buildUploadedFilename(opts?: { filename?: string; mimeType?: string }): string {
	const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
	const prefix = `upload-${Date.now()}-${hex}`;
	const safeName = sanitizeUploadedFilename(opts?.filename);
	if (safeName) {
		return `${prefix}-${safeName}`;
	}

	return `${prefix}${getUploadedImageExtension(undefined, opts?.mimeType)}`;
}

async function saveUploadedFile(
	projectId: string,
	fileData: Buffer | Uint8Array,
	opts?: { filename?: string; mimeType?: string },
): Promise<{ path: string }> {
	const project = await data.getProject(projectId);
	const slug = project.path.replace(/^\//, "").replaceAll("/", "-");
	const uploadsDir = `${DEV3_HOME}/worktrees/${slug}/uploads`;
	const mkdirProc = spawn(["mkdir", "-p", uploadsDir]);
	await mkdirProc.exited;
	const filename = buildUploadedFilename(opts);
	const fullPath = `${uploadsDir}/${filename}`;
	await Bun.write(fullPath, fileData);
	log.info("Uploaded file saved", { path: fullPath, size: fileData.length });
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
	return saveUploadedFile(params.projectId, pngData, { mimeType: "image/png" });
}

async function uploadImageBase64(params: { projectId: string; base64: string; filename?: string; mimeType?: string }): Promise<{ path: string } | null> {
	return uploadFileBase64(params);
}

async function uploadFileBase64(params: { projectId: string; base64: string; filename?: string; mimeType?: string }): Promise<{ path: string } | null> {
	log.info("→ uploadFileBase64", {
		projectId: params.projectId.slice(0, 8),
		len: params.base64.length,
		filename: params.filename,
	});
	const fileData = Buffer.from(params.base64, "base64");
	const MAX_FILE_SIZE = 100 * 1024 * 1024;
	if (fileData.length > MAX_FILE_SIZE) {
		log.warn("← uploadFileBase64: payload too large", { len: fileData.length });
		throw new Error("File too large (max 100 MB)");
	}
	if (fileData.length === 0) {
		log.warn("← uploadFileBase64: empty file data");
		return null;
	}
	return saveUploadedFile(params.projectId, fileData, {
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

async function openSystemSettings(params: { pane: "fullDiskAccess" }): Promise<{ ok: boolean }> {
	log.info("→ openSystemSettings", { pane: params.pane, platform: process.platform });
	if (process.platform !== "darwin") {
		log.warn("openSystemSettings: ignored on non-darwin platform", { platform: process.platform });
		return { ok: false };
	}
	const urls: Record<string, string> = {
		fullDiskAccess: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
	};
	const url = urls[params.pane];
	if (!url) {
		log.warn("openSystemSettings: unknown pane", { pane: params.pane });
		return { ok: false };
	}
	Utils.openExternal(url);
	return { ok: true };
}

async function getStuckPreparationThresholdMs(): Promise<{ ms: number }> {
	const raw = process.env.DEV3_STUCK_PREP_THRESHOLD_SEC;
	if (raw) {
		const sec = Number.parseFloat(raw);
		if (Number.isFinite(sec) && sec > 0) {
			return { ms: Math.round(sec * 1000) };
		}
		log.warn("getStuckPreparationThresholdMs: invalid DEV3_STUCK_PREP_THRESHOLD_SEC, using default", { raw });
	}
	return { ms: STUCK_PREPARATION_FETCH_THRESHOLD_MS };
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

async function getPreventSleepState(): Promise<{ enabled: boolean; available: boolean; forcedByRemote: boolean }> {
	const { isCaffeinateAvailable, isPreventSleepEnabled } = await import("../caffeinate");
	const { isRemoteAccessActive } = await import("../remote-access-server");
	const available = isCaffeinateAvailable();
	const forcedByRemote = isRemoteAccessActive();
	const enabled = isPreventSleepEnabled();
	log.info("← getPreventSleepState", { enabled, available, forcedByRemote });
	return { enabled, available, forcedByRemote };
}

async function setPreventSleep(params: { enabled: boolean }): Promise<{ enabled: boolean }> {
	log.info("→ setPreventSleep", { enabled: params.enabled });
	const { loadSettings, saveSettings } = await import("../settings");
	const settings = await loadSettings();
	settings.preventSleepWhileRunning = params.enabled;
	await saveSettings(settings);
	// Re-evaluate immediately so the inhibit process starts/stops without
	// waiting for the next resource-monitor poll cycle.
	const { updateCaffeinateState } = await import("../caffeinate");
	const { isRemoteAccessActive } = await import("../remote-access-server");
	updateCaffeinateState(isRemoteAccessActive());
	return { enabled: params.enabled };
}

async function copyTerminalSelection(params: { taskId: string; text: string; mouseTracking: boolean }): Promise<{ ok: boolean; tool: string | null }> {
	if (!params.text) return { ok: false, tool: null };
	if (process.env.DEV3_HEADLESS === "1") return { ok: false, tool: null };
	const tool = writeSystemClipboard(params.text);
	log.info("terminal selection copied through backend", {
		taskId: params.taskId.slice(0, 8),
		len: params.text.length,
		mouseTracking: params.mouseTracking,
		tool,
	});
	return { ok: Boolean(tool), tool };
}

export const appHandlers = {
	logRendererError,
	// TEMP DIAGNOSTIC: remove with logRendererEvent after terminal copy bug cleanup.
	logRendererEvent,
	quitApp,
	hideApp,
	showConfirm,
	updateMenuContext,
	getProjects,
	reorderProjects,
	listDirectory,
	addProject: addProjectImpl,
	cloneAndAddProject,
	createDirectory,
	initAndAddProject,
	removeProject,
	detectClonePaths,
	getChangelogs,
	pasteClipboardImage,
	uploadFileBase64,
	uploadImageBase64,
	readImageBase64,
	openImageFile,
	openFolder,
	openInApp,
	openSystemSettings,
	getStuckPreparationThresholdMs,
	getAvailableApps,
	getTipState,
	updateTipState,
	resetTipState,
	checkCaffeinateAvailable,
	getPreventSleepState,
	setPreventSleep,
	copyTerminalSelection,
};
