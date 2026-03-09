import { useState, useEffect, useMemo, useCallback } from "react";
import { useT } from "../i18n";
import type { Route } from "../state";
import type { ChangelogEntry } from "../../shared/types";
import { api } from "../rpc";

interface ChangelogProps {
	navigate: (route: Route) => void;
	previousRoute: Route | null;
}

const ENTRY_TYPES = ["feature", "fix", "refactor", "docs", "chore"] as const;
type EntryType = (typeof ENTRY_TYPES)[number];

const TYPE_SORT_ORDER: Record<string, number> = {
	feature: 0,
	fix: 1,
	refactor: 2,
	docs: 3,
	chore: 4,
};

const TYPE_STYLES: Record<string, string> = {
	feature: "bg-accent/15 text-accent",
	fix: "bg-danger/15 text-danger",
	refactor: "bg-elevated text-fg-3",
	docs: "bg-elevated text-fg-3",
	chore: "bg-elevated text-fg-3",
};

const FILTER_ACTIVE_STYLES: Record<string, string> = {
	feature: "bg-accent/25 text-accent border-accent/40",
	fix: "bg-danger/25 text-danger border-danger/40",
	refactor: "bg-raised text-fg border-edge-active",
	docs: "bg-raised text-fg border-edge-active",
	chore: "bg-raised text-fg border-edge-active",
};

function sortByType(a: ChangelogEntry, b: ChangelogEntry): number {
	return (TYPE_SORT_ORDER[a.type] ?? 99) - (TYPE_SORT_ORDER[b.type] ?? 99);
}

function formatDate(dateStr: string): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "long",
		day: "numeric",
	}).format(new Date(y, m - 1, d));
}

function Changelog({ navigate, previousRoute }: ChangelogProps) {
	const t = useT();
	const [entries, setEntries] = useState<ChangelogEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [activeFilter, setActiveFilter] = useState<EntryType | null>(null);

	useEffect(() => {
		api.request.getChangelogs().then((data) => {
			setEntries(data);
			setLoading(false);
		}).catch(() => {
			setLoading(false);
		});
	}, []);

	// Escape → go back to previous page
	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				navigate(previousRoute ?? { screen: "dashboard" });
			}
		}
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [navigate, previousRoute]);

	const toggleFilter = useCallback((type: EntryType) => {
		setActiveFilter((prev) => (prev === type ? null : type));
	}, []);

	const availableTypes = useMemo(() => {
		const typeSet = new Set(entries.map((e) => e.type));
		return ENTRY_TYPES.filter((type) => typeSet.has(type));
	}, [entries]);

	const grouped = useMemo(() => {
		const filtered = activeFilter
			? entries.filter((e) => e.type === activeFilter)
			: entries;
		const sorted = [...filtered].sort(sortByType);
		const map = new Map<string, ChangelogEntry[]>();
		for (const entry of sorted) {
			const group = map.get(entry.date) ?? [];
			group.push(entry);
			map.set(entry.date, group);
		}
		return Array.from(map.entries()).map(([date, items]) => ({ date, items }));
	}, [entries, activeFilter]);

	if (loading) {
		return (
			<div className="h-full w-full flex items-center justify-center">
				<span className="text-fg-3 text-sm">{t("changelog.loading")}</span>
			</div>
		);
	}

	if (entries.length === 0) {
		return (
			<div className="h-full w-full flex items-center justify-center">
				<span className="text-fg-muted text-sm">{t("changelog.empty")}</span>
			</div>
		);
	}

	return (
		<div className="h-full w-full flex flex-col">
			<div className="flex-1 overflow-y-auto p-7">
				<div className="mx-auto max-w-3xl">
					{availableTypes.length > 1 && (
						<div className="flex items-center gap-1.5 flex-wrap mb-5">
							<span className="text-fg-3 text-xs mr-1">
								{t("changelog.filterLabel")}
							</span>
							{availableTypes.map((type) => {
								const isActive = activeFilter === type;
								return (
									<button
										key={type}
										type="button"
										onClick={() => toggleFilter(type)}
										className={`px-2 py-0.5 rounded text-[0.6875rem] font-medium leading-tight border transition-colors cursor-pointer ${
											isActive
												? FILTER_ACTIVE_STYLES[type]
												: "bg-transparent text-fg-3 border-edge hover:border-edge-active hover:text-fg-2"
										}`}
									>
										{t(`changelog.${type}` as any) || type}
									</button>
								);
							})}
							{activeFilter && (
								<button
									type="button"
									onClick={() => setActiveFilter(null)}
									className="px-2 py-0.5 rounded text-[0.6875rem] text-fg-muted hover:text-fg-3 transition-colors cursor-pointer"
								>
									{t("changelog.clearFilter")}
								</button>
							)}
						</div>
					)}
					<div className="space-y-5">
						{grouped.map(({ date, items }) => (
							<div
								key={date}
								className="bg-raised rounded-lg border border-edge p-4"
							>
								<h3 className="text-fg-2 text-xs font-semibold uppercase tracking-wider mb-3">
									{formatDate(date)}
								</h3>
								<div className="space-y-1.5">
									{items.map((entry) => (
										<div
											key={`${entry.date}-${entry.slug}`}
											className="flex items-baseline gap-2 py-1 px-1 rounded-md"
										>
											<span
												className={`inline-block px-1.5 py-0.5 rounded text-[0.625rem] font-medium leading-none flex-shrink-0 ${TYPE_STYLES[entry.type] ?? "bg-elevated text-fg-3"}`}
											>
												{t(`changelog.${entry.type}` as any) || entry.type}
											</span>
											<span className="text-fg text-sm leading-snug">
												{entry.suggestedBy && (
													<span className="text-fg-3 mr-1.5">
														by{" "}
														{entry.issueUrl ? (
															<a
																href={entry.issueUrl}
																target="_blank"
																rel="noopener noreferrer"
																className="text-accent hover:underline"
															>
																@{entry.suggestedBy}
															</a>
														) : (
															<span className="text-accent">@{entry.suggestedBy}</span>
														)}
														{entry.issueRef && entry.issueUrl && (
															<>
																{" "}
																<a
																	href={entry.issueUrl}
																	target="_blank"
																	rel="noopener noreferrer"
																	className="text-fg-muted hover:text-fg-3 hover:underline"
																>
																	{entry.issueRef}
																</a>
															</>
														)}
														{" · "}
													</span>
												)}
												{entry.title}
											</span>
										</div>
									))}
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

export default Changelog;
