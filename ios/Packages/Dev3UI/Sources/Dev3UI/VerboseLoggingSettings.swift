import Dev3Kit
import SwiftUI

/// Shared plumbing for the "Verbose logging" preference. The persisted flag is
/// applied to `DiagnosticsLog.shared` both at launch (see `applyToDiagnosticsLog`)
/// and whenever the Settings toggle changes, so opt-in `.debug` tracing (gestures,
/// low-level events) is retained only while the user asks for it.
public enum VerboseLoggingPreference {
    /// UserDefaults key backing the toggle. Kept stable so the choice survives launches.
    public static let defaultsKey = "dev3.diagnostics.verboseLogging"

    /// Reads the persisted preference and applies it to the shared diagnostics log.
    /// Call once early in app startup so debug entries recorded before Settings is
    /// ever opened are honored.
    public static func applyToDiagnosticsLog(
        defaults: UserDefaults = .standard,
        log: DiagnosticsLog = .shared
    ) {
        log.setVerboseEnabled(defaults.bool(forKey: defaultsKey))
    }
}

/// Settings section that toggles verbose (debug-level) diagnostics logging.
struct VerboseLoggingSection: View {
    @AppStorage(VerboseLoggingPreference.defaultsKey) private var verboseEnabled = false

    private let log: DiagnosticsLog

    init(log: DiagnosticsLog = .shared) {
        self.log = log
    }

    var body: some View {
        Section {
            Toggle("Verbose logging", isOn: $verboseEnabled)
                .accessibilityIdentifier("settings.verboseLogging")
        } footer: {
            Text(
                "Records extra debug detail (gestures and low-level events) in Diagnostics. "
                    + "Leave off unless you're chasing a bug."
            )
        }
        .onChange(of: verboseEnabled, initial: true) { _, enabled in
            log.setVerboseEnabled(enabled)
        }
    }
}
