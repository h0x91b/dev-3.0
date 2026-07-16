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
        let code = app.textFields["manual.code"]
        code.tap()
        code.typeText("simulator-code")
        let name = app.textFields["manual.name"]
        name.tap()
        name.typeText("Pocket Studio")
        app.buttons["manual.connect"].tap()

        XCTAssertTrue(app.otherElements["connected.shell"].waitForExistence(timeout: 5))
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.staticTexts["Pocket Studio"].waitForExistence(timeout: 2))
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
        let code = app.textFields["manual.code"]
        code.tap()
        code.typeText("simulator-code")
        app.buttons["manual.connect"].tap()

        let error = app.staticTexts["manual.error"]
        XCTAssertTrue(error.waitForExistence(timeout: 2))
        XCTAssertFalse(error.label.isEmpty)
        XCTAssertTrue(app.otherElements["connected.shell"].exists == false)
    }

    @MainActor
    func testLiveRuntimePairsAndRefetchesTheAppStoreWhenConfigured() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let origin = environment["DEV3_INTEGRATION_ORIGIN"], !origin.isEmpty,
              let code = environment["DEV3_INTEGRATION_CODE"], !code.isEmpty
        else {
            throw XCTSkip("Set DEV3_INTEGRATION_ORIGIN and DEV3_INTEGRATION_CODE for the live runtime test.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.buttons["pairing.manualAction"].waitForExistence(timeout: 10))
        app.buttons["pairing.manualAction"].tap()
        let originField = app.textFields["manual.origin"]
        XCTAssertTrue(originField.waitForExistence(timeout: 2))
        originField.tap()
        originField.typeText(origin)
        let codeField = app.textFields["manual.code"]
        codeField.tap()
        codeField.typeText(code)
        app.buttons["manual.connect"].tap()

        XCTAssertTrue(app.otherElements["connected.shell"].waitForExistence(timeout: 20))
        app.buttons["Projects"].tap()
        XCTAssertTrue(app.otherElements["projects-dashboard"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.otherElements["projects.loading"].exists)
    }

    @MainActor
    private func launchApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launch()
        return app
    }
}
