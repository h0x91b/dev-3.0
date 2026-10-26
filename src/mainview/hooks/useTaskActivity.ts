import { useEffect } from "react";
import { api } from "../rpc";
import { randomUUID } from "../uuid";

export function useTaskActivity(taskId: string | null): void {
	useEffect(() => {
		if (!taskId) return;
		const clientId = randomUUID();
		const focused = () => document.visibilityState === "visible" && document.hasFocus();
		const send = () => {
			void api.request.reportTaskActivity?.({ clientId, taskId, focused: focused() })?.catch?.(() => {});
		};
		let lastReport = 0;
		const onInput = () => {
			if (Date.now() - lastReport < 5_000) return;
			lastReport = Date.now();
			send();
		};
		send();
		const timer = setInterval(() => { if (focused()) send(); }, 10_000);
		const events = ["pointerdown", "pointermove", "keydown", "wheel"] as const;
		for (const event of events) window.addEventListener(event, onInput, { passive: true, capture: true });
		window.addEventListener("focus", send);
		window.addEventListener("blur", send);
		document.addEventListener("visibilitychange", send);
		return () => {
			clearInterval(timer);
			for (const event of events) window.removeEventListener(event, onInput, { capture: true });
			window.removeEventListener("focus", send);
			window.removeEventListener("blur", send);
			document.removeEventListener("visibilitychange", send);
			void api.request.reportTaskActivity?.({ clientId, taskId: null, focused: false })?.catch?.(() => {});
		};
	}, [taskId]);
}
