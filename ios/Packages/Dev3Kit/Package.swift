// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Dev3Kit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "Dev3Kit", targets: ["Dev3Kit"])
    ],
    targets: [
        .target(name: "Dev3Kit"),
        .testTarget(name: "Dev3KitTests", dependencies: ["Dev3Kit"])
    ],
    swiftLanguageModes: [.v6]
)
