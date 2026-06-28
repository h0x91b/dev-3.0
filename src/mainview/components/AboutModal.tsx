import { useT } from "../i18n";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useEscapeKey } from "../hooks/useEscapeKey";

interface AboutModalProps {
	version: string;
	onClose: () => void;
}

/**
 * In-app About dialog — replaces the native `Utils.showMessageBox` About box so
 * it renders in both the Electrobun desktop shell and remote/browser mode.
 */
export default function AboutModal({ version, onClose }: AboutModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	useEscapeKey(onClose);
	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[24rem] p-6 space-y-2 text-center outline-none"
			>
				<div
					className="text-accent text-4xl leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\uf489"}
				</div>
				<h2 className="text-fg text-lg font-semibold">dev-3.0</h2>
				<p className="text-fg-3 text-xs font-mono">{t("about.version", { version })}</p>
				<p className="text-fg-2 text-sm pt-1">{t("about.tagline")}</p>
				<p className="text-fg-muted text-xs">{t("about.builtWith")}</p>
				<div className="flex justify-center gap-2 pt-3">
					<button
						type="button"
						onClick={() => window.open("https://h0x91b.github.io/dev-3.0/", "_blank")}
						className="px-4 py-2 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
					>
						{t("about.website")}
					</button>
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
					>
						{t("about.close")}
					</button>
				</div>
			</div>
		</div>
	);
}
