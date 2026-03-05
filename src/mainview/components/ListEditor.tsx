/** Reusable list editor for string arrays (additionalArgs, clonePaths, etc.) */
export function ListEditor({
	items,
	onChange,
	placeholder,
	addLabel,
}: {
	items: string[];
	onChange: (items: string[]) => void;
	placeholder: string;
	addLabel: string;
}) {
	return (
		<div className="space-y-1.5">
			{items.map((item, i) => (
				<div key={i} className="flex gap-2">
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
						className="flex-1 px-3 py-1.5 bg-base border border-edge rounded-lg text-fg text-sm font-mono placeholder-fg-muted outline-none focus:border-accent/40 transition-colors"
					/>
					<button
						onClick={() => onChange(items.filter((_, j) => j !== i))}
						className="text-danger text-xs hover:underline shrink-0 px-2"
					>
						×
					</button>
				</div>
			))}
			<button
				onClick={() => onChange([...items, ""])}
				className="text-accent text-xs hover:underline"
			>
				+ {addLabel}
			</button>
		</div>
	);
}
