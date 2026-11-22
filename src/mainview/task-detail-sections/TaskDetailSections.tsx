import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { useT, type TFunction } from "../i18n";
import { CordisContext } from "../plugins/react";
import { SlotErrorBoundary } from "../plugins/SlotHost";
import { isBuiltinItem } from "../plugins/SlotItems";
import type { SlotEntry } from "../plugins/slot-registry";
import {
	TASK_DETAIL_MAIN_EXTENSION_BUDGET,
	TASK_DETAIL_META_EXTENSION_BUDGET,
	getTaskDetailSectionRegistry,
	type TaskDetailMainSection,
	type TaskDetailMetaRow,
	type TaskDetailScope,
	type TaskDetailSectionItem,
} from "./registry";

type Entry<Item> = SlotEntry<TaskDetailSectionItem> & { def: Item };

/** The registered sections and rows; mounted only while a task's detail is open. */
export function useTaskDetailEntries(): readonly SlotEntry<TaskDetailSectionItem>[] {
	const registry = getTaskDetailSectionRegistry();
	return useSyncExternalStore(registry.subscribe, registry.list);
}

const reportedFailures = new Set<string>();

/** Once per item and failure: the view re-runs `when` and `label` on every render. */
function reportOnce(id: string, failure: string, err?: unknown): void {
	const key = `${id}\u0000${failure}`;
	if (reportedFailures.has(key)) return;
	reportedFailures.add(key);
	console.error(`[slots] taskDetailSections item ${id}: ${failure}; hiding it:`, err);
}

export function resetTaskDetailFailuresForTests(): void {
	reportedFailures.clear();
}

function applies(def: TaskDetailSectionItem, scope: TaskDetailScope): boolean {
	if (!def.when) return true;
	try {
		return def.when(scope);
	} catch (err) {
		reportOnce(def.id, "when() threw", err);
		return false;
	}
}

function textOf(def: TaskDetailMainSection | TaskDetailMetaRow, read: ((t: TFunction, scope: TaskDetailScope) => string) | undefined, t: TFunction, scope: TaskDetailScope, name: string): string | null {
	if (!read) {
		reportOnce(def.id, `has no ${name}`);
		return null;
	}
	try {
		const text = read(t, scope);
		if (typeof text === "string" && text) return text;
		reportOnce(def.id, `${name}() returned no text`);
	} catch (err) {
		reportOnce(def.id, `${name}() threw`, err);
	}
	return null;
}

/** Built-ins in registration order, then extensions by `order`: an extension never comes before a built-in. */
function inRegion<Item extends TaskDetailSectionItem>(entries: readonly SlotEntry<TaskDetailSectionItem>[], region: Item["region"], scope: TaskDetailScope) {
	const shown = entries.filter((entry): entry is Entry<Item> => entry.def.region === region && applies(entry.def, scope));
	return {
		builtins: shown.filter((entry) => isBuiltinItem(entry.def.id)),
		extensions: shown.filter((entry) => !isBuiltinItem(entry.def.id)),
	};
}

function SectionCrashed() {
	const t = useT();
	return (
		<div role="alert" className="mb-6 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">
			{t("taskDetail.sectionCrashed")}
		</div>
	);
}

function Item({ entry, scope, fallback, children }: { entry: SlotEntry<TaskDetailSectionItem>; scope: TaskDetailScope; fallback: () => ReactNode; children: (props: TaskDetailScope & { ctx: SlotEntry<TaskDetailSectionItem>["ctx"] }) => ReactNode }) {
	return (
		<SlotErrorBoundary slot="taskDetailSections" resetKey={entry.def.id} fallback={fallback}>
			<CordisContext.Provider value={entry.ctx}>{children({ ...scope, ctx: entry.ctx })}</CordisContext.Provider>
		</SlotErrorBoundary>
	);
}

function ExtensionSection({ entry, title, scope }: { entry: Entry<TaskDetailMainSection>; title: string; scope: TaskDetailScope }) {
	const headingId = useId();
	const Section = entry.def.component;
	// The boundary wraps the heading too: a crashed section must not leave its title behind.
	return (
		<Item entry={entry} scope={scope} fallback={() => null}>
			{(props) => (
				<section aria-labelledby={headingId} className="border-t border-edge pt-4 mt-6">
					<h3 id={headingId} className="text-xs text-fg-3 font-semibold uppercase tracking-wider mb-3">{title}</h3>
					<Section {...props} />
				</section>
			)}
		</Item>
	);
}

/** The left column of a finished task's view, after its title. */
export function TaskDetailMain({ scope, entries }: { scope: TaskDetailScope; entries: readonly SlotEntry<TaskDetailSectionItem>[] }) {
	const t = useT();
	const [moreOpen, setMoreOpen] = useState(false);
	const moreId = useId();
	const { builtins, extensions } = inRegion<TaskDetailMainSection>(entries, "main", scope);
	const titled = extensions.flatMap((entry) => {
		const title = textOf(entry.def, entry.def.title, t, scope, "title");
		return title ? [{ entry, title }] : [];
	});
	const visible = titled.slice(0, TASK_DETAIL_MAIN_EXTENSION_BUDGET);
	const more = titled.slice(TASK_DETAIL_MAIN_EXTENSION_BUDGET);
	return (
		<>
			{builtins.map((entry) => {
				const Section = entry.def.component;
				// A vanished built-in would hide what the agent shared: it leaves a notice instead.
				return <Item key={entry.def.id} entry={entry} scope={scope} fallback={() => <SectionCrashed />}>{(props) => <Section {...props} />}</Item>;
			})}
			{visible.map(({ entry, title }) => <ExtensionSection key={entry.def.id} entry={entry} title={title} scope={scope} />)}
			{more.length > 0 && (
				<div className="border-t border-edge pt-4 mt-6">
					<button
						type="button"
						aria-expanded={moreOpen}
						aria-controls={moreId}
						onClick={() => setMoreOpen((open) => !open)}
						className="text-xs text-fg-3 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50 rounded transition-colors"
					>
						{t.plural("taskDetail.moreFromExtensions", more.length)}
					</button>
					<div id={moreId} hidden={!moreOpen}>
						{moreOpen && more.map(({ entry, title }) => <ExtensionSection key={entry.def.id} entry={entry} title={title} scope={scope} />)}
					</div>
				</div>
			)}
		</>
	);
}

/** The metadata grid's rows: built-ins draw their own cells, an extension row gets a host-drawn label. */
export function TaskDetailMeta({ scope, entries }: { scope: TaskDetailScope; entries: readonly SlotEntry<TaskDetailSectionItem>[] }) {
	const t = useT();
	const { builtins, extensions } = inRegion<TaskDetailMetaRow>(entries, "meta", scope);
	const labelled = extensions.flatMap((entry) => {
		const label = textOf(entry.def, entry.def.label, t, scope, "label");
		if (!label) return [];
		if (!entry.def.value) {
			reportOnce(entry.def.id, "has no value");
			return [];
		}
		return [{ entry, label, Value: entry.def.value }];
	});
	for (const { entry } of labelled.slice(TASK_DETAIL_META_EXTENSION_BUDGET)) reportOnce(entry.def.id, "over the metadata row budget");
	return (
		<>
			{builtins.map((entry) => {
				const Cells = entry.def.cells;
				if (!Cells) {
					reportOnce(entry.def.id, "has no cells");
					return null;
				}
				return <Item key={entry.def.id} entry={entry} scope={scope} fallback={() => null}>{(props) => <Cells {...props} />}</Item>;
			})}
			{labelled.slice(0, TASK_DETAIL_META_EXTENSION_BUDGET).map(({ entry, label, Value }) => {
				return (
					<Item key={entry.def.id} entry={entry} scope={scope} fallback={() => null}>
						{(props) => (
							<>
								<span className="text-fg-3">{label}</span>
								<span className="flex min-w-0 text-fg-2"><Value {...props} /></span>
							</>
						)}
					</Item>
				);
			})}
		</>
	);
}
