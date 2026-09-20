import { useCallback, useEffect, useRef, useState } from "react";
import { ONBOARDING_POLL_MS, type InterfaceOnboardingRequest, type InterfaceOnboardingResponse } from "../../shared/interface-onboarding";
import { api } from "../rpc";
import type { Route } from "../state";
import { backLayerCount } from "../back-navigation";
import { getOverlayLayerElements } from "../utils/overlay-layers";
import { isTypingContext } from "../utils/typing-context";
import { artifactActivity } from "../artifact-activity";

export function onboardingRouteIsCalm(route: Route): boolean {
	return route.screen === "dashboard" || (route.screen === "project" && !route.activeTaskId && !route.taskDetailId && !route.taskView && !route.diff && !route.openUnresolvedComments);
}

export function useInterfaceOnboarding(route: Route, blocked: boolean) {
	const [prompt, setPrompt] = useState<InterfaceOnboardingResponse["prompt"]>(null);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const clientId = useRef(crypto.randomUUID());
	const lastInput = useRef(-Infinity);
	const current = useRef({ route, blocked, prompt });
	current.current = { route, blocked, prompt };
	const requestPending = useRef<Promise<unknown> | null>(null);
	const mutationPending = useRef(false);
	const mounted = useRef(true);
	const leaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const signals = useCallback(() => {
		const visible = document.visibilityState === "visible" && document.hasFocus();
		const idle = Date.now() - lastInput.current;
		const ownPrompt = current.current.prompt !== null;
		const calm = visible && !current.current.blocked && onboardingRouteIsCalm(current.current.route)
			&& (ownPrompt || idle >= 10_000) && !isTypingContext()
			&& backLayerCount() <= (ownPrompt ? 1 : 0) && getOverlayLayerElements().length === 0
			&& artifactActivity.open === 0;
		return { active: visible && idle <= 60_000, calm };
	}, []);

	const request = useCallback(async (action: InterfaceOnboardingRequest["action"]) => {
		if (action === "poll" && (requestPending.current || mutationPending.current)) return false;
		if (action !== "poll") {
			if (mutationPending.current) return false;
			mutationPending.current = true;
			setBusy(true);
			setFailed(false);
			await requestPending.current?.catch(() => {});
		}
		try {
			const startedAt = Date.now();
			const pending = api.request.interfaceOnboarding({ action, clientId: clientId.current, ...signals() });
			requestPending.current = pending;
			const result = await pending;
			if (mounted.current) {
				if (leaseTimer.current) clearTimeout(leaseTimer.current);
				const remaining = startedAt + 30_000 - Date.now();
				setPrompt(signals().calm && remaining > 0 ? result.prompt : null);
				if (result.prompt && remaining > 0) leaseTimer.current = setTimeout(() => setPrompt(null), remaining);
			}
			return true;
		} catch {
			if (mounted.current && action === "poll") setPrompt(null);
			if (mounted.current && action !== "poll") setFailed(true);
			return false;
		} finally {
			requestPending.current = null;
			if (action !== "poll") {
				mutationPending.current = false;
				if (mounted.current) setBusy(false);
			}
		}
	}, [signals]);

	useEffect(() => {
		mounted.current = true;
		const input = (event: Event) => { if (event.isTrusted) lastInput.current = Date.now(); };
		const visibility = () => {
			if (!document.hasFocus() || document.visibilityState !== "visible") setPrompt(null);
			void request("poll");
		};
		const events = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"];
		for (const event of events) window.addEventListener(event, input, { capture: true, passive: true });
		window.addEventListener("blur", visibility);
		document.addEventListener("visibilitychange", visibility);
		void request("poll");
		const timer = setInterval(() => void request("poll"), ONBOARDING_POLL_MS);
		return () => {
			mounted.current = false;
			clearInterval(timer);
			if (leaseTimer.current) clearTimeout(leaseTimer.current);
			for (const event of events) window.removeEventListener(event, input, true);
			window.removeEventListener("blur", visibility);
			document.removeEventListener("visibilitychange", visibility);
		};
	}, [request]);

	useEffect(() => {
		if (blocked || !onboardingRouteIsCalm(route)) setPrompt(null);
	}, [route, blocked]);
	return { prompt, busy, failed, request };
}
