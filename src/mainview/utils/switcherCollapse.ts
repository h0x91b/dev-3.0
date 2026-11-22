// Which groups of the header project switcher the user has folded. Its own key,
// apart from the dashboard's `dev3-collapsed-spaces`: folding a group in one place
// must not hide rows in the other. Ids are space ids plus `HOME_GROUP_ID`.

const LS_SWITCHER_COLLAPSED = "dev3-switcher-collapsed-groups";

export function readSwitcherCollapsed(): Set<string> {
	try {
		const raw = localStorage.getItem(LS_SWITCHER_COLLAPSED);
		const ids: unknown = raw ? JSON.parse(raw) : [];
		if (Array.isArray(ids)) return new Set(ids.filter((id): id is string => typeof id === "string"));
	} catch {
		/* unreadable value - every group starts expanded */
	}
	return new Set();
}

export function writeSwitcherCollapsed(ids: ReadonlySet<string>): void {
	try {
		localStorage.setItem(LS_SWITCHER_COLLAPSED, JSON.stringify([...ids]));
	} catch {
		/* private mode / quota - the fold just does not persist */
	}
}
