import { useState, useRef, useEffect } from "react";
import { useT } from "../i18n";

const TAB_BAR_H = 36;
const DEFAULT_OPEN_H = 260;
const MIN_H = 80;

type TabId = "env" | "logs" | "files";

interface EnvVar {
	key: string;
	value: string;
	masked?: boolean;
}

interface LogEntry {
	time: string;
	level: "info" | "success" | "warn" | "error" | "muted";
	text: string;
}

interface FileNode {
	name: string;
	type: "file" | "dir";
	children?: FileNode[];
}

const MOCK_ENV: EnvVar[] = [
	{ key: "GIT_BRANCH", value: "dev3/task-827699cf" },
	{ key: "NODE_ENV", value: "development" },
	{ key: "BUN_VERSION", value: "1.1.38" },
	{ key: "PORT", value: "5173" },
	{ key: "CLAUDE_API_KEY", value: "sk-ant-api03-••••••••", masked: true },
	{ key: "PATH", value: "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin" },
	{ key: "HOME", value: "/Users/arsenyp" },
	{ key: "SHELL", value: "/bin/zsh" },
	{ key: "TERM", value: "xterm-256color" },
	{ key: "LANG", value: "en_US.UTF-8" },
];

const MOCK_LOGS: LogEntry[] = [
	{ time: "12:34:01", level: "muted", text: "Task created" },
	{ time: "12:34:02", level: "success", text: "Worktree created → .dev3.0/worktrees/task-827699cf" },
	{ time: "12:34:03", level: "success", text: "Setup script exited 0" },
	{ time: "12:35:14", level: "info", text: "Launching agent: claude-sonnet-4-6" },
	{ time: "12:35:16", level: "muted", text: "$ claude --continue" },
	{ time: "13:42:01", level: "warn", text: "Token usage: 87k / 100k" },
	{ time: "13:43:12", level: "info", text: "Agent working on task..." },
	{ time: "13:58:00", level: "success", text: "Changes committed (3 files)" },
];

const MOCK_FILES: FileNode[] = [
	{
		name: "src",
		type: "dir",
		children: [
			{
				name: "mainview",
				type: "dir",
				children: [
					{ name: "App.tsx", type: "file" },
					{ name: "state.ts", type: "file" },
					{ name: "rpc.ts", type: "file" },
					{ name: "TerminalView.tsx", type: "file" },
					{
						name: "components",
						type: "dir",
						children: [
							{ name: "GlobalHeader.tsx", type: "file" },
							{ name: "SecondaryPanel.tsx", type: "file" },
							{ name: "TaskTerminal.tsx", type: "file" },
							{ name: "KanbanBoard.tsx", type: "file" },
						],
					},
				],
			},
			{
				name: "bun",
				type: "dir",
				children: [
					{ name: "index.ts", type: "file" },
					{ name: "rpc-handlers.ts", type: "file" },
				],
			},
			{
				name: "shared",
				type: "dir",
				children: [{ name: "types.ts", type: "file" }],
			},
		],
	},
	{ name: "package.json", type: "file" },
	{ name: "tsconfig.json", type: "file" },
	{ name: "CLAUDE.md", type: "file" },
];

const LOG_LEVEL_CLASS: Record<LogEntry["level"], string> = {
	muted: "text-fg-muted",
	info: "text-accent",
	success: "text-emerald-400",
	warn: "text-amber-400",
	error: "text-danger",
};

function FileTree({
	nodes,
	depth,
	expanded,
	onToggle,
}: {
	nodes: FileNode[];
	depth: number;
	expanded: Set<string>;
	onToggle: (name: string) => void;
}) {
	return (
		<>
			{nodes.map((node) => (
				<div key={node.name}>
					<button
						className="w-full flex items-center gap-1.5 py-0.5 hover:bg-elevated/50 transition-colors rounded-sm"
						style={{ paddingLeft: `${8 + depth * 14}px` }}
						onClick={() => node.type === "dir" && onToggle(node.name)}
					>
						{node.type === "dir" ? (
							<>
								<span className="text-fg-muted text-[10px] w-3 text-left flex-shrink-0">
									{expanded.has(node.name) ? "▾" : "▸"}
								</span>
								<svg
									className="w-3.5 h-3.5 text-amber-400/70 flex-shrink-0"
									fill="currentColor"
									viewBox="0 0 20 20"
								>
									<path
										fillRule="evenodd"
										d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1H8a3 3 0 00-3 3v1.5a1.5 1.5 0 01-3 0V6z"
										clipRule="evenodd"
									/>
									<path d="M6 12a2 2 0 012-2h8a2 2 0 012 2v2a2 2 0 01-2 2H2h2a2 2 0 002-2v-2z" />
								</svg>
								<span className="text-xs text-fg-2">{node.name}/</span>
							</>
						) : (
							<>
								<span className="w-3 flex-shrink-0" />
								<svg
									className="w-3.5 h-3.5 text-fg-muted flex-shrink-0"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={1.5}
										d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
									/>
								</svg>
								<span className="text-xs text-fg-3">{node.name}</span>
							</>
						)}
					</button>
					{node.type === "dir" && expanded.has(node.name) && node.children && (
						<FileTree
							nodes={node.children}
							depth={depth + 1}
							expanded={expanded}
							onToggle={onToggle}
						/>
					)}
				</div>
			))}
		</>
	);
}

export default function SecondaryPanel() {
	const t = useT();
	const [activeTab, setActiveTab] = useState<TabId | null>(null);
	const [openHeight, setOpenHeight] = useState(DEFAULT_OPEN_H);
	const [isDragging, setIsDragging] = useState(false);
	const [fileExpanded, setFileExpanded] = useState<Set<string>>(
		new Set(["src", "mainview", "components"]),
	);
	const dragStartY = useRef(0);
	const dragStartH = useRef(0);

	const isOpen = activeTab !== null;
	const panelHeight = isOpen ? openHeight : TAB_BAR_H;

	function handleTabClick(tab: TabId) {
		setActiveTab((prev) => (prev === tab ? null : tab));
	}

	function onDragStart(e: React.MouseEvent) {
		e.preventDefault();
		setIsDragging(true);
		dragStartY.current = e.clientY;
		dragStartH.current = openHeight;
	}

	function toggleFileNode(name: string) {
		setFileExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}

	useEffect(() => {
		if (!isDragging) return;
		function onMove(e: MouseEvent) {
			const delta = e.clientY - dragStartY.current;
			const newH = Math.max(
				MIN_H,
				Math.min(window.innerHeight * 0.65, dragStartH.current + delta),
			);
			setOpenHeight(newH);
		}
		function onUp() {
			setIsDragging(false);
		}
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
	}, [isDragging]);

	useEffect(() => {
		document.documentElement.style.cursor = isDragging ? "ns-resize" : "";
		return () => {
			document.documentElement.style.cursor = "";
		};
	}, [isDragging]);

	const tabs: {
		id: TabId;
		labelKey: "panel.environment" | "panel.logs" | "panel.files";
		icon: React.ReactNode;
	}[] = [
		{
			id: "env",
			labelKey: "panel.environment",
			icon: (
				<svg
					className="w-3.5 h-3.5 flex-shrink-0"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={1.5}
						d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
					/>
				</svg>
			),
		},
		{
			id: "logs",
			labelKey: "panel.logs",
			icon: (
				<svg
					className="w-3.5 h-3.5 flex-shrink-0"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={1.5}
						d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
					/>
				</svg>
			),
		},
		{
			id: "files",
			labelKey: "panel.files",
			icon: (
				<svg
					className="w-3.5 h-3.5 flex-shrink-0"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={1.5}
						d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
					/>
				</svg>
			),
		},
	];

	return (
		<div
			className={`flex-shrink-0 border-b border-edge flex flex-col overflow-hidden${
				!isDragging ? " transition-[height] duration-200 ease-out" : ""
			}`}
			style={{ height: panelHeight }}
		>
			{/* Tab bar — always visible */}
			<div className="h-9 flex-shrink-0 flex items-center px-2 gap-0.5">
				{tabs.map(({ id, labelKey, icon }) => {
					const isActive = activeTab === id;
					return (
						<button
							key={id}
							onClick={() => handleTabClick(id)}
							className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
								isActive
									? "bg-elevated text-accent"
									: "text-fg-muted hover:text-fg-2 hover:bg-raised-hover"
							}`}
						>
							{icon}
							<span>{t(labelKey)}</span>
							{isActive && (
								<span className="ml-0.5 w-1 h-1 rounded-full bg-accent inline-block" />
							)}
						</button>
					);
				})}

				<div className="flex-1" />

				{isOpen && (
					<button
						onClick={() => setActiveTab(null)}
						className="p-1 text-fg-muted hover:text-fg-2 transition-colors rounded-md hover:bg-raised-hover"
						title={t("panel.collapse")}
					>
						<svg
							className="w-3.5 h-3.5"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M5 15l7-7 7 7"
							/>
						</svg>
					</button>
				)}
			</div>

			{/* Content area */}
			{isOpen && (
				<>
					<div className="flex-1 overflow-auto" style={{ minHeight: 0 }}>
						{activeTab === "env" && (
							<div className="p-2">
								<table className="w-full text-xs border-separate border-spacing-0">
									<tbody>
										{MOCK_ENV.map(({ key, value, masked }) => (
											<tr key={key}>
												<td className="py-0.5 px-2 text-accent font-mono font-medium whitespace-nowrap align-top w-48">
													{key}
												</td>
												<td className="py-0.5 px-2 font-mono align-top break-all">
													{masked ? (
														<span className="text-fg-muted italic">{value}</span>
													) : (
														<span className="text-fg-3">{value}</span>
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}

						{activeTab === "logs" && (
							<div className="p-2 font-mono text-xs space-y-0.5">
								{MOCK_LOGS.map((log, i) => (
									<div
										key={i}
										className="flex items-start gap-3 py-0.5 px-1 hover:bg-elevated/50 rounded"
									>
										<span className="text-fg-muted flex-shrink-0 tabular-nums">
											{log.time}
										</span>
										<span className={`${LOG_LEVEL_CLASS[log.level]} flex-1`}>
											{log.text}
										</span>
									</div>
								))}
							</div>
						)}

						{activeTab === "files" && (
							<div className="py-1">
								<FileTree
									nodes={MOCK_FILES}
									depth={0}
									expanded={fileExpanded}
									onToggle={toggleFileNode}
								/>
							</div>
						)}
					</div>

					{/* Drag handle */}
					<div
						className={`h-1 flex-shrink-0 cursor-ns-resize transition-colors ${
							isDragging ? "bg-accent/40" : "hover:bg-accent/20 bg-transparent"
						}`}
						onMouseDown={onDragStart}
						onDoubleClick={() => setOpenHeight(DEFAULT_OPEN_H)}
					/>
				</>
			)}
		</div>
	);
}
