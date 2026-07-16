import SwiftUI
import UIKit

struct MediaShareSheet: UIViewControllerRepresentable {
    let payload: TaskMediaSharePayload

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let url = temporaryURL(for: payload.fileName)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try payload.data.write(to: url, options: .atomic)
            context.coordinator.temporaryURL = url
            return UIActivityViewController(activityItems: [url], applicationActivities: nil)
        } catch {
            return UIActivityViewController(activityItems: [payload.data], applicationActivities: nil)
        }
    }

    func updateUIViewController(_: UIActivityViewController, context _: Context) {}

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
