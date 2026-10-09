import { describe, expect, it, vi } from "vitest";
import type { CellLine } from "../terminal-file-links";
import {
	createTapTracker,
	findTouchLink,
	installTouchLinkTap,
	osc8TouchLink,
	plainUrlAt,
	type TouchLink,
	type TouchLinkSource,
} from "../terminal-touch-links";

function touches(...points: Array<[number, number]>): TouchList {
	return points.map(([clientX, clientY]) => ({ clientX, clientY })) as unknown as TouchList;
}

function cellLine(spec: string, cols = 80): CellLine {
	const codes = [...spec].map((ch) => ch.codePointAt(0)!);
	return { isWrapped: false, length: cols, getCell: (x) => ({ getCode: () => codes[x] ?? 0 }) };
}

function touchEvent(type: string, now: Array<[number, number]>, changed: Array<[number, number]>): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "touches", { value: touches(...now) });
	Object.defineProperty(event, "changedTouches", { value: touches(...changed) });
	return event;
}

describe("createTapTracker", () => {
	it("reports a still single-finger touch as a tap at its end point", () => {
		const tap = createTapTracker();
		tap.start(touches([100, 100]));
		tap.move(touches([103, 102]));
		expect(tap.end(touches(), touches([104, 103]))).toEqual({ clientX: 104, clientY: 103 });
	});

	it("never calls a scroll a tap, even when the finger returns to the start", () => {
		const tap = createTapTracker();
		tap.start(touches([100, 100]));
		tap.move(touches([100, 140]));
		tap.move(touches([100, 101]));
		expect(tap.end(touches(), touches([100, 100]))).toBeNull();
	});

	it("rejects a swipe whose moves it never saw (claimed by the pane carousel)", () => {
		const tap = createTapTracker();
		tap.start(touches([100, 100]));
		expect(tap.end(touches(), touches([180, 100]))).toBeNull();
	});

	it("rejects pinch and any touch that saw a second finger", () => {
		const tap = createTapTracker();
		tap.start(touches([100, 100], [200, 200]));
		expect(tap.end(touches([200, 200]), touches([100, 100]))).toBeNull();
		tap.start(touches([100, 100]));
		tap.move(touches([100, 100], [150, 150]));
		expect(tap.end(touches(), touches([100, 100]))).toBeNull();
	});

	it("forgets a cancelled touch", () => {
		const tap = createTapTracker();
		tap.start(touches([100, 100]));
		tap.cancel();
		expect(tap.end(touches(), touches([100, 100]))).toBeNull();
	});
});

describe("osc8TouchLink", () => {
	const open = () => {};

	it("classifies web, dev3 and file destinations", () => {
		expect(osc8TouchLink("https://example.com/a", open)).toMatchObject({ kind: "web", target: "https://example.com/a" });
		expect(osc8TouchLink("dev3://task/a21540d6-4890-426f-81c1-41cfc460715e", open)).toMatchObject({ kind: "app" });
		expect(osc8TouchLink("file:///Users/me/src/app.ts", open)).toMatchObject({ kind: "file", target: "/Users/me/src/app.ts" });
	});

	it("refuses every destination the click path refuses", () => {
		expect(osc8TouchLink("javascript:alert(1)", open)).toBeUndefined();
		expect(osc8TouchLink("https://ok.dev\n@evil.example", open)).toBeUndefined();
		expect(osc8TouchLink("file://server/share/x", open)).toBeUndefined();
		expect(osc8TouchLink("vscode://file/x", open)).toBeUndefined();
	});
});

describe("plainUrlAt", () => {
	const line = cellLine("see https://example.org/x, then more");

	it("returns the URL under the cell without trailing punctuation", () => {
		expect(plainUrlAt(line, 4)).toBe("https://example.org/x");
		expect(plainUrlAt(line, 24)).toBe("https://example.org/x");
	});

	it("answers nothing beside the URL, on the comma, or on an empty row", () => {
		expect(plainUrlAt(line, 3)).toBeUndefined();
		expect(plainUrlAt(line, 25)).toBeUndefined();
		expect(plainUrlAt(undefined, 0)).toBeUndefined();
	});
});

describe("findTouchLink", () => {
	const link = (target: string): TouchLink => ({ kind: "web", target, open: () => {} });

	it("takes the first source with a link, in order", () => {
		const sources: TouchLinkSource[] = [() => undefined, () => link("a"), () => link("b")];
		expect(findTouchLink(sources, 0, 0)?.target).toBe("a");
	});

	it("skips a source that throws", () => {
		const sources: TouchLinkSource[] = [
			() => {
				throw new Error("row unreadable");
			},
			() => link("b"),
		];
		expect(findTouchLink(sources, 0, 0)?.target).toBe("b");
	});
});

describe("installTouchLinkTap", () => {
	function setup(hasLink: boolean) {
		const container = document.createElement("div");
		const canvas = document.createElement("canvas");
		container.appendChild(canvas);
		document.body.appendChild(container);
		const onLink = vi.fn();
		const canvasTouchEnd = vi.fn();
		canvas.addEventListener("touchend", canvasTouchEnd);
		const target: TouchLink = { kind: "web", target: "https://example.com/", open: vi.fn() };
		const handle = installTouchLinkTap({
			container,
			sources: [() => (hasLink ? target : undefined)],
			cellAt: () => ({ y: 0, x: 0 }),
			onLink,
		});
		const tapAt = (end: [number, number]) => {
			canvas.dispatchEvent(touchEvent("touchstart", [[10, 10]], [[10, 10]]));
			const ended = touchEvent("touchend", [], [end]);
			canvas.dispatchEvent(ended);
			return ended;
		};
		return { handle, onLink, canvasTouchEnd, target, tapAt };
	}

	it("claims a tap on a link: sheet opens, ghostty and the mouse translation never see it", () => {
		const { onLink, canvasTouchEnd, target, tapAt, handle } = setup(true);
		const ended = tapAt([11, 11]);
		expect(onLink).toHaveBeenCalledWith(target);
		expect(target.open).not.toHaveBeenCalled();
		expect(ended.defaultPrevented).toBe(true);
		expect(canvasTouchEnd).not.toHaveBeenCalled();
		handle.dispose();
	});

	it("leaves a tap off any link untouched", () => {
		const { onLink, canvasTouchEnd, tapAt, handle } = setup(false);
		const ended = tapAt([11, 11]);
		expect(onLink).not.toHaveBeenCalled();
		expect(ended.defaultPrevented).toBe(false);
		expect(canvasTouchEnd).toHaveBeenCalledTimes(1);
		handle.dispose();
	});

	it("never opens the sheet at the end of a drag over a link", () => {
		const { onLink, canvasTouchEnd, tapAt, handle } = setup(true);
		tapAt([10, 60]);
		expect(onLink).not.toHaveBeenCalled();
		expect(canvasTouchEnd).toHaveBeenCalledTimes(1);
		handle.dispose();
	});

	it("stops listening once disposed", () => {
		const { onLink, tapAt, handle } = setup(true);
		handle.dispose();
		tapAt([11, 11]);
		expect(onLink).not.toHaveBeenCalled();
	});
});
