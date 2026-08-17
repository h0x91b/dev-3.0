import { api } from "./rpc";

/**
 * Report the page's own view of its geometry into the backend log, so a broken
 * layout after a resolution change or a wake can be read off one file: the
 * backend writes the window frame and the display bounds, this writes what the
 * page believes. If the two disagree the viewport went stale; if they agree the
 * geometry was never the problem.
 *
 * Only real changes are reported, so an idle app writes nothing.
 */

const DEBOUNCE_MS = 500;

export function startViewportDiagnostics(): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let last = "";

	function report() {
		const width = window.innerWidth;
		const height = window.innerHeight;
		const dpr = window.devicePixelRatio;
		const signature = `${width}x${height}@${dpr}`;
		if (signature === last) return;
		last = signature;
		try {
			void api.request
				.logRendererDiagnostic({
					level: "info",
					tag: "viewport",
					message: "renderer viewport",
					extra: { innerWidth: width, innerHeight: height, devicePixelRatio: dpr },
				})
				?.catch(() => {});
		} catch {
			/* diagnostics only — never break the app */
		}
	}

	function schedule() {
		if (timer) clearTimeout(timer);
		timer = setTimeout(report, DEBOUNCE_MS);
	}

	report();
	window.addEventListener("resize", schedule);
	return () => {
		if (timer) clearTimeout(timer);
		window.removeEventListener("resize", schedule);
	};
}
