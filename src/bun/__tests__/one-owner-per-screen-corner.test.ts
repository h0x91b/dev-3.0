import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Two independent `fixed` stacks pinned to the same screen corner land on top of
 * each other, because neither can know how tall the other one is. Raising a
 * z-index does not fix that — the winner simply covers the loser. It shipped
 * once: an arriving toast hid the update prompt's header and its close button,
 * both being `fixed top-14 right-4`.
 *
 * So a corner gets exactly one owner and everything else that belongs there
 * renders inside it — `ToastHost`'s pinned slot for the top-right, `StatusDock`
 * for the bottom-left.
 */
const DECLARED_OWNERS: Record<string, string> = {
	"top-right": "src/mainview/toast.tsx",
	// Positions itself through `style` for the safe-area insets, so the class
	// scanner below cannot see it. Declared here instead.
	"bottom-left": "src/mainview/components/StatusDock.tsx",
	"bottom-right": "src/mainview/components/TerminalPerfOverlay.tsx",
};

/** `fixed` + a vertical edge + a horizontal edge in one class list = a corner claim. */
const CORNER_CLAIM = /\bfixed\b[^"`}]*?\b(top|bottom)-\d[\w.[\]/-]*[^"`}]*?\b(left|right)-\d[\w.[\]/-]*/g;

async function rendererFiles(): Promise<string[]> {
	const entries = await readdir(path.join(ROOT, "src/mainview"), { recursive: true });
	return entries
		.map((entry) => `src/mainview/${entry.split(path.sep).join("/")}`)
		.filter((file) => file.endsWith(".tsx") && !file.includes("__tests__"))
		.sort();
}

/** corner -> files positioning themselves there via Tailwind classes. */
async function scanCornerClaims(): Promise<Map<string, string[]>> {
	const byCorner = new Map<string, string[]>();
	for (const file of await rendererFiles()) {
		const text = await readFile(path.join(ROOT, file), "utf8");
		for (const match of text.matchAll(CORNER_CLAIM)) {
			const corner = `${match[1]}-${match[2]}`;
			const files = byCorner.get(corner) ?? [];
			if (!files.includes(file)) files.push(file);
			byCorner.set(corner, files);
		}
	}
	return byCorner;
}

describe("one owner per screen corner", () => {
	it("gives every claimed corner exactly one owner", async () => {
		const shared = [...(await scanCornerClaims())]
			.filter(([, files]) => files.length > 1)
			.map(([corner, files]) => `${corner}: ${files.join(", ")}`);
		expect(shared).toEqual([]);
	});

	it("keeps each corner owned by the surface that declares it", async () => {
		const claims = await scanCornerClaims();
		for (const [corner, owner] of Object.entries(DECLARED_OWNERS)) {
			const found = claims.get(corner) ?? [];
			if (found.length === 0) {
				// Owner positions itself outside the class scanner's reach (safe-area
				// insets in `style`). Prove it still positions itself at all.
				const text = await readFile(path.join(ROOT, owner), "utf8");
				expect(/safe-area-inset|\bfixed\b/.test(text), `${owner} no longer positions itself`).toBe(true);
				continue;
			}
			expect(found, `unexpected owner of ${corner}`).toEqual([owner]);
		}
	});
});
