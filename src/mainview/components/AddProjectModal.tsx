import { useState, useEffect, useRef, type Dispatch } from "react";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { extractRepoName } from "../../shared/types";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";
import { openFolderPicker, openFolderPickerMulti } from "../folder-picker";
import { toast } from "../toast";
import { useFocusTrap } from "../utils/useFocusTrap";

interface AddProjectModalProps {
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
}

function AddProjectModal({ dispatch, onClose }: AddProjectModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const [kind, setKind] = useState<"git" | "operations">("git");
	const [opsName, setOpsName] = useState("");
	const [creatingOps, setCreatingOps] = useState(false);
	const [activeTab, setActiveTab] = useState<"local" | "clone" | "init">("local");
	const [gitUrl, setGitUrl] = useState("");
	const [repoName, setRepoName] = useState("");
	const [cloneBaseDir, setCloneBaseDir] = useState<string | null>(null);
	const [cloning, setCloning] = useState(false);
	const [browsing, setBrowsing] = useState(false);
	const [initializing, setInitializing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [cloneOutput, setCloneOutput] = useState<string[]>([]);
	const cloneProgressIdRef = useRef<string | null>(null);
	const urlInputRef = useRef<HTMLInputElement>(null);

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
		}).catch(() => {});
	}, []);

	useEffect(() => {
		if (activeTab === "clone") {
			urlInputRef.current?.focus();
		}
	}, [activeTab]);

	useEscapeKey(onClose);

	const inferredName = gitUrl.trim() ? extractRepoName(gitUrl.trim()) : "";
	const displayName = repoName.trim() || inferredName;
	const targetPath = cloneBaseDir && displayName ? `${cloneBaseDir}/${displayName}` : "";

	async function handleBrowseLocal() {
		if (browsing) return;
		setError(null);
		setBrowsing(true);
		try {
			const folders = await openFolderPickerMulti();
			if (!folders || folders.length === 0) return;

			const errors: string[] = [];
			let anySucceeded = false;
			for (const folder of folders) {
				const name = folder.split("/").pop() || folder;
				try {
					const result = await api.request.addProject({ path: folder, name });
					if (result.ok) {
						dispatch({ type: "addProject", project: result.project });
						trackEvent("project_added", { source: "local" });
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
			} else if (anySucceeded) {
				onClose();
				for (const err of errors) toast.error(err);
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
			const name = folder.split("/").pop() || folder;
			const result = await api.request.initAndAddProject({ path: folder, name });
			if (result.ok) {
				dispatch({ type: "addProject", project: result.project });
				trackEvent("project_added", { source: "init" });
				onClose();
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
			});
			if (result.ok) {
				dispatch({ type: "addProject", project: result.project });
				trackEvent("project_added", { source: "clone" });
				onClose();
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
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[32.5rem] p-6 space-y-5 outline-none"
			>
				<h2 className="text-fg text-lg font-semibold">
					{t("addProject.title")}
				</h2>

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
							<label className="text-fg-2 text-sm font-medium">{t("ops.create.nameLabel")}</label>
							<input
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
						<button
							onClick={handleBrowseLocal}
							disabled={browsing}
							className="w-full px-4 py-3 bg-accent text-white text-sm font-semibold rounded-xl hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							{browsing ? t("addProject.adding") : t("addProject.browseBtn")}
						</button>
					</div>
				) : activeTab === "init" ? (
					<div className="space-y-3">
						<p className="text-fg-3 text-sm">
							{t("addProject.initHint")}
						</p>
						<button
							onClick={handleInitNew}
							disabled={initializing}
							className="w-full px-4 py-3 bg-accent text-white text-sm font-semibold rounded-xl hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							{initializing ? t("addProject.initializing") : t("addProject.initBtn")}
						</button>
					</div>
				) : (
					<div className="space-y-4">
						{/* Git URL */}
						<div className="space-y-1.5">
							<label className="text-fg-2 text-sm font-medium">
								{t("addProject.gitUrl")}
							</label>
							<input
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
							<label className="text-fg-2 text-sm font-medium">
								{t("addProject.repoName")}
							</label>
							<input
								type="text"
								value={repoName}
								onChange={(e) => setRepoName(e.target.value)}
								placeholder={inferredName || t("addProject.repoNamePlaceholder")}
								className="w-full px-3 py-2.5 bg-elevated border border-edge rounded-xl text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/50 transition-colors"
							/>
						</div>

						{/* Clone Base Directory */}
						<div className="space-y-1.5">
							<label className="text-fg-2 text-sm font-medium">
								{t("addProject.cloneBaseDir")}
							</label>
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
							className="px-4 py-1.5 bg-accent text-white text-sm font-semibold rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							{cloning ? t("addProject.cloning") : t("addProject.cloneBtn")}
						</button>
					)}
					{kind === "operations" && (
						<button
							onClick={handleCreateOps}
							disabled={creatingOps}
							className="px-4 py-1.5 bg-accent text-white text-sm font-semibold rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
