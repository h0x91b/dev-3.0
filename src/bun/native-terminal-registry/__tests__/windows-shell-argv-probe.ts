#!/usr/bin/env bun

import { renameSync, writeFileSync } from "node:fs";

const evidencePath = process.env.DEV3_SHELL_MATRIX_EVIDENCE;
if (!evidencePath) throw new Error("DEV3_SHELL_MATRIX_EVIDENCE is required");

const temporaryPath = `${evidencePath}.tmp-${process.pid}`;
writeFileSync(
	temporaryPath,
	`${JSON.stringify({
		cwd: process.cwd(),
		environment: process.env.DEV3_SHELL_MATRIX_UNICODE,
		arguments: process.argv.slice(2),
		parentPid: process.ppid,
	})}\n`,
);
renameSync(temporaryPath, evidencePath);
console.log("ARGV-PROBE-WROTE");
