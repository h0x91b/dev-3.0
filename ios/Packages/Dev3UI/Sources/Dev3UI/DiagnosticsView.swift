import Dev3Kit
import SwiftUI

/// On-device diagnostics viewer. Reachable from the pairing screen (so failures
/// that never connect are still inspectable) and from Settings. The log stays
/// local; "Share" is the only way anything leaves the device.
@MainActor
struct DiagnosticsView: View {
    @State private var entries: [DiagnosticEntry] = []
    @State private var exportURL: URL?

    private let log: DiagnosticsLog

    init(log: DiagnosticsLog = .shared) {
        self.log = log
    }

    var body: some View {
        List {
            if entries.isEmpty {
                ContentUnavailableView(
                    "No diagnostics yet",
                    systemImage: "doc.text.magnifyingglass",
                    description: Text("Try to pair or connect, then reopen this screen.")
                )
            } else {
                ForEach(entries) { entry in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(entry.message)
                            .font(.callout.monospaced())
                        Text(subtitle(for: entry))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .navigationTitle("Diagnostics")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    reload()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh")
                .accessibilityIdentifier("diagnostics.refresh")

                if let exportURL {
                    ShareLink(item: exportURL) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Share logs")
                    .accessibilityIdentifier("diagnostics.share")
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if !entries.isEmpty {
                Button(role: .destructive) {
                    log.clear()
                    reload()
                } label: {
                    Label("Clear log", systemImage: "trash")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .padding()
                .accessibilityIdentifier("diagnostics.clear")
            }
        }
        .onAppear(perform: reload)
    }

    private func subtitle(for entry: DiagnosticEntry) -> String {
        let time = entry.timestamp.formatted(date: .omitted, time: .standard)
        return "\(entry.category) · \(time)"
    }

    private func reload() {
        entries = log.entries().reversed()
        exportURL = writeExport()
    }

    private func writeExport() -> URL? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("dev3-diagnostics.txt")
        do {
            try Data(log.export().utf8).write(to: url, options: .atomic)
            return url
        } catch {
            return nil
        }
    }
}
