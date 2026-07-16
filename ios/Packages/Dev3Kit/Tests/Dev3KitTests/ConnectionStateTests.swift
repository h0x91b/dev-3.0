@testable import Dev3Kit
import Testing

@Test("Connection states remain stable for persistence")
func connectionStateRawValues() {
    #expect(ConnectionState.pairing.rawValue == "pairing")
    #expect(ConnectionState.connected.rawValue == "connected")
}

@Test("Preview server has a recognizable local name")
func previewServer() {
    #expect(CompanionServer.preview.name == "Local dev3")
}
