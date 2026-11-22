import { createContext, useCallback, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** What a section with unsaved edits tells the host: the host owns the banner and the navigation guard. */
export interface SectionDirtyReport {
	dirty: boolean;
	/** A save of this section is in flight. */
	saving?: boolean;
	/** The section holds input that must not be saved yet (e.g. unparseable env lines). */
	blocked?: boolean;
	save(): Promise<void>;
	discard(): void;
}

type Reporter = (id: string, report: SectionDirtyReport | null) => void;

const SectionDirtyContext = createContext<Reporter | null>(null);

function flags(report: SectionDirtyReport | undefined | null): string {
	return report ? `${report.dirty}|${!!report.saving}|${!!report.blocked}` : "";
}

/**
 * The host side: collects the reports of the sections mounted under its provider. Reads go
 * through a ref, so a navigation guard asked later sees the latest edit; a change of a
 * report's flags re-renders the host.
 */
export function useSectionDirtyHost() {
	const reports = useRef(new Map<string, SectionDirtyReport>());
	const [, setVersion] = useState(0);
	const reporter = useCallback<Reporter>((id, report) => {
		const before = flags(reports.current.get(id));
		if (report) reports.current.set(id, report);
		else reports.current.delete(id);
		if (flags(report) !== before) setVersion((v) => v + 1);
	}, []);
	const dirtyReports = useCallback(() => [...reports.current.values()].filter((report) => report.dirty), []);
	const isDirty = useCallback(() => dirtyReports().length > 0, [dirtyReports]);
	const save = useCallback(async () => {
		const pending = dirtyReports();
		if (pending.some((report) => report.blocked)) return;
		for (const report of pending) await report.save();
	}, [dirtyReports]);
	const discard = useCallback(() => {
		for (const report of dirtyReports()) report.discard();
	}, [dirtyReports]);
	const pending = dirtyReports();
	return {
		reporter,
		isDirty,
		save,
		discard,
		saving: pending.some((report) => report.saving),
		blocked: pending.some((report) => report.blocked),
	};
}

export function SectionDirtyProvider({ reporter, children }: { reporter: Reporter; children: ReactNode }) {
	return <SectionDirtyContext.Provider value={reporter}>{children}</SectionDirtyContext.Provider>;
}

/** A section reports its unsaved state to the host on every render; unmounting withdraws it. */
export function useSectionDirty(report: SectionDirtyReport): void {
	const id = useId();
	const reporter = useContext(SectionDirtyContext);
	useLayoutEffect(() => {
		reporter?.(id, report);
	});
	useLayoutEffect(() => () => reporter?.(id, null), [reporter, id]);
}
