#!/usr/bin/env bun

import { spawn } from "../../spawn";

const child = spawn(
	[
		process.execPath,
		"-e",
		'Bun.serve({ port: 0, fetch() { return new Response("alive"); } }); await new Promise(() => {});',
	],
	{
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	},
);
child.unref();
console.log(`TREEPID[${child.pid}]`);
