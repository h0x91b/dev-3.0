// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Dev3TerminalKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "Dev3TerminalKit", targets: ["Dev3TerminalKit"])
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.14.0")
    ],
    targets: [
        .target(
            name: "Dev3TerminalKit",
            dependencies: [
                .product(name: "SwiftTerm", package: "SwiftTerm")
            ]
        ),
        .testTarget(name: "Dev3TerminalKitTests", dependencies: ["Dev3TerminalKit"])
    ],
    swiftLanguageModes: [.v6]
)
