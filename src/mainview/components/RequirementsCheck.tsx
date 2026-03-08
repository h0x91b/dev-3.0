import { useState, useCallback } from "react";
import type { RequirementCheckResult } from "../../shared/types";
import { useT } from "../i18n";
import { api } from "../rpc";

interface Props {
	results: RequirementCheckResult[];
	checking: boolean;
	onRefresh: () => void;
	onRefreshResults: () => Promise<void>;
}

export default function RequirementsCheck({ results, checking, onRefresh, onRefreshResults }: Props) {
	const t = useT();
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [customPaths, setCustomPaths] = useState<Record<string, string>>({});
	const [savingId, setSavingId] = useState<string | null>(null);

	const handleCopy = useCallback((id: string, command: string) => {
		navigator.clipboard.writeText(command);
		setCopiedId(id);
		setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000);
	}, []);

	const handleSetCustomPath = useCallback(async (reqId: string) => {
		const path = customPaths[reqId]?.trim();
		if (!path) return;
		setSavingId(reqId);
		try {
			await api.request.setCustomBinaryPath({ requirementId: reqId, path });
			await onRefreshResults();
		} catch (err) {
			console.error("Failed to save custom binary path:", err);
		}
		setSavingId(null);
	}, [customPaths, onRefresh]);

	return (
		<div className="h-full w-full flex items-center justify-center bg-base">
			<div className="max-w-md w-full px-6">
				<h1 className="text-2xl font-semibold text-fg mb-2">
					{t("requirements.title")}
				</h1>
				<p className="text-fg-3 text-sm mb-6">
					{t("requirements.subtitle")}
				</p>

				<div className="space-y-3 mb-6">
					{results.map((req) => (
						<div
							key={req.id}
							className="flex items-start gap-3 p-3 rounded-lg bg-raised"
						>
							<span className="mt-0.5 text-lg leading-none">
								{req.installed ? (
									<span className="text-green-400">&#10003;</span>
								) : (
									<span className="text-danger">&#10007;</span>
								)}
							</span>
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2">
									<span className="font-medium text-fg">{req.name}</span>
									{req.optional && (
										<span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-fg-muted/10 text-fg-muted">
											{t("requirements.optional")}
										</span>
									)}
									<span
										className={`text-xs px-1.5 py-0.5 rounded ${
											req.installed
												? "bg-green-400/15 text-green-400"
												: req.optional
													? "bg-yellow-400/15 text-yellow-400"
													: "bg-danger/15 text-danger"
										}`}
									>
										{req.installed
											? t("requirements.installed")
											: t("requirements.missing")}
									</span>
								</div>
								{req.installed && req.resolvedPath && (
									<p className="text-fg-muted text-xs mt-1 font-mono truncate">
										{req.resolvedPath}
									</p>
								)}
								{!req.installed && (
									<div className="mt-2">
										<p className="text-fg-muted text-xs mb-1.5">
											{t(req.installHint as any)}
										</p>
										<div className="flex items-center gap-1.5">
											<code className="text-yellow-400 bg-yellow-400/10 px-2 py-1 rounded text-xs font-mono">
												{req.installCommand}
											</code>
											<button
												type="button"
												onClick={() => handleCopy(req.id, req.installCommand)}
												className="p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg shrink-0"
												title="Copy"
											>
												{copiedId === req.id ? (
													<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
														<polyline points="20 6 9 17 4 12" />
													</svg>
												) : (
													<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
														<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
														<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
													</svg>
												)}
											</button>
											{copiedId === req.id && (
												<span className="text-green-400 text-xs">
													{t("requirements.copied")}
												</span>
											)}
										</div>
										<div className="mt-2.5 pt-2.5 border-t border-edge/50">
											<p className="text-fg-3 text-xs mb-1.5">
												{t("requirements.customPathHint")}
											</p>
											{req.customPathError && (
												<p className="text-danger text-xs mb-1.5">
													{t("requirements.pathNotFound")}
												</p>
											)}
											<div className="flex items-center gap-1.5">
												<input
													type="text"
													value={customPaths[req.id] ?? ""}
													onChange={(e) => setCustomPaths((prev) => ({ ...prev, [req.id]: e.target.value }))}
													placeholder={`/path/to/${req.name.toLowerCase()}`}
													className={`flex-1 bg-base border rounded px-2 py-1 text-xs font-mono text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none ${req.customPathError ? "border-danger" : "border-edge"}`}
												/>
												<button
													type="button"
													onClick={() => handleSetCustomPath(req.id)}
													disabled={!customPaths[req.id]?.trim() || savingId === req.id}
													className="px-2.5 py-1 rounded bg-accent text-white text-xs font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors shrink-0"
												>
													{t("requirements.setPath")}
												</button>
											</div>
										</div>
									</div>
								)}
							</div>
						</div>
					))}
				</div>

				<button
					type="button"
					onClick={onRefresh}
					disabled={checking}
					className="w-full py-2 px-4 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
				>
					{checking ? (
						<span className="flex items-center justify-center gap-2">
							<span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
							{t("requirements.refresh")}
						</span>
					) : (
						t("requirements.refresh")
					)}
				</button>
			</div>
		</div>
	);
}
