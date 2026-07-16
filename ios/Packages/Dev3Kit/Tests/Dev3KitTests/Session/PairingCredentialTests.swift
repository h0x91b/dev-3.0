@testable import Dev3Kit
import Foundation
import Testing

@Suite("Pairing URL parser")
struct PairingCredentialTests {
    @Test("Scanned links preserve the origin and extract the token")
    func scannedLink() throws {
        let credential = try PairingURLParser.parseScannedValue(
            " https://Example.com:4242/some/path?token=abc.def&unused=1#fragment "
        )

        #expect(credential.origin.absoluteString == "https://example.com:4242")
        #expect(credential.token == "abc.def")
    }

    @Test("Manual pairing trims the code and strips origin details")
    func manualPairing() throws {
        let credential = try PairingURLParser.parseManual(
            origin: "http://192.168.1.20:4242/old/path?ignored=1",
            code: " test1234\n"
        )

        #expect(credential.origin.absoluteString == "http://192.168.1.20:4242")
        #expect(credential.token == "test1234")
    }

    @Test(
        "Invalid pairing values are rejected",
        arguments: [
            ("", PairingURLParserError.emptyValue),
            ("ftp://host/?token=code", PairingURLParserError.unsupportedScheme),
            ("https:///missing?token=code", PairingURLParserError.missingHost),
            ("https://user:password@host/?token=code", PairingURLParserError.userInfoNotAllowed),
            ("https://host/", PairingURLParserError.missingToken)
        ]
    )
    func invalidScannedValues(rawValue: String, expected: PairingURLParserError) {
        #expect(throws: expected) {
            try PairingURLParser.parseScannedValue(rawValue)
        }
    }

    @Test("Manual addresses require an explicit HTTP or HTTPS scheme")
    func manualAddressRequiresScheme() {
        #expect(throws: PairingURLParserError.unsupportedScheme) {
            try PairingURLParser.parseManual(origin: "localhost:4242", code: "code")
        }
    }
}
