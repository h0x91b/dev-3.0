import { useState, useEffect, useMemo } from "react";
import { useT } from "../i18n";
import type { Route } from "../state";
import type { ChangelogEntry } from "../../shared/types";
import { api } from "../rpc";

interface ChangelogProps {
	navigate: (route: Route) => void;
	previousRoute: Route | null;
}

const TYPE_STYLES: Record<string, string> = {
	feature: "bg-accent/15 text-accent",
	fix: "bg-danger/15 text-danger",
	refactor: "bg-elevated text-fg-3",
	docs: "bg-elevated text-fg-3",
	chore: "bg-elevated text-fg-3",
};

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

	useEffect(() => {
		api.request.getChangelogs().then((data) => {
			setEntries(data);
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

	const grouped = useMemo(() => {
		const map = new Map<string, ChangelogEntry[]>();
		for (const entry of entries) {
			const group = map.get(entry.date) ?? [];
			group.push(entry);
			map.set(entry.date, group);
		}
		return Array.from(map.entries()).map(([date, items]) => ({ date, items }));
	}, [entries]);

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
				<div className="max-w-2xl space-y-6">
					{grouped.map(({ date, items }) => (
						<div key={date}>
							<h3 className="text-fg-2 text-xs font-semibold uppercase tracking-wider mb-2 sticky top-0 bg-base py-1">
								{formatDate(date)}
							</h3>
							<div className="space-y-1">
								{items.map((entry) => (
									<div
										key={`${entry.date}-${entry.slug}`}
										className="flex items-baseline gap-2 py-1 px-2 rounded-md"
									>
										<span
											className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium leading-none flex-shrink-0 ${TYPE_STYLES[entry.type] ?? "bg-elevated text-fg-3"}`}
										>
											{t(`changelog.${entry.type}` as any) || entry.type}
										</span>
										<span className="text-fg text-sm leading-snug">
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
	);
}

export default Changelog;
