import ActivityKit
import Foundation

/// The small, non-sensitive state rendered by the Live Voice Live Activity.
///
/// This file is compiled into both the application and the Widget Extension.
/// It deliberately contains no transcript, endpoint, credential, or recording
/// data.  The widget has no network access and only renders this state.
@available(iOS 16.2, *)
public struct LiveVoiceActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    public var status: String
    public var muted: Bool
    public var recording: Bool
    public var backendWorking: Bool
    public var startedAt: Date?

    public init(
      status: String,
      muted: Bool,
      recording: Bool,
      backendWorking: Bool,
      startedAt: Date?
    ) {
      self.status = status
      self.muted = muted
      self.recording = recording
      self.backendWorking = backendWorking
      self.startedAt = startedAt
    }
  }

  public let sessionID: String
  public let locale: String

  public init(sessionID: String, locale: String) {
    self.sessionID = sessionID
    self.locale = locale == "en" ? "en" : "zh"
  }
}
