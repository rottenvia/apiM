import XCTest

/// The app against `ios/MockServer` (the desktop's own link code in front of a scripted chat), the way a person
/// uses it. Each step leaves a screenshot in the test results; the CI job exports them. The test server keeps its
/// state for the whole run and the tests run in name order, so each one works on chats the others leave alone.
final class FlowTests: XCTestCase {
    /// The test server's key: it guards nothing but the test.
    static let link = "apim://pair?v=1&n=MOCK-PC&p=47199&h=127.0.0.1&k=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

    /// The app the test launched, for what it shows when the test fails.
    private var app: XCUIApplication?

    override func setUp() {
        continueAfterFailure = false
    }

    /// A failed test leaves the screen it stopped on, and what the app said was on it.
    override func tearDown() {
        if let run = testRun, run.failureCount > 0 {
            shot("x-" + name.split(separator: " ").last!.dropLast())
            if let app { print("apim-tree \(name):\n\(app.debugDescription)") }
        }
    }

    private func launch(paired: Bool, link: String = FlowTests.link) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-reset"]
        if paired {
            app.launchEnvironment["APIM_PAIR"] = link
        }
        app.launch()
        self.app = app
        return app
    }

    /// Kept in the results, and written straight to the Mac running the simulator (`~/apim-shots/<light|dark>/`,
    /// as fastlane's snapshot does) so the CI job can upload the pictures without digging them out of the bundle.
    private func shot(_ name: String) {
        // Animations settle first: a picture mid-spring says nothing about how it looks.
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
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

    /// Anything showing these words, in any case (a list's section headers are capitals): a text, or a button or
    /// row whose label holds them.
    private func text(_ app: XCUIApplication, _ fragment: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", fragment)).firstMatch
    }

    private func button(_ app: XCUIApplication, _ fragment: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", fragment)).firstMatch
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// Scrolls until it is on screen: a list draws only the rows near what it shows.
    private func reach(_ app: XCUIApplication, _ target: XCUIElement, down: Bool = false, fast: Bool = false, tries: Int = 6) {
        for _ in 0..<tries where !(target.exists && target.isHittable) {
            // A flick a reader gives a long chat, a few thousand points a second.
            let velocity: XCUIGestureVelocity = fast ? XCUIGestureVelocity(rawValue: 5000) : .default
            if down { app.swipeDown(velocity: velocity) } else { app.swipeUp(velocity: velocity) }
        }
    }

    private func see(_ app: XCUIApplication, _ fragment: String, timeout: TimeInterval = 30, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(text(app, fragment).waitForExistence(timeout: timeout), "never saw \u{201c}\(fragment)\u{201d}", file: file, line: line)
    }

    /// On screen above the message box, not only somewhere in the transcript: the test passed once while the
    /// approval card sat out of sight under the box.
    private func inView(_ app: XCUIApplication, _ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        let box = self.element(app, "composer")
        // The chat auto-scrolls the newest content above the composer; on the slow dark screenshot run (the whole
        // suite re-run without building) that settle can take several seconds, so wait well past it.
        let deadline = Date().addingTimeInterval(12)
        while Date() < deadline {
            if element.exists, element.frame.minY > 80, element.frame.maxY <= box.frame.minY {
                return
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        XCTFail("\(element.label) is at \(element.frame), out of view above the message box at \(box.frame)", file: file, line: line)
    }

    private func type(_ app: XCUIApplication, _ words: String) {
        let box = element(app, "composer")
        XCTAssertTrue(box.waitForExistence(timeout: 5))
        box.tap()
        box.typeText(words)
        let send = app.buttons["Send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertTrue(send.isEnabled, "Send stays off while offline or empty")
        send.tap()
    }

    /// The drawer, by its button.
    private func chats(_ app: XCUIApplication) {
        app.buttons["Chats"].tap()
        XCTAssertTrue(app.textFields["Search chats"].waitForExistence(timeout: 5))
    }

    func testChatActions() {
        let app = launch(paired: true)
        see(app, "The loop comes from")
        chats(app)

        // Hold a chat for its menu, and rename it.
        let row = button(app, "Center a div, properly")
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Rename"].waitForExistence(timeout: 5))
        shot("13-chat-menu")
        app.buttons["Rename"].tap()
        let field = app.alerts.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40) + "Centering, properly")
        app.alerts.buttons["Rename"].tap()
        see(app, "Centering, properly")

        // Swipe one away into the archive, and find it there.
        let other = button(app, "Rust lifetimes, explained simply")
        XCTAssertTrue(other.waitForExistence(timeout: 5))
        other.swipeLeft()
        XCTAssertTrue(app.buttons["Archive"].waitForExistence(timeout: 5))
        shot("14-swipe-actions")
        app.buttons["Archive"].tap()
        let archive = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Archived")).firstMatch
        XCTAssertTrue(archive.waitForExistence(timeout: 10))
        archive.tap()
        see(app, "Rust lifetimes, explained simply")
        see(app, "Old project notes")
        shot("15-archived")
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

        // The pictures in it: the one attached to the question opens full screen.
        app.swipeDown()
        app.swipeDown()
        let picture = element(app, "picture")
        XCTAssertTrue(picture.waitForExistence(timeout: 10))
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        shot("02b-pictures")
        picture.tap()
        XCTAssertTrue(element(app, "viewer").waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Close"].waitForExistence(timeout: 5))
        shot("12-viewer")
        app.buttons["Close"].tap()

        // Hold a question to ask it again in other words.
        let question = text(app, "The login page keeps redirecting")
        XCTAssertTrue(question.waitForExistence(timeout: 5))
        question.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Edit"].waitForExistence(timeout: 5))
        shot("16-message-menu")
        app.buttons["Edit"].tap()
        see(app, "Editing")
        shot("17-editing")
        app.buttons["Cancel editing"].tap()

        // The chats, newest first, by day.
        chats(app)
        see(app, "Plan a weekend in Lisbon")
        see(app, "Yesterday")
        shot("03-chats")
        button(app, "Plan a weekend in Lisbon").tap()
        see(app, "Alfama")
        shot("04-other-chat")
        chats(app)
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

        // Stop while it waits; the reply can be carried on.
        type(app, "Run it again")
        XCTAssertTrue(app.buttons["Allow"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Stop"].waitForExistence(timeout: 5))
        app.buttons["Stop"].tap()
        see(app, "Stopped.")
        see(app, "This reply stopped before it finished")
        XCTAssertFalse(app.buttons["Allow"].exists, "the card goes with the reply")
        shot("18-stopped")

        // A new chat starts empty.
        app.buttons["New chat"].tap()
        see(app, "Whatever you send here runs in apiM on MOCK-PC")
        shot("09-new-chat")
    }

    /// A swipe right from the left half of the screen opens the chats, a swipe left closes them.
    func testDrawerSwipe() {
        let app = launch(paired: true)
        see(app, "MOCK-PC")
        let left = app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.45))
        let right = app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.45))
        left.press(forDuration: 0.05, thenDragTo: right, withVelocity: .fast, thenHoldForDuration: 0)
        XCTAssertTrue(app.textFields["Search chats"].waitForExistence(timeout: 5), "the swipe opened the chats")
        shot("19-drawer-swipe")
        right.press(forDuration: 0.05, thenDragTo: left, withVelocity: .fast, thenHoldForDuration: 0)
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: app.textFields["Search chats"])
        waitForExpectations(timeout: 5)
    }

    /// A long chat opens at its end; its start comes when asked for.
    func testLongChat() {
        let app = launch(paired: true)
        see(app, "MOCK-PC")
        chats(app)
        let row = button(app, "Database migration, step by step")
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        let tapped = Date()
        row.tap()
        see(app, "Step 119 of the migration")
        // Read in the CI log: how long a chat of 240 messages takes from the tap to its end on screen, the round
        // trip to the test server included.
        print("apim-timing: long chat shown \(Int(Date().timeIntervalSince(tapped) * 1000)) ms after the tap")
        shot("20-long-chat")

        // Opened again, it is on screen from what the phone kept, before the computer answers.
        chats(app)
        button(app, "Fix the login redirect loop").tap()
        see(app, "The loop comes from")
        chats(app)
        let again = Date()
        button(app, "Database migration, step by step").tap()
        see(app, "Step 119 of the migration")
        print("apim-timing: long chat shown again \(Int(Date().timeIntervalSince(again) * 1000)) ms after the tap")
        let earlier = element(app, "earlier")
        reach(app, earlier, down: true, fast: true, tries: 30)
        XCTAssertTrue(earlier.waitForExistence(timeout: 5))
        see(app, "160 earlier messages")
        earlier.tap()
        // The message that was first stays in view; the button, with what is still left, is above it.
        see(app, "Step 80: what should the migration do next?")
        reach(app, earlier, down: true, fast: true, tries: 30)
        see(app, "80 earlier messages")
        shot("21-earlier")
    }

    func testModelAndEffort() {
        let app = launch(paired: true)
        see(app, "MOCK-PC")

        // The model menu, as the computer has it.
        let model = element(app, "model")
        XCTAssertTrue(model.waitForExistence(timeout: 10))
        model.tap()
        see(app, "DeepSeek V4 Flash")
        reach(app, text(app, "Your models"))
        see(app, "Your models")
        shot("22-models")
        button(app, "DeepSeek V4 Flash").tap()
        see(app, "MOCK-PC · DeepSeek V4 Flash")

        // Its effort: Auto, then a depth on the slider.
        let effort = element(app, "effort")
        XCTAssertTrue(effort.waitForExistence(timeout: 10))
        effort.tap()
        XCTAssertTrue(app.switches["effort-auto"].waitForExistence(timeout: 5))
        shot("23-effort-auto")
        // On the switch itself: the middle of the row is its label, which does not toggle it.
        app.switches["effort-auto"].coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        see(app, "Deep reasoning for complex problems")
        shot("24-effort-high")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()

        // The web and computer switches.
        let tools = element(app, "tools")
        XCTAssertTrue(tools.waitForExistence(timeout: 5))
        tools.tap()
        XCTAssertTrue(app.buttons["Use the computer"].waitForExistence(timeout: 5))
        shot("25-tools")
        app.buttons["Use the computer"].tap()
    }

    func testPairingScreen() {
        let app = launch(paired: false)
        XCTAssertTrue(app.buttons["Scan code"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Paste pairing link"].exists)
        shot("01-pair")
    }

    /// The computer's settings, changed from the phone, and the phone's own.
    func testSettings() {
        let app = launch(paired: true)
        see(app, "MOCK-PC")
        app.buttons["connection"].tap()
        see(app, "Web search")
        shot("11-settings")
        let frugal = button(app, "Frugal")
        reach(app, frugal)
        frugal.tap()
        reach(app, text(app, "Running commands"))
        see(app, "Running commands")
        reach(app, text(app, "API keys"))
        see(app, "API keys")
        shot("26-settings-more")
        reach(app, app.buttons["Unpair this phone"])
        XCTAssertTrue(app.buttons["Unpair this phone"].waitForExistence(timeout: 5))
        see(app, "127.0.0.1:47199")
        shot("27-settings-phone")
        app.buttons["Done"].tap()
    }
}
