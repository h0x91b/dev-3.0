import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Terminal } from "ghostty-web";
import { api } from "../rpc";
import { buildSearchLine, findMatches, type SearchLine, type TerminalSearchMatch } from "../terminal-search";
import { useT } from "../i18n";
import Tooltip from "./Tooltip";

export interface TerminalSearchBarHandle {
	/** Re-focus the query input and select its text (repeat ⌘F while open). */
	focusInput: () => void;
}

interface TerminalSearchBarProps {
	/** PTY session key — a task id or `project-<id>`. */
	taskId: string;
	onClose: () => void;
	/**
	 * Called with the tmux pane id the search resolved to (or null when the pane
	 * is gone). TerminalView uses it to frame that pane so a multi-pane layout
	 * makes it obvious WHICH pane is being searched.
	 */
	onPaneResolved?: (paneId: string | null) => void;
	/**
	 * Native-backend terminal: search its own ghostty buffer instead of tmux
	 * copy-mode. No tmuxSearch* call is made when this is set.
	 */
	term?: Terminal;
	/** Native search: true while the bar's current-match highlight is the terminal selection. */
	onHighlightChange?: (on: boolean) => void;
}

const SEARCH_DEBOUNCE_MS = 150;

/**
 * Floating ⌘F search bar over a terminal. The search itself runs inside tmux
 * copy-mode (the scrollback lives there, not in ghostty), so tmux highlights
 * every match in the pane content natively; this bar only drives the query and
 * steps between matches. Enter / ↑ walk up the history (older), Shift+Enter /
 * ↓ walk back down (newer) — terminal convention: search starts at the most
 * recent output. See `decisions/2026/07/20/terminal-cmdf-tmux-copy-mode-search.md`. With `term` (native backend, no tmux) the
 * same bar searches the renderer's ghostty buffer directly.
 */
const TerminalSearchBar = forwardRef<TerminalSearchBarHandle, TerminalSearchBarProps>(
	function TerminalSearchBar({ taskId, onClose, onPaneResolved, term, onHighlightChange }, ref) {
		const t = useT();
		const inputRef = useRef<HTMLInputElement>(null);
		// Mirror the callback in a ref so runUpdate (called from the debounce
		// effect) always sees the latest without re-running the effect.
		const onPaneResolvedRef = useRef(onPaneResolved);
		onPaneResolvedRef.current = onPaneResolved;
		const onHighlightChangeRef = useRef(onHighlightChange);
		onHighlightChangeRef.current = onHighlightChange;
		const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		const [query, setQuery] = useState("");
		// null = nothing searched yet (empty query) — the counter stays hidden.
		const [matches, setMatches] = useState<number | null>(null);
		// The pane the search is pinned to. Resolved by the first update; kept in
		// a ref so the unmount cleanup below sees the latest value.
		const paneIdRef = useRef<string | null>(null);
		// Guards against out-of-order RPC responses while typing fast.
		const requestSeqRef = useRef(0);

		// Native search: index of the current match in the latest match list.
		const matchIndexRef = useRef(0);

		useImperativeHandle(ref, () => ({
			focusInput: () => {
				inputRef.current?.focus();
				inputRef.current?.select();
			},
		}), []);

		useEffect(() => {
			inputRef.current?.focus();
		}, []);

		// Leaving the search (✕, Esc, task switch, terminal unmount) always exits
		// copy-mode so the pane resumes live output — cleanup is the single path.
		useEffect(() => {
			if (term) return;
			return () => {
				const paneId = paneIdRef.current;
				if (!paneId) return;
				api.request.tmuxSearchCancel({ taskId, paneId }).catch(() => {});
			};
		}, [taskId, term]);

		// shortcut: wrapped scrollback rows unsplit, upgrade when ghostty exposes isWrapped for scrollback
		function nativeMatches(q: string): TerminalSearchMatch[] {
			if (!q) return [];
			const buffer = term!.buffer.active;
			const lines: SearchLine[] = [];
			for (let y = 0; y < buffer.length; y++) {
				const line = buffer.getLine(y);
				lines.push(line ? buildSearchLine(line) : { text: "", col: [], end: [] });
			}
			return findMatches(lines, q);
		}

		// ghostty's select() takes a viewport row but anchors it at viewportY, so
		// scroll first, select, then scroll the match into view.
		// shortcut: current-match highlight only, upgrade when ghostty has a decoration API
		function revealNativeMatch(match: TerminalSearchMatch) {
			const scrollback = term!.buffer.active.length - term!.rows;
			const anchor = Math.min(match.row, scrollback);
			term!.scrollToLine(anchor);
			term!.select(match.col, match.row - anchor, match.length);
			const top = Math.max(0, match.row - Math.floor(term!.rows / 2));
			term!.scrollToLine(scrollback - top);
			onHighlightChangeRef.current?.(true);
		}

		function clearNativeHighlight() {
			term!.clearSelection();
			onHighlightChangeRef.current?.(false);
		}

		function runNativeUpdate(q: string): TerminalSearchMatch[] {
			const found = nativeMatches(q);
			matchIndexRef.current = found.length - 1;
			setMatches(q ? found.length : null);
			if (found.length) revealNativeMatch(found[matchIndexRef.current]);
			else clearNativeHighlight();
			return found;
		}

		function runNativeStep(direction: "older" | "newer") {
			if (!query) return;
			// Enter inside the debounce window: commit the typed query first, or its timer undoes this step.
			let found: TerminalSearchMatch[];
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
				found = runNativeUpdate(query);
			} else {
				// ghostty-web has no buffer-changed event, so re-read on every step.
				found = nativeMatches(query);
				setMatches(found.length);
			}
			if (!found.length) return clearNativeHighlight();
			const delta = direction === "older" ? -1 : 1;
			const from = Math.min(matchIndexRef.current, found.length - 1);
			matchIndexRef.current = (from + delta + found.length) % found.length;
			revealNativeMatch(found[matchIndexRef.current]);
		}

		function runUpdate(q: string) {
			if (term) return runNativeUpdate(q);
			const seq = ++requestSeqRef.current;
			api.request
				.tmuxSearchUpdate({ taskId, query: q, paneId: paneIdRef.current ?? undefined })
				.then((res) => {
					if (requestSeqRef.current !== seq) return;
					paneIdRef.current = res.paneId;
					onPaneResolvedRef.current?.(res.paneId);
					setMatches(q ? res.matches : null);
				})
				.catch(() => {
					if (requestSeqRef.current !== seq) return;
					setMatches(q ? 0 : null);
				});
		}

		useEffect(() => {
			const timer = setTimeout(() => {
				debounceRef.current = null;
				runUpdate(query);
			}, SEARCH_DEBOUNCE_MS);
			debounceRef.current = timer;
			return () => clearTimeout(timer);
		}, [taskId, query, term]);

		// Closing leaves the scroll position alone — only the highlight goes.
		useEffect(() => {
			if (!term) return;
			return () => {
				try { term.clearSelection(); } catch { /* disposed */ }
				onHighlightChangeRef.current?.(false);
			};
		}, [term]);

		function step(direction: "older" | "newer") {
			if (term) return runNativeStep(direction);
			const paneId = paneIdRef.current;
			if (!paneId || !query) return;
			api.request
				.tmuxSearchStep({ taskId, paneId, direction })
				.then((res) => {
					// 0 after a step usually means the pane left copy-mode behind our
					// back (global Esc, user's own `q`) — restart the search instead
					// of showing a dead zero for a query that just had matches.
					if (res.matches === 0) runUpdate(query);
					else setMatches(res.matches);
				})
				.catch(() => runUpdate(query));
		}

		function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
			if (e.key === "Enter") {
				e.preventDefault();
				step(e.shiftKey ? "newer" : "older");
			} else if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		}

		const noMatches = matches === 0 && query.length > 0;

		return (
			<div className="absolute top-2 right-2 z-30 flex items-center gap-1 rounded-lg border border-edge bg-elevated/95 px-2 py-1 shadow-lg shadow-black/30 backdrop-blur-sm">
				<input
					ref={inputRef}
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={t("terminal.searchPlaceholder")}
					aria-label={t("terminal.searchPlaceholder")}
					spellCheck={false}
					autoCorrect="off"
					autoCapitalize="off"
					className="w-44 bg-transparent text-sm text-fg placeholder:text-fg-muted"
				/>
				{matches !== null && (
					<span
						className={`min-w-[2ch] text-right text-xs tabular-nums ${noMatches ? "text-danger" : "text-fg-muted"}`}
						aria-live="polite"
					>
						{matches}
					</span>
				)}
				<Tooltip content={t("terminal.searchOlder")} placement="bottom">
					<button
						type="button"
						onClick={() => step("older")}
						disabled={!matches}
						aria-label={t("terminal.searchOlder")}
						className="rounded px-1 text-sm text-fg-3 transition-colors hover:text-fg disabled:opacity-40"
					>
						{"↑"}
					</button>
				</Tooltip>
				<Tooltip content={t("terminal.searchNewer")} placement="bottom">
					<button
						type="button"
						onClick={() => step("newer")}
						disabled={!matches}
						aria-label={t("terminal.searchNewer")}
						className="rounded px-1 text-sm text-fg-3 transition-colors hover:text-fg disabled:opacity-40"
					>
						{"↓"}
					</button>
				</Tooltip>
				<Tooltip content={t("terminal.searchClose")} placement="bottom">
					<button
						type="button"
						onClick={onClose}
						aria-label={t("terminal.searchClose")}
						className="rounded px-1 text-sm text-fg-3 transition-colors hover:text-fg"
					>
						{"✕"}
					</button>
				</Tooltip>
			</div>
		);
	},
);

export default TerminalSearchBar;
