import { useEffect, useState, type ReactNode } from "react";

/**
 * Streamer mode — a global privacy toggle for screen recording (bible §10).
 *
 * When ON, `<html data-streamer="on">` is set and every element carrying the
 * `streamer-private` (text) or `streamer-private-media` (QR/images) class is
 * blurred by CSS (`index.css`). Masking is pure CSS: toggling never re-renders
 * the tree, and the wrapped values stay in the DOM/clipboard — the threat
 * model is a viewer of a recording, not a local inspector. Terminal content
 * (tmux panes) is NOT masked — it renders whatever the agent prints.
 *
 * Any UI that displays identity-bearing values (emails, account labels,
 * org/workspace names, home-dir paths, tunnel URLs, GitHub logins) must apply
 * one of these classes — via the `Private` wrapper or directly on the element.
 */

export const STREAMER_MODE_STORAGE_KEY = "dev3-streamer-mode";
export const STREAMER_MODE_CHANGED_EVENT = "dev3:streamerModeChanged";

export function isStreamerModeOn(): boolean {
	try {
		return localStorage.getItem(STREAMER_MODE_STORAGE_KEY) === "on";
	} catch {
		return false;
	}
}

function applyStreamerAttribute(on: boolean): void {
	if (on) document.documentElement.dataset.streamer = "on";
	else delete document.documentElement.dataset.streamer;
}

export function setStreamerMode(on: boolean): void {
	try {
		localStorage.setItem(STREAMER_MODE_STORAGE_KEY, on ? "on" : "off");
	} catch {
		// localStorage unavailable — the attribute still applies for this session
	}
	applyStreamerAttribute(on);
	window.dispatchEvent(new CustomEvent(STREAMER_MODE_CHANGED_EVENT, { detail: { on } }));
}

export function toggleStreamerMode(): boolean {
	const next = !isStreamerModeOn();
	setStreamerMode(next);
	return next;
}

/**
 * Apply the persisted state before React mounts (theme-bootstrap pattern).
 *
 * A `?streamer=on|off` (or `1|0`) URL parameter overrides AND persists — the
 * machine entry point for agent-driven QA (`agent-browser` appends it to the
 * app URL so every screenshot is masked without touching the UI). Persisting
 * keeps `isStreamerModeOn()`/the settings toggle consistent with the attribute.
 */
export function initStreamerMode(): void {
	const param = new URLSearchParams(window.location.search).get("streamer");
	if (param === "on" || param === "1") {
		setStreamerMode(true);
		return;
	}
	if (param === "off" || param === "0") {
		setStreamerMode(false);
		return;
	}
	applyStreamerAttribute(isStreamerModeOn());
}

/** Reactive read of the toggle for controls that display its state. */
export function useStreamerMode(): boolean {
	const [on, setOn] = useState(isStreamerModeOn);
	useEffect(() => {
		function onChange() {
			setOn(isStreamerModeOn());
		}
		window.addEventListener(STREAMER_MODE_CHANGED_EVENT, onChange);
		return () => window.removeEventListener(STREAMER_MODE_CHANGED_EVENT, onChange);
	}, []);
	return on;
}

/** Inline wrapper for identity-bearing text; blurred while streamer mode is on. */
export function Private({ children, className }: { children: ReactNode; className?: string }) {
	return <span className={className ? `streamer-private ${className}` : "streamer-private"}>{children}</span>;
}
