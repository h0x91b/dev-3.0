Short: Intel macOS builds ship again

Fixed macOS x64 builds failing Apple notarization since the model-catalog proxy landed: the vendored bifrost binary for Intel declared an SDK of 10.4 and Apple rejects anything below 10.9, which failed the whole app archive. The staged copy now declares 10.15; arm64 was never affected.
