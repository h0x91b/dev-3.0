import SwiftUI
import UIKit

struct MediaShareSheet: UIViewControllerRepresentable {
    let payload: TaskMediaSharePayload

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller: UIActivityViewController
        let url = temporaryURL(for: payload.fileName)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try payload.data.write(to: url, options: .atomic)
            context.coordinator.temporaryURL = url
            controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        } catch {
            controller = UIActivityViewController(activityItems: [payload.data], applicationActivities: nil)
        }
        configurePopoverAnchor(for: controller)
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context _: Context) {
        configurePopoverAnchor(for: controller)
    }

    /// On iPad a `UIActivityViewController` is presented as a popover, and UIKit
    /// raises `NSGenericException` at presentation time unless the popover has an
    /// anchor (`sourceView`/`barButtonItem`). SwiftUI's `.sheet` does not provide
    /// one, so anchor it to the controller's own view, centered with no arrow.
    private func configurePopoverAnchor(for controller: UIActivityViewController) {
        guard let popover = controller.popoverPresentationController else { return }
        popover.permittedArrowDirections = []
        popover.sourceView = controller.view
        let bounds = controller.view.bounds
        popover.sourceRect = CGRect(x: bounds.midX, y: bounds.midY, width: 0, height: 0)
    }

    static func dismantleUIViewController(
        _: UIActivityViewController,
        coordinator: Coordinator
    ) {
        coordinator.removeTemporaryFile()
    }

    final class Coordinator {
        var temporaryURL: URL?

        deinit {
            removeTemporaryFile()
        }

        func removeTemporaryFile() {
            guard let temporaryURL else { return }
            try? FileManager.default.removeItem(at: temporaryURL.deletingLastPathComponent())
            self.temporaryURL = nil
        }
    }

    private func temporaryURL(for fileName: String) -> URL {
        let sanitized = fileName
            .split(whereSeparator: { $0 == "/" || $0 == "\\" })
            .last
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let name = sanitized.flatMap { $0.isEmpty ? nil : $0 } ?? "dev3-media"
        return FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent(name, isDirectory: false)
    }
}
