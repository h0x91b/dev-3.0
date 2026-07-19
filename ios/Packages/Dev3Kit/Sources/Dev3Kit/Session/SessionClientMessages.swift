import Foundation

/// User-facing copy for pairing failures. Kept out of `SessionClient.swift` so
/// the FSM file stays focused (and under the file-length limit).
///
/// Three distinct failure shapes, each with its own actionable message:
///   (a) reachable but the desktop predates `/instance` (HTTP 404) → "too old, update it".
///   (b) reachable but the desktop errored or replied with something we can't use
///       (5xx / other status / malformed body / protocol mismatch) → "it responded but
///       something went wrong; retry or restart the desktop".
///   (c) never reached the desktop at all (network error / timeout, whether fetching
///       `/instance` or exchanging the token) → "couldn't reach it; same Wi-Fi? VPN /
///       firewall? — do NOT blame the version".
extension SessionClient {
    /// Scenario (c): the phone could not reach the desktop. This is a reachability
    /// problem, so the copy must not mention the desktop being outdated.
    static let pairingUnreachableMessage =
        "Couldn't reach this dev3 desktop. Make sure your phone and the desktop are on the same "
            + "Wi-Fi network — a VPN or firewall can block the connection — and that the desktop "
            + "app is running, then scan the QR code again."

    static func pairingInstanceFailureMessage(for error: Error) -> String {
        guard let http = error as? SessionHTTPError else {
            // Not an HTTP-level failure: the request never produced a valid HTTP
            // response (URLError, timeout, connection refused). Scenario (c).
            return pairingUnreachableMessage
        }
        switch http {
        case .httpStatus(404):
            // Scenario (a): reachable, but this desktop build has no /instance endpoint.
            return "This dev3 desktop is too old for the iOS app — it doesn't serve the /instance "
                + "endpoint. Update the desktop app to a build that includes it, then scan again."
        case let .unsupportedProtocol(version):
            // Scenario (b): reachable and understood, but versions don't line up.
            return "This dev3 desktop speaks pairing protocol v\(version), which this app doesn't "
                + "support. Update whichever of the app or desktop is behind, then scan again."
        case let .httpStatus(status):
            // Scenario (b): reachable, but the desktop itself errored while pairing.
            return "This dev3 desktop is reachable but responded with an error (HTTP \(status)) "
                + "while pairing. Try again in a moment; if it keeps failing, restart the desktop "
                + "app, then scan again."
        case .invalidResponse:
            // Scenario (b): reachable, but the /instance reply was malformed.
            return "This dev3 desktop is reachable but its response to /instance couldn't be read. "
                + "Make sure the desktop app is up to date and running normally, then scan again."
        }
    }
}
