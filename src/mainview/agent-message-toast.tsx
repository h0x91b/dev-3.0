import type { TFunction } from "./i18n";
import type { ToastLink, ToastOpts } from "./toast";
import { AgentTrafficIcon } from "./components/HeaderIcons";

/** The `rpc:agentMessage` push payload, as the renderer reads it. */
export interface AgentMessageDetail {
	taskId: string;
	projectId: string;
	fromProjectId?: string;
	fromTaskId?: string;
	fromVariantIndex?: number;
	toVariantIndex?: number;
	toSeq: number;
	toTitle: string;
	fromSeq: number;
	fromTitle?: string;
	preview: string;
}

/** One task an agent-message toast names, with what it needs to be opened and spoken. */
export interface AgentToastEnd {
	taskId: string;
	projectId: string;
	/** `21`, or `21-2` for one attempt of a variant group. */
	seq: string;
	title?: string;
	/** Set only when the message crossed boards. */
	projectName?: string;
}

export interface AgentMessageToastDeps {
	t: TFunction;
	projectName: (projectId: string) => string | undefined;
	/** Whether the traffic destination exists right now; frozen into the toast. */
	trafficOffered: boolean;
	openEnd: (end: AgentToastEnd) => void;
	/** Opens agent traffic with the receiver as subject. */
	openTraffic: (recipient: AgentToastEnd) => void;
}

/** Paper plane: the end that sent the message (the toast itself is the envelope). */
function SentIcon() {
	return (
		<svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
			<path d="M21 3 10.5 13.5" />
			<path d="M21 3 14.5 21l-4-7.5L3 9.5 21 3Z" />
		</svg>
	);
}

/** Inbox tray: the end the message landed in. */
function ReceivedIcon() {
	return (
		<svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
			<path d="M3 13h5l1.5 3h5L16 13h5" />
			<path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5l2.5-8Z" />
		</svg>
	);
}

export function variantSeqLabel(seq: number, variantIndex: number | undefined): string {
	return variantIndex != null ? `${seq}-${variantIndex}` : `${seq}`;
}

/**
 * The violet toast for one `dev3 message`: both names as links, one row of labelled
 * actions (sender · traffic · recipient), and a card click that opens the SENDER
 * (decisions/2026/10/08/agent-message-toast-card-opens-the-sender.md).
 */
export function agentMessageToast(
	detail: AgentMessageDetail,
	{ t, projectName, trafficOffered, openEnd, openTraffic }: AgentMessageToastDeps,
): { message: string; opts: ToastOpts } {
	const { taskId, projectId, fromProjectId, toSeq, toTitle, fromSeq, fromTitle, preview } = detail;
	const senderProjectId = fromProjectId ?? projectId;
	// Name the projects only when the two ends live on different boards.
	const crossProject = senderProjectId !== projectId;
	const recipient: AgentToastEnd = {
		taskId,
		projectId,
		seq: variantSeqLabel(toSeq, detail.toVariantIndex),
		title: toTitle,
		projectName: crossProject ? projectName(projectId) : undefined,
	};
	const sender: AgentToastEnd | undefined = detail.fromTaskId
		? {
			taskId: detail.fromTaskId,
			projectId: senderProjectId,
			seq: variantSeqLabel(fromSeq, detail.fromVariantIndex),
			title: fromTitle,
			projectName: crossProject ? projectName(senderProjectId) : undefined,
		}
		: undefined;
	const fromLabel = sender?.seq ?? variantSeqLabel(fromSeq, detail.fromVariantIndex);
	const from = [`#${fromLabel}`, fromTitle].filter(Boolean).join(" ");
	const to = [`#${recipient.seq}`, toTitle].filter(Boolean).join(" ");
	const describe = (end: AgentToastEnd) =>
		[`#${end.seq}`, end.title, end.projectName && `· ${end.projectName}`].filter(Boolean).join(" ");
	const senderAria = sender && t("toast.agent.openSender", { task: describe(sender) });
	const recipientAria = t("toast.agent.openRecipient", { task: describe(recipient) });
	const link = (end: AgentToastEnd, ariaLabel: string): ToastLink => ({
		lead: `#${end.seq}`,
		label: end.title,
		suffix: end.projectName ? `· ${end.projectName}` : undefined,
		ariaLabel,
		onClick: () => openEnd(end),
	});
	const traffic = () => openTraffic(recipient);

	return {
		message: t("toast.agentMessage", { preview }),
		opts: {
			context: `${from} → ${to}`,
			contextParts: [sender ? link(sender, senderAria!) : from, "→", link(recipient, recipientAria)],
			// No sender id (a record queued before it existed) leaves the card inert:
			// guessing would open some other task. No `taskId` either, because the host
			// would resolve it into a default click on the recipient.
			...(sender ? { clickLabel: senderAria, onClick: () => openEnd(sender) } : {}),
			actions: [
				...(sender
					? [{
						label: `#${sender.seq}`,
						icon: <SentIcon />,
						ariaLabel: t("toast.agent.sender", { seq: sender.seq }),
						emphasis: true,
						onClick: () => openEnd(sender),
					}]
					: []),
				...(trafficOffered
					? [{ label: t("traffic.label"), icon: <AgentTrafficIcon className="h-3.5 w-3.5" />, shrink: true, onClick: traffic }]
					: []),
				{
					label: `#${recipient.seq}`,
					icon: <ReceivedIcon />,
					ariaLabel: t("toast.agent.recipient", { seq: recipient.seq }),
					onClick: () => openEnd(recipient),
				},
			],
		},
	};
}
