import XCTest

final class Dev3UITests: XCTestCase {
    @MainActor
    func testManualPairingConnectsAndStoresTheNamedInstance() {
        continueAfterFailure = false
        let app = launchApp()

        let scanButton = app.buttons["pairing.primaryAction"]
        XCTAssertTrue(scanButton.waitForExistence(timeout: 5))
        XCTAssertTrue(scanButton.isHittable)

        app.buttons["pairing.manualAction"].tap()
        let origin = app.textFields["manual.origin"]
        XCTAssertTrue(origin.waitForExistence(timeout: 2))
        origin.tap()
        origin.typeText("http://127.0.0.1:4242")
        let code = app.secureTextFields["manual.code"]
        code.tap()
        code.typeText("simulator-code")
        let name = app.textFields["manual.name"]
        name.tap()
        name.typeText("Pocket Studio")
        app.buttons["manual.connect"].tap()

        XCTAssertTrue(app.otherElements["connected.shell"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Pocket Studio"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["Connected to dev3"].exists)
    }

    @MainActor
    func testManualPairingRejectsAnAddressWithoutExplicitHTTP() {
        continueAfterFailure = false
        let app = launchApp()

        app.buttons["pairing.manualAction"].tap()
        let origin = app.textFields["manual.origin"]
        XCTAssertTrue(origin.waitForExistence(timeout: 2))
        origin.tap()
        origin.typeText("127.0.0.1:4242")
        let code = app.secureTextFields["manual.code"]
        code.tap()
        code.typeText("simulator-code")
        app.buttons["manual.connect"].tap()

        let error = app.staticTexts["manual.error"]
        XCTAssertTrue(error.waitForExistence(timeout: 2))
        XCTAssertFalse(error.label.isEmpty)
        XCTAssertTrue(app.otherElements["connected.shell"].exists == false)
    }

    @MainActor
    private func launchApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launch()
        return app
    }
}
