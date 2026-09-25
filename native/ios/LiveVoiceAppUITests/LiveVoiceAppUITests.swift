import XCTest

final class LiveVoiceAppUITests: XCTestCase {
  // Run only with SettingsLockHarness.tsx: no real service or microphone.
  func testInCallSettingsLocks() throws {
    guard app.staticTexts["Settings lock harness"].exists else {
      throw XCTSkip("Requires isolated settings harness")
    }
    tap(label: "开始对话")
    XCTAssertTrue(waitForLabel("已连接，可以自然交流"))
    tap(label: "对话设置")
    XCTAssertFalse(app.buttons["保存"].exists)
    XCTAssertFalse(app.buttons["保存并应用"].exists)
    let voice = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "音色:")).firstMatch
    XCTAssertTrue(voice.exists)
    XCTAssertFalse(voice.isEnabled)
    openSettingsRow("语气")
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "温暖")).firstMatch.tap()
    XCTAssertTrue(scrollUntilVisible("自动保存对话录音"))
    XCTAssertTrue(waitForLabel("已自动保存并应用"))
    XCTAssertTrue(waitForLabel("Applied: warm | "))
    let header = XCTAttachment(screenshot: app.screenshot()); header.name = "autosave-active"; header.lifetime = .keepAlways; add(header)
    XCTAssertTrue(waitForLabel("录音开关在会话结束后可修改，当前录音保持不变。"))
    let recording = app.switches["自动保存对话录音"]
    let before = recording.value as? String
    recording.tap()
    XCTAssertEqual(recording.value as? String, before)
    let locked = XCTAttachment(screenshot: app.screenshot())
    locked.name = "locked-recording"
    locked.lifetime = .keepAlways
    add(locked)
    tap(label: "返回")
    XCTAssertTrue(waitForLabel("已连接，可以自然交流"))
    tap(label: "结束")
    tap(label: "设置")
    openSettingsRow("对话设置")
    XCTAssertTrue(voice.isEnabled)
    XCTAssertTrue(scrollUntilVisible("自动保存对话录音"))
    XCTAssertTrue(app.switches["自动保存对话录音"].isEnabled)
    app.switches["自动保存对话录音"].tap()
    XCTAssertNotEqual(app.switches["自动保存对话录音"].value as? String, before)
  }
  func testSourcesCollapsedAndBounded() throws {
    guard app.staticTexts["Settings lock harness"].exists else { throw XCTSkip("Requires isolated harness") }
    tap(label: "开始对话")
    XCTAssertTrue(waitForLabel("已连接，可以自然交流"))
    let settingsButton = app.buttons["对话设置"]
    let muteButton = app.buttons["静音"]
    let endButton = app.buttons["结束"]
    XCTAssertTrue(settingsButton.isHittable)
    XCTAssertLessThan(settingsButton.frame.midX, muteButton.frame.midX)
    XCTAssertLessThan(muteButton.frame.midX, endButton.frame.midX)
    XCTAssertEqual(settingsButton.frame.midY, muteButton.frame.midY, accuracy: 2)
    XCTAssertEqual(muteButton.frame.midY, endButton.frame.midY, accuracy: 2)
    XCTAssertFalse(app.buttons["收起字幕"].exists)
    XCTAssertFalse(app.buttons["展开字幕"].exists)
    let toggle = app.buttons["search-sources-toggle"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 5))
    XCTAssertTrue(toggle.label.contains("12"))
    XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "search-sources-list").firstMatch.exists)
    // Inspect screenshot too: selectable RN text may be exposed as a text view.
    toggle.tap()
    let evidence = XCTAttachment(screenshot: app.screenshot()); evidence.name = "sources-inspect"; evidence.lifetime = .keepAlways; add(evidence)
    let tree = XCTAttachment(string: app.debugDescription); tree.name = "sources-tree"; tree.lifetime = .keepAlways; add(tree)
    let list = app.descendants(matching: .any).matching(identifier: "search-sources-list").firstMatch
    XCTAssertTrue(list.waitForExistence(timeout: 5))
    XCTAssertLessThanOrEqual(list.frame.height, 161)
    // Inspect screenshot too: selectable RN text may be exposed as a text view.
    let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "sources-expanded"; shot.lifetime = .keepAlways; add(shot)
    toggle.tap()
    XCTAssertFalse(list.exists)
    let folded = XCTAttachment(screenshot: app.screenshot()); folded.name = "sources-collapsed"; folded.lifetime = .keepAlways; add(folded)
    tap(label: "结束")
    tap(label: "回到首页")
    tap(label: "开始对话")
    XCTAssertTrue(toggle.waitForExistence(timeout: 5))
    XCTAssertFalse(list.exists)
  }

  func testAutomaticPreferenceApplyAndRetry() throws {
    guard app.staticTexts["Settings lock harness"].exists else { throw XCTSkip("Requires isolated harness") }
    tap(label: "开始对话")
    XCTAssertTrue(waitForLabel("已连接，可以自然交流"))
    tap(label: "对话设置")
    openSettingsRow("语气")
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "温暖")).firstMatch.tap()
    XCTAssertTrue(waitForLabel("Applied: warm | "))
    let instructions = app.textViews["自定义指令"]
    XCTAssertTrue(instructions.exists)
    instructions.tap()
    instructions.typeText("Keep answers brief.")
    tap(label: "返回")
    XCTAssertTrue(waitForLabel("已连接，可以自然交流"))
    XCTAssertTrue(waitForLabel("Applied: warm | Keep answers brief."))
    tap(label: "对话设置")
    instructions.tap()
    // Wait for each native text edit before the next synthesized keystroke.
    // Bulk XCTest typing can reorder characters in a controlled RN input.
    for character in "FAIL_ONCE" { instructions.typeText(String(character)) }
    XCTAssertTrue((instructions.value as? String)?.contains("FAIL_ONCE") == true)
    let retry = app.buttons["重试更新"]
    let showedError = retry.waitForExistence(timeout: 12)
    let failureShot = XCTAttachment(screenshot: app.screenshot()); failureShot.name = "autosave-failure"; failureShot.lifetime = .keepAlways; add(failureShot)
    let failureTree = XCTAttachment(string: app.debugDescription); failureTree.name = "autosave-failure-tree"; failureTree.lifetime = .keepAlways; add(failureTree)
    XCTAssertTrue(showedError)
    tap(label: "重试更新")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Applied: warm |", "FAIL_ONCE")).firstMatch.waitForExistence(timeout: 10))
    XCTAssertTrue(waitForLabel("已自动保存并应用"))
    tap(label: "返回")
    XCTAssertTrue(waitForLabel("已连接，可以自然交流"))
    tap(label: "结束")
  }

  private let app = XCUIApplication(bundleIdentifier: "com.kylefu.livevoice")

  func testBilingualDocumentationScreens() throws {
    guard app.staticTexts["演示数据 / Demo data"].exists else { throw XCTSkip("Requires isolated documentation harness") }
    for chinese in [true, false] {
      func label(_ zh: String, _ en: String) -> String { chinese ? zh : en }
      func capture(_ page: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "docs-mobile-" + page + (chinese ? "-zh" : "-en")
        shot.lifetime = .keepAlways
        add(shot)
      }
      if !chinese { tap(label: "EN") }
      XCTAssertTrue(waitForLabel(label("面向 GPT-Live-1 模型的实时语音客户端", "A real-time voice client for the GPT-Live-1 model")))
      capture("home")
      tap(label: label("设置", "Settings"))
      capture("settings")
      openSettingsRow(label("连接管理", "Connections"))
      XCTAssertTrue(waitForLabel(label("语音连接用于 GPT-Live-1 模型，后端 LLM 单独配置。首次使用可扫码导入，也可手动编辑并测试。", "The voice connection is for GPT-Live-1; configure the backend LLM separately. Import a QR code or edit and test manually for first-time setup.")))
      if !labelElement("Endpoint").exists { openSettingsRow(label("语音模型连接", "Voice connection")) }
      XCTAssertTrue(waitForLabel("Endpoint"))
      capture("connections")
      tap(label: label("返回", "Back"))
      openSettingsRow(label("对话设置", "Conversation settings"))
      capture("preferences")
      let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label("后端推理参数:", "Backend reasoning:"))).firstMatch
      for _ in 0..<6 { if row.isHittable { break }; app.swipeUp() }
      XCTAssertTrue(row.isHittable)
      row.tap()
      capture("backend")
      tap(label: label("返回", "Back"))
      tap(label: label("返回", "Back"))
      tap(label: label("历史", "History"))
      capture("history")
      tap(label: label("对话", "Conversation"))
    }
  }

  func testEdgeBackPreservesConversationAndDraft() throws {
    guard app.staticTexts["Settings lock harness"].exists else { throw XCTSkip("Requires isolated harness") }
    func drag(fromX: CGFloat, toX: CGFloat, y: CGFloat = 0.42) {
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: fromX, dy: y))
      let end = app.coordinate(withNormalizedOffset: CGVector(dx: toX, dy: y))
      start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
    }
    tap(label: "设置")
    openSettingsRow("对话设置")
    // A short edge drag cancels; a horizontal drag in the form is not back.
    drag(fromX: 0.02, toX: 0.08)
    XCTAssertTrue(app.textViews["自定义指令"].exists)
    drag(fromX: 0.35, toX: 0.85, y: 0.20)
    XCTAssertTrue(app.textViews["自定义指令"].exists)
    drag(fromX: 0.02, toX: 0.65)
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "连接管理:")).firstMatch.waitForExistence(timeout: 5))
    drag(fromX: 0.02, toX: 0.65)
    tap(label: "开始对话")
    XCTAssertTrue(waitForLabel("已连接，可以自然交流"))
    tap(label: "对话设置")
    let instructions = app.textViews["自定义指令"]
    instructions.tap()
    instructions.typeText("Edge back draft.")
    drag(fromX: 0.02, toX: 0.65)
    XCTAssertTrue(waitForLabel("已连接，可以自然交流"))
    XCTAssertTrue(waitForLabel("Applied: natural | Edge back draft."))
    tap(label: "结束")
  }

  override func setUpWithError() throws {
    continueAfterFailure = false
    app.launch()
    XCTAssertNotNil(
      waitForAnyLabel(["设置", "Settings", "想聊什么？", "What’s on your mind?"]),
      "Live Voice did not become ready"
    )
  }

  func testSettingsHistoryAboutAndLanguageSwitch() throws {
    let settingsLabel = try XCTUnwrap(
      existingLabel(["设置", "Settings"]),
      "The settings tab is not available"
    )
    let initialLocaleIsChinese = settingsLabel == "设置"
    tap(label: settingsLabel)

    let settingsTitle = initialLocaleIsChinese ? "设置" : "Settings"
    XCTAssertTrue(waitForLabel(settingsTitle), "Settings page did not open")

    XCTAssertTrue(
      scrollUntilVisible("kylefu8"),
      "The author information is not visible in Settings"
    )
    XCTAssertTrue(
      scrollUntilVisible("https://github.com/kylefu8/live-voice-app"),
      "The repository information is not visible in Settings"
    )

    let historyLabel = initialLocaleIsChinese ? "历史" : "History"
    tap(label: historyLabel)
    let historyTitle = initialLocaleIsChinese ? "历史会话" : "History"
    XCTAssertTrue(waitForLabel(historyTitle), "History page did not open")

    tap(label: settingsLabel)
    XCTAssertTrue(waitForLabel(settingsTitle), "Could not return to Settings")

    let switchToLabel = initialLocaleIsChinese ? "EN" : "中文"
    XCTAssertTrue(
      tapIfPresent(label: switchToLabel),
      "The language switch control is not available"
    )
    XCTAssertTrue(
      waitForLabel(initialLocaleIsChinese ? "Settings" : "设置"),
      "The interface did not switch language"
    )

    let restoreLabel = initialLocaleIsChinese ? "中文" : "EN"
    XCTAssertTrue(
      tapIfPresent(label: restoreLabel),
      "The language switch could not restore the saved locale"
    )
    XCTAssertTrue(waitForLabel(settingsTitle), "The saved locale was not restored")
  }

  func testRecordingPreferencePersistsAcrossLaunch() throws {
    let settingsLabel = try XCTUnwrap(existingLabel(["设置", "Settings"]))
    let chinese = settingsLabel == "设置"
    let label = chinese ? "自动保存对话录音" : "Automatically record conversations"
    tap(label: settingsLabel)
    openSettingsRow(chinese ? "对话设置" : "Conversation settings")
    XCTAssertTrue(scrollUntilVisible(label))
    let toggle = app.switches.matching(NSPredicate(format: "label == %@", label)).firstMatch
    XCTAssertTrue(toggle.waitForExistence(timeout: 10))
    let previous = try XCTUnwrap(toggle.value as? String)
    let next = previous == "1" ? "0" : "1"
    toggle.tap()
    let changed = NSPredicate(format: "value == %@", next)
    expectation(for: changed, evaluatedWith: toggle)
    waitForExpectations(timeout: 10)
    app.terminate()
    app.launch()
    tap(label: settingsLabel)
    openSettingsRow(chinese ? "对话设置" : "Conversation settings")
    XCTAssertTrue(scrollUntilVisible(label))
    XCTAssertTrue(toggle.waitForExistence(timeout: 10))
    XCTAssertEqual(toggle.value as? String, next)
    toggle.tap()
    expectation(for: NSPredicate(format: "value == %@", previous), evaluatedWith: toggle)
    waitForExpectations(timeout: 10)
  }

  func testSeparatedConnectionAndConversationSettings() throws {
    tap(label: try XCTUnwrap(existingLabel(["设置", "Settings"])))
    // Exercise both locales without network calls or real credentials.
    for chinese in [true, false] {
      if chinese && labelElement("中文").exists { tap(label: "中文") }
      if !chinese && labelElement("EN").exists { tap(label: "EN") }
      func label(_ zh: String, _ en: String) -> String { chinese ? zh : en }
      tap(label: label(chinese ? "浅色" : "深色", chinese ? "Light" : "Dark"))
      let menu = XCTAttachment(screenshot: app.screenshot())
      menu.name = chinese ? "settings-entry-zh" : "settings-entry-en"
      menu.lifetime = .keepAlways
      add(menu)
      openSettingsRow(label("连接管理", "Connections"))
      XCTAssertTrue(waitForLabel(label("连接管理", "Connections")))
      for title in [label("扫码导入连接", "Import connections from QR"),
                    label("语音模型连接", "Voice connection"),
                    label("后端模型连接", "Backend connection")] {
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title + ":")).firstMatch.exists)
      }
      XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label("音色", "Voice") + ":")).firstMatch.exists)
      let connections = XCTAttachment(screenshot: app.screenshot())
      connections.name = chinese ? "connections-zh" : "connections-en-dark"
      connections.lifetime = .keepAlways
      add(connections)
      openSettingsRow(label("语音模型连接", "Voice connection"))
      XCTAssertTrue(waitForLabel("Endpoint"))
      openSettingsRow(label("语音模型连接", "Voice connection"))
      tap(label: label("返回", "Back"))
      openSettingsRow(label("对话设置", "Conversation settings"))
      XCTAssertTrue(waitForLabel(label("对话设置", "Conversation settings")))
      XCTAssertFalse(labelElement("Endpoint").exists)
      XCTAssertFalse(labelElement("API key").exists)
      openSettingsRow(label("语气", "Tone"))
      app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label("自然", "Natural"))).firstMatch.tap()
      let preferences = XCTAttachment(screenshot: app.screenshot())
      preferences.name = chinese ? "conversation-settings-zh" : "conversation-settings-en-dark"
      preferences.lifetime = .keepAlways
      add(preferences)
      XCTAssertFalse(app.buttons[label("保存", "Save")].exists)
      XCTAssertTrue(waitForLabel(label("已自动保存，下次会话使用", "Saved for the next conversation")))
      let backend = label("后端推理参数", "Backend reasoning")
      let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", backend + ":")).firstMatch
      for _ in 0..<5 { if row.isHittable { break }; app.swipeUp() }
      XCTAssertTrue(row.isHittable)
      let entry = XCTAttachment(screenshot: app.screenshot())
      entry.name = chinese ? "backend-entry-zh" : "backend-entry-en"
      entry.lifetime = .keepAlways
      add(entry)
      row.tap()
      XCTAssertTrue(waitForLabel(backend))
      XCTAssertFalse(labelElement("Endpoint").exists)
      tap(label: label("返回", "Back"))
      XCTAssertTrue(waitForLabel(label("对话设置", "Conversation settings")))
      tap(label: label("返回", "Back"))
      XCTAssertTrue(waitForLabel(label("设置", "Settings")))
    }
    tap(label: "中文")
    tap(label: "跟随系统")
  }

  private func openSettingsRow(_ title: String) {
    let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title + ":")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    XCTAssertTrue(row.isHittable)
    row.tap()
  }

  // Seed the three synthetic ui-history-* rows in the simulator before running.
  func testShortSwipeRemainsOpen() throws {
    tap(label: try XCTUnwrap(existingLabel(["历史", "History"])))
    let row = app.buttons["history-row-ui-history-audio"]
    guard row.waitForExistence(timeout: 5) else { throw XCTSkip("Seed synthetic history fixtures first.") }
    // A normal short swipe is much shorter than half of three action buttons.
    let start = row.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
    let end = row.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: 0.55))
    start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
    let rename = app.buttons["history-swipe-ui-history-audio-rename"]
    XCTAssertTrue(rename.waitForExistence(timeout: 5))
    for _ in 0..<8 {
      RunLoop.current.run(until: Date().addingTimeInterval(0.25))
      XCTAssertTrue(rename.isHittable, "Actions collapsed after the finger was released")
    }
    rename.tap()
    XCTAssertNotNil(waitForAnyLabel(["修改会话名称", "Rename conversation"]))
  }

  func testHistorySwipeActions() throws {
    let historyLabel = try XCTUnwrap(existingLabel(["历史", "History"]))
    let chinese = historyLabel == "历史"
    func label(_ zh: String, _ en: String) -> String { chinese ? zh : en }
    func row(_ suffix: String) -> XCUIElement { app.buttons["history-row-ui-history-\(suffix)"] }
    tap(label: historyLabel)
    guard row("text").waitForExistence(timeout: 5) else {
      throw XCTSkip("Synthetic history fixtures have not been seeded in this simulator.")
    }
    XCTAssertFalse(app.buttons["history-swipe-ui-history-text-rename"].exists)
    row("text").swipeLeft()
    XCTAssertFalse(app.buttons["history-swipe-ui-history-text-audio"].exists)
    let rename = app.buttons["history-swipe-ui-history-text-rename"]
    XCTAssertTrue(rename.waitForExistence(timeout: 5))
    rename.tap()
    let field = app.textFields[label("会话名称", "Conversation name")]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (field.value as? String ?? "").count) + "UI renamed")
    tap(label: label("保存名称", "Save name"))
    XCTAssertTrue(row("text").waitForExistence(timeout: 5))
    XCTAssertTrue(row("text").label.contains("UI renamed"))

    row("text").swipeLeft()
    row("audio").swipeLeft()
    XCTAssertFalse(app.buttons["history-swipe-ui-history-text-rename"].exists)
    let deleteAudio = app.buttons["history-swipe-ui-history-audio-audio"]
    XCTAssertTrue(deleteAudio.waitForExistence(timeout: 5))
    deleteAudio.tap()
    XCTAssertTrue(waitForLabel(label("确认删除录音", "Confirm recording deletion")))
    tap(label: label("返回", "Back"))
    XCTAssertTrue(row("audio").waitForExistence(timeout: 5))
    row("audio").swipeLeft()
    XCTAssertTrue(deleteAudio.waitForExistence(timeout: 5))
    deleteAudio.tap()
    tap(label: label("确认删除录音", "Delete recording"))
    XCTAssertTrue(row("audio").waitForExistence(timeout: 5))
    row("audio").swipeLeft()
    XCTAssertTrue(app.buttons["history-swipe-ui-history-audio-rename"].waitForExistence(timeout: 5))
    XCTAssertFalse(deleteAudio.exists)
    row("audio").tap()
    XCTAssertFalse(app.buttons["history-swipe-ui-history-audio-rename"].exists)

    row("delete").swipeLeft()
    let deleteRecord = app.buttons["history-swipe-ui-history-delete-delete"]
    XCTAssertTrue(deleteRecord.waitForExistence(timeout: 5))
    deleteRecord.tap()
    tap(label: label("确认删除记录", "Delete record"))
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: row("delete"))
    waitForExpectations(timeout: 10)
    XCTAssertTrue(row("audio").exists)
    XCTAssertTrue(row("text").exists)
    row("text").tap()
    XCTAssertTrue(waitForLabel("UI renamed"))
  }

  private func existingLabel(_ labels: [String]) -> String? {
    for label in labels {
      if waitForLabel(label, timeout: 2) {
        return label
      }
    }
    return nil
  }

  @discardableResult
  private func waitForLabel(_ label: String, timeout: TimeInterval = 10) -> Bool {
    waitForAnyLabel([label], timeout: timeout) != nil
  }

  private func waitForAnyLabel(
    _ labels: [String],
    timeout: TimeInterval = 10
  ) -> String? {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      for label in labels {
        if labelElement(label).exists {
          return label
        }
      }
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    return nil
  }

  private func labelElement(_ label: String) -> XCUIElement {
    let predicate = NSPredicate(format: "label == %@", label)
    let buttons = app.buttons.matching(predicate)
    // A modal Back button can share a label with the covered page header.
    if let visible = buttons.allElementsBoundByIndex.first(where: { $0.isHittable }) {
      return visible
    }
    let button = buttons.firstMatch
    if button.exists { return button }
    return app.descendants(matching: .any).matching(predicate).firstMatch
  }

  private func tap(label: String) {
    let element = labelElement(label)
    XCTAssertTrue(element.waitForExistence(timeout: 10), "Missing control: \(label)")
    XCTAssertTrue(element.isHittable, "Control is not hittable: \(label)")
    element.tap()
  }

  private func tapIfPresent(label: String) -> Bool {
    let element = labelElement(label)
    guard element.waitForExistence(timeout: 5) else { return false }
    guard element.isHittable else { return false }
    element.tap()
    return true
  }

  private func scrollUntilVisible(_ label: String) -> Bool {
    let element = labelElement(label)
    if element.waitForExistence(timeout: 2) && element.isHittable {
      return true
    }

    for _ in 0..<8 {
      app.swipeUp()
      if element.waitForExistence(timeout: 1) && element.isHittable {
        return true
      }
    }
    return false
  }
}

final class AutomaticAudioTests: XCTestCase {
  func testAutomaticRoutingBridge() throws {
    let app=XCUIApplication(bundleIdentifier: "com.kylefu.livevoice")
    app.launch()
    guard app.staticTexts["Audio routing harness"].waitForExistence(timeout: 10) else { throw XCTSkip("Requires isolated audio harness") }
    app.buttons["Verify automatic routing"].tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@", "Automatic routing bridge passed:")).firstMatch.waitForExistence(timeout:15))
  }
}
