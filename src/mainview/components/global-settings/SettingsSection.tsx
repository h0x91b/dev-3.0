import type { ReactNode } from "react";

interface SettingsSectionProps {
	title: string;
	description?: string;
	children: ReactNode;
}

export default function SettingsSection({
	title,
	description,
	children,
}: SettingsSectionProps) {
	return (
		<section className="pt-8 first:pt-0 border-t border-edge/50 first:border-t-0">
			<div className="mb-4">
				<h2 className="text-fg text-sm font-semibold">{title}</h2>
				{description ? (
					<p className="text-fg-3 text-sm mt-1">{description}</p>
				) : null}
			</div>
			<div className="space-y-6">{children}</div>
		</section>
	);
}
