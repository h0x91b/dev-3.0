import { useState, useEffect, useMemo, useCallback } from "react";
import { useT } from "../i18n";
import { useEscapeKey } from "../hooks/useEscapeKey";
import type { Route } from "../state";
import type { ChangelogEntry } from "../../shared/types";
import { api } from "../rpc";

interface ChangelogProps {
	navigate: (route: Route) => void;
	goBack: () => void;
	canGoBack: boolean;
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

// Type badge on the card. feature = accent, fix = danger, rest = neutral.
const TYPE_STYLES: Record<string, string> = {
	feature: "bg-accent/15 text-accent",
	fix: "bg-danger/15 text-danger",
	refactor: "bg-elevated text-fg-3",
	docs: "bg-elevated text-fg-3",
	chore: "bg-elevated text-fg-3",
};

// Thin colored top accent, keyed by type, that gives the card grid its rhythm.
const TYPE_ACCENT: Record<string, string> = {
	feature: "bg-accent",
	fix: "bg-danger",
	refactor: "bg-edge-active",
	docs: "bg-edge-active",
	chore: "bg-edge-active",
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

function formatDate(dateStr: string): { label: string; weekday: string } {
	const [y, m, d] = dateStr.split("-").map(Number);
	const date = new Date(y, m - 1, d);
	const label = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
	const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
	return { label, weekday };
}

function entryKey(e: ChangelogEntry): string {
	return `${e.date}-${e.type}-${e.slug}`;
}

function Chevron({ open }: { open: boolean }) {
	return (
		<svg
			className={`w-3.5 h-3.5 shrink-0 text-fg-muted transition-transform duration-150 ${open ? "rotate-90" : ""}`}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M9 6l6 6-6 6" />
		</svg>
	);
}

function CreditPrefix({ entry }: { entry: ChangelogEntry }) {
	if (!entry.suggestedBy) return null;
	return (
		<span className="text-fg-3 mr-1.5">
			by{" "}
			{entry.issueUrl ? (
				<a
					href={entry.issueUrl}
					target="_blank"
					rel="noopener noreferrer"
					onClick={(e) => e.stopPropagation()}
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
						onClick={(e) => e.stopPropagation()}
						className="text-fg-muted hover:text-fg-3 hover:underline"
					>
						{entry.issueRef}
					</a>
				</>
			)}
		</span>
	);
}

function EntryCard({
	entry,
	expanded,
	onToggle,
}: {
	entry: ChangelogEntry;
	expanded: boolean;
	onToggle: () => void;
}) {
	const t = useT();
	const hasBody = Boolean(entry.body);
	const typeLabel = t(`changelog.${entry.type}` as never) || entry.type;
	const text = expanded && entry.body ? entry.body : entry.title;

	const inner = (
		<>
			<span className={`absolute inset-x-0 top-0 h-0.5 ${TYPE_ACCENT[entry.type] ?? "bg-edge-active"}`} />
			<div className="flex items-center gap-2">
				<span
					className={`inline-block px-1.5 py-0.5 rounded text-[0.625rem] font-medium leading-none ${
						TYPE_STYLES[entry.type] ?? "bg-elevated text-fg-3"
					}`}
				>
					{typeLabel}
				</span>
				{hasBody && <Chevron open={expanded} />}
			</div>
			<p
				className={`text-fg text-sm leading-snug ${
					expanded ? "whitespace-pre-line" : "line-clamp-3"
				}`}
			>
				<CreditPrefix entry={entry} />
				{text}
			</p>
		</>
	);

	const base =
		"relative flex flex-col gap-2 rounded-xl border border-edge bg-raised px-3.5 pt-4 pb-3.5 overflow-hidden transition-colors";
	// Collapsed cards share one fixed height so the grid reads as even tiles;
	// an expanded card drops to auto height and grows within its own cell.
	const collapsedSize = "h-28";

	if (!hasBody) {
		return <div className={`${base} ${collapsedSize}`}>{inner}</div>;
	}

	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={expanded}
			className={`${base} w-full text-left cursor-pointer hover:border-edge-active hover:bg-raised-hover ${
				expanded ? "h-auto sm:col-span-2 border-edge-active" : collapsedSize
			}`}
		>
			{inner}
		</button>
	);
}

function Changelog({ navigate, goBack, canGoBack }: ChangelogProps) {
	const t = useT();
	const [entries, setEntries] = useState<ChangelogEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [activeFilter, setActiveFilter] = useState<EntryType | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	useEffect(() => {
		api.request
			.getChangelogs()
			.then((data) => {
				setEntries(data);
				setLoading(false);
			})
			.catch(() => {
				setLoading(false);
			});
	}, []);

	// Escape → go back to previous page
	useEscapeKey(() => {
		if (canGoBack) {
			goBack();
		} else {
			navigate({ screen: "dashboard" });
		}
	});

	const toggleFilter = useCallback((type: EntryType) => {
		setActiveFilter((prev) => (prev === type ? null : type));
	}, []);

	const toggleExpand = useCallback((key: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	const availableTypes = useMemo(() => {
		const typeSet = new Set(entries.map((e) => e.type));
		return ENTRY_TYPES.filter((type) => typeSet.has(type));
	}, [entries]);

	const grouped = useMemo(() => {
		const filtered = activeFilter ? entries.filter((e) => e.type === activeFilter) : entries;
		const sorted = [...filtered].sort(sortByType);
		const map = new Map<string, ChangelogEntry[]>();
		for (const entry of sorted) {
			const group = map.get(entry.date) ?? [];
			group.push(entry);
			map.set(entry.date, group);
		}
		return Array.from(map.entries())
			.map(([date, items]) => ({ date, items }))
			.sort((a, b) => b.date.localeCompare(a.date));
	}, [entries, activeFilter]);

	const shownCount = useMemo(() => grouped.reduce((n, g) => n + g.items.length, 0), [grouped]);

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
		<div className="h-full w-full overflow-y-auto">
			<div className="mx-auto max-w-[90rem] px-6 sm:px-8 py-8">
				<header className="mb-6">
					<h1 className="text-fg text-2xl font-bold tracking-tight">{t("header.changelog")}</h1>
					<p className="text-fg-3 text-sm mt-1">{t("changelog.subtitle")}</p>
					<p className="text-fg-muted text-xs mt-1">{t.plural("changelog.entries", shownCount)}</p>
				</header>

				{availableTypes.length > 1 && (
					<div className="flex items-center gap-1.5 flex-wrap mb-7">
						<span className="text-fg-3 text-xs mr-1">{t("changelog.filterLabel")}</span>
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
									{t(`changelog.${type}` as never) || type}
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

				<div className="space-y-8">
					{grouped.map(({ date, items }) => {
						const { label, weekday } = formatDate(date);
						return (
							<section key={date}>
								<div className="sticky top-0 z-10 bg-base flex items-center gap-3 py-2 mb-3">
									<h2 className="text-fg text-sm font-semibold whitespace-nowrap">{label}</h2>
									<span className="text-fg-muted text-xs whitespace-nowrap hidden sm:inline">{weekday}</span>
									<span className="flex-1 h-px bg-edge" />
									<span className="text-fg-muted text-xs whitespace-nowrap">{items.length}</span>
								</div>
								<div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
									{items.map((entry) => {
										const key = entryKey(entry);
										return (
											<EntryCard
												key={key}
												entry={entry}
												expanded={expanded.has(key)}
												onToggle={() => toggleExpand(key)}
											/>
										);
									})}
								</div>
							</section>
						);
					})}
				</div>
			</div>
		</div>
	);
}

export default Changelog;
