# Cross-Platform Development

Electrobun enables you to build desktop applications that run on macOS, Windows, and Linux from a single codebase. This guide covers platform-specific considerations and best practices for cross-platform development.

## Platform-Specific Issues

### Window Management

Some window options like frameless windows work differently on different OSes.

### Webview Behavior

Webview hiding and passthrough behavior varies between platforms:

- **macOS**: Webviews can be set to hidden and passthrough separately. These are independent settings.
- **Windows & Linux**: Setting a webview to hidden also automatically enables passthrough behavior. There is no separate passthrough setting - clicks will pass through hidden webviews to underlying content.

```javascript
// Hide a webview (behavior differs by platform)
webviewSetHidden(webviewId, true);

// On macOS: webview is hidden but still intercepts clicks (unless passthrough is also enabled)
// On Windows/Linux: webview is hidden AND clicks pass through automatically

// Enable click passthrough (macOS only - no effect on Windows/Linux)
webviewSetPassthrough(webviewId, true);
```

### Linux

By default on Linux, GTK windows and GTKWebkit webviews are used. This represents the closest approximation to a system-managed webview on Linux. Some distributions lack these dependencies by default, requiring end users to install them.

GTK and GTKWebkit have significant limitations preventing support for Electrobun's advanced webview layering and masking functionality. Bundling CEF (by setting `bundleCEF` to true in electrobun.config.ts) is strongly recommended for Linux distributions. Open windows and webviews with `renderer="cef"` to use pure x11 windows.

## Building for Multiple Platforms

Electrobun builds for the current host platform. To produce builds for all platforms, use a CI service like GitHub Actions with a runner for each OS/architecture.

```bash
# On each CI runner, just run:
electrobun build --env=stable
```

Electrobun's GitHub repository includes a release workflow that builds natively on each platform using a build matrix. This recommended approach ensures each platform build runs on its native OS, avoiding cross-compilation complexity and ensuring platform-specific tools work correctly.

### Architecture Considerations

| Platform | Architectures | Notes |
|----------|---------------|-------|
| macOS | x64, ARM64 | Universal binaries supported |
| Windows | x64 | ARM64 runs via emulation |
| Linux | x64, ARM64 | Native support for both |

## Windows Console Output

On Windows, Electrobun builds apps as GUI applications so no console window appears when users launch them. Dev builds automatically attach to the parent console for `console.log` output visibility.

When inspecting console output from canary or stable builds, set the `ELECTROBUN_CONSOLE` environment variable:

```bash
# Launch a canary/stable build with console output visible
set ELECTROBUN_CONSOLE=1
.\MyApp.exe
```

When `ELECTROBUN_CONSOLE=1` is set, the launcher attaches to the parent console and inherits standard output/error streams like a dev build. This has no effect on macOS or Linux where console output is always available.
