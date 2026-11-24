import { useRef, type KeyboardEvent } from "react";
import { LIBRARY_KINDS, type LibraryKind } from "../../../shared/library";
import { useT, type TranslationKey } from "../../i18n";

type KindFilter = LibraryKind | "all";

const OPTIONS: readonly KindFilter[] = ["all", ...LIBRARY_KINDS];

const LABEL: Record<KindFilter, TranslationKey> = {
	all: "library.kind.all",
	report: "library.kind.report",
	video: "library.kind.video",
	image: "library.kind.image",
	audio: "library.kind.audio",
};

// Same segment grammar as the board's Active | All switch.
const SEGMENT =
	"rounded-md px-2.5 py-1 text-sm leading-5 font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:scale-[0.96] transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none motion-reduce:active:scale-100";

/** One-click type filter for the Library: All · Reports · Video · Images · Audio. */
export default function LibraryKindSwitch({ value, onChange }: { value: KindFilter; onChange: (next: KindFilter) => void }) {
	const t = useT();
	const refs = useRef<Partial<Record<KindFilter, HTMLButtonElement | null>>>({});

	const select = (next: KindFilter) => {
		if (next !== value) onChange(next);
		refs.current[next]?.focus();
	};

	const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
		const index = OPTIONS.indexOf(value);
		const count = OPTIONS.length;
		let next: KindFilter | undefined;
		if (e.key === "ArrowRight" || e.key === "ArrowDown") next = OPTIONS[(index + 1) % count];
		else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = OPTIONS[(index - 1 + count) % count];
		else if (e.key === "Home") next = OPTIONS[0];
		else if (e.key === "End") next = OPTIONS[count - 1];
		if (!next) return;
		e.preventDefault();
		select(next);
	};

	return (
		<div
			role="radiogroup"
			aria-label={t("library.kind.label")}
			data-testid="library-kind-switch"
			className="inline-flex max-w-full flex-shrink-0 items-center gap-0.5 overflow-x-auto rounded-xl border border-edge bg-base p-0.5"
		>
			{OPTIONS.map((option) => {
				const selected = option === value;
				return (
					<button
						key={option}
						ref={(el) => { refs.current[option] = el; }}
						type="button"
						role="radio"
						aria-checked={selected}
						tabIndex={selected ? 0 : -1}
						onClick={() => select(option)}
						onKeyDown={onKeyDown}
						className={`${SEGMENT} ${selected ? "bg-elevated text-fg" : "text-fg-3 hover:text-fg-2 hover:bg-raised-hover"}`}
					>
						{t(LABEL[option])}
					</button>
				);
			})}
		</div>
	);
}
