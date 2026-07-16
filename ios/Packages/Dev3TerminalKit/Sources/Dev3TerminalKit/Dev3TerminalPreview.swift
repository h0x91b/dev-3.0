#if DEBUG && canImport(UIKit)
    import Dev3UI
    import SwiftUI

    public struct Dev3TerminalPreview: View {
        @State private var inputMode = Dev3TerminalInputMode.compose
        private let endpoint = Dev3TerminalEndpoint.preview

        public init() {}

        public var body: some View {
            VStack(spacing: 0) {
                HStack {
                    Text("SwiftTerm")
                        .font(.headline)
                    Spacer()
                    Picker("Input mode", selection: $inputMode) {
                        Text("Compose").tag(Dev3TerminalInputMode.compose)
                        Text("Raw").tag(Dev3TerminalInputMode.raw)
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 220)
                }
                .padding()

                Dev3TerminalView(
                    endpoint: endpoint,
                    serverID: "preview-server",
                    inputMode: inputMode
                )
            }
            .background(Color.dev3(.surfaceBase, scheme: .dark))
            .preferredColorScheme(.dark)
        }
    }

    private extension Dev3TerminalEndpoint {
        static var preview: Dev3TerminalEndpoint {
            let output = AsyncStream<Data> { continuation in
                let sample = """
                \u{1B}[1;36mdev3\u{1B}[0m native terminal
                \u{1B}[90mSwiftTerm · frame-coalesced PTY\u{1B}[0m

                \u{1B}[32m✓\u{1B}[0m Connected to studio-mac
                \u{1B}[34m~/dev-3.0\u{1B}[0m $ bun run test
                \u{1B}[32m  847 pass\u{1B}[0m

                \u{1B}[35m❯\u{1B}[0m _
                """
                continuation.yield(Data(sample.utf8))
                continuation.finish()
            }
            return Dev3TerminalEndpoint(
                identity: "preview",
                output: output,
                send: { _ in },
                resize: { _, _ in }
            )
        }
    }

    #Preview("Terminal · Dark") {
        Dev3TerminalPreview()
    }
#endif
