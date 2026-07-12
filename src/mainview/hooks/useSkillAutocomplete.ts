import { useCallback, useEffect, useState, type KeyboardEvent, type RefObject } from "react";
import type { AgentSkillInfo } from "../../shared/types";
import { api } from "../rpc";

const MAX_SUGGESTIONS = 8;
export type SkillInvocationPrefix = "$" | "/";

const SKILL_INVOCATION_PREFIXES: readonly SkillInvocationPrefix[] = ["/", "$"];

interface SkillToken {
	/** Index of the leading skill prefix in the text. */
	start: number;
	/** Prefix the user typed, preserved when accepting a suggestion. */
	invocationPrefix: SkillInvocationPrefix;
	/** Text typed after the prefix (may be empty). */
	query: string;
}

/** Find an active skill token with a supported agent prefix, or null. */
export function findSkillToken(text: string, caret: number, invocationPrefixes = SKILL_INVOCATION_PREFIXES): SkillToken | null {
	let start = caret;
	while (start > 0 && !/[\s]/.test(text[start - 1])) start--;
	const invocationPrefix = text[start] as SkillInvocationPrefix;
	if (!invocationPrefixes.includes(invocationPrefix)) return null;
	const token = text.slice(start, caret);
	if (!/^[\w-]*$/.test(token.slice(1))) return null;
	return { start, invocationPrefix, query: token.slice(1) };
}

/** Filter skills by query: prefix matches first, then substring matches. */
export function filterSkills(skills: AgentSkillInfo[], query: string): AgentSkillInfo[] {
	const q = query.toLowerCase();
	if (!q) return skills.slice(0, MAX_SUGGESTIONS);
	const prefix: AgentSkillInfo[] = [];
	const substring: AgentSkillInfo[] = [];
	for (const skill of skills) {
		const name = skill.name.toLowerCase();
		if (name.startsWith(q)) prefix.push(skill);
		else if (name.includes(q)) substring.push(skill);
	}
	return [...prefix, ...substring].slice(0, MAX_SUGGESTIONS);
}

/**
 * Skill-name autocomplete for a textarea. Typing "/" or "$" at a word boundary
 * opens a suggestion list of installed agent skills — the project's local
 * `.agents/.claude/.codex/skills` (when `projectPath` is given) plus the global
 * home directories, via `listAgentSkills`. Project-local skills win over
 * same-named global ones. The prefix is user-selected because the launch agent
 * is chosen after the task description is written.
 */
export function useSkillAutocomplete(
	textareaRef: RefObject<HTMLTextAreaElement | null>,
	value: string,
	setValue: (next: string) => void,
	projectPath?: string | null,
) {
	const [skills, setSkills] = useState<AgentSkillInfo[]>([]);
	const [token, setToken] = useState<SkillToken | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	const [dismissed, setDismissed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		api.request
			.listAgentSkills({ projectPath })
			.then((result) => {
				if (!cancelled) setSkills(result);
			})
			.catch(() => {
				/* No skills — autocomplete simply never opens. */
			});
		return () => {
			cancelled = true;
		};
	}, [projectPath]);

	const sync = useCallback(() => {
		const el = textareaRef.current;
		if (!el) return;
		const next = findSkillToken(el.value, el.selectionStart);
		setToken((prev) => {
			if (prev?.start !== next?.start) setDismissed(false);
			if (prev?.start === next?.start && prev?.invocationPrefix === next?.invocationPrefix && prev?.query === next?.query) return prev;
			setActiveIndex(0);
			return next;
		});
	}, [textareaRef]);

	const items = token && !dismissed ? filterSkills(skills, token.query) : [];
	const open = items.length > 0;

	const close = useCallback(() => setDismissed(true), []);

	const accept = useCallback(
		(skill: AgentSkillInfo) => {
			const el = textareaRef.current;
			if (!el || !token) return;
			const caret = el.selectionStart;
			const insert = `${token.invocationPrefix}${skill.name} `;
			const next = value.slice(0, token.start) + insert + value.slice(caret);
			setValue(next);
			setToken(null);
			requestAnimationFrame(() => {
				const pos = token.start + insert.length;
				el.selectionStart = pos;
				el.selectionEnd = pos;
				el.focus();
			});
		},
		[textareaRef, token, value, setValue],
	);

	/** Returns true when the event was consumed by the autocomplete. */
	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
			if (!open) return false;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveIndex((i) => (i + 1) % items.length);
				return true;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveIndex((i) => (i - 1 + items.length) % items.length);
				return true;
			}
			if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
				e.preventDefault();
				accept(items[Math.min(activeIndex, items.length - 1)]);
				return true;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				close();
				return true;
			}
			return false;
		},
		[open, items, activeIndex, accept, close],
	);

	return {
		open,
		items,
		activeIndex,
		setActiveIndex,
		sync,
		accept,
		close,
		handleKeyDown,
		invocationPrefix: token?.invocationPrefix ?? "/",
	};
}
