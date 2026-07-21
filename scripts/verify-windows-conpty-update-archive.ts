// Electrobun lifecycle hooks accept only a script path, so this wrapper selects final-archive mode.
process.env.DEV3_VERIFY_UPDATE_ARCHIVE = "1";

await import("./verify-packaged-windows-conpty");

export {};
