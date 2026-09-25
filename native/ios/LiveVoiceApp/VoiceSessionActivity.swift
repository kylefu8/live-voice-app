import ActivityKit
import Foundation
import React
import UIKit

private let liveVoiceSessionAudioStopped = Notification.Name("LiveVoiceSessionAudioStopped")

@available(iOS 16.2, *)
@MainActor
private final class VoiceSessionActivityCoordinator {
  private struct Active {
    let identifier: String
    let activity: Activity<LiveVoiceActivityAttributes>
    var state: LiveVoiceActivityAttributes.ContentState
    let generation: UInt64
  }

  private var active: Active?
  private var generation: UInt64 = 0
  private var refreshTask: Task<Void, Never>?
  private var tail: Task<Void, Never> = Task {}

  deinit {
    refreshTask?.cancel()
  }

  func start(identifier: String, locale: String, state: LiveVoiceActivityAttributes.ContentState) async -> Bool {
    await enqueue { [weak self] in
      guard let self else { return false }
      return await self.startNow(identifier: identifier, locale: locale, state: state)
    }
  }

  func update(
    identifier: String,
    status: String,
    muted: Bool,
    recording: Bool,
    backendWorking: Bool,
    startedAt: Date?
  ) async {
    await enqueue { [weak self] in
      guard let self else { return }
      await self.updateNow(
        identifier: identifier,
        state: LiveVoiceActivityAttributes.ContentState(
          status: status,
          muted: muted,
          recording: recording,
          backendWorking: backendWorking,
          startedAt: startedAt
        )
      )
    }
  }

  func end(identifier: String) async {
    await enqueue { [weak self] in
      guard let self else { return }
      await self.endNow(identifier: identifier)
    }
  }

  func endCurrent() async {
    await enqueue { [weak self] in
      guard let self, let active = self.active else { return }
      await self.endNow(identifier: active.identifier)
    }
  }

  func cleanupOrphans() async {
    await enqueue { [weak self] in
      guard let self, self.active == nil else { return }
      for orphan in Activity<LiveVoiceActivityAttributes>.activities {
        await orphan.end(nil, dismissalPolicy: .immediate)
      }
    }
  }

  private func enqueue<T>(_ operation: @escaping @MainActor () async -> T) async -> T {
    let previous = tail
    let task = Task { @MainActor in
      await previous.value
      return await operation()
    }
    tail = Task { @MainActor in
      _ = await task.value
    }
    return await task.value
  }

  private func startNow(identifier: String, locale: String, state: LiveVoiceActivityAttributes.ContentState) async -> Bool {
    guard !identifier.isEmpty, UIApplication.shared.applicationState == .active else {
      return false
    }
    let authorization = ActivityAuthorizationInfo()
    guard authorization.areActivitiesEnabled else { return false }

    if let active {
      // A second start can only be a stale caller. Keep the current activity
      // and let the caller observe a harmless false result.
      return active.identifier == identifier
    }

    refreshTask?.cancel()
    refreshTask = nil
    generation &+= 1

    // The app owns one conversation at a time.  If the process was relaunched
    // with an orphaned activity, remove only our old activities before starting
    // a new one.  This is intentionally local and contains no user data.
    if active == nil {
      for orphan in Activity<LiveVoiceActivityAttributes>.activities {
        await orphan.end(nil, dismissalPolicy: .immediate)
      }
    }

    // The session is already connected. The first WidgetKit snapshot contains
    // its clock, without depending on a second, potentially delayed update.
    var initialState = state
    initialState.status = "connected"
    if initialState.startedAt == nil { initialState.startedAt = Date() }
    let attributes = LiveVoiceActivityAttributes(
      sessionID: identifier,
      locale: locale
    )
    do {
      let activity = try Activity.request(
        attributes: attributes,
        content: ActivityContent(
          state: initialState,
          staleDate: Date().addingTimeInterval(90)
        ),
        pushType: nil
      )
      active = Active(
        identifier: identifier,
        activity: activity,
        state: initialState,
        generation: generation
      )
      startRefreshTimer(identifier: identifier, generation: generation)
      return true
    } catch {
      return false
    }
  }

  private func updateNow(
    identifier: String,
    state: LiveVoiceActivityAttributes.ContentState
  ) async {
    guard var active, active.identifier == identifier else { return }
    var next = state
    // Connection is a one-way transition for this activity. A queued initial
    // update must never clear a running clock or revert it to "connecting".
    if let established = active.state.startedAt {
      next.startedAt = established
      if next.status == "connecting" { next.status = active.state.status }
    } else if next.status == "connected" && next.startedAt == nil {
      next.startedAt = Date()
    }
    if active.state.status == "closing" { next.status = "closing" }
    if next == active.state { return }
    active.state = next
    self.active = active
    await active.activity.update(
      ActivityContent(state: next, staleDate: Date().addingTimeInterval(90))
    )
  }

  private func endNow(identifier: String) async {
    guard let active, active.identifier == identifier else { return }
    generation &+= 1
    refreshTask?.cancel()
    refreshTask = nil
    self.active = nil
    await active.activity.end(
      ActivityContent(state: active.state, staleDate: nil),
      dismissalPolicy: .immediate
    )
  }

  private func startRefreshTimer(identifier: String, generation: UInt64) {
    refreshTask?.cancel()
    refreshTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        do {
          try await Task.sleep(nanoseconds: 30_000_000_000)
        } catch {
          return
        }
        guard let self else { return }
        await self.refresh(identifier: identifier, generation: generation)
      }
    }
  }

  private func refresh(identifier: String, generation: UInt64) async {
    await enqueue { [weak self] in
      guard let self,
            let active = self.active,
            active.identifier == identifier,
            active.generation == generation else {
        return
      }
      await active.activity.update(ActivityContent(state: active.state, staleDate: Date().addingTimeInterval(90)))
    }
  }
}

@objc(VoiceSessionActivity)
@MainActor
final class VoiceSessionActivity: NSObject {
  private let coordinatorStorage: AnyObject?

  override init() {
    if #available(iOS 16.2, *) {
      coordinatorStorage = VoiceSessionActivityCoordinator()
    } else {
      coordinatorStorage = nil
    }
    super.init()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(audioStopped),
      name: liveVoiceSessionAudioStopped,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(applicationWillTerminate),
      name: UIApplication.willTerminateNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(applicationDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification,
      object: nil
    )
    applicationDidBecomeActive()
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  @objc static func requiresMainQueueSetup() -> Bool {
    true
  }

  @objc func invalidate() {
    NotificationCenter.default.removeObserver(self)
    audioStopped()
  }

  @objc(start:locale:state:resolver:rejecter:)
  func start(
    _ identifier: String,
    locale: String,
    state: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard #available(iOS 16.2, *),
          let coordinator = coordinatorStorage as? VoiceSessionActivityCoordinator,
          let initialState = decodeState(state), initialState.status == "connected" else {
      resolve(false)
      return
    }
    Task { @MainActor in
      resolve(await coordinator.start(identifier: identifier, locale: locale, state: initialState))
    }
  }

  @objc(update:state:resolver:rejecter:)
  func update(
    _ identifier: String,
    state: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard #available(iOS 16.2, *),
          let coordinator = coordinatorStorage as? VoiceSessionActivityCoordinator,
          let decoded = decodeState(state) else {
      resolve(nil)
      return
    }
    Task { @MainActor in
      await coordinator.update(
        identifier: identifier,
        status: decoded.status,
        muted: decoded.muted,
        recording: decoded.recording,
        backendWorking: decoded.backendWorking,
        startedAt: decoded.startedAt
      )
      resolve(nil)
    }
  }

  @available(iOS 16.2, *)
  private func decodeState(_ value: NSDictionary) -> LiveVoiceActivityAttributes.ContentState? {
    guard let status = value["status"] as? String,
          ["connecting", "connected", "closing"].contains(status) else { return nil }
    let milliseconds = (value["startedAt"] as? NSNumber)?.doubleValue
    let date = milliseconds.flatMap { $0.isFinite && $0 > 0 ? Date(timeIntervalSince1970: $0 / 1000) : nil }
    return LiveVoiceActivityAttributes.ContentState(
      status: status, muted: value["muted"] as? Bool ?? false,
      recording: value["recording"] as? Bool ?? false,
      backendWorking: value["backendWorking"] as? Bool ?? false,
      startedAt: date
    )
  }

  @objc(end:resolver:rejecter:)
  func end(
    _ identifier: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard #available(iOS 16.2, *),
          let coordinator = coordinatorStorage as? VoiceSessionActivityCoordinator else {
      resolve(nil)
      return
    }
    Task { @MainActor in
      await coordinator.end(identifier: identifier)
      resolve(nil)
    }
  }

  @objc private func audioStopped() {
    guard #available(iOS 16.2, *),
          let coordinator = coordinatorStorage as? VoiceSessionActivityCoordinator else { return }
    Task { @MainActor in
      await coordinator.endCurrent()
    }
  }

  @objc private func applicationWillTerminate() {
    guard #available(iOS 16.2, *),
          let coordinator = coordinatorStorage as? VoiceSessionActivityCoordinator else { return }
    Task { @MainActor in
      await coordinator.endCurrent()
    }
  }

  @objc private func applicationDidBecomeActive() {
    guard #available(iOS 16.2, *),
          let coordinator = coordinatorStorage as? VoiceSessionActivityCoordinator else { return }
    Task { @MainActor in
      await coordinator.cleanupOrphans()
    }
  }
}
