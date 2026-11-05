import { useState, useEffect, useRef, type Dispatch } from "react";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { extractRepoName } from "../../shared/types";
import type { AutoConfigureKey, AutoConfigureResult, BoardCopyOffer, GitInitOffer, Project } from "../../shared/types";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT, type TranslationKey } from "../i18n";
import HelpSpot from "./HelpSpot";
import { trackEvent } from "../analytics";
import posthog from "../posthog";
import { openFolderPicker, openFolderPickerMulti } from "../folder-picker";
import { toast } from "../toast";
import { confirm } from "../confirm";
import { useFocusTrap } from "../utils/useFocusTrap";
import ProjectSpacesField, { applyDeferredSpaces, type DeferredSpaces } from "./ProjectSpacesField";
import { ToggleSwitch } from "./project-settings/fields";

const AUTO_CONFIGURE_LABELS = {
	setupScript: "addProject.autoConfigSetup",
	devScript: "addProject.autoConfigDev",
} as const satisfies Record<AutoConfigureKey, TranslationKey>;

interface AddProjectModalProps {
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
	/** Pre-selected space memberships when the flow started from a space. */
	initialSpaceIds?: string[];
	/**
	 * The git projects this dialog just added, reported once it is done. dev3
	 * offers to import the agent conversations that already ran in them.
	 */
	onGitProjectsAdded?: (projects: Project[]) => void;
}

function AddProjectModal({ dispatch, onClose, initialSpaceIds, onGitProjectsAdded }: AddProjectModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const [kind, setKind] = useState<"git" | "operations">("git");
	const [opsName, setOpsName] = useState("");
	const [creatingOps, setCreatingOps] = useState(false);
	const [activeTab, setActiveTab] = useState<"local" | "clone" | "init">("local");
	// Off unless the user turned it on last time - the choice is remembered in global settings.
	const [autoConfigure, setAutoConfigure] = useState(false);
	// A click before the stored value arrives wins over it.
	const autoConfigureTouched = useRef(false);
	// Off every time: it writes into the project folder, so each project opts in on its own.
	const [boardCopy, setBoardCopy] = useState(false);
	const [gitUrl, setGitUrl] = useState("");
	const [repoName, setRepoName] = useState("");
	const [cloneBaseDir, setCloneBaseDir] = useState<string | null>(null);
	const [cloning, setCloning] = useState(false);
	const [browsing, setBrowsing] = useState(false);
	const [initializing, setInitializing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [cloneOutput, setCloneOutput] = useState<string[]>([]);
	const [pendingSpaces, setPendingSpaces] = useState<DeferredSpaces>({
		spaceIds: initialSpaceIds ?? [],
		newNames: [],
	});
	const cloneProgressIdRef = useRef<string | null>(null);
	const urlInputRef = useRef<HTMLInputElement>(null);

	// Membership is applied after the project exists; failures only toast —
	// the project itself was created fine.
	async function applyPendingSpaces(projectId: string) {
		try {
			await applyDeferredSpaces(projectId, pendingSpaces);
		} catch (err) {
			toast.error(t("spaces.failedUpdate", { error: String(err) }), { source: "dashboard" });
		}
	}

	useEffect(() => {
		function onCloneProgress(e: Event) {
			const detail = (e as CustomEvent).detail as { progressId: string; lines: string[] };
			if (detail.progressId === cloneProgressIdRef.current) {
				setCloneOutput(detail.lines);
			}
		}
		window.addEventListener("rpc:cloneProgress", onCloneProgress);
		return () => window.removeEventListener("rpc:cloneProgress", onCloneProgress);
	}, []);

	useEffect(() => {
		api.request.getGlobalSettings().then((settings) => {
			if (settings.cloneBaseDirectory) {
				setCloneBaseDir(settings.cloneBaseDirectory);
			}
			if (!autoConfigureTouched.current) setAutoConfigure(settings.autoConfigureNewProjects === true);
		}).catch(() => {});
	}, []);

	useEffect(() => {
		if (activeTab === "clone") {
			urlInputRef.current?.focus();
		}
	}, [activeTab]);

	const pendingConfirmRef = useRef<AbortController | null>(null);
	// The confirm dialog does not take Escape itself; without this, Escape would
	// close this modal underneath it and leave the question hanging.
	useEscapeKey(() => (pendingConfirmRef.current ? pendingConfirmRef.current.abort() : onClose()));

	const inferredName = gitUrl.trim() ? extractRepoName(gitUrl.trim()) : "";
	const displayName = repoName.trim() || inferredName;
	const targetPath = cloneBaseDir && displayName ? `${cloneBaseDir}/${displayName}` : "";

	/** Ask before dev3 touches a folder that has files, spelling out what changes and what does not. */
	function confirmGitInit(offer: GitInitOffer): Promise<boolean> {
		const keep = offer.placeholder === "keep";
		const plan = offer.mode === "init"
			? t(keep ? "addProject.gitInit.planInitEmpty" : "addProject.gitInit.planInit")
			: t(keep ? "addProject.gitInit.planFirstCommitEmpty" : "addProject.gitInit.planFirstCommit");
		const parts = [offer.path, plan];
		// A commit-less repo may already track or stage files, so "untracked" would be a promise we cannot keep.
		if (offer.mode === "first-commit") parts.push(t("addProject.gitInit.existingRepo"));
		else if (offer.existingEntries > 0) parts.push(t.plural("addProject.gitInit.existing", offer.existingEntries));
		const controller = new AbortController();
		pendingConfirmRef.current = controller;
		return confirm({
			title: t("addProject.gitInit.title"),
			message: parts.join("\n\n"),
			confirmLabel: t(offer.mode === "init" ? "addProject.gitInit.confirm" : "addProject.gitInit.confirmFirstCommit"),
			signal: controller.signal,
		}).finally(() => {
			if (pendingConfirmRef.current === controller) pendingConfirmRef.current = null;
		});
	}

	/**
	 * Settle an add attempt that came back with a git-init offer: confirm, then
	 * initialize in place. `null` means the user declined and nothing changed.
	 */
	async function initAfterConfirm(offer: GitInitOffer, withAutoConfigure: boolean): Promise<
		{ ok: true; project: Project; autoConfigured?: AutoConfigureResult; boardCopyOffer?: BoardCopyOffer } | { ok: false; error: string } | null
	> {
		if (!(await confirmGitInit(offer))) return null;
		const result = await api.request.initAndAddProject({
			path: offer.path,
			initNonEmpty: true,
			...(withAutoConfigure ? { autoConfigure: true } : {}),
			...(boardCopy ? { boardCopy: true } : {}),
		});
		if (result.ok) {
			const key = offer.mode === "init" ? "addProject.gitInit.success" : "addProject.gitInit.successFirstCommit";
			toast.success(t(key, { name: result.project.name }), { source: "dashboard" });
		}
		return result;
	}

	async function toggleAutoConfigure() {
		autoConfigureTouched.current = true;
		const next = !autoConfigure;
		setAutoConfigure(next);
		try {
			const settings = await api.request.getGlobalSettings();
			await api.request.saveGlobalSettings({ ...settings, autoConfigureNewProjects: next || undefined });
		} catch {
			// Remembering the choice is best-effort
		}
	}

	// Says what auto-configure wrote, so a new .dev3 file never appears unannounced.
	function reportAutoConfigured(project: Project, result: AutoConfigureResult | undefined) {
		if (!result) return;
		if (result.failed) {
			toast.error(t("addProject.autoConfigFailed", { name: project.name }), { source: "dashboard" });
			return;
		}
		if (result.existingConfig) {
			toast.info(t("addProject.autoConfigExisting", { name: project.name }), { source: "dashboard" });
			return;
		}
		const keys = result.written;
		if (keys.length === 0) {
			toast.info(t("addProject.autoConfigNothing", { name: project.name }), { source: "dashboard" });
			return;
		}
		const fields = keys.map((key) => t(AUTO_CONFIGURE_LABELS[key])).join(", ");
		toast.success(t("addProject.autoConfigDone", { name: project.name, fields }), { source: "dashboard" });
	}

	/**
	 * The folder already holds a board copy and the new board is empty: ask
	 * before restoring. Declining leaves both the board and the copy untouched.
	 */
	async function offerBoardCopyRestore(project: Project, offer: BoardCopyOffer | undefined) {
		if (!offer) return;
		if (offer.status === "unsupported-version") {
			toast.error(t("boardCopy.restoreUnsupported", { name: project.name, version: offer.version }), { source: "dashboard" });
			return;
		}
		if (offer.status === "invalid") {
			toast.error(t("boardCopy.restoreInvalid", { name: project.name }), { source: "dashboard" });
			return;
		}
		const controller = new AbortController();
		pendingConfirmRef.current = controller;
		const ok = await confirm({
			title: t("boardCopy.restoreTitle"),
			message: t.plural("boardCopy.restoreMessage", offer.taskCount, {
				name: project.name,
				date: new Date(offer.exportedAt).toLocaleString(),
			}),
			confirmLabel: t("boardCopy.restoreConfirm"),
			signal: controller.signal,
		}).finally(() => {
			if (pendingConfirmRef.current === controller) pendingConfirmRef.current = null;
		});
		if (!ok) return;
		try {
			const result = await api.request.restoreBoardCopy({ projectId: project.id });
			if (!result.ok) {
				const key = result.reason === "unsupported-version" ? "boardCopy.restoreUnsupported"
					: result.reason === "board-not-empty" ? "boardCopy.restoreNotEmpty"
					: "boardCopy.restoreInvalid";
				toast.error(t(key, { name: project.name, version: result.version ?? "" }), { source: "dashboard" });
				return;
			}
			const [projects, tasks] = await Promise.all([api.request.getProjects(), api.request.getTasks({ projectId: project.id })]);
			const restoredProject = projects.find((p) => p.id === project.id);
			if (restoredProject) dispatch({ type: "updateProject", project: restoredProject });
			dispatch({ type: "setTasks", projectId: project.id, tasks });
			toast.success(t.plural("boardCopy.restored", result.restored, { name: project.name }), { source: "dashboard" });
			if (result.missing > 0) toast.error(t.plural("boardCopy.restoreMissing", result.missing), { source: "dashboard" });
		} catch (err) {
			toast.error(t("boardCopy.restoreFailed", { name: project.name, error: String(err) }), { source: "dashboard" });
		}
	}

	const boardCopySwitch = (
		<div className="flex items-center justify-between gap-4">
			<div className="space-y-0.5">
				<span className="block text-fg-2 text-sm font-medium">{t("boardCopy.addSwitch")}</span>
				<span className="block text-fg-3 text-xs leading-5">{t("boardCopy.addSwitchHint")}</span>
			</div>
			<ToggleSwitch checked={boardCopy} ariaLabel={t("boardCopy.addSwitch")} onToggle={() => setBoardCopy((on) => !on)} />
		</div>
	);

	// Lives inside the Local and Clone panes, so the tab strip stays put on New, which has nothing to detect.
	const autoConfigureSwitch = (
		<div className="flex items-center justify-between gap-4">
			<div className="space-y-0.5">
				<span className="block text-fg-2 text-sm font-medium">{t("addProject.autoConfig")}</span>
				<span className="block text-fg-3 text-xs leading-5">{t("addProject.autoConfigHint")}</span>
			</div>
			<ToggleSwitch checked={autoConfigure} ariaLabel={t("addProject.autoConfig")} onToggle={() => void toggleAutoConfigure()} />
		</div>
	);

	async function handleBrowseLocal() {
		if (browsing) return;
		setError(null);
		setBrowsing(true);
		try {
			const folders = await openFolderPickerMulti();
			if (!folders || folders.length === 0) return;

			const errors: string[] = [];
			const added: Project[] = [];
			let anySucceeded = false;
			for (const folder of folders) {
				// The backend names the project — see the addProject RPC comment.
				const name = folder;
				try {
					const first = await api.request.addProject({
						path: folder,
						...(autoConfigure ? { autoConfigure: true } : {}),
						...(boardCopy ? { boardCopy: true } : {}),
					});
					const result = !first.ok && first.gitInit
						? (await initAfterConfirm(first.gitInit, autoConfigure)) ?? { ok: false as const, error: t("addProject.gitInit.declined") }
						: first;
					if (result.ok) {
						dispatch({ type: "addProject", project: result.project });
						reportAutoConfigured(result.project, result.autoConfigured);
						await offerBoardCopyRestore(result.project, result.boardCopyOffer);
						added.push(result.project);
						void applyPendingSpaces(result.project.id);
						trackEvent("project_added", { source: "local" });
						posthog.capture("project_added", { source: "local" });
						anySucceeded = true;
					} else {
						errors.push(`${name}: ${result.error}`);
					}
				} catch (err) {
					errors.push(`${name}: ${String(err)}`);
				}
			}

			if (errors.length === 0) {
				onClose();
				if (added.length > 0) onGitProjectsAdded?.(added);
			} else if (anySucceeded) {
				onClose();
				if (added.length > 0) onGitProjectsAdded?.(added);
				for (const err of errors) toast.error(err, { source: "dashboard" });
			} else {
				setError(errors.join("\n"));
			}
		} catch (err) {
			setError(String(err));
		} finally {
			setBrowsing(false);
		}
	}

	async function handleInitNew() {
		if (initializing) return;
		setError(null);
		let folder: string | null;
		try {
			folder = await openFolderPicker({
				allowCreateFolder: true,
				title: t("addProject.initPickerTitle"),
			});
		} catch (err) {
			setError(String(err));
			return;
		}
		if (!folder) return;
		setInitializing(true);
		try {
			const first = await api.request.initAndAddProject({ path: folder, ...(boardCopy ? { boardCopy: true } : {}) });
			const result = !first.ok && first.gitInit
				? (await initAfterConfirm(first.gitInit, false)) ?? { ok: false as const, error: t("addProject.gitInit.declined") }
				: first;
			if (result.ok) {
				dispatch({ type: "addProject", project: result.project });
				await offerBoardCopyRestore(result.project, result.boardCopyOffer);
				void applyPendingSpaces(result.project.id);
				trackEvent("project_added", { source: "init" });
				posthog.capture("project_added", { source: "init" });
				onClose();
				onGitProjectsAdded?.([result.project]);
			} else {
				setError(result.error);
			}
		} catch (err) {
			setError(String(err));
		} finally {
			setInitializing(false);
		}
	}

	async function handlePickBaseDir() {
		let folder: string | null;
		try {
			folder = await openFolderPicker({ initialPath: cloneBaseDir });
		} catch (err) {
			console.error("[AddProjectModal] openFolderPicker failed:", err);
			return;
		}
		if (!folder) return;
		setCloneBaseDir(folder);
		try {
			const settings = await api.request.getGlobalSettings();
			await api.request.saveGlobalSettings({
				...settings,
				cloneBaseDirectory: folder,
			});
		} catch {
			// Settings save is best-effort
		}
	}

	async function handleClone() {
		if (!gitUrl.trim() || !cloneBaseDir || cloning) return;
		setCloning(true);
		setError(null);
		setCloneOutput([]);
		const progressId = crypto.randomUUID();
		cloneProgressIdRef.current = progressId;
		try {
			const result = await api.request.cloneAndAddProject({
				url: gitUrl.trim(),
				baseDir: cloneBaseDir,
				repoName: repoName.trim() || undefined,
				progressId,
				...(autoConfigure ? { autoConfigure: true } : {}),
				...(boardCopy ? { boardCopy: true } : {}),
			});
			if (result.ok) {
				dispatch({ type: "addProject", project: result.project });
				reportAutoConfigured(result.project, result.autoConfigured);
				await offerBoardCopyRestore(result.project, result.boardCopyOffer);
				void applyPendingSpaces(result.project.id);
				trackEvent("project_added", { source: "clone" });
				posthog.capture("project_added", { source: "clone" });
				onClose();
				onGitProjectsAdded?.([result.project]);
			} else {
				setError(result.error);
			}
		} catch (err) {
			setError(String(err));
		}
		cloneProgressIdRef.current = null;
		setCloning(false);
	}

	async function handleCreateOps() {
		if (creatingOps) return;
		setCreatingOps(true);
		setError(null);
		try {
			const result = await api.request.addVirtualProject({ name: opsName.trim() || "Operations" });
			if (result.ok) {
				dispatch({ type: "addProject", project: result.project });
				trackEvent("project_added", { source: "operations" });
				posthog.capture("project_added", { source: "operations" });
				onClose();
			} else {
				setError(result.error);
			}
		} catch (err) {
			setError(String(err));
		} finally {
			setCreatingOps(false);
		}
	}

	const canClone = gitUrl.trim() && cloneBaseDir && !cloning;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="add-project-dialog-title"
				tabIndex={-1}
				// The Clone tab is ~690px tall now; a short window has no scroll of its own here.
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[32.5rem] max-h-[90vh] overflow-y-auto p-6 space-y-5 outline-none"
			>
				<div className="flex items-center gap-1.5">
					<h2 id="add-project-dialog-title" className="text-fg text-lg font-semibold">
						{t("addProject.title")}
					</h2>
					<HelpSpot topicId="modal.add-project" className="w-5 h-5 text-base" />
				</div>

				{/* Kind toggle: Git repository | Operations */}
				<div className="flex gap-1 p-1 bg-raised rounded-xl">
					<button
						onClick={() => { setKind("git"); setError(null); }}
						className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
							kind === "git" ? "bg-elevated text-fg shadow-sm" : "text-fg-3 hover:text-fg-2"
						}`}
					>
						{t("ops.create.typeGit")}
					</button>
					<button
						onClick={() => { setKind("operations"); setError(null); }}
						className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
							kind === "operations" ? "bg-elevated text-fg shadow-sm" : "text-fg-3 hover:text-fg-2"
						}`}
					>
						{t("ops.create.typeOps")}
					</button>
				</div>

				{kind === "operations" ? (
					<div className="space-y-3">
						<p className="text-fg-3 text-sm">{t("ops.create.hint")}</p>
						<div className="space-y-1.5">
							<label htmlFor="add-project-ops-name" className="text-fg-2 text-sm font-medium">{t("ops.create.nameLabel")}</label>
							<input
								id="add-project-ops-name"
								type="text"
								autoFocus
								value={opsName}
								onChange={(e) => setOpsName(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter" && !creatingOps) handleCreateOps(); }}
								placeholder={t("ops.create.namePlaceholder")}
								className="w-full px-3 py-2.5 bg-elevated border border-edge-active rounded-xl text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/50 transition-colors"
							/>
						</div>
					</div>
				) : (
				<>
				{/* Blast-radius copy (bible §10): standing, not dismissible — over half the
				    userbase point this at a work monorepo and ask what it writes first.
				    Two lines, deliberately. Longer copy is its own way of scaring people off. */}
				<div className="bg-raised border border-edge rounded-xl px-3 py-2.5 space-y-1.5 text-fg-3 text-xs leading-5">
					<p>{t("addProject.safetyBase")}</p>
					<p>{t("addProject.safetyBranch")}</p>
				</div>

				{/* Tabs */}
				<div className="flex gap-1 p-1 bg-raised rounded-xl">
					<button
						onClick={() => { setActiveTab("local"); setError(null); }}
						className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
							activeTab === "local"
								? "bg-elevated text-fg shadow-sm"
								: "text-fg-3 hover:text-fg-2"
						}`}
					>
						{t("addProject.tabLocal")}
					</button>
					<button
						onClick={() => { setActiveTab("clone"); setError(null); }}
						className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
							activeTab === "clone"
								? "bg-elevated text-fg shadow-sm"
								: "text-fg-3 hover:text-fg-2"
						}`}
					>
						{t("addProject.tabClone")}
					</button>
					<button
						onClick={() => { setActiveTab("init"); setError(null); }}
						className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
							activeTab === "init"
								? "bg-elevated text-fg shadow-sm"
								: "text-fg-3 hover:text-fg-2"
						}`}
					>
						{t("addProject.tabInit")}
					</button>
				</div>

				{/* Tab content */}
				{activeTab === "local" ? (
					<div className="space-y-3">
						<p className="text-fg-3 text-sm">
							{t("addProject.browseHint")}
						</p>
						{autoConfigureSwitch}
						{boardCopySwitch}
						<button
							onClick={handleBrowseLocal}
							disabled={browsing}
							className="w-full px-4 py-3 bg-accent-fill text-white text-sm font-semibold rounded-xl hover:bg-accent-fill-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							{browsing ? t("addProject.adding") : t("addProject.browseBtn")}
						</button>
					</div>
				) : activeTab === "init" ? (
					<div className="space-y-3">
						<p className="text-fg-3 text-sm">
							{t("addProject.initHint")}
						</p>
						{boardCopySwitch}
						<button
							onClick={handleInitNew}
							disabled={initializing}
							className="w-full px-4 py-3 bg-accent-fill text-white text-sm font-semibold rounded-xl hover:bg-accent-fill-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							{initializing ? t("addProject.initializing") : t("addProject.initBtn")}
						</button>
					</div>
				) : (
					<div className="space-y-4">
						{/* Git URL */}
						<div className="space-y-1.5">
							<label htmlFor="add-project-git-url" className="text-fg-2 text-sm font-medium">
								{t("addProject.gitUrl")}
							</label>
							<input
								id="add-project-git-url"
								ref={urlInputRef}
								type="text"
								value={gitUrl}
								onChange={(e) => setGitUrl(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canClone) {
										handleClone();
									}
								}}
								placeholder={t("addProject.gitUrlPlaceholder")}
								className="w-full px-3 py-2.5 bg-elevated border border-edge-active rounded-xl text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/50 transition-colors font-mono"
							/>
						</div>

						{/* Repository Name (optional) */}
						<div className="space-y-1.5">
							<label htmlFor="add-project-repo-name" className="text-fg-2 text-sm font-medium">
								{t("addProject.repoName")}
							</label>
							<input
								id="add-project-repo-name"
								type="text"
								value={repoName}
								onChange={(e) => setRepoName(e.target.value)}
								placeholder={inferredName || t("addProject.repoNamePlaceholder")}
								className="w-full px-3 py-2.5 bg-elevated border border-edge rounded-xl text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/50 transition-colors"
							/>
						</div>

						{/* Clone Base Directory */}
						<div className="space-y-1.5">
							<p className="text-fg-2 text-sm font-medium">
								{t("addProject.cloneBaseDir")}
							</p>
							<div className="flex gap-2">
								<div className="flex-1 px-3 py-2.5 bg-raised border border-edge rounded-xl text-sm font-mono truncate">
									{cloneBaseDir ? (
										<span className="text-fg">{cloneBaseDir}</span>
									) : (
										<span className="text-fg-muted">{t("addProject.cloneBaseDirNotSet")}</span>
									)}
								</div>
								<button
									onClick={handlePickBaseDir}
									className="px-3 py-2.5 bg-raised border border-edge rounded-xl text-fg-2 text-sm hover:border-edge-active transition-colors flex-shrink-0"
								>
									{cloneBaseDir ? t("addProject.changeCloneDir") : t("addProject.pickCloneDir")}
								</button>
							</div>
						</div>

						{/* Target path preview */}
						{targetPath && (
							<div className="text-fg-3 text-xs font-mono">
								{t("addProject.targetPath")} {targetPath}
							</div>
						)}

						{autoConfigureSwitch}
						{boardCopySwitch}

						{/* Live clone output (last lines of `git clone --progress`) */}
						{cloning && (
							<div
								role="status"
								aria-live="polite"
								className="bg-raised border border-edge rounded-xl px-3 py-2 font-mono text-xs text-fg-3 leading-5 h-24 overflow-hidden"
							>
								{(cloneOutput.length > 0 ? cloneOutput : [t("addProject.cloning")]).map((line, i) => (
									<div key={i} className="truncate">{line}</div>
								))}
							</div>
						)}
					</div>
				)}

				{/* Optional space memberships, applied after the project is created */}
				<div className="flex items-center gap-3">
					<span className="text-fg-2 text-sm font-medium flex-shrink-0">{t("spaces.fieldLabel")}</span>
					<ProjectSpacesField mode="deferred" value={pendingSpaces} onChange={setPendingSpaces} />
				</div>
				</>
				)}

				{/* Error */}
				{error && (
					<div className="text-danger text-sm bg-danger/10 px-3 py-2 rounded-lg whitespace-pre-line">
						{error}
					</div>
				)}

				{/* Actions */}
				<div className="flex items-center justify-end gap-2 pt-1">
					<button
						onClick={onClose}
						className="px-4 py-1.5 text-fg-3 text-sm hover:text-fg transition-colors rounded-lg"
					>
						{t("addProject.cancel")}
					</button>
					{kind === "git" && activeTab === "clone" && (
						<button
							onClick={handleClone}
							disabled={!canClone}
							className="px-4 py-1.5 bg-accent-fill text-white text-sm font-semibold rounded-lg hover:bg-accent-fill-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							{cloning ? t("addProject.cloning") : t("addProject.cloneBtn")}
						</button>
					)}
					{kind === "operations" && (
						<button
							onClick={handleCreateOps}
							disabled={creatingOps}
							className="px-4 py-1.5 bg-accent-fill text-white text-sm font-semibold rounded-lg hover:bg-accent-fill-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							{creatingOps ? t("addProject.adding") : t("ops.create.submit")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

export default AddProjectModal;
