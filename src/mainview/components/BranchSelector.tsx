import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";

interface BranchInfo {
	name: string;
	isRemote: boolean;
}

/** Split a branch name into words on /, -, _, ., and camelCase boundaries. */
export function splitBranchWords(name: string): string[] {
	return name
		// insert a split before uppercase letters in camelCase: "myBranch" → "my Branch"
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[/\-_.]+|\s+/)
		.filter(Boolean)
		.map((w) => w.toLowerCase());
}

/** Check if any word in the branch name starts with any query token. */
export function matchesBranchQuery(branchName: string, query: string): boolean {
	if (!query) return true;
	const words = splitBranchWords(branchName);
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	return tokens.every((token) => words.some((w) => w.startsWith(token)));
}

interface BranchSelectorProps {
	projectId: string;
	selectedBranch: string | null;
	onSelectBranch: (branch: string | null) => void;
}

function BranchSelector({ projectId, selectedBranch, onSelectBranch }: BranchSelectorProps) {
	const t = useT();
	const [branchQuery, setBranchQuery] = useState("");
	const [branches, setBranches] = useState<BranchInfo[]>([]);
	const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
	const [fetchingBranches, setFetchingBranches] = useState(false);
	const [branchesLoaded, setBranchesLoaded] = useState(false);
	const [branchSectionOpen, setBranchSectionOpen] = useState(false);
	const branchInputRef = useRef<HTMLInputElement>(null);
	const branchDropdownRef = useRef<HTMLDivElement>(null);

	const loadBranches = useCallback(async () => {
		if (branchesLoaded) return;
		try {
			const result = await api.request.listBranches({ projectId });
			setBranches(result);
			setBranchesLoaded(true);
		} catch {
			// silently fail — branch selector is optional
		}
	}, [projectId, branchesLoaded]);

	const handleFetchBranches = useCallback(async () => {
		setFetchingBranches(true);
		try {
			const result = await api.request.fetchBranches({ projectId });
			setBranches(result);
			setBranchesLoaded(true);
		} catch {
			// silently fail
		} finally {
			setFetchingBranches(false);
		}
	}, [projectId]);

	const filteredBranches = branches.filter((b) =>
		matchesBranchQuery(b.name, branchQuery),
	);

	const localBranches = filteredBranches.filter((b) => !b.isRemote);
	const remoteBranches = filteredBranches.filter((b) => b.isRemote);

	// Close dropdown on outside click
	useEffect(() => {
		function handleClickOutside(e: MouseEvent) {
			if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
				setBranchDropdownOpen(false);
			}
		}
		if (branchDropdownOpen) {
			document.addEventListener("mousedown", handleClickOutside);
			return () => document.removeEventListener("mousedown", handleClickOutside);
		}
	}, [branchDropdownOpen]);

	if (!branchSectionOpen && !selectedBranch) {
		return (
			<button
				type="button"
				onClick={() => {
					setBranchSectionOpen(true);
					loadBranches();
				}}
				className="px-3 py-1.5 bg-elevated border border-edge rounded-lg text-fg-2 text-xs hover:bg-elevated-hover hover:border-edge-active transition-colors flex items-center gap-1.5"
			>
				<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
				</svg>
				{t("createTask.useExistingBranch")}
			</button>
		);
	}

	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between">
				<label className="text-fg-2 text-sm font-medium">
					{t("createTask.branchLabel")}
				</label>
				{!selectedBranch && (
					<button
						type="button"
						onClick={() => {
							setBranchSectionOpen(false);
							setBranchQuery("");
							setBranchDropdownOpen(false);
						}}
						className="text-fg-muted text-xs hover:text-fg-3 transition-colors"
					>
						{t("kanban.cancel")}
					</button>
				)}
			</div>
			<div className="relative" ref={branchDropdownRef}>
				<div className="flex gap-2">
					<div className="relative flex-1">
						{selectedBranch ? (
							<div className="flex items-center gap-2 w-full px-3 py-2 bg-elevated border border-edge-active rounded-xl text-fg text-sm">
								<svg className="w-3.5 h-3.5 text-fg-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
								</svg>
								<span className="truncate">{selectedBranch}</span>
								<button
									type="button"
									onClick={() => {
										onSelectBranch(null);
										setBranchQuery("");
									}}
									className="ml-auto text-fg-muted hover:text-fg transition-colors shrink-0"
								>
									<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							</div>
						) : (
							<input
								ref={branchInputRef}
								type="text"
								value={branchQuery}
								onChange={(e) => setBranchQuery(e.target.value)}
								onFocus={() => {
									loadBranches();
									setBranchDropdownOpen(true);
								}}
								placeholder={t("createTask.branchPlaceholder")}
								className="w-full px-3 py-2 bg-elevated border border-edge-active rounded-xl text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/50 transition-colors"
							/>
						)}
					</div>
					<button
						type="button"
						onClick={handleFetchBranches}
						disabled={fetchingBranches}
						className="px-3 py-2 bg-elevated border border-edge-active rounded-xl text-fg-2 text-xs font-medium hover:bg-elevated-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0 flex items-center gap-1.5"
					>
						<svg className={`w-3.5 h-3.5 ${fetchingBranches ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
						</svg>
						{fetchingBranches ? t("createTask.branchFetching") : t("createTask.branchFetch")}
					</button>
				</div>

				{branchDropdownOpen && !selectedBranch && (
					<div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-overlay border border-edge rounded-xl shadow-lg">
						{localBranches.length > 0 && (
							<>
								<div className="px-3 py-1 text-[0.625rem] font-semibold text-fg-muted uppercase tracking-wider">
									{t("createTask.branchLocal")}
								</div>
								{localBranches.map((b) => (
									<button
										key={b.name}
										type="button"
										onClick={() => {
											onSelectBranch(b.name);
											setBranchQuery("");
											setBranchDropdownOpen(false);
										}}
										className="w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-raised-hover transition-colors truncate"
									>
										{b.name}
									</button>
								))}
							</>
						)}

						{remoteBranches.length > 0 && (
							<>
								<div className="px-3 py-1 text-[0.625rem] font-semibold text-fg-muted uppercase tracking-wider">
									{t("createTask.branchRemote")}
								</div>
								{remoteBranches.map((b) => (
									<button
										key={b.name}
										type="button"
										onClick={() => {
											onSelectBranch(b.name);
											setBranchQuery("");
											setBranchDropdownOpen(false);
										}}
										className="w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-raised-hover transition-colors truncate"
									>
										{b.name}
									</button>
								))}
							</>
						)}

						{filteredBranches.length === 0 && branchesLoaded && (
							<div className="px-3 py-2 text-sm text-fg-muted">
								No branches found
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

export default BranchSelector;
