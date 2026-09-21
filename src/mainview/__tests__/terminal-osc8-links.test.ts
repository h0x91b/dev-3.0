import { describe, it, expect, vi } from "vitest";
import {
	createOsc8Tracker,
	createOsc8LinkProvider,
	safeHttpUri,
	safeFileUri,
	safeOsc8Uri,
	safeDeepLinkUri,
	fileUriToLocalPath,
	type HyperlinkLine,
} from "../terminal-osc8-links";
import type { ILink } from "ghostty-web";

const ESC = "\x1b";
const ST = `${ESC}\\`;
const BEL = "\x07";

function osc8(uri: string, params = ""): string {
	return `${ESC}]8;${params};${uri}${ST}`;
}

describe("createOsc8Tracker", () => {
	it("maps the visible label to the URI of an ST-terminated link", () => {
		const t = createOsc8Tracker();
		t.feed(`See ${osc8("https://example.com/pr/3226")}#3226${osc8("")} for details`);
		expect(t.uriFor("#3226")).toBe("https://example.com/pr/3226");
	});

	it("handles BEL-terminated sequences and id params", () => {
		const t = createOsc8Tracker();
		t.feed(`${ESC}]8;id=xyz;https://a.dev${BEL}click me${ESC}]8;;${BEL}`);
		expect(t.uriFor("click me")).toBe("https://a.dev");
	});

	it("keeps the URI intact when it contains extra semicolons", () => {
		const t = createOsc8Tracker();
		t.feed(`${osc8("https://a.dev/x;y;z")}L${osc8("")}`);
		expect(t.uriFor("L")).toBe("https://a.dev/x;y;z");
	});

	it("survives chunk splits in the middle of the escape and of the label", () => {
		const t = createOsc8Tracker();
		const full = `${osc8("https://split.example")}#42${osc8("")}`;
		for (const c of full) t.feed(c);
		expect(t.uriFor("#42")).toBe("https://split.example");
	});

	it("ignores SGR and other escapes inside the label", () => {
		const t = createOsc8Tracker();
		t.feed(`${osc8("https://sgr.example")}${ESC}[1;34m#77${ESC}[0m${osc8("")}`);
		expect(t.uriFor("#77")).toBe("https://sgr.example");
	});

	it("matches labels whitespace-insensitively (wide glyphs pad cells)", () => {
		const t = createOsc8Tracker();
		t.feed(`${osc8("https://wide.example")}ab cd${osc8("")}`);
		expect(t.uriFor("a b cd")).toBe("https://wide.example");
	});

	it("a new start terminates the previous link implicitly", () => {
		const t = createOsc8Tracker();
		t.feed(`${osc8("https://one.example")}one${osc8("https://two.example")}two${osc8("")}`);
		expect(t.uriFor("one")).toBe("https://one.example");
		expect(t.uriFor("two")).toBe("https://two.example");
	});

	it("a label seen with two different URIs resolves to nothing (anti-spoof)", () => {
		// Terminal content is untrusted: a later hostile line re-using an
		// earlier label must kill the mapping, never retarget the old link.
		const t = createOsc8Tracker();
		t.feed(`${osc8("https://trusted.example/pr/1")}#1${osc8("")}`);
		t.feed(`log: ${osc8("https://evil.example/phish")}#1${osc8("")}`);
		expect(t.uriFor("#1")).toBeUndefined();
	});

	it("a poisoned label stays dead even when the original URI is re-fed", () => {
		const t = createOsc8Tracker();
		t.feed(`${osc8("https://a.dev")}#1${osc8("")}${osc8("https://b.dev")}#1${osc8("")}`);
		t.feed(`${osc8("https://a.dev")}#1${osc8("")}`);
		expect(t.uriFor("#1")).toBeUndefined();
	});

	it("re-feeding the same label with the same URI keeps it (tmux redraws)", () => {
		const t = createOsc8Tracker();
		const link = `${osc8("https://same.example")}#1${osc8("")}`;
		t.feed(link);
		t.feed(link);
		expect(t.uriFor("#1")).toBe("https://same.example");
	});

	it("RIS (ESC c) forgets every mapping", () => {
		const t = createOsc8Tracker();
		t.feed(`${osc8("https://a.dev")}a${osc8("")}`);
		t.feed(`${ESC}c`);
		expect(t.uriFor("a")).toBeUndefined();
	});

	it("erase-scrollback (CSI 3J) forgets mappings; erase-screen (CSI 2J) keeps them", () => {
		const t = createOsc8Tracker();
		t.feed(`${osc8("https://a.dev")}a${osc8("")}${ESC}[2J`);
		expect(t.uriFor("a")).toBe("https://a.dev");
		t.feed(`${ESC}[3J`);
		expect(t.uriFor("a")).toBeUndefined();
	});

	it("evicts the oldest label past the cap", () => {
		const t = createOsc8Tracker(2);
		t.feed(`${osc8("https://a.dev")}a${osc8("")}${osc8("https://b.dev")}b${osc8("")}${osc8("https://c.dev")}c${osc8("")}`);
		expect(t.uriFor("a")).toBeUndefined();
		expect(t.uriFor("b")).toBe("https://b.dev");
		expect(t.uriFor("c")).toBe("https://c.dev");
	});

	it("plain output records nothing", () => {
		const t = createOsc8Tracker();
		t.feed("just text with https://example.com and \x1b[31mcolors\x1b[0m\n");
		expect(t.uriFor("https://example.com")).toBeUndefined();
	});
});

function lineOf(text: string, ids: number[]): HyperlinkLine {
	return {
		length: text.length,
		getCell(x: number) {
			if (x < 0 || x >= text.length) return undefined;
			return {
				getCode: () => text.charCodeAt(x),
				getHyperlinkId: () => ids[x] ?? 0,
			};
		},
	};
}

function collectLinks(
	rows: Record<number, HyperlinkLine>,
	uriFor: (label: string) => string | undefined,
	y: number,
	onActivate = vi.fn(),
	isRowWrapped?: (row: number) => boolean | undefined,
): { links: ILink[]; onActivate: ReturnType<typeof vi.fn> } {
	const provider = createOsc8LinkProvider({ getLine: (row) => rows[row], isRowWrapped, uriFor, onActivate });
	let links: ILink[] = [];
	provider.provideLinks(y, (found) => {
		links = found ?? [];
	});
	return { links, onActivate };
}

describe("createOsc8LinkProvider", () => {
	it("produces a link for an id range whose label the tracker knows", () => {
		const text = "See #3226 now";
		const ids = text.split("").map((_, i) => (i >= 4 && i <= 8 ? 1 : 0));
		const { links } = collectLinks({ 5: lineOf(text, ids) }, (l) => (l === "#3226" ? "https://x.dev/pr/3226" : undefined), 5);
		expect(links).toHaveLength(1);
		expect(links[0].text).toBe("https://x.dev/pr/3226");
		expect(links[0].range).toEqual({ start: { x: 4, y: 5 }, end: { x: 8, y: 5 } });
	});

	it("activates only on Ctrl/Cmd+click", () => {
		const text = "#7";
		const { links, onActivate } = collectLinks({ 0: lineOf(text, [1, 1]) }, () => "https://x.dev", 0);
		links[0].activate(new MouseEvent("click"));
		expect(onActivate).not.toHaveBeenCalled();
		links[0].activate(new MouseEvent("click", { ctrlKey: true }));
		expect(onActivate).toHaveBeenCalledWith("https://x.dev", expect.anything());
	});

	it("activates the link under the cursor, not the ILink it was handed", () => {
		// ghostty-web keys its link cache by hyperlink id and gives every OSC 8
		// link on screen the same id, so a click in row 1 arrives carrying the
		// ILink built for row 0. The cell under the cursor has to win, or the
		// hover tooltip promises one target and the click opens another.
		const rows: Record<number, HyperlinkLine> = {
			0: lineOf("ONE", [1, 1, 1]),
			1: lineOf("TWO", [1, 1, 1]),
		};
		const uriFor = (label: string) =>
			label === "ONE" ? "file:///tmp/one.txt" : label === "TWO" ? "file:///tmp/two.txt" : undefined;
		const onActivate = vi.fn();
		const provider = createOsc8LinkProvider({
			getLine: (row) => rows[row],
			isRowWrapped: () => false,
			uriFor,
			cellFromEvent: () => ({ y: 1, x: 0 }),
			onActivate,
		});
		let links: ILink[] = [];
		provider.provideLinks(0, (found) => {
			links = found ?? [];
		});
		expect(links[0].text).toBe("file:///tmp/one.txt");
		links[0].activate(new MouseEvent("click", { metaKey: true }));
		expect(onActivate).toHaveBeenCalledWith("file:///tmp/two.txt", expect.anything());
	});

	it("keeps its own URI when the click lands on no link at all", () => {
		const { links, onActivate } = collectLinks({ 0: lineOf("#7", [1, 1]) }, () => "https://x.dev", 0);
		links[0].activate(new MouseEvent("click", { metaKey: true }));
		expect(onActivate).toHaveBeenCalledWith("https://x.dev", expect.anything());
	});

	it("falls back to the label itself when it is a safe URI", () => {
		const text = "https://self.dev";
		const { links } = collectLinks({ 0: lineOf(text, text.split("").map(() => 2)) }, () => undefined, 0);
		expect(links).toHaveLength(1);
		expect(links[0].text).toBe("https://self.dev");
	});

	it("drops unknown labels and unsafe URIs", () => {
		const text = "#9 evil";
		const ids = [1, 1, 0, 3, 3, 3, 3];
		const { links } = collectLinks(
			{ 0: lineOf(text, ids) },
			(l) => (l === "evil" ? "javascript:alert(1)" : undefined),
			0,
		);
		expect(links).toHaveLength(0);
	});

	it("produces a link for a file:// URI (agents wrap printed paths in them)", () => {
		const text = "read a.png ok";
		const ids = [0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 0, 0, 0];
		const { links } = collectLinks(
			{ 0: lineOf(text, ids) },
			(l) => (l === "a.png" ? "file:///tmp/mock%20dir/a.png" : undefined),
			0,
		);
		expect(links).toHaveLength(1);
		expect(links[0].text).toBe("file:///tmp/mock%20dir/a.png");
	});

	it("stitches a wrapped link across rows to resolve the full label", () => {
		// Row 3 ends with "#12" (id 4), row 4 starts with "34" (id 4).
		const top = "text #12";
		const topIds = [0, 0, 0, 0, 0, 4, 4, 4];
		const bottom = "34 rest";
		const bottomIds = [4, 4, 0, 0, 0, 0, 0];
		const rows = { 3: lineOf(top, topIds), 4: lineOf(bottom, bottomIds) };
		const uriFor = (l: string) => (l === "#1234" ? "https://x.dev/1234" : undefined);
		const upper = collectLinks(rows, uriFor, 3);
		const lower = collectLinks(rows, uriFor, 4);
		expect(upper.links).toHaveLength(1);
		expect(upper.links[0].range).toEqual({ start: { x: 5, y: 3 }, end: { x: 7, y: 3 } });
		expect(lower.links).toHaveLength(1);
		expect(lower.links[0].range).toEqual({ start: { x: 0, y: 4 }, end: { x: 1, y: 4 } });
		expect(lower.links[0].text).toBe("https://x.dev/1234");
	});

	it("separates two adjacent links with different ids", () => {
		const text = "ab";
		const { links } = collectLinks(
			{ 0: lineOf(text, [1, 2]) },
			(l) => (l === "a" ? "https://a.dev" : l === "b" ? "https://b.dev" : undefined),
			0,
		);
		expect(links.map((l) => l.text)).toEqual(["https://a.dev", "https://b.dev"]);
	});

	it("does not stitch across a hard line break (same id from ghostty dedup)", () => {
		// The same link printed twice, ending row 0 and starting row 1: ghostty
		// de-duplicates identical hyperlinks to one id, but the rows are not
		// soft-wrapped, so each row must resolve on its own label.
		const url = "https://x.dev/a";
		const rows = {
			0: lineOf(url, url.split("").map(() => 5)),
			1: lineOf(url, url.split("").map(() => 5)),
		};
		const uriFor = (l: string) => (l === url ? url : undefined);
		const { links } = collectLinks(rows, uriFor, 0, vi.fn(), () => false);
		expect(links).toHaveLength(1);
		expect(links[0].text).toBe(url);
	});

	it("still stitches when wrap info is unknown (scrollback rows)", () => {
		const top = lineOf("#12", [4, 4, 4]);
		const bottom = lineOf("34", [4, 4]);
		const uriFor = (l: string) => (l === "#1234" ? "https://x.dev/1234" : undefined);
		const { links } = collectLinks({ 3: top, 4: bottom }, uriFor, 3, vi.fn(), () => undefined);
		expect(links).toHaveLength(1);
		expect(links[0].text).toBe("https://x.dev/1234");
	});

	it("falls back to the bare segment when a falsely-stitched label misses", () => {
		// Wrap info unavailable AND the joined label matches nothing: the
		// row's own segment must still resolve rather than going dead.
		const url = "https://x.dev/a";
		const rows = {
			0: lineOf(url, url.split("").map(() => 5)),
			1: lineOf(url, url.split("").map(() => 5)),
		};
		const uriFor = (l: string) => (l === url ? url : undefined);
		const { links } = collectLinks(rows, uriFor, 0);
		expect(links).toHaveLength(1);
		expect(links[0].text).toBe(url);
	});

	it("a poisoned URL-shaped label resolves to its own visible text", () => {
		// uriFor returns undefined (label collision poisoned the map); the
		// text IS the destination, so what you see is where you go.
		const text = "https://ok.dev/path";
		const { links } = collectLinks({ 0: lineOf(text, text.split("").map(() => 1)) }, () => undefined, 0);
		expect(links).toHaveLength(1);
		expect(links[0].text).toBe("https://ok.dev/path");
	});

	it("linkAt returns the resolved link for a covered cell only", () => {
		const text = "no #7 yes";
		const ids = [0, 0, 0, 1, 1, 0, 0, 0, 0];
		const provider = createOsc8LinkProvider({
			getLine: (row) => (row === 2 ? lineOf(text, ids) : undefined),
			uriFor: (l) => (l === "#7" ? "https://x.dev/7" : undefined),
			onActivate: vi.fn(),
		});
		expect(provider.linkAt(2, 4)).toEqual({ uri: "https://x.dev/7", x0: 3, x1: 4 });
		expect(provider.linkAt(2, 6)).toBeUndefined();
		expect(provider.linkAt(1, 4)).toBeUndefined();
	});
});

describe("safeHttpUri", () => {
	it("accepts plain http(s) URLs", () => {
		expect(safeHttpUri("https://a.dev/x?y=1")).toBe("https://a.dev/x?y=1");
		expect(safeHttpUri("http://a.dev")).toBe("http://a.dev");
	});

	it("rejects non-http(s) schemes, mailto included (dead click on desktop)", () => {
		expect(safeHttpUri("file:///etc/passwd")).toBeUndefined();
		expect(safeHttpUri("javascript:alert(1)")).toBeUndefined();
		expect(safeHttpUri("mailto:a@b.dev")).toBeUndefined();
	});

	it("rejects URLs smuggling control characters past a prefix check", () => {
		// Browsers strip the raw newline while parsing, landing on evil.example.
		expect(safeHttpUri("https://ok.dev\n@evil.example")).toBeUndefined();
		expect(safeHttpUri("https://ok.dev/\x00x")).toBeUndefined();
		expect(safeHttpUri("https://ok.dev/a b")).toBeUndefined();
	});

	it("rejects non-URLs", () => {
		expect(safeHttpUri("#3226")).toBeUndefined();
		expect(safeHttpUri("https://")).toBeUndefined();
	});
});

describe("safeFileUri", () => {
	it("accepts local file URIs, empty or localhost host", () => {
		expect(safeFileUri("file:///tmp/a.png")).toBe("file:///tmp/a.png");
		expect(safeFileUri("file://localhost/tmp/a.png")).toBe("file://localhost/tmp/a.png");
	});

	it("rejects remote hosts, other schemes, and control characters", () => {
		expect(safeFileUri("file://evil.example/share/x")).toBeUndefined();
		expect(safeFileUri("https://a.dev")).toBeUndefined();
		expect(safeFileUri("file:///tmp/a b.png")).toBeUndefined();
		expect(safeFileUri("file:///tmp/a\nb.png")).toBeUndefined();
	});
});

describe("fileUriToLocalPath", () => {
	it("converts a pathToFileURL-style URI back to a path", () => {
		expect(fileUriToLocalPath("file:///tmp/mock-cc-global.png")).toEqual({ path: "/tmp/mock-cc-global.png" });
	});

	it("percent-decodes the path", () => {
		expect(fileUriToLocalPath("file:///tmp/mock%20dir/a.png")).toEqual({ path: "/tmp/mock dir/a.png" });
	});

	it("strips the leading slash of a Windows drive path", () => {
		expect(fileUriToLocalPath("file:///C:/dir/file.ts")).toEqual({ path: "C:/dir/file.ts" });
	});

	it("carries a trailing :line[:col] suffix out separately", () => {
		expect(fileUriToLocalPath("file:///a/b.ts:12")).toEqual({ path: "/a/b.ts", line: 12 });
		expect(fileUriToLocalPath("file:///a/b.ts:12:5")).toEqual({ path: "/a/b.ts", line: 12 });
	});

	it("rejects a path whose decoding re-introduces a control character", () => {
		// safeFileUri sees the encoded form and passes it; the NUL and the
		// newline only exist after decodeURIComponent. A space is legitimate.
		expect(fileUriToLocalPath("file:///tmp/a%00b")).toBeUndefined();
		expect(fileUriToLocalPath("file:///tmp/a%0Ab")).toBeUndefined();
		expect(fileUriToLocalPath("file:///tmp/a%20b")).toEqual({ path: "/tmp/a b" });
	});

	it("leaves an absurd line suffix as part of the path instead of parsing it", () => {
		expect(fileUriToLocalPath("file:///a/b.ts:99999999999999999999")).toEqual({
			path: "/a/b.ts:99999999999999999999",
		});
		expect(fileUriToLocalPath("file:///a/b.ts:999999999")).toEqual({ path: "/a/b.ts", line: 999_999_999 });
	});

	it("rejects what safeFileUri rejects, and undecodable paths", () => {
		expect(fileUriToLocalPath("https://a.dev/x")).toBeUndefined();
		expect(fileUriToLocalPath("file://evil.example/x")).toBeUndefined();
		expect(fileUriToLocalPath("file:///tmp/%zz")).toBeUndefined();
	});
});

describe("safeDeepLinkUri", () => {
	it("accepts the deep-link kinds the app navigates", () => {
		expect(safeDeepLinkUri("dev3://task/a21540d6-4890-426f-81c1-41cfc460715e")).toBe(
			"dev3://task/a21540d6-4890-426f-81c1-41cfc460715e",
		);
		expect(safeDeepLinkUri("dev3://new-task?project=p1&text=hi")).toBe("dev3://new-task?project=p1&text=hi");
	});

	it("refuses an unknown kind, whitespace and control characters", () => {
		expect(safeDeepLinkUri("dev3://bogus/x")).toBeUndefined();
		expect(safeDeepLinkUri("dev3://task/a b")).toBeUndefined();
		expect(safeDeepLinkUri("dev3://task/a\nb")).toBeUndefined();
	});

	it("is the only non-web scheme an OSC 8 link may carry", () => {
		expect(safeOsc8Uri("dev3://task/t1")).toBe("dev3://task/t1");
		expect(safeOsc8Uri("https://example.com")).toBe("https://example.com");
		expect(safeOsc8Uri("file:///tmp/a.ts")).toBe("file:///tmp/a.ts");
		for (const hostile of ["javascript:alert(1)", "vscode://file/tmp/a", "smb://host/share", "data:text/html,x"]) {
			expect(safeOsc8Uri(hostile)).toBeUndefined();
		}
	});
});
