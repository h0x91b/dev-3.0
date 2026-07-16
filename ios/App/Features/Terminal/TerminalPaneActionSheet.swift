import Dev3UI
import SwiftUI

@MainActor
struct TerminalPaneActionSheet: View {
    @Bindable var store: TerminalTaskStore
    @Environment(\.colorScheme) private var colorScheme

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Create") {
                    paneActionButton(
                        .splitHorizontal,
                        title: "Split horizontally",
                        systemName: "rectangle.split.2x1"
                    )
                    paneActionButton(
                        .splitVertical,
                        title: "Split vertically",
                        systemName: "rectangle.split.1x2"
                    )
                    paneActionButton(
                        .newWindow,
                        title: "New tmux window",
                        systemName: "macwindow.badge.plus"
                    )
                }
                Section {
                    Button(role: .destructive) {
                        store.performPaneAction(.closePane)
                    } label: {
                        Label("Close active pane", systemImage: "xmark.rectangle")
                    }
                } footer: {
                    Text("Closing the last pane also ends the task's tmux session and requires confirmation.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.surfaceBase)
            .navigationTitle("Panes & windows")
            .navigationBarTitleDisplayMode(.inline)
        }
        .accessibilityIdentifier("terminal.paneActions")
    }

    private func paneActionButton(
        _ action: TerminalPaneAction,
        title: String,
        systemName: String
    ) -> some View {
        Button {
            store.performPaneAction(action)
        } label: {
            Label(title, systemImage: systemName)
        }
    }
}
