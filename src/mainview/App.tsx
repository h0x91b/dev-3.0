import TerminalView from "./TerminalView";

function App() {
	return (
		<div className="h-screen w-screen flex flex-col bg-[#1a1b26] overflow-hidden">
			<div className="flex items-center px-4 py-2 bg-[#16161e] border-b border-[#292e42]">
				<span className="text-[#7aa2f7] font-semibold text-sm tracking-wide">
					ghostty-web terminal
				</span>
				<span className="ml-2 text-[#565f89] text-xs">hello world</span>
			</div>
			<div className="flex-1 min-h-0">
				<TerminalView />
			</div>
		</div>
	);
}

export default App;
