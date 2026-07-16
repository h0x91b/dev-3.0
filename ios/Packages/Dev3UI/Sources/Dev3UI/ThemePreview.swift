import SwiftUI

public struct ThemePreview: View {
    private let mode: Dev3ThemeMode
    @Environment(\.colorScheme) private var systemColorScheme

    public init(mode: Dev3ThemeMode = .system) {
        self.mode = mode
    }

    private var palette: Dev3ThemePalette {
        mode.palette(systemColorScheme: systemColorScheme)
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                surfaceLadder
                semanticColors
                statusColors
                labelColors
                terminalPalette
            }
            .padding(24)
        }
        .background(backgroundGradient.ignoresSafeArea())
        .foregroundStyle(palette.textPrimary)
    }

    private var backgroundGradient: LinearGradient {
        LinearGradient(
            colors: [
                palette.backgroundGradientStart,
                palette.backgroundGradientMiddle,
                palette.backgroundGradientEnd
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text(Dev3Glyph.terminal)
                .font(.custom(Dev3Glyph.fontName, size: 28))
                .foregroundStyle(palette.accent)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text("dev3 native theme")
                    .font(.title2.bold())
                Text("Generated from the desktop semantic tokens")
                    .font(.subheadline)
                    .foregroundStyle(palette.textSecondary)
            }
        }
    }

    private var surfaceLadder: some View {
        previewSection("Surface ladder") {
            HStack(spacing: 8) {
                surfaceSwatch("Base", color: palette.surfaceBase)
                surfaceSwatch("Raised", color: palette.surfaceRaised)
                surfaceSwatch("Elevated", color: palette.surfaceElevated)
                surfaceSwatch("Overlay", color: palette.surfaceOverlay)
            }
        }
    }

    private var semanticColors: some View {
        previewSection("Semantic colors") {
            HStack(spacing: 14) {
                colorChip("Accent", color: palette.accent)
                colorChip("Success", color: palette.success)
                colorChip("Warning", color: palette.warning)
                colorChip("Danger", color: palette.danger)
                colorChip("Favorite", color: palette.favorite)
            }
        }
    }

    private var statusColors: some View {
        previewSection("Task status") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 8)], spacing: 8) {
                ForEach(Dev3StatusToken.allCases, id: \.self) { status in
                    HStack(spacing: 8) {
                        Circle()
                            .fill(palette.statusColor(status))
                            .frame(width: 9, height: 9)
                        Text(status.rawValue)
                            .font(.caption.monospaced())
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 34)
                    .background(palette.glassCard, in: Capsule())
                    .overlay(Capsule().stroke(palette.glassBorderCard))
                }
            }
        }
    }

    private var labelColors: some View {
        previewSection("Label palette") {
            HStack(spacing: 8) {
                ForEach(palette.labelValues.indices, id: \.self) { index in
                    Circle()
                        .fill(palette.labelColor(at: index))
                        .frame(width: 18, height: 18)
                        .accessibilityLabel("Label color \(index + 1)")
                }
            }
        }
    }

    private var terminalPalette: some View {
        previewSection("Terminal ANSI") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 7) {
                    ForEach(Array(terminalColors.enumerated()), id: \.offset) { _, color in
                        RoundedRectangle(cornerRadius: 4)
                            .fill(color)
                            .frame(width: 22, height: 22)
                    }
                }

                Text("$ dev3 task list --status in-progress")
                    .font(.custom(Dev3Glyph.fontName, size: 13))
                    .foregroundStyle(palette.terminal.foreground)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.terminal.background, in: RoundedRectangle(cornerRadius: 9))
            }
        }
    }

    private var terminalColors: [Color] {
        [
            palette.terminal.black,
            palette.terminal.red,
            palette.terminal.green,
            palette.terminal.yellow,
            palette.terminal.blue,
            palette.terminal.magenta,
            palette.terminal.cyan,
            palette.terminal.white
        ]
    }

    private func previewSection(
        _ title: String,
        @ViewBuilder content: () -> some View
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.caption.bold())
                .tracking(0.8)
                .foregroundStyle(palette.textTertiary)
            content()
        }
    }

    private func surfaceSwatch(_ title: String, color: Color) -> some View {
        Text(title)
            .font(.caption.weight(.medium))
            .foregroundStyle(palette.textPrimary)
            .frame(maxWidth: .infinity, minHeight: 58)
            .background(color, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.borderDefault))
    }

    private func colorChip(_ title: String, color: Color) -> some View {
        VStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 28, height: 28)
            Text(title)
                .font(.caption2)
                .foregroundStyle(palette.textSecondary)
        }
    }
}

#Preview("Theme / Dark") {
    ThemePreview(mode: .dark)
        .preferredColorScheme(.dark)
}

#Preview("Theme / Light") {
    ThemePreview(mode: .light)
        .preferredColorScheme(.light)
}
