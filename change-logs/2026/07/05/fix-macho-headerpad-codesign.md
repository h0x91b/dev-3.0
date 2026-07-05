Fixed macOS Intel (x86_64) builds crashing instantly on launch: Apple's codesign silently overwrote the start of the code section in Electrobun's zero-headerpad Zig binaries (launcher/extractor/libasar), producing signed, notarized apps that segfault. Release CI now reserves a code-signature slot in these binaries before signing, and a new gate verifies every shipped Mach-O and smoke-runs the launcher on a native Intel runner so this class of corruption can never ship silently again.

Suggested by @AlexanderVase (h0x91b/dev-3.0#563)
