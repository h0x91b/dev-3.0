Short: macOS release gate reports the real failure

The macOS release JIT-entitlements gate no longer dies silently when Electrobun stops before packing the self-extractor payload (for example after a transient `stapler staple` network error): it now finds the shipped CLI and clonefile worker in the unpacked build, and still fails loudly on a genuinely missing file or a broken search, so the run reaches the step that names the real cause.
