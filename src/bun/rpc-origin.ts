import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which transport an RPC call arrived on. The browser transport (`dev3 remote`)
 * runs its handlers inside `runAsRemoteRpc`, so a handler that must stay
 * desktop-only (installing or trusting third-party code, D12) can refuse it on
 * the host instead of trusting the renderer to hide a button.
 */
const remoteCall = new AsyncLocalStorage<true>();

export function runAsRemoteRpc<T>(fn: () => Promise<T>): Promise<T> {
	return remoteCall.run(true, fn);
}

export function isRemoteRpcCall(): boolean {
	return remoteCall.getStore() === true;
}
