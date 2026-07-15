import type { ReactNode } from "react";

/** Adds the stable scroll target owned by the settings registry. */
export default function SettingsEntry({
	anchor,
	children,
}: {
	anchor: string;
	children: ReactNode;
}) {
	return (
		<div
			id={`settings-entry-${anchor}`}
			data-settings-entry={anchor}
			className="scroll-mt-4"
		>
			{children}
		</div>
	);
}
