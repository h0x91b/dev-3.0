import type { TranslationRecord } from "./en";
import common from "./ru/common";
import dashboard from "./ru/dashboard";
import kanban from "./ru/kanban";
import settings from "./ru/settings";
import infoPanel from "./ru/infoPanel";
import terminal from "./ru/terminal";
import updates from "./ru/updates";
import columns from "./ru/columns";
import tips from "./ru/tips";
import gaugeDemo from "./ru/gaugeDemo";
import overview from "./ru/overview";
import scripts from "./ru/scripts";
import tunnels from "./ru/tunnels";

const ru: TranslationRecord & Record<string, string> = {
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
	...overview,
	...scripts,
	...tunnels,
};

export default ru;
