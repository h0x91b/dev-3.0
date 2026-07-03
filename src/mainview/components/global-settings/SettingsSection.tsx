import type { ReactNode } from "react";
import HelpSpot from "../HelpSpot";

interface SettingsSectionProps {
	title: string;
	description?: string;
	/** Inline-help topic (help.ts registry) rendered as a (i) next to the heading. */
	helpTopicId?: string;
	children: ReactNode;
}

export default function SettingsSection({
	title,
	description,
	helpTopicId,
	children,
}: SettingsSectionProps) {
	return (
		<section className="pt-8 first:pt-0 border-t border-edge/50 first:border-t-0">
			<div className="mb-4">
				<div className="flex items-center gap-1.5">
					<h2 className="text-fg text-sm font-semibold">{title}</h2>
					{helpTopicId ? <HelpSpot topicId={helpTopicId} /> : null}
				</div>
				{description ? (
					<p className="text-fg-3 text-sm mt-1">{description}</p>
				) : null}
			</div>
			<div className="space-y-6">{children}</div>
		</section>
	);
}
