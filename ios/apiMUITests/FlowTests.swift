import XCTest

/// The app against `ios/MockServer` (the desktop's own link code in front of a scripted chat), the way a person
/// uses it. Each step leaves a screenshot in the test results; the CI job exports them.
final class FlowTests: XCTestCase {
    /// The test server's key: it guards nothing but the test.
    static let link = "apim://pair?v=1&n=MOCK-PC&p=47199&h=127.0.0.1&k=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(paired: Bool, link: String = FlowTests.link) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-reset"]
        if paired {
            app.launchEnvironment["APIM_PAIR"] = link
        }
        app.launch()
        return app
    }

    /// Kept in the results, and written straight to the Mac running the simulator (`~/apim-shots/<light|dark>/`,
    /// as fastlane's snapshot does) so the CI job can upload the pictures without digging them out of the bundle.
    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        let environment = ProcessInfo.processInfo.environment
        guard let home = environment["SIMULATOR_HOST_HOME"] else { return }
        let folder = URL(fileURLWithPath: home).appendingPathComponent("apim-shots").appendingPathComponent(environment["APIM_SHOTS"] ?? "light")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? screenshot.pngRepresentation.write(to: folder.appendingPathComponent(name + ".png"))
    }

    /// Anything showing these words: a text, or a button or row whose label holds them.
    private func text(_ app: XCUIApplication, _ fragment: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", fragment)).firstMatch
    }

    private func button(_ app: XCUIApplication, _ fragment: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", fragment)).firstMatch
    }

    private func see(_ app: XCUIApplication, _ fragment: String, timeout: TimeInterval = 20, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(text(app, fragment).waitForExistence(timeout: timeout), "never saw \u{201c}\(fragment)\u{201d}", file: file, line: line)
    }

    /// On screen above the message box, not only somewhere in the transcript: the test passed once while the
    /// approval card sat out of sight under the box.
    private func inView(_ app: XCUIApplication, _ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        let box = app.descendants(matching: .any).matching(identifier: "composer").firstMatch
        let deadline = Date().addingTimeInterval(4)
        while Date() < deadline {
            if element.exists, element.frame.minY > 80, element.frame.maxY <= box.frame.minY {
                return
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        XCTFail("\(element.label) is at \(element.frame), out of view above the message box at \(box.frame)", file: file, line: line)
    }

    private func type(_ app: XCUIApplication, _ words: String) {
        let box = app.descendants(matching: .any).matching(identifier: "composer").firstMatch
        XCTAssertTrue(box.waitForExistence(timeout: 5))
        box.tap()
        box.typeText(words)
        let send = app.buttons["Send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertTrue(send.isEnabled, "Send stays off while offline or empty")
        send.tap()
    }

    func testPairingScreen() {
        let app = launch(paired: false)
        XCTAssertTrue(app.buttons["Scan code"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Paste pairing link"].exists)
        shot("01-pair")
    }

    /// Nothing listens where the link points: the app says so, and what to do, and keeps trying.
    func testComputerNotListening() {
        let app = launch(paired: true, link: FlowTests.link.replacingOccurrences(of: "p=47199", with: "p=47198"))
        see(app, "apiM is not listening")
        see(app, "Connecting to MOCK-PC")
        XCTAssertTrue(app.buttons["Retry"].exists)
        XCTAssertFalse(app.buttons["New chat"].isEnabled, "nothing to ask until it answers")
        shot("10-not-listening")
    }

    func testConversation() {
        let app = launch(paired: true)

        // The chat on the computer's screen comes over whole: prose, a heading, code, a table, the steps.
        see(app, "The loop comes from")
        see(app, "The fix")
        see(app, "MOCK-PC")
        shot("02-chat")

        // The chats, newest first, by day.
        app.buttons["Chats"].tap()
        see(app, "Plan a weekend in Lisbon")
        see(app, "Yesterday")
        shot("03-chats")
        button(app, "Plan a weekend in Lisbon").tap()
        see(app, "Alfama")
        shot("04-other-chat")
        app.buttons["Chats"].tap()
        button(app, "Fix the login redirect loop").tap()
        see(app, "The loop comes from")

        // A message from the phone runs on the computer, stops for approval, and answers once allowed.
        type(app, "Make the tests pass")
        see(app, "Make the tests pass")
        XCTAssertTrue(app.buttons["Allow"].waitForExistence(timeout: 20))
        see(app, "apiM wants to run this")
        inView(app, app.buttons["Allow"])
        shot("05-approval")
        app.buttons["Allow"].tap()
        see(app, "All 12 tests pass")
        see(app, "I updated both assertions")
        inView(app, text(app, "I updated both assertions"))
        shot("06-answer")

        // A question with choices.
        type(app, "Push it ?ask")
        XCTAssertTrue(app.buttons["fix/login-loop"].waitForExistence(timeout: 20))
        inView(app, app.buttons["fix/login-loop"])
        shot("07-question")
        app.buttons["fix/login-loop"].tap()
        see(app, "Pushing to")

        // A message the computer would not send says why.
        type(app, "fail")
        see(app, "No API key")
        XCTAssertFalse(app.staticTexts["fail"].exists, "a message that was not sent leaves no bubble behind")
        shot("08-notice")

        // Stop while it waits.
        type(app, "Run it again")
        XCTAssertTrue(app.buttons["Allow"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Stop"].waitForExistence(timeout: 5))
        app.buttons["Stop"].tap()
        see(app, "Stopped.")
        inView(app, text(app, "Stopped."))
        XCTAssertFalse(app.buttons["Allow"].exists, "the card goes with the reply")

        // A new chat starts empty.
        app.buttons["New chat"].tap()
        see(app, "Whatever you send here runs in apiM on MOCK-PC")
        shot("09-new-chat")

        // What the phone is paired with, from the line under the title.
        app.buttons["connection"].tap()
        XCTAssertTrue(app.buttons["Unpair this phone"].waitForExistence(timeout: 5))
        see(app, "127.0.0.1:47199")
        shot("11-settings")
        app.buttons["Done"].tap()
    }
}
