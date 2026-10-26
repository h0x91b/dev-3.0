import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenCounts } from "../../shared/agent-pricing";
import { mergeUsageRecord, type UsageState } from "../rpc-handlers/agent-usage-parse";

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function countsOf(metric: ObjectValue): TokenCounts | undefined {
	const usage = object(metric.usage);
	if (!usage) return;
	const details = object(metric.tokenDetails);
	const detail = (key: string): unknown => object(details?.[key])?.tokenCount;
	const cached = count(detail("cache_read") ?? usage.cacheReadTokens);
	const written = count(detail("cache_write") ?? usage.cacheWriteTokens);
	return {
		inputTokens: details && typeof detail("input") === "number" ? count(detail("input"))
			: Math.max(0, count(usage.inputTokens) - cached - written),
		outputTokens: count(detail("output") ?? usage.outputTokens),
		cacheReadInputTokens: cached,
		cacheCreationInputTokens: written,
	};
}

/** Reads durable Copilot accounting; live assistant.usage events are ephemeral. */
export function collectCopilotUsage(state: UsageState, home: string): void {
	const root = join(home, "session-state");
	let directories: import("node:fs").Dirent[];
	try { directories = readdirSync(root, { withFileTypes: true }); }
	catch { return; }
	for (const directory of directories) {
		if (!directory.isDirectory()) continue;
		let text: string;
		try { text = readFileSync(join(root, directory.name, "events.jsonl"), "utf8"); }
		catch { continue; }
		const seenEvents = new Set<string>();
		let sessionId = directory.name;
		for (const line of text.split("\n")) {
			let event: ObjectValue | undefined;
			try { event = object(JSON.parse(line)); }
			catch { continue; }
			const data = object(event?.data);
			if (!event || !data) continue;
			if (event.type === "session.start" && typeof data.sessionId === "string") {
				sessionId = data.sessionId;
				continue;
			}
			if (event.type !== "session.shutdown" && event.type !== "session.usage_checkpoint") continue;
			const timestamp = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
			if (!Number.isFinite(timestamp)) continue;
			const snapshot = object(data.accountingSnapshot) ?? data;
			const metrics = object(snapshot.modelMetrics);
			if (!metrics) continue;
			const rawStart = snapshot.sessionStartTime ?? data.sessionStartTime;
			const start = typeof rawStart === "string" ? Date.parse(rawStart) : rawStart;
			if (typeof start !== "number" || !Number.isFinite(start)) continue;
			const nativeEventId = typeof event.id === "string" && event.id ? event.id : undefined;
			if (nativeEventId && seenEvents.has(nativeEventId)) continue;
			if (nativeEventId) seenEvents.add(nativeEventId);
			for (const [model, rawMetric] of Object.entries(metrics)) {
				const metric = object(rawMetric);
				const counts = metric && countsOf(metric);
				if (!counts) continue;
				const cumulativeScope = JSON.stringify([sessionId, start, model]);
				const eventId = nativeEventId ?? `${event.type}:${timestamp}:${JSON.stringify(counts)}`;
				mergeUsageRecord(state, `copilot:${cumulativeScope}:${eventId}`, { model, timestamp, counts, cumulativeScope });
			}
		}
	}
}
