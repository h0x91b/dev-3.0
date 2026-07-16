import SwiftUI

#if canImport(UIKit)
    @preconcurrency import AVFoundation
    import UIKit
    import VisionKit
#endif

@MainActor
struct QRCodeScannerView: View {
    let onScanned: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            scanner
                .navigationTitle("Scan pairing code")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
        }
    }

    @ViewBuilder
    private var scanner: some View {
        #if targetEnvironment(simulator)
            ContentUnavailableView(
                "Camera unavailable in Simulator",
                systemImage: "camera.fill",
                description: Text("Use Enter address manually to test pairing in Simulator.")
            )
            .accessibilityIdentifier("scanner.simulatorUnavailable")
        #elseif canImport(UIKit)
            ScannerCameraContainer { value in
                onScanned(value)
            }
            .ignoresSafeArea(edges: .bottom)
            .overlay(alignment: .bottom) {
                Text("Point the camera at the pairing QR shown by dev3")
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 24)
            }
            .accessibilityIdentifier("scanner.camera")
        #else
            ContentUnavailableView("Camera unavailable", systemImage: "camera.fill")
        #endif
    }
}

#if canImport(UIKit) && !targetEnvironment(simulator)
    @MainActor
    private struct ScannerCameraContainer: UIViewControllerRepresentable {
        let onScanned: (String) -> Void

        func makeCoordinator() -> Coordinator {
            Coordinator(onScanned: onScanned)
        }

        func makeUIViewController(context: Context) -> UIViewController {
            if DataScannerViewController.isSupported, DataScannerViewController.isAvailable {
                let scanner = DataScannerViewController(
                    recognizedDataTypes: [.barcode(symbologies: [.qr])],
                    qualityLevel: .balanced,
                    recognizesMultipleItems: false,
                    isHighFrameRateTrackingEnabled: true,
                    isHighlightingEnabled: true
                )
                scanner.delegate = context.coordinator
                context.coordinator.dataScanner = scanner
                try? scanner.startScanning()
                return scanner
            }
            return LegacyScannerController(onScanned: onScanned)
        }

        func updateUIViewController(_: UIViewController, context _: Context) {}

        static func dismantleUIViewController(_ viewController: UIViewController, coordinator: Coordinator) {
            coordinator.dataScanner?.stopScanning()
            (viewController as? LegacyScannerController)?.stopScanning()
        }

        @MainActor
        final class Coordinator: NSObject, DataScannerViewControllerDelegate {
            let onScanned: (String) -> Void
            weak var dataScanner: DataScannerViewController?
            private var hasScanned = false

            init(onScanned: @escaping (String) -> Void) {
                self.onScanned = onScanned
            }

            func dataScanner(
                _: DataScannerViewController,
                didAdd addedItems: [RecognizedItem],
                allItems _: [RecognizedItem]
            ) {
                guard !hasScanned else { return }
                for item in addedItems {
                    guard case let .barcode(barcode) = item,
                          let value = barcode.payloadStringValue
                    else {
                        continue
                    }
                    hasScanned = true
                    onScanned(value)
                    return
                }
            }
        }
    }

    @MainActor
    private final class LegacyScannerController: UIViewController {
        private let onScanned: (String) -> Void
        private let session = AVCaptureSession()
        private let sessionQueue = DispatchQueue(label: "com.ittaiz.dev3.qr-camera")
        private var previewLayer: AVCaptureVideoPreviewLayer?
        private var hasScanned = false

        init(onScanned: @escaping (String) -> Void) {
            self.onScanned = onScanned
            super.init(nibName: nil, bundle: nil)
        }

        @available(*, unavailable)
        required init?(coder _: NSCoder) {
            fatalError("init(coder:) is unavailable")
        }

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            requestCameraAndConfigure()
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            previewLayer?.frame = view.bounds
        }

        func stopScanning() {
            let session = session
            sessionQueue.async {
                if session.isRunning {
                    session.stopRunning()
                }
            }
        }

        private func requestCameraAndConfigure() {
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized:
                configureSession()
            case .notDetermined:
                Task {
                    if await AVCaptureDevice.requestAccess(for: .video) {
                        configureSession()
                    }
                }
            case .denied, .restricted:
                showCameraUnavailable()
            @unknown default:
                showCameraUnavailable()
            }
        }

        private func configureSession() {
            guard let camera = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: camera),
                  session.canAddInput(input)
            else {
                showCameraUnavailable()
                return
            }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                showCameraUnavailable()
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let previewLayer = AVCaptureVideoPreviewLayer(session: session)
            previewLayer.videoGravity = .resizeAspectFill
            previewLayer.frame = view.bounds
            view.layer.addSublayer(previewLayer)
            self.previewLayer = previewLayer
            let session = session
            sessionQueue.async {
                session.startRunning()
            }
        }

        private func showCameraUnavailable() {
            let label = UILabel()
            label.text = "Camera access is unavailable. Pair manually instead."
            label.textColor = .white
            label.textAlignment = .center
            label.numberOfLines = 0
            label.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(label)
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
                label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
                label.centerYAnchor.constraint(equalTo: view.centerYAnchor)
            ])
        }
    }

    extension LegacyScannerController: @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
        func metadataOutput(
            _: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from _: AVCaptureConnection
        ) {
            guard !hasScanned,
                  let code = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  code.type == .qr,
                  let value = code.stringValue
            else {
                return
            }
            hasScanned = true
            onScanned(value)
        }
    }
#endif
