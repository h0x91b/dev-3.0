import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

// happy-dom before 20.11.2 held each observer's delivery callback only through a
// WeakRef, so any garbage collection silenced every MutationObserver: RTL's waitFor
// and app code alike. See decisions/2026/11/09/happy-dom-observer-gc-flakes.md.
setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
}

it("a MutationObserver keeps delivering records after a garbage collection", async () => {
	let deliveries = 0;
	const observer = new MutationObserver(() => { deliveries++; });
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-gc-probe"] });
	try {
		document.documentElement.dataset.gcProbe = "before";
		await flushMicrotasks();
		// A WeakRef target survives until the job that created it ends.
		await new Promise((resolve) => setTimeout(resolve, 0));
		collectGarbage();
		document.documentElement.dataset.gcProbe = "after";
		await flushMicrotasks();
		expect(deliveries, "the observer went silent after a GC: happy-dom regressed to a WeakRef-only callback; pin a fixed version").toBe(2);
	} finally {
		observer.disconnect();
		delete document.documentElement.dataset.gcProbe;
	}
});
