import Dev3Kit
import SwiftUI

@MainActor
struct PairingHomeView: View {
    let controller: ConnectionController
    let canCancel: Bool
    let onCancel: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var showsScanner = false
    @State private var showsManualEntry = false
    @State private var pendingPairing: PendingPairing?
    @State private var localError: String?

    private var palette: Dev3ThemePalette {
        Dev3Theme.palette(for: colorScheme)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    BrandMark()
                    pairingCopy
                    actions
                    savedInstances
                    localInstances
                    securityNote
                }
                .frame(maxWidth: 560)
                .padding(.horizontal, 24)
                .padding(.vertical, 32)
                .frame(maxWidth: .infinity)
            }
            .background(background)
            .toolbar {
                if canCancel {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel", action: onCancel)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pairing.screen")
        .sheet(isPresented: $showsScanner) {
            QRCodeScannerView { value in
                handleScannedValue(value)
            }
        }
        .sheet(isPresented: $showsManualEntry) {
            ManualPairingView(controller: controller)
        }
        .sheet(item: $pendingPairing) { pending in
            NameServerView(credential: pending.credential, controller: controller)
        }
        .alert("Pairing unavailable", isPresented: localErrorBinding) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(localError ?? "Try again.")
        }
        .alert("Connection issue", isPresented: controllerErrorBinding) {
            Button("OK", role: .cancel) { controller.clearError() }
        } message: {
            Text(controller.errorMessage ?? "Try again.")
        }
    }

    private var pairingCopy: some View {
        VStack(spacing: 12) {
            Text("Your agents, in your pocket.")
                .font(.largeTitle.bold())
                .foregroundStyle(palette.textPrimary)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)

            Text("Pair this iPhone with a dev3 instance, or reconnect to one you already trust.")
                .font(.body)
                .foregroundStyle(palette.textSecondary)
                .multilineTextAlignment(.center)
        }
    }

    private var actions: some View {
        VStack(spacing: 12) {
            Button {
                showsScanner = true
            } label: {
                Label("Scan pairing code", systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("pairing.primaryAction")

            Button("Enter address manually") {
                showsManualEntry = true
            }
            .frame(minHeight: 44)
            .accessibilityIdentifier("pairing.manualAction")

            if controller.isBusy {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(connectionStatus)
                }
                .font(.footnote)
                .foregroundStyle(palette.textSecondary)
                .accessibilityIdentifier("pairing.progress")
            }
        }
    }

    @ViewBuilder
    private var savedInstances: some View {
        if !controller.savedServers.isEmpty {
            PairingSection(title: "Saved instances", systemImage: "key.fill") {
                ForEach(controller.savedServers) { server in
                    SavedInstanceRow(controller: controller, server: server)
                }
            }
        }
    }

    @ViewBuilder
    private var localInstances: some View {
        if !controller.discoveredInstances.isEmpty {
            PairingSection(title: "Nearby instances", systemImage: "wifi") {
                ForEach(controller.discoveredInstances) { instance in
                    DiscoveredInstanceRow(controller: controller, instance: instance)
                }
            }
        }
    }

    private var securityNote: some View {
        Label("Session credentials stay in this device’s Keychain", systemImage: "lock.shield.fill")
            .font(.footnote)
            .foregroundStyle(palette.textTertiary)
            .multilineTextAlignment(.center)
    }

    private var background: some View {
        LinearGradient(
            colors: [
                palette.backgroundGradientStart,
                palette.backgroundGradientMiddle,
                palette.backgroundGradientEnd
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .ignoresSafeArea()
    }

    private var connectionStatus: String {
        switch controller.sessionState {
        case .authenticating:
            "Securing the session…"
        case .connecting:
            "Opening dev3…"
        case .reconnecting:
            "Reconnecting…"
        case .idle, .connected, .expired:
            "Connecting…"
        }
    }

    private var localErrorBinding: Binding<Bool> {
        Binding(
            get: { localError != nil },
            set: {
                if !$0 {
                    localError = nil
                }
            }
        )
    }

    private var controllerErrorBinding: Binding<Bool> {
        Binding(
            get: { controller.errorMessage != nil },
            set: {
                if !$0 {
                    controller.clearError()
                }
            }
        )
    }

    private func handleScannedValue(_ value: String) {
        do {
            pendingPairing = try PendingPairing(credential: PairingURLParser.parseScannedValue(value))
            showsScanner = false
        } catch {
            let fallback = "The QR code is not a dev3 pairing link."
            localError = (error as? LocalizedError)?.errorDescription ?? fallback
        }
    }
}

private struct PendingPairing: Identifiable {
    let id = UUID()
    let credential: PairingCredential
}

@MainActor
private struct BrandMark: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = Dev3Theme.palette(for: colorScheme)
        VStack(spacing: 14) {
            Image(systemName: "terminal.fill")
                .font(.system(size: 40, weight: .semibold))
                .foregroundStyle(palette.accent)
                .frame(width: 88, height: 88)
                .background(palette.glassCard, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .stroke(palette.glassBorderCard)
                }
                .accessibilityHidden(true)

            Text("dev3")
                .font(.custom(Dev3Glyph.fontName, size: 28).weight(.bold))
                .foregroundStyle(palette.textPrimary)
                .accessibilityLabel("dev three")
        }
    }
}

@MainActor
private struct PairingSection<Content: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder let content: Content

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = Dev3Theme.palette(for: colorScheme)
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: systemImage)
                .font(.headline)
                .foregroundStyle(palette.textPrimary)
            VStack(spacing: 0) {
                content
            }
            .background(palette.glassCard, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(palette.glassBorderCard)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

@MainActor
private struct SavedInstanceRow: View {
    let controller: ConnectionController
    let server: PairedServer

    var body: some View {
        HStack(spacing: 12) {
            Button {
                Task { await controller.connect(to: server) }
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(server.name)
                        .font(.body.weight(.semibold))
                    Text(server.origin.host ?? server.origin.absoluteString)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("pairing.saved.\(server.instanceId)")

            if server.instanceId == controller.activeServer?.instanceId {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.tint)
                    .accessibilityLabel("Active")
            }

            Button(role: .destructive) {
                Task { await controller.delete(server) }
            } label: {
                Image(systemName: "trash")
                    .frame(width: 36, height: 36)
            }
            .accessibilityLabel("Delete \(server.name)")
            .accessibilityIdentifier("pairing.delete.\(server.instanceId)")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

@MainActor
private struct DiscoveredInstanceRow: View {
    let controller: ConnectionController
    let instance: DiscoveredInstance

    var body: some View {
        Button {
            Task { await controller.connect(to: instance) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: instance.origin == nil ? "wifi.exclamationmark" : "wifi")
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(instance.serviceName)
                        .font(.body.weight(.semibold))
                    Text(instance.origin?.host ?? "Resolving local address…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(instance.origin == nil)
        .accessibilityIdentifier("pairing.nearby.\(instance.instanceId)")
    }
}

@MainActor
private struct ManualPairingView: View {
    let controller: ConnectionController

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var origin = ""
    @State private var code = ""
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Instance") {
                    TextField("Name (optional)", text: $name)
                        .textContentType(.name)
                        .accessibilityIdentifier("manual.name")
                    TextField("https://dev3.example.com", text: $origin)
                        .textContentType(.URL)
                        .dev3URLKeyboard()
                        .accessibilityIdentifier("manual.origin")
                }
                Section("Pairing code") {
                    TextField("Code", text: $code)
                        .textContentType(.oneTimeCode)
                        .dev3OneTimeCodeInput()
                        .accessibilityIdentifier("manual.code")
                }
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("manual.error")
                    }
                }
            }
            .navigationTitle("Pair manually")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") { connect() }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("manual.connect")
                }
            }
        }
        .onChange(of: controller.sessionState) { _, state in
            if state == .connected {
                dismiss()
            }
        }
    }

    private func connect() {
        do {
            let credential = try PairingURLParser.parseManual(origin: origin, code: code)
            let displayName = name.trimmingCharacters(in: .whitespacesAndNewlines)
            controller.pair(credential, displayName: displayName.isEmpty ? nil : displayName)
            errorMessage = nil
        } catch {
            let fallback = "Check the instance address and code."
            errorMessage = (error as? LocalizedError)?.errorDescription ?? fallback
        }
    }
}

@MainActor
private struct NameServerView: View {
    let credential: PairingCredential
    let controller: ConnectionController

    @Environment(\.dismiss) private var dismiss
    @State private var name: String

    init(credential: PairingCredential, controller: ConnectionController) {
        self.credential = credential
        self.controller = controller
        _name = State(initialValue: credential.origin.host ?? "dev3")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Instance name", text: $name)
                        .textContentType(.name)
                        .accessibilityIdentifier("nameServer.name")
                } footer: {
                    Text("Choose the name shown in your saved instance list.")
                }
            }
            .navigationTitle("Name this instance")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Pair") {
                        controller.pair(credential, displayName: name)
                    }
                    .fontWeight(.semibold)
                    .accessibilityIdentifier("nameServer.pair")
                }
            }
        }
        .onChange(of: controller.sessionState) { _, state in
            if state == .connected {
                dismiss()
            }
        }
    }
}

private extension View {
    @ViewBuilder
    func dev3OneTimeCodeInput() -> some View {
        #if os(iOS)
            textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        #else
            self
        #endif
    }

    @ViewBuilder
    func dev3URLKeyboard() -> some View {
        #if os(iOS)
            textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
        #else
            self
        #endif
    }
}
