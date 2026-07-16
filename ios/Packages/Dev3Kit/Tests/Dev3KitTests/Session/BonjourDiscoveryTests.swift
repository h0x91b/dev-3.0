@testable import Dev3Kit
import Foundation
import Network
import Testing

@Suite("Bonjour discovery")
struct BonjourDiscoveryTests {
    @Test("TXT records expose stable identity and compatibility metadata")
    func parseRecord() throws {
        let origin = try #require(URL(string: "http://mac.local:4242"))
        let instance = try #require(BonjourRecordParser.parse(
            serviceName: "dev3 Development Mac abcdef12 4242",
            txtRecord: [
                "instanceId": " 0190f3d1-0e39 ",
                "protocolVersion": "1",
                "appVersion": "1.36.0"
            ],
            origin: origin
        ))

        #expect(instance.id == "0190f3d1-0e39")
        #expect(instance.protocolVersion == 1)
        #expect(instance.appVersion == "1.36.0")
        #expect(instance.origin == origin)
    }

    @Test("Malformed optional metadata does not hide a discoverable instance")
    func optionalMetadata() throws {
        let instance = try #require(BonjourRecordParser.parse(
            serviceName: "dev3 Mac",
            txtRecord: [
                "instanceId": "instance-1",
                "protocolVersion": "future",
                "appVersion": "  "
            ]
        ))

        #expect(instance.protocolVersion == nil)
        #expect(instance.appVersion == nil)
        #expect(instance.origin == nil)
    }

    @Test("Records without a stable instance id are ignored")
    func missingIdentity() {
        #expect(BonjourRecordParser.parse(serviceName: "dev3 Mac", txtRecord: [:]) == nil)
        #expect(BonjourRecordParser.parse(
            serviceName: "dev3 Mac",
            txtRecord: ["instanceId": "  "]
        ) == nil)
    }

    @Test("Resolved IPv4 and IPv6 endpoints become local HTTP origins")
    func resolvedOrigins() {
        #expect(BonjourDiscovery.origin(from: .hostPort(
            host: "192.168.1.8",
            port: 4242
        ))?.absoluteString == "http://192.168.1.8:4242")
        #expect(BonjourDiscovery.origin(from: .hostPort(
            host: "fe80::1",
            port: 4242
        ))?.absoluteString == "http://[fe80::1]:4242")
        #expect(BonjourDiscovery.origin(from: .service(
            name: "dev3",
            type: "_dev3._tcp",
            domain: "local",
            interface: nil
        )) == nil)
    }
}
