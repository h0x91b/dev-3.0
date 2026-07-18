import Foundation

/// User-facing copy for pairing failures. Kept out of `SessionClient.swift` so
/// the FSM file stays focused (and under the file-length limit).
extension SessionClient {
    static let pairingUnreachableMessage =
        "Couldn't reach this dev3 instance. Check that the desktop app is running and the "
            + "address is reachable, then scan the QR code again."

    static func pairingInstanceFailureMessage(for error: Error) -> String {
        guard let http = error as? SessionHTTPError else { return pairingUnreachableMessage }
        switch http {
        case .httpStatus(404):
            return "This dev3 desktop is too old for the iOS app — it doesn't serve the /instance "
                + "endpoint. Update the desktop app to a build that includes it, then scan again."
        case let .httpStatus(status):
            return "The instance returned HTTP \(status) for /instance. "
                + "Update the desktop app, then scan again."
        case let .unsupportedProtocol(version):
            return "This instance speaks protocol v\(version), which this app doesn't support. "
                + "Update the app to match the desktop."
        case .invalidResponse:
            return "The instance returned an invalid response to /instance. "
                + "Update the desktop app, then scan again."
        }
    }
}
