import { useT } from "../i18n";

/** Warns that a task about to start still depends on open tasks. It never blocks the start. */
function OpenDependenciesNote({ seqs }: { seqs: number[] }) {
	const t = useT();
	if (seqs.length === 0) return null;
	return (
		<p
			role="status"
			data-testid="open-dependencies-note"
			className="m-0 rounded-lg border-l-2 border-warning/60 bg-elevated/70 px-3 py-2 text-sm leading-relaxed text-fg"
		>
			{t("task.openDependenciesWarning", { refs: seqs.map((seq) => `#${seq}`).join(", ") })}
		</p>
	);
}

export default OpenDependenciesNote;
