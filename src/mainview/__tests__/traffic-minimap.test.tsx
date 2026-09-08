import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n";
import TrafficMinimap from "../components/agent-traffic/TrafficMinimap";

beforeEach(() => {
	// happy-dom omits DOMPoint.matrixTransform; keep the browser geometry API in the fixture.
	vi.stubGlobal("DOMPoint", class {
		constructor(public x: number, public y: number) {}
		matrixTransform(matrix: DOMMatrix) {
			return { x: this.x * matrix.a + this.y * matrix.c + matrix.e, y: this.x * matrix.b + this.y * matrix.d + matrix.f };
		}
	});
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
	const onNavigate = vi.fn();
	const onFit = vi.fn();
	const parentPointer = vi.fn();
	const result = render(<I18nProvider><div onPointerDown={parentPointer}>
		<TrafficMinimap scene={{ width: 2000, height: 1000, placed: [], edges: [], groups: [], quietCount: 0, parkedCount: 0 }}
			selected={null} view={{ x: -500, y: -250, scale: 1 }} width={1000} height={500}
			onNavigate={onNavigate} onFit={onFit} />
	</div></I18nProvider>);
	const map = screen.getByRole("button", { name: "Canvas minimap" });
	const capture = vi.fn();
	Object.assign(map, { setPointerCapture: capture, releasePointerCapture: vi.fn() });
	// 10:1 scene reduction, with screen offset/letterboxing of (100, 50).
	Object.assign(map.querySelector("svg")!, { getScreenCTM: () => new DOMMatrix([0.1, 0, 0, 0.1, 100, 50]) });
	return { ...result, map, onNavigate, onFit, parentPointer, capture };
}

it("clicks outside the viewport center that scene point without changing zoom", () => {
	const { map, onNavigate, parentPointer, capture } = setup();
	fireEvent.pointerDown(map, { pointerId: 1, button: 0, clientX: 280, clientY: 130 });
	expect(onNavigate).toHaveBeenLastCalledWith({ x: expect.closeTo(-1300), y: expect.closeTo(-550), scale: 1 });
	expect(parentPointer).not.toHaveBeenCalled();
	expect(capture).toHaveBeenCalledWith(1);
});

it("grabs the viewport without jumping, drags beyond the minimap and stops after release", () => {
	const { map, onNavigate } = setup();
	fireEvent.pointerDown(map, { pointerId: 1, button: 0, clientX: 220, clientY: 110 });
	expect(onNavigate).toHaveBeenLastCalledWith({ x: -500, y: -250, scale: 1 });
	fireEvent.pointerMove(map, { pointerId: 1, clientX: 330, clientY: 160 });
	expect(onNavigate).toHaveBeenLastCalledWith({ x: expect.closeTo(-1600), y: expect.closeTo(-750), scale: 1 });
	fireEvent.pointerUp(map, { pointerId: 1 });
	const calls = onNavigate.mock.calls.length;
	fireEvent.pointerMove(map, { pointerId: 1, clientX: 350, clientY: 160 });
	expect(onNavigate).toHaveBeenCalledTimes(calls);
});

it("ignores secondary pointers and cancels an interrupted touch drag", () => {
	const { map, onNavigate } = setup();
	fireEvent.pointerDown(map, { pointerId: 1, button: 2, clientX: 280, clientY: 130 });
	expect(onNavigate).not.toHaveBeenCalled();
	fireEvent.pointerDown(map, { pointerId: 1, button: 0, pointerType: "touch", clientX: 220, clientY: 110 });
	fireEvent.pointerMove(map, { pointerId: 2, clientX: 270, clientY: 110 });
	expect(onNavigate).toHaveBeenCalledTimes(1);
	fireEvent.pointerCancel(map, { pointerId: 1 });
	fireEvent.pointerMove(map, { pointerId: 1, clientX: 270, clientY: 110 });
	expect(onNavigate).toHaveBeenCalledTimes(1);
});

it("supports keyboard navigation and fits only on keyboard activation", async () => {
	const { map, onNavigate, onFit } = setup();
	map.focus();
	await userEvent.keyboard("{ArrowRight}");
	expect(onNavigate).toHaveBeenLastCalledWith({ x: -580, y: -250, scale: 1 });
	await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
	expect(onNavigate).toHaveBeenLastCalledWith({ x: -500, y: -10, scale: 1 });
	fireEvent.click(map, { detail: 1 });
	expect(onFit).not.toHaveBeenCalled();
	await userEvent.keyboard("{Enter}");
	expect(onFit).toHaveBeenCalledTimes(1);
});
