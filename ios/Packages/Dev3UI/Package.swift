// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Dev3UI",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "Dev3UI", targets: ["Dev3UI"])
    ],
    dependencies: [
        .package(path: "../Dev3Kit")
    ],
    targets: [
        .target(name: "Dev3UI", dependencies: ["Dev3Kit"]),
        .testTarget(name: "Dev3UITests", dependencies: ["Dev3UI"])
    ],
    swiftLanguageModes: [.v6]
)
