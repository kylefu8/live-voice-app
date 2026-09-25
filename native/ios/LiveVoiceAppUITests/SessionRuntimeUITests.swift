import XCTest

final class SessionRuntimeUITests: XCTestCase {
  func testDiagnosticBridge() {
    XCTAssertTrue(app.buttons["Check diagnostics"].waitForExistence(timeout: 20))
    app.buttons["Check diagnostics"].tap()
    XCTAssertTrue(app.staticTexts["Diagnostics exercised"].waitForExistence(timeout: 10))
  }
  private let app = XCUIApplication(bundleIdentifier: "com.kylefu.livevoice")

  override func setUpWithError() throws {
    continueAfterFailure = false
    app.launch()
    guard waitForLabel("Session UI harness", timeout: 8) else {
      throw XCTSkip("The simulator is running the product UI, not the session harness.")
    }
  }

  override func tearDownWithError() throws {
    // Keep a failed test from leaving a synthetic Live Activity behind.
    app.activate()
    let end = app.buttons["End activity"]
    if end.waitForExistence(timeout: 2) && end.isHittable {
      end.tap()
      _ = waitForLabel("Activity ended", timeout: 2)
    }
    try super.tearDownWithError()
  }

  func testTranscriptFollowing() throws {
    let transcript = element(identifier: "transcript-harness")
    XCTAssertTrue(waitUntil { transcript.exists }, "Transcript ScrollView is missing")

    let line49 = element(identifier: "transcript-line-49")
    XCTAssertTrue(waitForHittable(line49), "Initial newest line is not visible")

    tap(button: "Append line")
    let line50 = element(identifier: "transcript-line-50")
    XCTAssertTrue(waitForHittable(line50), "The first appended line did not follow")

    transcript.swipeDown()
    XCTAssertTrue(
      waitUntil { !line50.isHittable },
      "The transcript did not leave the newest line after a manual swipe",
    )
    var anchor: XCUIElement?
    let candidates = (0..<50).map { element(identifier: "transcript-line-\($0)") }
    XCTAssertTrue(
      waitUntil {
        anchor = candidates.first(where: { $0.exists && $0.isHittable })
        return anchor != nil
      },
      "Could not establish a manual-scroll anchor",
    )
    let retainedAnchor = try XCTUnwrap(anchor)

    tap(button: "Append line")
    let line51 = element(identifier: "transcript-line-51")
    XCTAssertTrue(waitUntil { line51.exists }, "The second appended line is missing")
    XCTAssertTrue(
      waitUntil { !line51.isHittable },
      "Appending while manually scrolled unexpectedly followed the newest line",
    )
    XCTAssertTrue(
      waitForHittable(retainedAnchor),
      "The user's transcript position was not retained",
    )

    for _ in 0..<8 {
      if line51.isHittable { break }
      transcript.swipeUp()
      _ = waitUntil { line51.isHittable }
    }
    XCTAssertTrue(waitForHittable(line51), "Could not return to the newest line")
    // A line can be partially hittable before reaching the actual scroll limit.
    // Scroll through the final line and bottom padding, as a user reaching the bottom does.
    transcript.swipeUp()

    tap(button: "Append line")
    let line52 = element(identifier: "transcript-line-52")
    XCTAssertTrue(
      waitForHittable(line52),
      "Live follow did not resume after returning to the bottom",
    )
  }

  func testLiveActivity() throws {
    tap(button: "Start activity")
    let started = app.staticTexts["Activity started"]
    let unavailable = app.staticTexts["Activity unavailable"]
    XCTAssertTrue(
      waitUntil { started.exists || unavailable.exists },
      "The harness did not report ActivityKit availability",
    )
    XCTAssertFalse(
      unavailable.exists,
      "ActivityKit was unavailable; the simulator activity test cannot verify a started activity",
    )
    XCTAssertTrue(started.exists, "The harness did not start the activity")

    // Keep this as a real SpringBoard transition after the activity started.
    XCUIDevice.shared.press(.home)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    XCTAssertTrue(waitUntil { springboard.exists }, "SpringBoard did not appear")
    XCTAssertTrue(waitUntil { self.app.state == .runningBackground }, "App did not enter the background")
    RunLoop.current.run(until: Date().addingTimeInterval(1))
    let screenshot = XCTAttachment(screenshot: springboard.screenshot())
    screenshot.name = "springboard-after-session-activity"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    RunLoop.current.run(until: Date().addingTimeInterval(2))
    let later = XCTAttachment(screenshot: springboard.screenshot())
    later.name = "session-activity-timer-after-two-seconds"
    later.lifetime = .keepAlways
    add(later)

    app.activate()
    tap(button: "End activity")
    XCTAssertTrue(waitForLabel("Activity ended"), "The harness did not end the activity")
  }

  private func element(identifier: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: identifier).firstMatch
  }

  private func tap(button label: String) {
    let button = app.buttons[label]
    XCTAssertTrue(button.waitForExistence(timeout: 5), "Missing harness button: \(label)")
    XCTAssertTrue(button.isHittable, "Harness button is not hittable: \(label)")
    button.tap()
  }

  @discardableResult
  private func waitForLabel(_ label: String, timeout: TimeInterval = 8) -> Bool {
    let candidate = app.descendants(matching: .any).matching(
      NSPredicate(format: "label == %@", label)
    ).firstMatch
    return waitUntil(timeout: timeout) { candidate.exists }
  }

  private func waitForHittable(_ element: XCUIElement, timeout: TimeInterval = 8) -> Bool {
    waitUntil(timeout: timeout) { element.exists && element.isHittable }
  }

  private func waitUntil(
    timeout: TimeInterval = 8,
    _ condition: @escaping () -> Bool,
  ) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return true }
      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    return condition()
  }
}
