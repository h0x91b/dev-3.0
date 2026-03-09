/**
 * Stub for electrobun/view used when the UI runs in a regular browser.
 * Vite resolves electrobun/view to this file in dev mode.
 * The real Electroview class is never instantiated in browser mode —
 * this stub only exists to prevent import resolution errors.
 */

export class Electroview {
	rpc: any = null;
	constructor(_config: any) {
		throw new Error("Electroview is not available in browser mode");
	}
	static defineRPC(_config: any): any {
		throw new Error("Electroview.defineRPC is not available in browser mode");
	}
}

export function createRPC() {
	throw new Error("createRPC is not available in browser mode");
}
