import type { TFunction } from "../../i18n";
import {
	BUNDLED_TERMINAL_FONTS,
	REFERENCE_TERMINAL_FONT,
	terminalFontStack,
	terminalFontScale,
} from "../../terminal-font";

/**
 * Deliberately not localized. A terminal font is judged on the things a terminal
 * actually prints: Nerd Font icons, box drawing, ambiguous glyphs and digits.
 * Translating them would change what is being compared.
 */
const SAMPLE_PROMPT = " ~/src/dev-3.0   feat/terminal-font  2";
const SAMPLE_GLYPHS = "├─ 0OIl1 {}[]() =>=< !== --> ~/.dev3.0 ✓ ✗ ± → ×";

/**
 * Every bundled font rendering the same two lines, so picking one is a comparison
 * rather than a guess. Rows, not a grid: what differs between these fonts is the
 * horizontal extent of a line, and a card would crop exactly that away.
 */
export default function TerminalFontGallery({
	t,
	value,
	size,
	onSelect,
}: {
	t: TFunction;
	/** The family currently in force; empty means the reference font. */
	value: string;
	size: number;
	onSelect: (family: string) => void;
}) {
	const current = value.trim() || REFERENCE_TERMINAL_FONT;
	return (
		<div
			role="radiogroup"
			aria-label={t("settings.terminalFontGallery")}
			className="mt-3 flex flex-col gap-2"
		>
			{BUNDLED_TERMINAL_FONTS.map((font) => {
				const selected = font.family === current;
				const scale = terminalFontScale(font.family);
				// Rounded first: a 0.02% trim is true but reads as "0% narrower", which is
				// noise pretending to be information.
				const narrowedBy = Math.round((1 - scale) * 1000) / 10;
				return (
					<button
						key={font.family}
						type="button"
						role="radio"
						aria-checked={selected}
						onClick={() => onSelect(font.family)}
						className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
							selected
								? "border-accent bg-accent/10"
								: "border-edge bg-raised hover:border-edge-active"
						}`}
					>
						<span className="flex items-baseline gap-2 flex-wrap">
							<span className={`text-sm font-semibold ${selected ? "text-accent" : "text-fg"}`}>
								{font.label}
							</span>
							{/* The CSS family, for anyone matching this against their own config —
							    skipped when it is the label already, as it is for unpatched faces. */}
							{font.family !== font.label && (
								<span className="text-fg-muted text-micro">{font.family}</span>
							)}
							{font.family === REFERENCE_TERMINAL_FONT && (
								<span className="text-fg-3 text-micro">{t("settings.terminalFontReference")}</span>
							)}
							{narrowedBy > 0 && (
								<span className="text-fg-muted text-micro">
									{t("settings.terminalFontNarrowed", { percent: String(narrowedBy) })}
								</span>
							)}
						</span>
						<span
							className="mt-1.5 block rounded-lg bg-base border border-edge px-2.5 py-1.5 overflow-hidden"
							style={{ fontFamily: terminalFontStack(font.family), fontSize: size * scale }}
						>
							<span className="block whitespace-nowrap text-fg-2">{SAMPLE_PROMPT}</span>
							<span className="block whitespace-nowrap text-fg-3">{SAMPLE_GLYPHS}</span>
						</span>
					</button>
				);
			})}
		</div>
	);
}
