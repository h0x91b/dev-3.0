@testable import Dev3TerminalKit
import Testing
import UIKit

@MainActor
@Test("Terminal font changes discard stale backing pixels before full redraw")
func terminalFontChangeDiscardsBackingPixels() throws {
    let bounds = CGRect(x: 0, y: 0, width: 32, height: 32)
    let view = Dev3SwiftTermView(frame: bounds)
    view.layer.backgroundColor = UIColor(
        red: 26 / 255,
        green: 27 / 255,
        blue: 38 / 255,
        alpha: 1
    ).cgColor
    view.layer.contents = try whitePixel()

    view.setTerminalFontSize(21)

    #expect(view.layer.contents == nil)
    #expect(view.layer.needsDisplay())
    #expect(view.font.pointSize == 21)

    view.layer.displayIfNeeded()
    let pixel = try #require(renderedCenterPixel(of: view.layer, bounds: bounds))
    #expect(pixel.red < 40)
    #expect(pixel.green < 40)
    #expect(pixel.blue < 50)
    #expect(pixel.alpha == 255)
}

private func whitePixel() throws -> CGImage {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).image { context in
        context.cgContext.setFillColor(UIColor.white.cgColor)
        context.cgContext.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
    }
    return try #require(image.cgImage)
}

private struct Pixel {
    let red: UInt8
    let green: UInt8
    let blue: UInt8
    let alpha: UInt8
}

private func renderedCenterPixel(of layer: CALayer, bounds: CGRect) -> Pixel? {
    let width = Int(bounds.width)
    let height = Int(bounds.height)
    let bytesPerRow = width * 4
    var pixels = [UInt8](repeating: 0, count: bytesPerRow * height)
    let rendered = pixels.withUnsafeMutableBytes { bytes in
        guard let context = CGContext(
            data: bytes.baseAddress,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return false
        }
        layer.render(in: context)
        return true
    }
    guard rendered else { return nil }
    let center = ((height / 2) * bytesPerRow) + ((width / 2) * 4)
    return Pixel(
        red: pixels[center],
        green: pixels[center + 1],
        blue: pixels[center + 2],
        alpha: pixels[center + 3]
    )
}
