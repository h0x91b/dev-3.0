import { useEffect, useState } from "react";
import {
	getDiagnostics,
	getErrorCount,
	subscribeDiagnostics,
	RPC_STATUS_EVENT,
	type DiagnosticEntry,
	type RpcConnectionState,
} from "../diagnostics";
import { getRpcConnectionState } from "../rpc";

/** Live snapshot of all diagnostics entries (re-renders on any change). */
export function useDiagnostics(): DiagnosticEntry[] {
	const [snapshot, setSnapshot] = useState<DiagnosticEntry[]>(() => getDiagnostics());
	useEffect(() => subscribeDiagnostics(() => setSnapshot(getDiagnostics())), []);
	return snapshot;
}

/** Live count of error-level diagnostics (drives the diagnostics pill badge). */
export function useDiagnosticsErrorCount(): number {
	const [count, setCount] = useState<number>(() => getErrorCount());
	useEffect(() => subscribeDiagnostics(() => setCount(getErrorCount())), []);
	return count;
}

/**
 * Live RPC/WebSocket connection state. Seeds from the transport's current value
 * and updates on every {@link RPC_STATUS_EVENT}. In the Electrobun desktop shell
 * the socket is local and stays `connected`; the events matter for the browser
 * remote transport, where a stuck bootstrap is almost always a connection issue.
 */
export function useRpcStatus(): RpcConnectionState {
	const [status, setStatus] = useState<RpcConnectionState>(() => getRpcConnectionState());
	useEffect(() => {
		function onStatus(e: Event) {
			const detail = (e as CustomEvent).detail as { state?: RpcConnectionState } | undefined;
			if (detail?.state) setStatus(detail.state);
		}
		window.addEventListener(RPC_STATUS_EVENT, onStatus);
		return () => window.removeEventListener(RPC_STATUS_EVENT, onStatus);
	}, []);
	return status;
}
