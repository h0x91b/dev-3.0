import { fireEvent, render, screen } from "@testing-library/react";
import { Context } from "cordis";
import { SlotHost, type ReplaceSlotItem } from "../SlotHost";
import { resetPluginsForTests, setExtensionLoadForTests } from "../runtime";
import type { SlotEntry } from "../slot-registry";

vi.mock("../../rpc", () => ({ api: { request: {} } }));

const root = new Context();
const Fallback = () => <div>built-in</div>;
const Chosen = () => <div>chosen</div>;
const Boom = () => {
	throw new Error("boom");
};

function entry(id: string, component: ReplaceSlotItem["component"]): SlotEntry<ReplaceSlotItem> {
	return { def: { id, component }, ctx: root };
}

function host(props: { requestedId: string; active?: SlotEntry<ReplaceSlotItem>; ready?: boolean; onManage?: () => void; fill?: boolean }) {
	return (
		<SlotHost
			slot="testSlot"
			requestedId={props.requestedId}
			active={props.active}
			fallback={<Fallback />}
			ready={props.ready}
			crashedMessage="crashed"
			failedMessage={(name) => `${name} failed`}
			manageAction={props.onManage && { label: "Manage", onClick: props.onManage }}
			fill={props.fill}
		/>
	);
}

beforeEach(() => resetPluginsForTests());

describe("SlotHost", () => {
	it("renders the fallback until the chosen item is registered", () => {
		const { rerender } = render(host({ requestedId: "builtin:x" }));
		expect(screen.getByText("built-in")).toBeTruthy();
		rerender(host({ requestedId: "builtin:x", active: entry("builtin:x", Chosen) }));
		expect(screen.getByText("chosen")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows the fallback under a notice when the item crashes, and retries on another pick", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const { rerender } = render(host({ requestedId: "ext:boom", active: entry("ext:boom", Boom) }));
		expect(screen.getByRole("alert").textContent).toBe("crashed");
		expect(screen.getByText("built-in")).toBeTruthy();
		rerender(host({ requestedId: "builtin:x", active: entry("builtin:x", Chosen) }));
		expect(screen.getByText("chosen")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
		errors.mockRestore();
	});

	it("names an extension that failed to load and offers the manage action", () => {
		setExtensionLoadForTests("ext", { state: "failed", error: "x" });
		const onManage = vi.fn();
		render(host({ requestedId: "ext:view", onManage }));
		expect(screen.getByRole("alert").textContent).toContain("ext failed");
		expect(screen.getByText("built-in")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Manage" }));
		expect(onManage).toHaveBeenCalled();
	});

	it("adds no wrapper outside fill mode", () => {
		const { container } = render(host({ requestedId: "builtin:x", active: entry("builtin:x", Chosen) }));
		expect(container.innerHTML).toBe("<div>chosen</div>");
	});

	it("in fill mode puts a notice and the content in one flex column, the content shrinkable", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		render(host({ requestedId: "ext:boom", active: entry("ext:boom", Boom), fill: true }));
		const notice = screen.getByRole("alert");
		const column = notice.parentElement!;
		expect(column.className.split(" ")).toEqual(expect.arrayContaining(["flex", "flex-col", "flex-1", "min-h-0"]));
		expect(notice.className).toContain("shrink-0");
		const contentBox = screen.getByText("built-in").parentElement!;
		expect(contentBox.parentElement).toBe(column);
		expect(contentBox.className.split(" ")).toEqual(expect.arrayContaining(["flex-1", "min-h-0"]));
		errors.mockRestore();
	});

	it("keeps the notice but holds the content back until ready", () => {
		setExtensionLoadForTests("ext", { state: "failed", error: "x" });
		render(host({ requestedId: "ext:view", ready: false }));
		expect(screen.getByRole("alert")).toBeTruthy();
		expect(screen.queryByText("built-in")).toBeNull();
	});
});
