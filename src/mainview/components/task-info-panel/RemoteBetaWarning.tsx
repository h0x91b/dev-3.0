import { isRemote } from "../../utils/platform";

/**
 * Yellow "still experimental over the tunnel" line appended to a tooltip's
 * detail body. Renders nothing in the desktop shell — dev server and port
 * tunnels are tuned for local use and only shaky in browser remote mode.
 */
export default function RemoteBetaWarning({ text }: { text: string }) {
	if (!isRemote()) return null;
	return (
		<span className="mt-1.5 flex items-start gap-1.5 text-warning">
			<span
				aria-hidden
				className="flex-shrink-0 leading-none"
				style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
			>
				{"\uf071"}
			</span>
			<span>{text}</span>
		</span>
	);
}
