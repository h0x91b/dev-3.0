/**
 * The real thing: a real occupied port, a real `Bun.serve`, under Bun.
 *
 * The vitest sibling (`remote-access-port-in-use.test.ts`) runs on Node against a
 * stubbed Bun global, so it can pin our guard but not the OS. This one squats a
 * port for real and proves that the guard turns a real EADDRINUSE into a status.
 *
 *   bun run test:remote-port-e2e
 */
import { startRemoteAccessServerGuarded } from "../remote-access-server";

const squatter = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("squatter") });
// Read it BEFORE stopping: a stopped Bun server reports port 0.
const takenPort = squatter.port;
process.env.DEV3_REMOTE_PORT = String(takenPort);

let bootContinued = false;
const status = await startRemoteAccessServerGuarded({
	rpcHandler: async () => ({}),
	getPtyPort: () => 0,
	registerBackpressureProbe: () => () => {},
});
bootContinued = true;

squatter.stop(true);

const problems: string[] = [];
if (!bootContinued) problems.push("the guard let the throw escape — boot would stop here");
if (status.running) problems.push("reported running while the port was held by another server");
if (status.failure?.reason !== "port-in-use") problems.push(`expected reason port-in-use, got ${status.failure?.reason}`);
if (status.failure?.port !== takenPort) problems.push(`expected port ${takenPort}, got ${status.failure?.port}`);
if (status.port !== 0) problems.push(`silently moved the pinned port to ${status.port}`);

if (problems.length > 0) {
	console.error("FAIL\n" + problems.map((p) => ` - ${p}`).join("\n"));
	process.exit(1);
}
console.log(`OK — real EADDRINUSE on port ${takenPort} became a status, boot continued`);
process.exit(0);
