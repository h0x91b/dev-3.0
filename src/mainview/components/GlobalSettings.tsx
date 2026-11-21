import { modifierLabel } from "../utils/platform";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useT, type TFunction } from "../i18n";
import type { SettingsPresetTarget, SettingsSectionId } from "../state";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { useIsControlHidden } from "../hooks/useIsControlHidden";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import {
	filterSettingsEntries,
	groupSettingsEntriesByCategory,
	normalizeSettingsCategoryId,
	SETTINGS_CATEGORIES,
	type SettingsCategoryId,
	type SettingsEntryAnchor,
	type SettingsEntry as SettingsRegistryEntry,
} from "../settings-registry";
import { SettingsControllerContext, useGlobalSettingsController } from "../settings-sections/controller";
import { SettingsCategoryPage, useRegisteredSettingsSections } from "../settings-sections/SettingsCategoryPage";

function GlobalSettings({
	section,
	anchor,
	preset,
}: {
	section?: SettingsSectionId;
	anchor?: SettingsEntryAnchor;
	preset?: SettingsPresetTarget;
} = {}) {
	const t = useT();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	// The "keyboard-shortcut-editor" control (§5.10) hides the Keyboard category
	// — the ⌘/ reference overlay is a different surface and stays reachable.
	const keyboardEditorHidden = useIsControlHidden("keyboard-shortcut-editor");
	const visibleSettingsCategories = keyboardEditorHidden
		? SETTINGS_CATEGORIES.filter((category) => category.id !== "keyboard")
		: SETTINGS_CATEGORIES;
	const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>(() =>
		normalizeSettingsCategoryId(section),
	);
	const [mobileCategory, setMobileCategory] = useState<SettingsCategoryId | null>(
		() => (section ? normalizeSettingsCategoryId(section) : null),
	);
	useEffect(() => {
		if (keyboardEditorHidden && activeCategory === "keyboard") {
			// Fall back into the currently visible list, not the unfiltered one —
			// correct today only because "appearance" happens never to be hidden.
			setActiveCategory(visibleSettingsCategories[0].id);
		}
	}, [keyboardEditorHidden, activeCategory, visibleSettingsCategories]);
	const [searchQuery, setSearchQuery] = useState("");
	const [pendingAnchor, setPendingAnchor] = useState<string | null>(anchor ?? null);
	// A deep-link that names a preset, held until the agents list has loaded and
	// the Agents page has actually pointed at it. One-shot: leaving it set would
	// yank the selection back on every later visit to this screen.
	const [focusPreset, setFocusPreset] = useState<SettingsPresetTarget | null>(preset ?? null);
	const clearFocusPreset = useCallback(() => setFocusPreset(null), []);
	const detailHeadingRef = useRef<HTMLHeadingElement>(null);
	const controller = useGlobalSettingsController({ focusPreset, clearFocusPreset });
	const sections = useRegisteredSettingsSections();
	const registeredEntries = useMemo(() => sections.flatMap((section) => section.def.entries), [sections]);
	const visibleCategoryIds = useMemo(
		() => new Set(visibleSettingsCategories.map((category) => category.id)),
		[visibleSettingsCategories],
	);
	// Search is an entry point like the palette and the native menu (§5.10
	// finding #2): a hidden category's rows must not surface here either, or
	// picking one lands the user on a category the reset effect bounces away
	// from with no explanation.
	const filteredSettingsEntries = useMemo(
		() => filterSettingsEntries(searchQuery, t, registeredEntries).filter((entry) => visibleCategoryIds.has(entry.category)),
		[searchQuery, t, registeredEntries, visibleCategoryIds],
	);
	const groupedSearchResults = useMemo(
		() => groupSettingsEntriesByCategory(filteredSettingsEntries),
		[filteredSettingsEntries],
	);
	// Deep-links keep accepting legacy section ids while the visible route uses
	// the current category vocabulary.
	useEffect(() => {
		const nextCategory = normalizeSettingsCategoryId(section);
		setActiveCategory(nextCategory);
		if (narrow && section) setMobileCategory(nextCategory);
	}, [narrow, section]);

	useEffect(() => {
		if (anchor) setPendingAnchor(anchor);
	}, [anchor]);

	useEffect(() => {
		if (!narrow) setMobileCategory(null);
	}, [narrow]);

	// A named preset also scrolls the page to the editor that holds it — landing
	// on the right category and leaving the user to scroll is most of the way to
	// not having deep-linked at all.
	useEffect(() => {
		if (!preset) return;
		setFocusPreset(preset);
		setPendingAnchor("agents-editor");
	}, [preset]);

	useEffect(() => {
		if (!pendingAnchor || searchQuery.trim()) return;
		const element = document.querySelector(
			`[data-settings-entry="${pendingAnchor}"]`,
		) as HTMLElement | null;
		if (!element) return;
		element.scrollIntoView?.({ behavior: "smooth", block: "start" });
		setPendingAnchor(null);
		detailHeadingRef.current?.focus({ preventScroll: true });
		// `sections`: an anchor inside a section registered after this render still lands.
	}, [activeCategory, pendingAnchor, searchQuery, sections]);

	const selectCategory = useCallback(
		(category: SettingsCategoryId) => {
			setSearchQuery("");
			setPendingAnchor(null);
			setActiveCategory(category);
			if (narrow) setMobileCategory(category);
		},
		[narrow],
	);

	const selectSearchResult = useCallback(
		(entry: SettingsRegistryEntry) => {
			setSearchQuery("");
			setActiveCategory(entry.category);
			setPendingAnchor(entry.anchor ?? null);
			if (narrow) setMobileCategory(entry.category);
		},
		[narrow],
	);

	const returnToCategoryList = useCallback(() => {
		setSearchQuery("");
		setPendingAnchor(null);
		setMobileCategory(null);
	}, []);

	const selectedCategory =
		visibleSettingsCategories.find((category) => category.id === activeCategory) ??
		visibleSettingsCategories[0];
	const settingsNavigation = (
		<SettingsNavigation
			t={t}
			categories={visibleSettingsCategories}
			activeCategory={activeCategory}
			query={searchQuery}
			narrow={narrow}
			searchGroups={groupedSearchResults}
			onQueryChange={setSearchQuery}
			onCategorySelect={selectCategory}
			onSearchResult={selectSearchResult}
		/>
	);
	const settingsDetail = (
		<section
			className="min-w-0 min-h-0 flex-1 overflow-y-auto p-5 md:p-7"
			aria-labelledby="settings-category-title"
		>
			{narrow ? (
				<button
					type="button"
					onClick={returnToCategoryList}
					className="mb-5 inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm text-fg-2 hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				>
					<span aria-hidden="true">←</span>
					{t("settings.categoryBack")}
				</button>
			) : null}
			<div className="mx-auto w-full max-w-5xl">
				{searchQuery.trim() ? (
					<SettingsSearchResults
						t={t}
						groups={groupedSearchResults}
						onSelect={selectSearchResult}
					/>
				) : (
					<>
						<div className="mb-7">
							<h2
								id="settings-category-title"
								ref={detailHeadingRef}
								tabIndex={-1}
								className="text-fg text-xl font-semibold tracking-tight outline-none"
							>
								{t(selectedCategory.labelKey)}
							</h2>
							<p className="mt-1 text-sm text-fg-3">
								{t(selectedCategory.descriptionKey)}
							</p>
						</div>
						{/* Body reads the same resolved id as the heading above it (§5.10
					    finding #3) — `activeCategory` alone could name a category the
					    fallback effect hasn't caught up to yet, painting one frame of
					    the wrong page under the right heading, or vice versa. */}
					<SettingsCategoryPage region={selectedCategory.id} sections={sections} />
					</>
				)}
			</div>
		</section>
	);

	return (
		<SettingsControllerContext.Provider value={controller}>
			<div className="h-full w-full flex flex-col">
				<div className="min-h-0 flex-1 p-2 sm:p-4 md:p-6">
					<div className="h-full min-h-0 max-w-6xl mx-auto overflow-hidden flex flex-col md:flex-row bg-raised/80 backdrop-blur-sm border border-edge/50 rounded-2xl">
						{narrow ? (
							mobileCategory ? settingsDetail : settingsNavigation
						) : (
							<>
								{settingsNavigation}
								{settingsDetail}
							</>
						)}
					</div>
				</div>
			</div>
		</SettingsControllerContext.Provider>
	);
}

function SettingsNavigation({
	t,
	categories,
	activeCategory,
	query,
	narrow,
	searchGroups,
	onQueryChange,
	onCategorySelect,
	onSearchResult,
}: {
	t: TFunction;
	categories: readonly (typeof SETTINGS_CATEGORIES)[number][];
	activeCategory: SettingsCategoryId;
	query: string;
	narrow: boolean;
	searchGroups: ReturnType<typeof groupSettingsEntriesByCategory>;
	onQueryChange: (query: string) => void;
	onCategorySelect: (category: SettingsCategoryId) => void;
	onSearchResult: (entry: SettingsRegistryEntry) => void;
}) {
	return (
		<aside
			className={`flex min-h-0 w-full shrink-0 flex-col ${
				narrow ? "" : "md:w-64 md:border-r md:border-edge/60"
			}`}
		>
			<div className="border-b border-edge/60 p-4 md:p-5">
				<h1 className="text-fg text-2xl font-semibold tracking-tight">
					{t("settings.settingsTitle")}
				</h1>
				<p className="mt-1 text-xs text-fg-3">{t("settings.settingsDesc")}</p>
				<div className="relative mt-4">
					<label htmlFor="settings-search" className="sr-only">
						{t("settings.searchLabel")}
					</label>
					<input
						id="settings-search"
						type="search"
						value={query}
						onChange={(event) => onQueryChange(event.target.value)}
						placeholder={t("settings.searchPlaceholder")}
						className="w-full rounded-xl border border-edge bg-base px-3 py-2.5 pr-10 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
					/>
					{query ? (
						<button
							type="button"
							onClick={() => onQueryChange("")}
							aria-label={t("settings.searchClear")}
							className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-lg text-fg-muted hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
						>
							×
						</button>
					) : null}
				</div>
			</div>
			<nav
				aria-label={t("settings.categories")}
				className="min-h-0 flex-1 overflow-y-auto p-2"
			>
				{narrow && query.trim() ? (
					<SettingsSearchResults
						t={t}
						groups={searchGroups}
						onSelect={onSearchResult}
					/>
				) : (
					<ul className="space-y-1">
						{categories.map((category) => (
							<li key={category.id}>
								<button
									type="button"
									aria-current={
										activeCategory === category.id ? "page" : undefined
									}
									onClick={() => onCategorySelect(category.id)}
									className={`flex min-h-11 w-full items-center rounded-xl border px-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
										activeCategory === category.id
											? "border-accent/50 bg-accent/10 text-accent"
											: "border-transparent text-fg-2 hover:border-edge hover:bg-elevated hover:text-fg"
									}`}
								>
									{t(category.labelKey)}
								</button>
							</li>
						))}
					</ul>
				)}
			</nav>
		</aside>
	);
}

function SettingsSearchResults({
	t,
	groups,
	onSelect,
}: {
	t: TFunction;
	groups: ReturnType<typeof groupSettingsEntriesByCategory>;
	onSelect: (entry: SettingsRegistryEntry) => void;
}) {
	if (groups.length === 0) {
		return (
			<div className="rounded-xl border border-edge bg-base/50 p-4 text-sm text-fg-3">
				{t("settings.searchNoResults")}
			</div>
		);
	}

	return (
		<div>
			<h2 className="text-fg text-xl font-semibold tracking-tight">
				{t("settings.searchResults")}
			</h2>
			<div className="mt-5 space-y-6">
				{groups.map((group) => (
					<section key={group.category.id}>
						<h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
							{t(group.category.labelKey)}
						</h3>
						<div className="mt-2 space-y-2">
							{group.entries.map((entry) => (
								<button
									key={entry.id}
									type="button"
									onClick={() => onSelect(entry)}
									className="block min-h-11 w-full rounded-xl border border-edge bg-raised p-3 text-left transition-colors hover:border-accent/50 hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
								>
									<span className="block text-sm font-semibold text-fg">
										{t(entry.titleKey)}
									</span>
									<span className="mt-0.5 block text-xs text-fg-3">
										{t(entry.descriptionKey, { mod: modifierLabel() })}
									</span>
									<span className="mt-2 block text-micro text-fg-muted">
										{t("settings.searchResultCategory", {
											category: t(group.category.labelKey),
										})}
									</span>
								</button>
							))}
						</div>
					</section>
				))}
			</div>
		</div>
	);
}

export default GlobalSettings;
