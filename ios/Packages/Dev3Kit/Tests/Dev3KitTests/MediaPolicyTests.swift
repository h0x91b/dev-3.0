@testable import Dev3Kit
import Foundation
import Testing

@Suite("Native media boundary")
struct MediaPolicyTests {
    @Test("Raster data URLs decode exactly")
    func imageDataURL() throws {
        let source = Data([0x00, 0x7F, 0xFF])
        let decoded = try Dev3MediaDataURL.decode(
            "data:image/png;base64,\(source.base64EncodedString())"
        )

        #expect(decoded == Dev3DecodedMedia(mime: "image/png", data: source))
    }

    @Test("Data URL rejects active, malformed, and oversized media")
    func imageDataURLRejections() {
        #expect(throws: Dev3MediaPayloadError.unsupportedMIME("image/svg+xml")) {
            try Dev3MediaDataURL.decode("data:image/svg+xml;base64,PHN2Zz4=")
        }
        #expect(throws: Dev3MediaPayloadError.invalidDataURL) {
            try Dev3MediaDataURL.decode("data:image/png,not-base64")
        }
        #expect(throws: Dev3MediaPayloadError.invalidDataURL) {
            try Dev3MediaDataURL.decode("https://example.com/image.png")
        }
        let tooLarge = Data(repeating: 0, count: Dev3MediaDataURL.maximumBytes + 1)
        #expect(throws: Dev3MediaPayloadError.payloadTooLarge) {
            try Dev3MediaDataURL.decode(
                "data:image/png;base64,\(tooLarge.base64EncodedString())"
            )
        }
    }

    @Test("History removes duplicate ids, retains newest order, and applies its cap")
    func normalizedHistory() {
        #expect(Dev3MediaHistory.normalizedIDs(["a", "b", "a", "c"], limit: 3) == ["b", "a", "c"])
        #expect(Dev3MediaHistory.normalizedIDs(["a", "b", "c"], limit: 2) == ["b", "c"])
        #expect(Dev3MediaHistory.normalizedIDs(["", "a"], limit: 10) == ["a"])
        #expect(Dev3MediaHistory.normalizedIDs(["a"], limit: 0).isEmpty)
    }

    @Test("History selects new arrivals and otherwise preserves the visible id")
    func replacementSelection() {
        #expect(Dev3MediaHistory.replacementSelection(
            currentIDs: ["a", "b"],
            currentIndex: 0,
            incomingIDs: ["a", "b", "c"],
            newCount: 1
        ) == 2)
        #expect(Dev3MediaHistory.replacementSelection(
            currentIDs: ["a", "b", "c"],
            currentIndex: 1,
            incomingIDs: ["b", "c", "d"],
            newCount: 0
        ) == 0)
        #expect(Dev3MediaHistory.replacementSelection(
            currentIDs: ["a"],
            currentIndex: 99,
            incomingIDs: ["b", "c"],
            newCount: 0
        ) == 1)
        #expect(Dev3MediaHistory.replacementSelection(
            currentIDs: [],
            currentIndex: nil,
            incomingIDs: [],
            newCount: 2
        ) == nil)
    }

    @Test("Artifact document receives the restrictive native CSP")
    func artifactCSPComposition() {
        let withHead = Dev3ArtifactDocumentPolicy.compose(
            "<!doctype html><html><head><title>Report</title></head><body></body></html>"
        )
        #expect(withHead.contains("Content-Security-Policy"))
        #expect(withHead.contains("connect-src 'none'"))
        #expect(withHead.contains("script-src 'unsafe-inline'"))
        #expect(withHead.components(separatedBy: "Content-Security-Policy").count == 2)

        let fragment = Dev3ArtifactDocumentPolicy.compose("<h1>Report</h1>")
        #expect(fragment.hasPrefix("<!doctype html><html><head>"))
        #expect(fragment.contains("<body><h1>Report</h1></body>"))
    }

    @Test("Artifact bundle accepts unique safe relative raster resources")
    func artifactBundleValidation() throws {
        let image = Data([1, 2, 3])
        let payload = Dev3ArtifactContentAsset(
            name: "images/charts/chart.png",
            mime: "image/png",
            dataUrl: "data:image/png;base64,\(image.base64EncodedString())"
        )
        let bundle = try Dev3ArtifactWebBundle(
            artifactID: "Report 7",
            html: "<html><body><img src='images/charts/chart.png'></body></html>",
            assets: [payload]
        )

        #expect(bundle.assets["images/charts/chart.png"]?.data == image)
        #expect(bundle.urlSpace.host == "artifact-report-7")
        #expect(String(data: bundle.document, encoding: .utf8)?.contains("default-src 'none'") == true)

        #expect(throws: Dev3MediaPayloadError.invalidAssetName("../chart.png")) {
            try Dev3ArtifactWebBundle(
                artifactID: "x",
                html: "<html></html>",
                assets: [Dev3ArtifactContentAsset(
                    name: "../chart.png",
                    mime: "image/png",
                    dataUrl: payload.dataUrl
                )]
            )
        }
        #expect(throws: Dev3MediaPayloadError.duplicateAssetName("images/charts/chart.png")) {
            try Dev3ArtifactWebBundle(
                artifactID: "x",
                html: "<html></html>",
                assets: [payload, payload]
            )
        }
    }

    @Test("Artifact URL space permits only its document and declared relative resources")
    func artifactURLPolicy() throws {
        let space = Dev3ArtifactURLSpace(artifactID: "A/B")
        let asset = try #require(
            URL(string: "dev3artifact://artifact-a-b/images/charts/chart.png?v=1")
        )

        #expect(space.resolve(space.documentURL, assetNames: ["images/charts/chart.png"]) == .document)
        #expect(space.resolve(
            asset,
            assetNames: ["images/charts/chart.png"]
        ) == .asset("images/charts/chart.png"))
        #expect(space.resolve(asset, assetNames: []) == .denied)
        #expect(try space.resolve(
            #require(URL(string: "https://example.com/chart.png")),
            assetNames: ["images/charts/chart.png"]
        ) == .denied)
        #expect(try space.resolve(
            #require(URL(string: "dev3artifact://artifact-a-b/%2e%2e/chart.png")),
            assetNames: ["images/charts/chart.png"]
        ) == .denied)
        #expect(try space.resolve(
            #require(URL(string: "dev3artifact://artifact-a-b/images%2Fcharts%2Fchart.png")),
            assetNames: ["images/charts/chart.png"]
        ) == .denied)
        #expect(try space.resolve(
            #require(URL(string: "dev3artifact://artifact-a-b/images//chart.png")),
            assetNames: ["images/chart.png"]
        ) == .denied)
        #expect(try space.resolve(
            #require(URL(string: "dev3artifact://artifact-a-b/images/%2e/chart.png")),
            assetNames: ["images/chart.png"]
        ) == .denied)
        #expect(try space.resolve(
            #require(URL(string: "dev3artifact://artifact-a-b/images/chart..final.png")),
            assetNames: ["images/chart..final.png"]
        ) == .asset("images/chart..final.png"))
    }

    @Test("Top-level navigation allows initial load and same-document fragments only")
    func artifactNavigationPolicy() throws {
        let space = Dev3ArtifactURLSpace(artifactID: "report")
        #expect(space.allowsTopLevelNavigation(to: space.documentURL, isInitial: true))
        #expect(!space.allowsTopLevelNavigation(to: space.documentURL, isInitial: false))
        let fragment = try #require(URL(string: "\(space.documentURL.absoluteString)#details"))
        #expect(space.allowsTopLevelNavigation(to: fragment, isInitial: false))
        #expect(try !space.allowsTopLevelNavigation(
            to: #require(URL(string: "https://example.com")),
            isInitial: false
        ))
    }

    @Test("Artifact downloads accept HTML or ZIP only")
    func artifactDownloadPolicy() throws {
        let source = Data("<html></html>".utf8)
        let decoded = try Dev3ArtifactDownloadPolicy.decode(
            Dev3ArtifactDownloadResponse(
                fileName: "report.html",
                mime: "text/html",
                base64: source.base64EncodedString()
            )
        )
        #expect(decoded == Dev3DecodedMedia(mime: "text/html", data: source))
        #expect(throws: Dev3MediaPayloadError.invalidDownload) {
            try Dev3ArtifactDownloadPolicy.decode(
                Dev3ArtifactDownloadResponse(
                    fileName: "report.exe",
                    mime: "application/octet-stream",
                    base64: source.base64EncodedString()
                )
            )
        }
    }
}
