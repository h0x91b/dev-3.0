import { useCallback, useState } from "react";
import { useT } from "../i18n";
import { copyTextToClipboard } from "../utils/clipboard";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useEscapeKey } from "../hooks/useEscapeKey";

interface RosettaWarningModalProps {
	command: string;
	kind: "brew" | "dmg";
	onClose: () => void;
}

/**
 * Startup warning for an Intel (x64) build running under Rosetta 2 on an
 * Apple Silicon Mac (macOS is sunsetting Rosetta). Shows a copy-pasteable
 * reinstall command; reappears on every launch while the condition persists —
 * it clears itself once the user reinstalls the native arm64 build.
 */
export default function RosettaWarningModal({ command, kind, onClose }: RosettaWarningModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	useEscapeKey(onClose);
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(() => {
		void copyTextToClipboard(command).then((ok) => {
			if (!ok) return;
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});
	}, [command]);

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
				aria-labelledby="rosetta-warning-title"
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[34rem] max-w-[calc(100vw-2rem)] p-6 space-y-3 outline-none"
			>
				<div className="flex items-center gap-3">
					<span
						className="text-warning text-2xl leading-none"
						style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
					>
						{"\uf071"}
					</span>
					<h2 id="rosetta-warning-title" className="text-fg text-lg font-semibold">
						{t("rosetta.title")}
					</h2>
				</div>

				<p className="text-fg-2 text-sm">{t("rosetta.body")}</p>
				<p className="text-fg-3 text-sm">
					{kind === "brew" ? t("rosetta.instructionBrew") : t("rosetta.instructionDmg")}
				</p>

				<code className="block bg-base border border-edge rounded-lg px-3 py-2 text-xs font-mono text-warning break-all select-all">
					{command}
				</code>

				<p className="text-fg-muted text-xs">{t("rosetta.dataSafe")}</p>

				<div className="flex justify-end gap-2 pt-1">
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
					>
						{t("rosetta.laterBtn")}
					</button>
					<button
						type="button"
						onClick={handleCopy}
						className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
					>
						{copied ? t("rosetta.copiedBtn") : t("rosetta.copyBtn")}
					</button>
				</div>
			</div>
		</div>
	);
}
