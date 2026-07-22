import { useState, useEffect, useMemo, useCallback, useRef } from "react";
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

// Nerd Font glyphs: fa-rocket, fa-bug, fa-refresh, fa-book, fa-wrench.
const TYPE_GLYPHS: Record<string, string> = {
	feature: "\uf135",
	fix: "\uf188",
	refactor: "\uf021",
	docs: "\uf02d",
	chore: "\uf0ad",
};

const TYPE_ICON_COLOR: Record<string, string> = {
	feature: "text-accent",
	fix: "text-danger",
	refactor: "text-fg-3",
	docs: "text-fg-3",
	chore: "text-fg-3",
};

const FILTER_ACTIVE_STYLES: Record<string, string> = {
	feature: "bg-accent/20 text-accent border-accent/40",
	fix: "bg-danger/15 text-danger border-danger/40",
	refactor: "bg-raised text-fg border-edge-active",
	docs: "bg-raised text-fg border-edge-active",
	chore: "bg-raised text-fg border-edge-active",
};

// Day groups render incrementally so ~1000 entries never hit the DOM at once.
const INITIAL_DAYS = 15;
const LOAD_MORE_DAYS = 15;

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

function Glyph({ glyph, className }: { glyph: string; className?: string }) {
	return (
		<span aria-hidden="true" className={className} style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
			{glyph}
		</span>
	);
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

/** Prominent card for `feature` entries: icon chip, optional short headline, teaser. */
function FeatureCard({
	entry,
	expanded,
	wide,
	onToggle,
}: {
	entry: ChangelogEntry;
	expanded: boolean;
	wide: boolean;
	onToggle: () => void;
}) {
	const hasBody = Boolean(entry.body);
	const headline = entry.short?.trim();
	const text = expanded && entry.body ? entry.body : entry.title;

	const inner = (
		<>
			<span className="absolute inset-y-0 left-0 w-[3px] bg-accent/60" />
			<div className="flex items-start gap-2.5">
				<span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent/15">
					<Glyph glyph={TYPE_GLYPHS.feature} className="text-accent text-[0.8125rem] leading-none" />
				</span>
				<span className="flex-1 min-w-0 pt-0.5">
					{headline && <span className="block text-fg text-sm font-semibold leading-snug">{headline}</span>}
					<span
						className={`block text-sm leading-relaxed ${headline ? "text-fg-2 mt-1" : "text-fg"} ${
							expanded ? "whitespace-pre-line" : "line-clamp-3"
						}`}
					>
						<CreditPrefix entry={entry} />
						{text}
					</span>
				</span>
				{hasBody && <Chevron open={expanded} />}
			</div>
		</>
	);

	const base = "relative rounded-xl border bg-raised p-4 overflow-hidden transition-colors";
	const span = expanded || wide ? "sm:col-span-2" : "";

	if (!hasBody) {
		return <div className={`${base} border-edge ${span}`}>{inner}</div>;
	}
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={expanded}
			className={`${base} ${span} w-full text-left cursor-pointer hover:bg-raised-hover ${
				expanded ? "border-accent/40" : "border-edge hover:border-accent/40"
			}`}
		>
			{inner}
		</button>
	);
}

/** Compact list row for fix/refactor/docs/chore entries. */
function MinorRow({
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
			<span className="mt-[3px] w-4 shrink-0 text-center" title={typeLabel}>
				<Glyph
					glyph={TYPE_GLYPHS[entry.type] ?? TYPE_GLYPHS.chore}
					className={`text-xs leading-none ${TYPE_ICON_COLOR[entry.type] ?? "text-fg-3"}`}
				/>
			</span>
			<span
				className={`flex-1 min-w-0 text-sm leading-snug text-fg-2 ${
					expanded ? "whitespace-pre-line" : "line-clamp-2"
				}`}
			>
				<CreditPrefix entry={entry} />
				{text}
			</span>
			{hasBody && <Chevron open={expanded} />}
		</>
	);

	const base = "flex items-start gap-3 px-4 py-2.5";
	if (!hasBody) {
		return <div className={base}>{inner}</div>;
	}
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={expanded}
			className={`${base} w-full text-left cursor-pointer hover:bg-raised-hover transition-colors`}
		>
			{inner}
		</button>
	);
}

function Changelog({ navigate, goBack, canGoBack }: ChangelogProps) {
	const t = useT();
	const [entries, setEntries] = useState<ChangelogEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [activeTypes, setActiveTypes] = useState<Set<EntryType>>(new Set());
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [visibleDays, setVisibleDays] = useState(INITIAL_DAYS);
	const sentinelRef = useRef<HTMLDivElement | null>(null);

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

	// Escape is staged: clear the search first, only then navigate back.
	useEscapeKey(() => {
		if (query) {
			setQuery("");
			return;
		}
		if (canGoBack) {
			goBack();
		} else {
			navigate({ screen: "dashboard" });
		}
	});

	const toggleFilter = useCallback((type: EntryType) => {
		setActiveTypes((prev) => {
			const next = new Set(prev);
			if (next.has(type)) next.delete(type);
			else next.add(type);
			return next;
		});
	}, []);

	const toggleExpand = useCallback((key: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	const resetFilters = useCallback(() => {
		setQuery("");
		setActiveTypes(new Set());
	}, []);

	const typeCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const e of entries) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
		return counts;
	}, [entries]);

	const availableTypes = useMemo(() => ENTRY_TYPES.filter((type) => typeCounts.has(type)), [typeCounts]);

	const grouped = useMemo(() => {
		const q = query.trim().toLowerCase();
		const matchesQuery = (e: ChangelogEntry) =>
			q === "" ||
			e.title.toLowerCase().includes(q) ||
			(e.body?.toLowerCase().includes(q) ?? false) ||
			(e.short?.toLowerCase().includes(q) ?? false) ||
			e.slug.toLowerCase().includes(q) ||
			(e.suggestedBy?.toLowerCase().includes(q) ?? false);
		const filtered = entries.filter(
			(e) => (activeTypes.size === 0 || activeTypes.has(e.type as EntryType)) && matchesQuery(e),
		);
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
	}, [entries, activeTypes, query]);

	useEffect(() => {
		setVisibleDays(INITIAL_DAYS);
	}, [query, activeTypes]);

	const visibleGroups = grouped.slice(0, visibleDays);
	const hasMore = grouped.length > visibleGroups.length;
	const shownCount = useMemo(() => grouped.reduce((n, g) => n + g.items.length, 0), [grouped]);
	const isFiltered = query.trim() !== "" || activeTypes.size > 0;

	useEffect(() => {
		if (!hasMore) return;
		const el = sentinelRef.current;
		if (!el || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(observed) => {
				if (observed.some((o) => o.isIntersecting)) setVisibleDays((v) => v + LOAD_MORE_DAYS);
			},
			{ rootMargin: "800px" },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [hasMore]);

	if (loading) {
		return (
			<div className="h-full w-full overflow-y-auto" aria-busy="true">
				<div className="mx-auto max-w-[72rem] px-6 sm:px-8 py-8">
					<div className="animate-pulse">
						<div className="h-8 w-56 rounded-lg bg-raised" />
						<div className="mt-3 h-4 w-80 rounded bg-raised" />
						<div className="mt-10 space-y-10">
							{[0, 1, 2].map((i) => (
								<div key={i} className="lg:grid lg:grid-cols-[9.5rem_minmax(0,1fr)] lg:gap-x-8">
									<div className="mb-3 space-y-2 lg:mb-0 lg:flex lg:flex-col lg:items-end">
										<div className="h-4 w-24 rounded bg-raised" />
										<div className="h-3 w-16 rounded bg-raised" />
									</div>
									<div className="grid grid-cols-1 gap-3 border-l border-edge pl-5 sm:grid-cols-2 sm:pl-7">
										<div className="h-24 rounded-xl bg-raised" />
										<div className="h-24 rounded-xl bg-raised" />
										<div className="h-16 rounded-xl bg-raised sm:col-span-2" />
									</div>
								</div>
							))}
						</div>
					</div>
					<span className="sr-only">{t("changelog.loading")}</span>
				</div>
			</div>
		);
	}

	if (entries.length === 0) {
		return (
			<div className="h-full w-full flex flex-col items-center justify-center gap-3">
				<Glyph glyph={""} className="text-fg-muted text-3xl" />
				<span className="text-fg-muted text-sm">{t("changelog.empty")}</span>
			</div>
		);
	}

	return (
		<div className="h-full w-full overflow-y-auto">
			<div className="mx-auto max-w-[72rem] px-6 sm:px-8 py-8">
				<header className="mb-5">
					<h1 className="text-fg text-3xl font-bold tracking-tight">{t("header.changelog")}</h1>
					<p className="text-fg-3 text-sm mt-1.5">
						{t("changelog.subtitle")}{" "}
						<span className="text-fg-muted">· {t.plural("changelog.entries", entries.length)}</span>
					</p>
				</header>

				<div className="sticky top-0 z-20 -mx-2 mb-8 bg-base px-2 py-3 border-b border-edge/70">
					<div className="flex flex-wrap items-center gap-2">
						<div className="relative w-full sm:w-72">
							<Glyph
								glyph={""}
								className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted text-xs"
							/>
							<input
								type="text"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder={t("changelog.searchPlaceholder")}
								className="w-full rounded-lg border border-edge bg-elevated py-1.5 pl-8 pr-8 text-sm text-fg placeholder-fg-muted outline-none transition-colors focus:border-accent/50"
							/>
							{query && (
								<button
									type="button"
									onClick={() => setQuery("")}
									aria-label={t("changelog.clearSearch")}
									className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-fg-muted transition-colors hover:text-fg-2"
								>
									<Glyph glyph={""} className="text-xs" />
								</button>
							)}
						</div>
						{availableTypes.length > 1 &&
							availableTypes.map((type) => {
								const isActive = activeTypes.has(type);
								return (
									<button
										key={type}
										type="button"
										onClick={() => toggleFilter(type)}
										aria-pressed={isActive}
										className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium leading-tight transition-colors ${
											isActive
												? FILTER_ACTIVE_STYLES[type]
												: "border-edge bg-transparent text-fg-3 hover:border-edge-active hover:text-fg-2"
										}`}
									>
										<Glyph glyph={TYPE_GLYPHS[type]} className="text-[0.6875rem] leading-none" />
										{t(`changelog.${type}` as never) || type}
										<span className={isActive ? "opacity-70" : "text-fg-muted"}>{typeCounts.get(type)}</span>
									</button>
								);
							})}
						{isFiltered && (
							<>
								<button
									type="button"
									onClick={resetFilters}
									className="cursor-pointer rounded px-2 py-0.5 text-xs text-fg-muted transition-colors hover:text-fg-3"
								>
									{t("changelog.clearFilter")}
								</button>
								<span className="ml-auto whitespace-nowrap text-xs text-fg-muted">
									{t.plural("changelog.entries", shownCount)}
								</span>
							</>
						)}
					</div>
				</div>

				{grouped.length === 0 ? (
					<div className="flex flex-col items-center gap-3 py-24 text-center">
						<Glyph glyph={""} className="text-fg-muted text-2xl" />
						<p className="text-fg-3 text-sm">{t("changelog.noResults")}</p>
						<button
							type="button"
							onClick={resetFilters}
							className="cursor-pointer text-sm text-accent hover:underline"
						>
							{t("changelog.resetFilters")}
						</button>
					</div>
				) : (
					<>
						{visibleGroups.map(({ date, items }) => {
							const { label, weekday } = formatDate(date);
							const features = items.filter((e) => e.type === "feature");
							const minors = items.filter((e) => e.type !== "feature");
							return (
								<section key={date} className="relative lg:grid lg:grid-cols-[9.5rem_minmax(0,1fr)] lg:gap-x-8">
									<div className="mb-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 lg:mb-0 lg:block lg:sticky lg:top-20 lg:self-start lg:pr-1 lg:text-right lg:space-y-0.5">
										<h2 className="whitespace-nowrap text-base font-semibold leading-tight text-fg">{label}</h2>
										<p className="text-xs text-fg-muted">{weekday}</p>
										<p className="text-xs text-fg-muted">{t.plural("changelog.entries", items.length)}</p>
									</div>
									<div className="relative border-l border-edge pb-10 pl-5 sm:pl-7">
										<span className="absolute -left-[5px] top-[3px] h-2.5 w-2.5 rounded-full bg-accent ring-4 ring-base" />
										{features.length > 0 && (
											<div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
												{features.map((entry) => {
													const key = entryKey(entry);
													return (
														<FeatureCard
															key={key}
															entry={entry}
															expanded={expanded.has(key)}
															wide={features.length === 1}
															onToggle={() => toggleExpand(key)}
														/>
													);
												})}
											</div>
										)}
										{minors.length > 0 && (
											<div
												className={`divide-y divide-edge overflow-hidden rounded-xl border border-edge bg-raised/60 ${
													features.length > 0 ? "mt-3" : ""
												}`}
											>
												{minors.map((entry) => {
													const key = entryKey(entry);
													return (
														<MinorRow
															key={key}
															entry={entry}
															expanded={expanded.has(key)}
															onToggle={() => toggleExpand(key)}
														/>
													);
												})}
											</div>
										)}
									</div>
								</section>
							);
						})}
						{hasMore && (
							<div ref={sentinelRef} className="flex justify-center pb-10">
								<button
									type="button"
									onClick={() => setVisibleDays((v) => v + LOAD_MORE_DAYS)}
									className="cursor-pointer rounded-lg border border-edge px-4 py-1.5 text-sm text-fg-3 transition-colors hover:border-edge-active hover:text-fg-2"
								>
									{t("changelog.showMore")}
								</button>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

export default Changelog;
