import XCTest

final class Dev3UITests: XCTestCase {
    @MainActor
    func testPairingScaffoldOpensConnectedShell() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launch()

        let scanButton = app.buttons["pairing.primaryAction"]
        XCTAssertTrue(scanButton.waitForExistence(timeout: 5))
        XCTAssertTrue(scanButton.isHittable)
        scanButton.tap()

        let connectedStatus = app.staticTexts["Connected to dev3"]
        XCTAssertTrue(connectedStatus.waitForExistence(timeout: 2))
    }
}
