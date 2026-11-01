import { useState, type ReactNode } from "react";
import type { Context } from "cordis";
import { useT } from "../../i18n";
import Select from "../../components/Select";
import { useBoard } from "../react";
import { useAttentionLayout, useBucketName } from "./hooks";
import {
	ATTENTION_BUCKET_SORTS,
	DEFAULT_ATTENTION_BUCKETS,
	newBucketId,
	type AttentionBucket,
	type AttentionBucketSort,
} from "./buckets";

const INPUT = "w-full min-h-8 px-2 rounded-md bg-elevated text-sm text-fg placeholder:text-fg-muted shadow-[0_0_0_1px_rgb(var(--border-default))] outline-none focus-visible:shadow-[0_0_0_2px_rgb(var(--accent))]";

/** A text field that writes on blur or Enter, so typing does not rewrite the layout file per keystroke. */
function CommitField({ value, onCommit, label, placeholder, mono }: {
	value: string;
	onCommit: (value: string) => void;
	label: string;
	placeholder?: string;
	mono?: boolean;
}) {
	const [draft, setDraft] = useState(value);
	const [base, setBase] = useState(value);
	if (base !== value) {
		setBase(value);
		setDraft(value);
	}
	const commit = () => {
		if (draft !== value) onCommit(draft);
	};
	return (
		<input
			type="text"
			value={draft}
			aria-label={label}
			placeholder={placeholder}
			spellCheck={false}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") commit();
			}}
			className={`${INPUT} ${mono ? "font-mono text-xs" : ""}`}
		/>
	);
}

function IconButton({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className={`w-7 h-7 flex items-center justify-center rounded-md text-fg-3 disabled:opacity-30 disabled:pointer-events-none hover:bg-overlay-hover ${danger ? "hover:text-danger" : "hover:text-fg"} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-safe:active:scale-[0.96] transition-[color,background-color,transform] duration-150 ease-out`}
		>
			<svg aria-hidden className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
				{children}
			</svg>
		</button>
	);
}

/** "View options" for Attention: the bucket editor. Order is precedence — a task sits in the first bucket it matches. */
export function AttentionOptions(_props: { ctx: Context }) {
	const t = useT();
	const board = useBoard();
	const nameOf = useBucketName();
	const [layout, setLayout] = useAttentionLayout(board);
	const { buckets } = layout;
	const write = (next: AttentionBucket[]) => setLayout({ buckets: next });
	const patch = (id: string, change: Partial<AttentionBucket>) =>
		write(buckets.map((b) => (b.id === id ? { ...b, ...change } : b)));
	const move = (index: number, delta: number) => {
		const next = [...buckets];
		const [item] = next.splice(index, 1);
		next.splice(index + delta, 0, item);
		write(next);
	};
	const sortLabels: Record<AttentionBucketSort, string> = {
		priority: t("boardView.attention.sort.priority"),
		recent: t("boardView.attention.sort.recent"),
	};

	return (
		<div className="flex flex-col gap-3 w-[22rem] max-w-full" data-testid="attention-options">
			<div>
				<h3 className="text-sm font-semibold text-fg">{t("boardView.attention.options.title")}</h3>
				<p className="text-xs text-fg-3 mt-0.5 text-pretty">{t("boardView.attention.options.hint")}</p>
			</div>
			<ol className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto -mx-1 px-1 py-0.5">
				{buckets.map((bucket, index) => (
					<li key={bucket.id} data-testid="attention-options-bucket" className="flex flex-col gap-1.5 p-2 rounded-lg bg-elevated/60">
						<div className="flex items-center gap-1.5">
							<div className="flex-1 min-w-0">
								<CommitField
									value={bucket.name}
									placeholder={nameOf({ ...bucket, name: "" })}
									label={t("boardView.attention.options.name")}
									onCommit={(name) => patch(bucket.id, { name })}
								/>
							</div>
							<div className="flex-shrink-0">
								<Select
									value={bucket.sort}
									options={ATTENTION_BUCKET_SORTS.map((s) => ({ value: s, label: sortLabels[s] }))}
									onChange={(sort) => patch(bucket.id, { sort: sort as AttentionBucketSort })}
									ariaLabel={t("boardView.attention.options.sort")}
								/>
							</div>
						</div>
						<div className="flex items-center gap-1">
							<CommitField
								mono
								value={bucket.query}
								placeholder="is:attention"
								label={t("boardView.attention.options.query")}
								onCommit={(query) => patch(bucket.id, { query })}
							/>
							<IconButton label={t("boardView.attention.options.moveUp")} disabled={index === 0} onClick={() => move(index, -1)}>
								<path d="M12 19V5M5 12l7-7 7 7" />
							</IconButton>
							<IconButton label={t("boardView.attention.options.moveDown")} disabled={index === buckets.length - 1} onClick={() => move(index, 1)}>
								<path d="M12 5v14M5 12l7 7 7-7" />
							</IconButton>
							<IconButton danger label={t("boardView.attention.options.remove")} onClick={() => write(buckets.filter((b) => b.id !== bucket.id))}>
								<path d="M6 6l12 12M18 6L6 18" />
							</IconButton>
						</div>
					</li>
				))}
			</ol>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => write([...buckets, { id: newBucketId(buckets), name: "", query: "", sort: "priority" }])}
					className="min-h-8 px-3 rounded-md text-xs font-medium bg-accent text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-safe:active:scale-[0.96] transition-[background-color,transform] duration-150 ease-out"
				>
					{t("boardView.attention.options.add")}
				</button>
				<button
					type="button"
					onClick={() => write([...DEFAULT_ATTENTION_BUCKETS])}
					className="ml-auto min-h-8 px-3 rounded-md text-xs text-fg-3 hover:text-fg hover:bg-overlay-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				>
					{t("boardView.attention.options.reset")}
				</button>
			</div>
		</div>
	);
}
