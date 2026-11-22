import { useCallback, useEffect, useRef, useState } from "react";
import type { AutoHibernateSuggestion } from "../../shared/auto-hibernate";
import { api } from "../rpc";
import { RPC_STATUS_EVENT } from "../diagnostics";
import { toast } from "../toast";
import AutoHibernateSuggestionModal from "./AutoHibernateSuggestionModal";

export default function AutoHibernateSuggestions({ blocked = false }: { blocked?: boolean }) {
	const [suggestion, setSuggestion] = useState<AutoHibernateSuggestion | null>(null);
	const [otherDialog, setOtherDialog] = useState(false);
	const [visible, setVisible] = useState(() => document.visibilityState === "visible");
	const revision = useRef(0);
	const presentedId = useRef<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		const restore = () => {
			const at = ++revision.current;
			void api.request.getAutoHibernateSuggestion?.({})?.then(value => {
				if (!cancelled && at === revision.current) setSuggestion(value);
			}).catch(() => {});
		};
		const changed = (event: Event) => {
			revision.current++;
			setSuggestion((event as CustomEvent<{ suggestion: AutoHibernateSuggestion | null }>).detail.suggestion);
		};
		window.addEventListener("rpc:autoHibernateSuggestionChanged", changed);
		window.addEventListener(RPC_STATUS_EVENT, restore);
		restore();
		return () => {
			cancelled = true;
			window.removeEventListener("rpc:autoHibernateSuggestionChanged", changed);
			window.removeEventListener(RPC_STATUS_EVENT, restore);
		};
	}, []);
	useEffect(() => {
		const check = () => setOtherDialog([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
			.some(element => !element.closest("[data-auto-hibernate-dialog]")));
		check();
		const observer = new MutationObserver(check);
		observer.observe(document.body, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		const changed = () => setVisible(document.visibilityState === "visible");
		document.addEventListener("visibilitychange", changed);
		return () => document.removeEventListener("visibilitychange", changed);
	}, []);
	const respond = useCallback(async (action: "hibernate" | "snooze" | "hold", taskIds: string[]) => {
		if (!suggestion) return;
		try { await api.request.respondAutoHibernateSuggestion({ id: suggestion.id, action, taskIds }); }
		catch (error) { toast.error(String(error)); throw error; }
	}, [suggestion]);
	useEffect(() => {
		if (suggestion?.autoConfirmAt && presentedId.current === suggestion.id && (blocked || otherDialog || !visible)) void respond("hold", []).catch(() => {});
	}, [suggestion?.autoConfirmAt, blocked, otherDialog, visible, respond]);
	if (!suggestion || blocked || otherDialog || !visible) return null;
	return <div data-auto-hibernate-dialog>
		<AutoHibernateSuggestionModal key={suggestion.id} suggestion={suggestion}
			onPresent={() => { presentedId.current = suggestion.id; void api.request.presentAutoHibernateSuggestion({ id: suggestion.id }).catch(error => toast.error(String(error))); }}
			onHold={() => { void respond("hold", []).catch(() => {}); }}
			onRespond={respond} />
	</div>;
}
