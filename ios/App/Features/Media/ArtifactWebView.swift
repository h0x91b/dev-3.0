import Dev3Kit
import SwiftUI
import WebKit

struct ArtifactWebView: UIViewRepresentable {
    @Environment(\.colorScheme) private var colorScheme

    let bundle: Dev3ArtifactWebBundle
    let onError: @MainActor @Sendable (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(bundle: bundle, onError: onError)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.setURLSchemeHandler(
            context.coordinator.schemeHandler,
            forURLScheme: Dev3ArtifactURLSpace.scheme
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.overrideUserInterfaceStyle = colorScheme == .dark ? .dark : .light
        webView.accessibilityLabel = "Interactive HTML artifact"
        webView.load(URLRequest(url: bundle.urlSpace.documentURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        webView.overrideUserInterfaceStyle = colorScheme == .dark ? .dark : .light
        context.coordinator.onError = onError
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator _: Coordinator) {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let schemeHandler: ArtifactSchemeHandler
        var onError: @MainActor @Sendable (String) -> Void
        private let urlSpace: Dev3ArtifactURLSpace
        private var finishedInitialNavigation = false

        init(
            bundle: Dev3ArtifactWebBundle,
            onError: @escaping @MainActor @Sendable (String) -> Void
        ) {
            schemeHandler = ArtifactSchemeHandler(bundle: bundle)
            urlSpace = bundle.urlSpace
            self.onError = onError
        }

        func webView(
            _: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            guard navigationAction.targetFrame?.isMainFrame == true,
                  let url = navigationAction.request.url,
                  urlSpace.allowsTopLevelNavigation(
                      to: url,
                      isInitial: !finishedInitialNavigation
                  )
            else {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_: WKWebView, didFinish _: WKNavigation?) {
            finishedInitialNavigation = true
        }

        func webView(_: WKWebView, didFail _: WKNavigation?, withError error: any Error) {
            onError(error.localizedDescription)
        }

        func webView(
            _: WKWebView,
            didFailProvisionalNavigation _: WKNavigation?,
            withError error: any Error
        ) {
            onError(error.localizedDescription)
        }

        func webView(
            _: WKWebView,
            createWebViewWith _: WKWebViewConfiguration,
            for _: WKNavigationAction,
            windowFeatures _: WKWindowFeatures
        ) -> WKWebView? {
            nil
        }

        func webView(
            _: WKWebView,
            runJavaScriptAlertPanelWithMessage _: String,
            initiatedByFrame _: WKFrameInfo,
            completionHandler: @escaping @MainActor () -> Void
        ) {
            completionHandler()
        }

        func webView(
            _: WKWebView,
            runJavaScriptConfirmPanelWithMessage _: String,
            initiatedByFrame _: WKFrameInfo,
            completionHandler: @escaping @MainActor (Bool) -> Void
        ) {
            completionHandler(false)
        }

        func webView(
            _: WKWebView,
            runJavaScriptTextInputPanelWithPrompt _: String,
            defaultText _: String?,
            initiatedByFrame _: WKFrameInfo,
            completionHandler: @escaping @MainActor (String?) -> Void
        ) {
            completionHandler(nil)
        }
    }
}

final class ArtifactSchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    private let bundle: Dev3ArtifactWebBundle

    init(bundle: Dev3ArtifactWebBundle) {
        self.bundle = bundle
    }

    func webView(_: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            deny(urlSchemeTask)
            return
        }
        let data: Data
        let mime: String
        switch bundle.urlSpace.resolve(url, assetNames: Set(bundle.assets.keys)) {
        case .document:
            data = bundle.document
            mime = "text/html"
        case let .asset(name):
            guard let asset = bundle.assets[name] else {
                deny(urlSchemeTask)
                return
            }
            data = asset.data
            mime = asset.mime
        case .denied:
            deny(urlSchemeTask)
            return
        }

        let response = URLResponse(
            url: url,
            mimeType: mime,
            expectedContentLength: data.count,
            textEncodingName: mime == "text/html" ? "utf-8" : nil
        )
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_: WKWebView, stop _: any WKURLSchemeTask) {}

    private func deny(_ task: any WKURLSchemeTask) {
        task.didFailWithError(URLError(.noPermissionsToReadFile))
    }
}
