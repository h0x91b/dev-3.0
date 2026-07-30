/** Reusable list editor for string arrays (additionalArgs, clonePaths, etc.) */
export function ListEditor({
	items,
	onChange,
	placeholder,
	addLabel,
	removeLabel,
}: {
	items: string[];
	onChange: (items: string[]) => void;
	placeholder: string;
	addLabel: string;
	/** Accessible name for each row's remove button. */
	removeLabel: string;
}) {
	return (
		<div className="space-y-1.5">
			{items.map((item, i) => (
				<div key={i} className="flex items-center gap-1.5">
					<input
						type="text"
						value={item}
						onChange={(e) => {
							const next = [...items];
							next[i] = e.target.value;
							onChange(next);
						}}
						placeholder={placeholder}
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						className="flex-1 min-w-0 px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
					/>
					<button
						type="button"
						onClick={() => onChange(items.filter((_, j) => j !== i))}
						aria-label={removeLabel}
						title={removeLabel}
						className="flex-shrink-0 grid place-items-center w-8 h-8 rounded-lg text-fg-3 hover:text-danger hover:bg-danger/10 outline-none focus-visible:ring-2 focus-visible:ring-danger/50 transition-colors"
					>
						<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>
			))}
			<button
				type="button"
				onClick={() => onChange([...items, ""])}
				className="px-2 py-1 -ml-2 rounded-lg text-accent text-xs font-medium outline-none hover:bg-accent/10 focus-visible:ring-2 focus-visible:ring-accent/50 transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]"
			>
				+ {addLabel}
			</button>
		</div>
	);
}
