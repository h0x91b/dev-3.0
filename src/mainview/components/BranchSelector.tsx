import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";
import HelpSpot from "./HelpSpot";

export interface BranchInfo {
	name: string;
	isRemote: boolean;
}

/** Detect GitHub fork reference format: "user:branch" */
const FORK_REF_RE = /^([a-zA-Z0-9_-]+):(.+)$/;

export function parseForkRef(query: string): { forkOwner: string; branchName: string } | null {
	const match = query.match(FORK_REF_RE);
	if (!match) return null;
	return { forkOwner: match[1], branchName: match[2] };
}

/** Detect a GitHub-style pull-request URL: https://<host>/<owner>/<repo>/pull/<number> (optional /files, ?query, #hash suffix). */
const PR_URL_RE = /https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/(\d+)(?:[/?#]\S*)?/i;

export function parsePrUrl(input: string): { url: string; number: number } | null {
	const match = input.match(PR_URL_RE);
	if (!match) return null;
	const number = Number(match[1]);
	if (!Number.isFinite(number)) return null;
	return { url: match[0], number };
}

export function normalizeBranchQuery(query: string): string {
	return query.trim().replace(":", "/");
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
	// Normalize fork ref format: "user:branch" → "user/branch" for matching
	const normalizedQuery = normalizeBranchQuery(query);
	const words = splitBranchWords(branchName);
	// Tokenize the query on the same separators as branch names (/, -, _, ., space)
	// so a dashed query like "login-page" splits into ["login", "page"] instead of
	// staying one token that prefix-matches nothing and finds no branch. (camelCase
	// is intentionally NOT split here — the user's raw query casing must not fragment
	// their input the way it does for the branch names being searched.)
	const tokens = normalizedQuery.toLowerCase().split(/[/\-_.]+|\s+/).filter(Boolean);
	// Every query token must prefix-match some word in the branch name.
	return tokens.every((token) => words.some((w) => w.startsWith(token)));
}

function isForkRemoteBranch(branch: BranchInfo): boolean {
	return branch.isRemote && !branch.name.startsWith("origin/");
}

export function sortBranchesForDisplay(
	branches: BranchInfo[],
	options: { preferRemote: boolean; prioritizedBranchNames?: string[] },
): BranchInfo[] {
	const prioritizedNames = new Set(options.prioritizedBranchNames ?? []);

	return [...branches].sort((a, b) => {
		const aPriority = prioritizedNames.has(a.name) ? 1 : 0;
		const bPriority = prioritizedNames.has(b.name) ? 1 : 0;
		if (aPriority !== bPriority) return bPriority - aPriority;

		if (options.preferRemote && a.isRemote !== b.isRemote) {
			return a.isRemote ? -1 : 1;
		}

		const aForkRemote = isForkRemoteBranch(a) ? 1 : 0;
		const bForkRemote = isForkRemoteBranch(b) ? 1 : 0;
		if (aForkRemote !== bForkRemote) return bForkRemote - aForkRemote;

		if (!options.preferRemote && a.isRemote !== b.isRemote) {
			return a.isRemote ? 1 : -1;
		}

		return a.name.localeCompare(b.name);
	});
}

interface BranchSelectorProps {
	projectId: string;
	selectedBranch: string | null;
	onSelectBranch: (branch: string | null) => void;
	reviewMode: boolean;
	onReviewModeChange: (enabled: boolean) => void;
}

function BranchSelector({ projectId, selectedBranch, onSelectBranch, reviewMode, onReviewModeChange }: BranchSelectorProps) {
	const t = useT();
	const [branchQuery, setBranchQuery] = useState("");
	const [branches, setBranches] = useState<BranchInfo[]>([]);
	const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
	const [fetchingBranches, setFetchingBranches] = useState(false);
	const [branchesLoaded, setBranchesLoaded] = useState(false);
	const [branchSectionOpen, setBranchSectionOpen] = useState(false);
	const [prioritizedBranchNames, setPrioritizedBranchNames] = useState<string[]>([]);
	const [resolvingPr, setResolvingPr] = useState(false);
	const [prError, setPrError] = useState<string | null>(null);
	const branchInputRef = useRef<HTMLInputElement>(null);
	const branchDropdownRef = useRef<HTMLDivElement>(null);

	const prMatch = parsePrUrl(branchQuery);

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
			const parsedForkRef = parseForkRef(branchQuery);
			const forkRef = parsedForkRef ? branchQuery : undefined;
			const result = await api.request.fetchBranches({ projectId, forkRef });
			setBranches(result);
			setBranchesLoaded(true);
			setBranchDropdownOpen(true);

			if (parsedForkRef) {
				const expectedRemote = `${parsedForkRef.forkOwner}/${parsedForkRef.branchName}`;
				const found = result.find((b) => b.name === expectedRemote);
				if (found) {
					setPrioritizedBranchNames((prev) => [expectedRemote, ...prev.filter((name) => name !== expectedRemote)]);
					setBranchQuery(expectedRemote);
				}
			}
		} catch {
			// silently fail
		} finally {
			setFetchingBranches(false);
		}
	}, [projectId, branchQuery]);

	const handleResolvePr = useCallback(async () => {
		const pr = parsePrUrl(branchQuery);
		if (!pr) return;
		setResolvingPr(true);
		setPrError(null);
		try {
			const result = await api.request.resolvePrUrl({ projectId, url: pr.url });
			if (result.ok && result.branch) {
				onSelectBranch(result.branch);
				onReviewModeChange(true);
				setBranchQuery("");
				setBranchDropdownOpen(false);
			} else {
				setPrError(result.error || t("createTask.prResolveFailedShort"));
			}
		} catch {
			setPrError(t("createTask.prResolveFailedShort"));
		} finally {
			setResolvingPr(false);
		}
	}, [branchQuery, projectId, onSelectBranch, onReviewModeChange, t]);

	const preferRemoteBranches = reviewMode || prioritizedBranchNames.length > 0 || parseForkRef(branchQuery) !== null;
	const filteredBranches = sortBranchesForDisplay(
		branches.filter((b) =>
		matchesBranchQuery(b.name, branchQuery),
		),
		{ preferRemote: preferRemoteBranches, prioritizedBranchNames },
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
				<div className="flex items-center gap-1.5">
					<label className="text-fg-2 text-sm font-medium">
						{t("createTask.branchLabel")}
					</label>
					<HelpSpot topicId="field.task-branch" />
				</div>
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
								onChange={(e) => { setBranchQuery(e.target.value); setPrError(null); }}
								onFocus={() => {
									loadBranches();
									setBranchDropdownOpen(true);
								}}
								placeholder={t("createTask.branchPlaceholder")}
								className="w-full px-3 py-2 bg-elevated border border-edge-active rounded-xl text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/50 transition-colors"
							/>
						)}
					</div>
					{prMatch ? (
						<button
							type="button"
							onClick={handleResolvePr}
							disabled={resolvingPr}
							className="px-3 py-2 bg-accent/15 border border-accent/40 rounded-xl text-accent text-xs font-medium hover:bg-accent/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0 flex items-center gap-1.5"
						>
							<svg className={`w-3.5 h-3.5 ${resolvingPr ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
							</svg>
							{resolvingPr ? t("createTask.prResolving") : t("createTask.branchResolvePr")}
						</button>
					) : (
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
					)}
				</div>

				{branchDropdownOpen && !selectedBranch && (
					<div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-overlay border border-edge rounded-xl shadow-lg">
						{(preferRemoteBranches ? remoteBranches.length > 0 : localBranches.length > 0) && (
							<>
								<div className="px-3 py-1 text-[0.625rem] font-semibold text-fg-muted uppercase tracking-wider">
									{preferRemoteBranches ? t("createTask.branchRemote") : t("createTask.branchLocal")}
								</div>
								{(preferRemoteBranches ? remoteBranches : localBranches).map((b) => (
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

						{(preferRemoteBranches ? localBranches.length > 0 : remoteBranches.length > 0) && (
							<>
								<div className="px-3 py-1 text-[0.625rem] font-semibold text-fg-muted uppercase tracking-wider">
									{preferRemoteBranches ? t("createTask.branchLocal") : t("createTask.branchRemote")}
								</div>
								{(preferRemoteBranches ? localBranches : remoteBranches).map((b) => (
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
								{parseForkRef(branchQuery)
									? t("createTask.branchForkHint")
									: t("createTask.branchNoneFound")
								}
							</div>
						)}
					</div>
				)}
			</div>

			{prError && !selectedBranch && (
				<p className="text-xs text-danger">{prError}</p>
			)}

			{/* Review mode toggle — shown when a branch is selected */}
			{selectedBranch && (
				<label
					className="flex items-center gap-2 cursor-pointer group/review"
					title={t("createTask.reviewModeHint")}
				>
					<button
						type="button"
						role="switch"
						aria-checked={reviewMode}
						onClick={() => onReviewModeChange(!reviewMode)}
						className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
							reviewMode ? "bg-accent" : "bg-fg/20"
						}`}
					>
						<span
							className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
								reviewMode ? "translate-x-3.5" : "translate-x-0.5"
							}`}
						/>
					</button>
					<span className={`text-xs transition-colors ${reviewMode ? "text-accent font-medium" : "text-fg-3 group-hover/review:text-fg-2"}`}>
						{t("createTask.reviewMode")}
					</span>
				</label>
			)}
		</div>
	);
}

export default BranchSelector;
