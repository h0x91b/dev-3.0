/**
 * The import preview. What matters here: the first screen is one ticked
 * checkbox, the list only appears when asked for, and an offer nobody asked for
 * disappears without a word when there is nothing to offer.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import ImportConversationsModal from "../ImportConversationsModal";
import type { Project } from "../../../shared/types";
import type { ImportableConversationView } from "../../../shared/conversation-import-model";

const mocks = vi.hoisted(() => ({
	scan: vi.fn(),
	importConversations: vi.fn(),
	markOffered: vi.fn(),
	success: vi.fn(),
	error: vi.fn(),
}));

vi.mock("../../toast", () => ({ toast: { success: mocks.success, error: mocks.error, info: vi.fn() } }));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("../../rpc", () => ({
	api: {
		request: {
			scanImportableConversations: mocks.scan,
			importConversations: mocks.importConversations,
			markConversationImportOffered: mocks.markOffered,
		},
	},
}));

const project = { id: "p1", name: "dev-3.0", path: "/code/dev-3.0" } as Project;

function conversation(over: Partial<ImportableConversationView> = {}): ImportableConversationView {
	return {
		sessionId: "sess-1",
		title: "Fix the parser",
		workingDir: "/code/dev-3.0",
		lastActivityMs: Date.now() - 2 * 24 * 60 * 60 * 1000,
		turns: 12,
		targetStatus: "user-questions",
		...over,
	};
}

function renderModal(over: Partial<React.ComponentProps<typeof ImportConversationsModal>> = {}) {
	const props = { project, onClose: vi.fn(), ...over };
	render(
		<I18nProvider>
			<ImportConversationsModal {...props} />
		</I18nProvider>,
	);
	return props;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.scan.mockResolvedValue({ conversations: [conversation()] });
	mocks.importConversations.mockResolvedValue({ imported: 1, tasks: [], problems: [] });
	mocks.markOffered.mockResolvedValue({ project });
});

describe("ImportConversationsModal", () => {
	it("opens on one ticked checkbox, with no list in sight", async () => {
		renderModal();
		expect(await screen.findByTestId("import-conversations-all")).toBeChecked();
		expect(screen.queryByTestId("import-conversations-list")).not.toBeInTheDocument();
	});

	it("reveals the per-conversation list only when asked", async () => {
		const user = userEvent.setup();
		mocks.scan.mockResolvedValue({ conversations: [conversation(), conversation({ sessionId: "sess-2", title: "Second" })] });
		renderModal();

		await user.click(await screen.findByTestId("import-conversations-partial"));
		expect(screen.getByTestId("import-conversations-list")).toBeInTheDocument();
		expect(screen.getByTestId("import-conversation-sess-1")).toBeChecked();
		expect(screen.getByTestId("import-conversation-sess-2")).toBeChecked();
	});

	it("imports everything the scan found when the default is left alone", async () => {
		const user = userEvent.setup();
		mocks.scan.mockResolvedValue({ conversations: [conversation(), conversation({ sessionId: "sess-2" })] });
		const props = renderModal();

		await user.click(await screen.findByTestId("import-conversations-submit"));
		await waitFor(() => expect(mocks.importConversations).toHaveBeenCalledWith({
			projectId: "p1",
			sessionIds: ["sess-1", "sess-2"],
		}));
		expect(props.onClose).toHaveBeenCalled();
	});

	it("imports only the rows still ticked after unselecting them all", async () => {
		const user = userEvent.setup();
		mocks.scan.mockResolvedValue({ conversations: [conversation(), conversation({ sessionId: "sess-2" })] });
		renderModal();

		await user.click(await screen.findByTestId("import-conversations-partial"));
		await user.click(screen.getByText("Unselect all"));
		await user.click(screen.getByTestId("import-conversation-sess-2"));
		await user.click(screen.getByTestId("import-conversations-submit"));

		await waitFor(() => expect(mocks.importConversations).toHaveBeenCalledWith({
			projectId: "p1",
			sessionIds: ["sess-2"],
		}));
	});

	it("has nothing to import with an empty selection", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.click(await screen.findByTestId("import-conversations-partial"));
		await user.click(screen.getByText("Unselect all"));
		expect(screen.getByTestId("import-conversations-submit")).toBeDisabled();
	});

	it("states the empty answer when the user asked for the list themselves", async () => {
		mocks.scan.mockResolvedValue({ conversations: [] });
		const props = renderModal();
		expect(await screen.findByText(/Nothing to import for dev-3\.0/)).toBeInTheDocument();
		expect(props.onClose).not.toHaveBeenCalled();
	});

	it("closes itself without a word when the offer was dev3's own idea", async () => {
		mocks.scan.mockResolvedValue({ conversations: [] });
		const props = renderModal({ autoOffer: true });
		await waitFor(() => expect(props.onClose).toHaveBeenCalled());
	});

	it("spends the project's single offer as soon as it is made, accepted or not", async () => {
		renderModal({ autoOffer: true });
		await waitFor(() => expect(mocks.markOffered).toHaveBeenCalledWith({ projectId: "p1" }));
	});

	it("spends it on an empty answer too, so a quiet project is not asked again", async () => {
		mocks.scan.mockResolvedValue({ conversations: [] });
		renderModal({ autoOffer: true });
		await waitFor(() => expect(mocks.markOffered).toHaveBeenCalledWith({ projectId: "p1" }));
	});

	it("does not burn the offer when the scan itself failed", async () => {
		mocks.scan.mockRejectedValue(new Error("disk on fire"));
		const props = renderModal({ autoOffer: true });
		await waitFor(() => expect(props.onClose).toHaveBeenCalled());
		expect(mocks.markOffered).not.toHaveBeenCalled();
	});

	it("records nothing when the user opened the dialog themselves", async () => {
		renderModal();
		expect(await screen.findByTestId("import-conversations-all")).toBeChecked();
		expect(mocks.markOffered).not.toHaveBeenCalled();
	});

	it("shows nothing at all while an unasked-for offer is still scanning", () => {
		mocks.scan.mockReturnValue(new Promise(() => {}));
		renderModal({ autoOffer: true });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("shows the scan in progress when the user asked for it", async () => {
		mocks.scan.mockReturnValue(new Promise(() => {}));
		renderModal();
		expect(await screen.findByText("Looking for conversations…")).toBeInTheDocument();
	});

	it("surfaces a per-conversation problem without losing what did land", async () => {
		const user = userEvent.setup();
		mocks.importConversations.mockResolvedValue({
			imported: 1,
			tasks: [],
			problems: [{ title: "Fix the parser", error: "imported without a worktree" }],
		});
		renderModal();

		await user.click(await screen.findByTestId("import-conversations-submit"));
		await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("without a worktree")));
		expect(mocks.success).toHaveBeenCalled();
	});

	it("keeps the dialog open when the import itself failed", async () => {
		const user = userEvent.setup();
		mocks.importConversations.mockRejectedValue(new Error("board is locked"));
		const props = renderModal();

		await user.click(await screen.findByTestId("import-conversations-submit"));
		await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("board is locked")));
		expect(props.onClose).not.toHaveBeenCalled();
		expect(screen.getByTestId("import-conversations-submit")).toBeEnabled();
	});
});
