import type { RequirementCheckResult } from "../../shared/types";
import { useT } from "../i18n";

interface Props {
	results: RequirementCheckResult[];
	checking: boolean;
	onRefresh: () => void;
}

export default function RequirementsCheck({ results, checking, onRefresh }: Props) {
	const t = useT();

	return (
		<div className="h-full w-full flex items-center justify-center bg-base">
			<div className="max-w-md w-full px-6">
				<h1 className="text-2xl font-semibold text-fg mb-2">
					{t("requirements.title")}
				</h1>
				<p className="text-fg-3 text-sm mb-6">
					{t("requirements.subtitle")}
				</p>

				<div className="space-y-3 mb-8">
					{results.map((req) => (
						<div
							key={req.id}
							className="flex items-start gap-3 p-3 rounded-lg bg-raised"
						>
							<span className="mt-0.5 text-lg leading-none">
								{req.installed ? (
									<span className="text-green-400">&#10003;</span>
								) : (
									<span className="text-danger">&#10007;</span>
								)}
							</span>
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2">
									<span className="font-medium text-fg">{req.name}</span>
									<span
										className={`text-xs px-1.5 py-0.5 rounded ${
											req.installed
												? "bg-green-400/15 text-green-400"
												: "bg-danger/15 text-danger"
										}`}
									>
										{req.installed
											? t("requirements.installed")
											: t("requirements.missing")}
									</span>
								</div>
								{!req.installed && (
									<div className="mt-1.5">
										<p className="text-fg-muted text-xs">
											{t(req.installHint as any)}
										</p>
										<a
											href={req.installUrl}
											target="_blank"
											rel="noopener noreferrer"
											className="text-accent text-xs hover:underline mt-1 inline-block"
										>
											{t("requirements.install")} &rarr;
										</a>
									</div>
								)}
							</div>
						</div>
					))}
				</div>

				<button
					type="button"
					onClick={onRefresh}
					disabled={checking}
					className="w-full py-2 px-4 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
				>
					{checking ? (
						<span className="flex items-center justify-center gap-2">
							<span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
							{t("requirements.refresh")}
						</span>
					) : (
						t("requirements.refresh")
					)}
				</button>
			</div>
		</div>
	);
}
