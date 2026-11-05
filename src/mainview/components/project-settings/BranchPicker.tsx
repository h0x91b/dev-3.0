import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../../rpc";
import { useT } from "../../i18n";
import { matchesBranchQuery } from "../BranchSelector";

interface BranchInfo {
	name: string;
	isRemote: boolean;
}

interface BranchPickerProps {
	projectId: string;
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	label: string;
	includeRemote: boolean;
}

export function BranchPicker({
	projectId,
	value,
	onChange,
	placeholder,
	label,
	includeRemote,
}: BranchPickerProps) {
	const t = useT();
	const [branches, setBranches] = useState<BranchInfo[]>([]);
	const [branchesLoaded, setBranchesLoaded] = useState(false);
	const [dropdownOpen, setDropdownOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [query, setQuery] = useState("");
	const dropdownRef = useRef<HTMLDivElement>(null);

	const loadBranches = useCallback(async () => {
		if (branchesLoaded) return;
		try {
			const result = await api.request.listBranches({ projectId });
			setBranches(result);
			setBranchesLoaded(true);
		} catch {
			setBranchesLoaded(true);
		}
	}, [branchesLoaded, projectId]);

	useEffect(() => {
		function handleClickOutside(event: MouseEvent) {
			if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
				setDropdownOpen(false);
				setEditing(false);
				setQuery("");
			}
		}

		if (dropdownOpen) {
			document.addEventListener("mousedown", handleClickOutside);
			return () => document.removeEventListener("mousedown", handleClickOutside);
		}
	}, [dropdownOpen]);

	const filteredBranches = branches.filter((branch) =>
		(includeRemote || !branch.isRemote) && matchesBranchQuery(branch.name, query),
	);
	const localBranches = filteredBranches.filter((branch) => !branch.isRemote);
	const remoteBranches = filteredBranches.filter((branch) => branch.isRemote);
	const inputValue = editing ? query : value;

	return (
		<div className="relative" ref={dropdownRef}>
			<input
				type="text"
				value={inputValue}
				onFocus={() => {
					loadBranches();
					setEditing(true);
					setQuery("");
					setDropdownOpen(true);
				}}
				onChange={(event) => {
					setEditing(true);
					setQuery(event.target.value);
					setDropdownOpen(true);
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						setDropdownOpen(false);
						setEditing(false);
						setQuery("");
					}
				}}
				aria-label={label}
				placeholder={placeholder}
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
				className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
			/>
			{dropdownOpen && (
				<div className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto bg-overlay border border-edge rounded-xl shadow-lg">
					{localBranches.length > 0 && (
						<>
							<div className="px-3 py-1 text-dense font-semibold text-fg-muted uppercase tracking-wider">
								{t("createTask.branchLocal")}
							</div>
							{localBranches.map((branch) => (
								<button
									key={branch.name}
									type="button"
									onMouseDown={(event) => event.preventDefault()}
									onClick={() => {
										onChange(branch.name);
										setDropdownOpen(false);
										setEditing(false);
										setQuery("");
									}}
									className="w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-overlay-hover transition-colors truncate"
								>
									{branch.name}
								</button>
							))}
						</>
					)}

					{includeRemote && remoteBranches.length > 0 && (
						<>
							<div className="px-3 py-1 text-dense font-semibold text-fg-muted uppercase tracking-wider">
								{t("createTask.branchRemote")}
							</div>
							{remoteBranches.map((branch) => (
								<button
									key={branch.name}
									type="button"
									onMouseDown={(event) => event.preventDefault()}
									onClick={() => {
										onChange(branch.name);
										setDropdownOpen(false);
										setEditing(false);
										setQuery("");
									}}
									className="w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-overlay-hover transition-colors truncate"
								>
									{branch.name}
								</button>
							))}
						</>
					)}

					{filteredBranches.length === 0 && (
						<div className="px-3 py-2 text-sm text-fg-muted">
							{t("createTask.branchNoneFound")}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
