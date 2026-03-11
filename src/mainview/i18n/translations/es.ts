import type { TranslationRecord } from "./en";
import common from "./es/common";
import dashboard from "./es/dashboard";
import kanban from "./es/kanban";
import settings from "./es/settings";
import infoPanel from "./es/infoPanel";
import terminal from "./es/terminal";
import updates from "./es/updates";
import columns from "./es/columns";
import tips from "./es/tips";
import gaugeDemo from "./es/gaugeDemo";

const es: TranslationRecord & Record<string, string> = {
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
};

export default es;
