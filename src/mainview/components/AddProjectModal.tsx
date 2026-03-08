import { useState, useEffect, useRef, type Dispatch } from "react";
import { extractRepoName } from "../../shared/types";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { trackEvent } from "../analytics";

interface AddProjectModalProps {
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
}

function AddProjectModal({ dispatch, onClose }: AddProjectModalProps) {
	const t = useT();
	const [activeTab, setActiveTab] = useState<"local" | "clone">("local");
	const [gitUrl, setGitUrl] = useState("");
	const [repoName, setRepoName] = useState("");
	const [cloneBaseDir, setCloneBaseDir] = useState<string | null>(null);
	const [cloning, setCloning] = useState(false);
	const [browsing, setBrowsing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const urlInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		api.request.getGlobalSettings().then((settings) => {
			if (settings.cloneBaseDirectory) {
				setCloneBaseDir(settings.cloneBaseDirectory);
			}
		});
	}, []);

	useEffect(() => {
		if (activeTab === "clone") {
			urlInputRef.current?.focus();
		}
	}, [activeTab]);

	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [onClose]);

	const inferredName = gitUrl.trim() ? extractRepoName(gitUrl.trim()) : "";
	const displayName = repoName.trim() || inferredName;
	const targetPath = cloneBaseDir && displayName ? `${cloneBaseDir}/${displayName}` : "";

	async function handleBrowseLocal() {
		if (browsing) return;
		setBrowsing(true);
		try {
			const folder = await api.request.pickFolder();
			if (!folder) return;

			const name = folder.split("/").pop() || folder;
			const result = await api.request.addProject({ path: folder, name });

			if (result.ok) {
				dispatch({ type: "addProject", project: result.project });
				trackEvent("project_added", { source: "local" });
				onClose();
			} else {
				setError(result.error);
			}
		} catch (err) {
			setError(String(err));
		} finally {
			setBrowsing(false);
		}
	}

	async function handlePickBaseDir() {
		const folder = await api.request.pickFolder();
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
		try {
			const result = await api.request.cloneAndAddProject({
				url: gitUrl.trim(),
				baseDir: cloneBaseDir,
				repoName: repoName.trim() || undefined,
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
		setCloning(false);
	}

	const canClone = gitUrl.trim() && cloneBaseDir && !cloning;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[32.5rem] p-6 space-y-5">
				<h2 className="text-fg text-lg font-semibold">
					{t("addProject.title")}
				</h2>

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
					</div>
				)}

				{/* Error */}
				{error && (
					<div className="text-danger text-sm bg-danger/10 px-3 py-2 rounded-lg">
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
					{activeTab === "clone" && (
						<button
							onClick={handleClone}
							disabled={!canClone}
							className="px-4 py-1.5 bg-accent text-white text-sm font-semibold rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							{cloning ? t("addProject.cloning") : t("addProject.cloneBtn")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

export default AddProjectModal;
