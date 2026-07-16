import Foundation
import Network

public struct DiscoveredInstance: Identifiable, Equatable, Sendable {
    public let serviceName: String
    public let instanceId: String
    public let protocolVersion: Int?
    public let appVersion: String?
    public let origin: URL?

    public var id: String {
        instanceId
    }

    public init(
        serviceName: String,
        instanceId: String,
        protocolVersion: Int?,
        appVersion: String?,
        origin: URL?
    ) {
        self.serviceName = serviceName
        self.instanceId = instanceId
        self.protocolVersion = protocolVersion
        self.appVersion = appVersion
        self.origin = origin
    }
}

public enum BonjourRecordParser {
    public static func parse(
        serviceName: String,
        txtRecord: [String: String],
        origin: URL? = nil
    ) -> DiscoveredInstance? {
        guard let rawInstanceId = txtRecord["instanceId"] else { return nil }
        let instanceId = rawInstanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instanceId.isEmpty else { return nil }
        let protocolVersion = txtRecord["protocolVersion"].flatMap(Int.init)
        let appVersion = txtRecord["appVersion"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        return DiscoveredInstance(
            serviceName: serviceName,
            instanceId: instanceId,
            protocolVersion: protocolVersion,
            appVersion: appVersion?.isEmpty == true ? nil : appVersion,
            origin: origin
        )
    }
}

@MainActor
public protocol BonjourDiscovering: AnyObject {
    var onInstancesChanged: (([DiscoveredInstance]) -> Void)? { get set }
    var onError: ((String) -> Void)? { get set }

    func start()
    func stop()
}

@MainActor
public final class BonjourDiscovery: BonjourDiscovering {
    public var onInstancesChanged: (([DiscoveredInstance]) -> Void)?
    public var onError: ((String) -> Void)?

    private let browserFactory: () -> NWBrowser
    private var browser: NWBrowser?
    private var records: [String: DiscoveredInstance] = [:]
    private var resolutions: [String: NWConnection] = [:]

    public convenience init() {
        self.init {
            NWBrowser(
                for: .bonjourWithTXTRecord(type: "_dev3._tcp", domain: nil),
                using: .tcp
            )
        }
    }

    init(browserFactory: @escaping () -> NWBrowser) {
        self.browserFactory = browserFactory
    }

    public func start() {
        guard browser == nil else { return }
        let browser = browserFactory()
        self.browser = browser
        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor [weak self] in
                self?.handleBrowserState(state)
            }
        }
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor [weak self] in
                self?.handleResults(results)
            }
        }
        browser.start(queue: .global(qos: .utility))
    }

    public func stop() {
        browser?.cancel()
        browser = nil
        resolutions.values.forEach { $0.cancel() }
        resolutions.removeAll()
        records.removeAll()
        onInstancesChanged?([])
    }

    nonisolated static func origin(from endpoint: NWEndpoint?) -> URL? {
        guard case let .hostPort(host, port) = endpoint else { return nil }
        let rawHost = String(describing: host)
        let escapedHost = rawHost.replacingOccurrences(of: "%", with: "%25")
        let authority = escapedHost.contains(":") ? "[\(escapedHost)]" : escapedHost
        return URL(string: "http://\(authority):\(port.rawValue)")
    }
}

private extension BonjourDiscovery {
    func handleBrowserState(_ state: NWBrowser.State) {
        switch state {
        case .failed:
            onError?("Local instance discovery is unavailable.")
            stop()
        case .cancelled:
            browser = nil
        case .setup, .ready, .waiting:
            break
        @unknown default:
            break
        }
    }

    func handleResults(_ results: Set<NWBrowser.Result>) {
        let liveIds = Set(results.compactMap(resultIdentity))
        records = records.filter { liveIds.contains($0.key) }
        for (id, connection) in resolutions where !liveIds.contains(id) {
            connection.cancel()
            resolutions[id] = nil
        }

        for result in results {
            guard let parsed = parse(result) else { continue }
            let existingOrigin = records[parsed.instanceId]?.origin
            records[parsed.instanceId] = DiscoveredInstance(
                serviceName: parsed.serviceName,
                instanceId: parsed.instanceId,
                protocolVersion: parsed.protocolVersion,
                appVersion: parsed.appVersion,
                origin: existingOrigin
            )
            resolve(result.endpoint, for: parsed.instanceId)
        }
        publish()
    }

    func parse(_ result: NWBrowser.Result) -> DiscoveredInstance? {
        guard case let .service(serviceName, _, _, _) = result.endpoint,
              case let .bonjour(txtRecord) = result.metadata
        else {
            return nil
        }
        let dictionary = txtRecord.dictionary.reduce(into: [String: String]()) { result, pair in
            result[pair.key] = pair.value
        }
        return BonjourRecordParser.parse(serviceName: serviceName, txtRecord: dictionary)
    }

    func resultIdentity(_ result: NWBrowser.Result) -> String? {
        parse(result)?.instanceId
    }

    func resolve(_ endpoint: NWEndpoint, for instanceId: String) {
        guard resolutions[instanceId] == nil else { return }
        let connection = NWConnection(to: endpoint, using: .tcp)
        resolutions[instanceId] = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let connection else { return }
            Task { @MainActor [weak self] in
                self?.handleResolutionState(state, connection: connection, instanceId: instanceId)
            }
        }
        connection.start(queue: .global(qos: .utility))
    }

    func handleResolutionState(
        _ state: NWConnection.State,
        connection: NWConnection,
        instanceId: String
    ) {
        switch state {
        case .ready:
            let origin = Self.origin(from: connection.currentPath?.remoteEndpoint)
            let record = records[instanceId]
            if let origin, let record {
                records[instanceId] = DiscoveredInstance(
                    serviceName: record.serviceName,
                    instanceId: record.instanceId,
                    protocolVersion: record.protocolVersion,
                    appVersion: record.appVersion,
                    origin: origin
                )
                publish()
            }
            finishResolution(instanceId)
        case .failed, .cancelled:
            finishResolution(instanceId)
        case .setup, .preparing, .waiting:
            break
        @unknown default:
            break
        }
    }

    func finishResolution(_ instanceId: String) {
        resolutions.removeValue(forKey: instanceId)?.cancel()
    }

    func publish() {
        let instances = records.values.sorted {
            $0.serviceName.localizedCaseInsensitiveCompare($1.serviceName) == .orderedAscending
        }
        onInstancesChanged?(instances)
    }
}
