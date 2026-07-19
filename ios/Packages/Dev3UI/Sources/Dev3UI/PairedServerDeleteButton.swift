import Dev3Kit
import SwiftUI

/// Destructive "remove this paired instance" control shared by the pairing screen
/// and Settings. The trash icon sits right next to the row's connect tap target, so
/// it is easy to hit by accident — and the only way back is to re-scan the QR code.
/// Every removal therefore routes through an explicit confirmation instead of firing
/// on the first tap.
@MainActor
struct PairedServerDeleteButton<Label: View>: View {
    let controller: ConnectionController
    let server: PairedServer
    /// Accessibility identifier for the trash button. The confirm action reuses it
    /// with a `.confirm` suffix so UI automation can drive the whole flow.
    let identifier: String
    @ViewBuilder var label: () -> Label

    @State private var isConfirming = false

    var body: some View {
        Button(role: .destructive) {
            isConfirming = true
        } label: {
            label()
        }
        .accessibilityLabel("Delete \(server.name)")
        .accessibilityIdentifier(identifier)
        .confirmationDialog(
            "Remove \(server.name)?",
            isPresented: $isConfirming,
            titleVisibility: .visible
        ) {
            Button("Remove instance", role: .destructive) {
                Task { await controller.delete(server) }
            }
            .accessibilityIdentifier("\(identifier).confirm")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "This removes the saved pairing for \(server.name). "
                    + "You'll need to scan its QR code again to reconnect."
            )
        }
    }
}
