import type { TaskPRBadgeInfo } from "../../shared/types";
import { useLocale, useT } from "../i18n";
import { useSharedClockValue } from "../hooks/useNow";
import { relativeAge } from "../utils/statusAge";

const TICK_MS = 30_000;

/** The author's profile on the PR's own GitHub host (GitHub Enterprise included). */
export function githubProfileUrl(login: string, prUrl?: string | null): string {
	let origin = "https://github.com";
	try {
		if (prUrl) origin = new URL(prUrl).origin;
	} catch {
		// A malformed PR URL still has a sensible profile on github.com.
	}
	return `${origin}/${encodeURIComponent(login)}`;
}

/** The PR author as a link to their GitHub profile, opened in a new tab. */
export function PrAuthorLink({ login, prUrl, className = "" }: { login: string; prUrl?: string | null; className?: string }) {
	const t = useT();
	return (
		<a
			href={githubProfileUrl(login, prUrl)}
			target="_blank"
			rel="noopener noreferrer"
			data-testid="pr-byline-author"
			title={t("task.prAuthor", { author: login })}
			className={`min-w-0 truncate rounded font-medium text-fg-2 transition-colors hover:text-accent-emphasis hover:underline focus:ring-1 focus:ring-accent ${className}`}
			onClick={(event) => event.stopPropagation()}
		>
			{login}
		</a>
	);
}

/** "a week ago" — or null when there is nothing to say about `iso`. */
export function useRelativeAgo(iso: string | null | undefined): string | null {
	const t = useT();
	return useSharedClockValue(TICK_MS, (now) => {
		const age = relativeAge(iso, now);
		if (!age) return "";
		if (age.unit === "now") return t("activity.justNow");
		if (age.unit === "yesterday") return t("time.ago.yesterday");
		return t.plural(`time.ago.${age.unit}` as Parameters<typeof t.plural>[0], age.value);
	}) || null;
}

/**
 * Who opened the PR and how fresh its head commit is, on one muted line.
 * Each half is dropped when GitHub did not send it (an older cache, a ghost author).
 */
export default function PrByline({ prInfo, showAuthor = true, className = "" }: {
	prInfo: Pick<TaskPRBadgeInfo, "authorLogin" | "lastCommitAt" | "url">;
	/** False when the surface puts the author elsewhere (the reference card's footer). */
	showAuthor?: boolean;
	className?: string;
}) {
	const t = useT();
	const [locale] = useLocale();
	const author = showAuthor ? prInfo.authorLogin || null : null;
	const ago = useRelativeAgo(prInfo.lastCommitAt);
	if (!author && !ago) return null;
	const exact = ago && prInfo.lastCommitAt
		? new Date(prInfo.lastCommitAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
		: null;
	return (
		<div data-testid="pr-byline" className={`flex min-w-0 items-center gap-1.5 text-fg-3 ${className}`}>
			{author && <PrAuthorLink login={author} prUrl={prInfo.url} />}
			{author && ago && <span aria-hidden className="flex-shrink-0 text-fg-muted">·</span>}
			{ago && (
				<time
					data-testid="pr-byline-commit"
					dateTime={prInfo.lastCommitAt ?? undefined}
					title={exact ? t("task.prLastCommitAt", { date: exact }) : undefined}
					className="flex-shrink-0 whitespace-nowrap tabular-nums"
				>
					{t("task.prLastCommit", { ago })}
				</time>
			)}
		</div>
	);
}
