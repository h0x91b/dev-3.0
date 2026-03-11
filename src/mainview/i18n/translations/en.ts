import common from "./en/common";
import dashboard from "./en/dashboard";
import kanban from "./en/kanban";
import settings from "./en/settings";
import infoPanel from "./en/infoPanel";
import terminal from "./en/terminal";
import updates from "./en/updates";
import columns from "./en/columns";
import tips from "./en/tips";
import gaugeDemo from "./en/gaugeDemo";

const en = {
	...common,
	...dashboard,
	...kanban,
	...settings,
	...infoPanel,
	...terminal,
	...updates,
	...columns,
	...tips,
	...gaugeDemo,
} as const;

export type TranslationKey = keyof typeof en;
export type TranslationRecord = Record<TranslationKey, string>;

export default en;
