import ActivityKit
import SwiftUI
import WidgetKit

@available(iOS 16.2, *)
private enum LiveVoiceActivityView {
  static let appURL = URL(string: "livevoice://session")

  static func statusText(
    _ state: LiveVoiceActivityAttributes.ContentState,
    locale: String,
    isStale: Bool
  ) -> String {
    if isStale {
      return locale == "en" ? "Open app to check" : "打开应用确认状态"
    }
    if state.backendWorking {
      return locale == "en" ? "Processing" : "正在处理"
    }
    if state.muted {
      return locale == "en" ? "Muted" : "已静音"
    }
    switch state.status {
    case "connecting":
      return locale == "en" ? "Connecting" : "正在连接"
    case "closing":
      return locale == "en" ? "Finishing" : "正在结束"
    default:
      return locale == "en" ? "Live conversation" : "对话进行中"
    }
  }

  @ViewBuilder
  static func timer(_ date: Date?, locale: String) -> some View {
    if let date {
      Text(date, style: .timer)
        .monospacedDigit()
        .accessibilityLabel(locale == "en" ? "Conversation duration" : "对话时长")
    } else {
      Text(locale == "en" ? "Connecting" : "连接中")
        .lineLimit(1)
        .minimumScaleFactor(0.7)
    }
  }

  @ViewBuilder
  static func mark(_ state: LiveVoiceActivityAttributes.ContentState) -> some View {
    if state.muted {
      Image(systemName: "mic.slash")
        .font(.title3.weight(.semibold))
        .symbolRenderingMode(.hierarchical)
        .accessibilityHidden(true)
    } else {
      Image("LiveVoiceLogo")
        .renderingMode(.original)
        .resizable()
        .scaledToFit()
        .frame(width: 22, height: 22)
        .clipShape(RoundedRectangle(cornerRadius: 5))
        .accessibilityHidden(true)
    }
  }

  @ViewBuilder
  static func staleMark() -> some View {
    Image(systemName: "questionmark.circle")
      .font(.title3.weight(.semibold))
      .symbolRenderingMode(.hierarchical)
      .accessibilityHidden(true)
  }
}

@available(iOS 16.2, *)
private struct LiveVoiceActivityLockScreenView: View {
  let context: ActivityViewContext<LiveVoiceActivityAttributes>

  var body: some View {
    let state = context.state
    let locale = context.attributes.locale
    HStack(spacing: 12) {
      if context.isStale {
        LiveVoiceActivityView.staleMark()
      } else {
        LiveVoiceActivityView.mark(state)
      }
      VStack(alignment: .leading, spacing: 3) {
        Text(LiveVoiceActivityView.statusText(state, locale: locale, isStale: context.isStale))
          .font(.headline)
          .lineLimit(1)
        if !context.isStale {
          HStack(spacing: 7) {
            LiveVoiceActivityView.timer(state.startedAt, locale: locale)
              .font(.caption)
            if state.recording {
              Label(
                locale == "en" ? "Recording" : "录音中",
                systemImage: "record.circle"
              )
              .font(.caption)
              .lineLimit(1)
            }
          }
          .foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 3)
    .widgetURL(LiveVoiceActivityView.appURL)
    .activityBackgroundTint(Color.black.opacity(0.08))
    .activitySystemActionForegroundColor(.accentColor)
  }
}

@available(iOS 16.2, *)
private struct LiveVoiceActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: LiveVoiceActivityAttributes.self) { context in
      LiveVoiceActivityLockScreenView(context: context)
    } dynamicIsland: { context in
      let state = context.state
      let locale = context.attributes.locale
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          if context.isStale {
            LiveVoiceActivityView.staleMark()
          } else {
            LiveVoiceActivityView.mark(state)
          }
        }
        DynamicIslandExpandedRegion(.center) {
          Text(LiveVoiceActivityView.statusText(state, locale: locale, isStale: context.isStale))
            .font(.caption.weight(.semibold))
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.trailing) {
          if context.isStale {
            Image(systemName: "ellipsis")
          } else {
            LiveVoiceActivityView.timer(state.startedAt, locale: locale)
              .font(.caption)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack(spacing: 8) {
            if context.isStale {
              LiveVoiceActivityView.staleMark()
            } else {
              LiveVoiceActivityView.mark(state)
            }
            Text(LiveVoiceActivityView.statusText(state, locale: locale, isStale: context.isStale))
              .font(.footnote)
              .lineLimit(1)
            Spacer(minLength: 0)
            if !context.isStale && state.recording {
              Image(systemName: "record.circle")
                .accessibilityLabel(locale == "en" ? "Recording" : "录音中")
            }
            if !context.isStale {
              LiveVoiceActivityView.timer(state.startedAt, locale: locale)
                .font(.footnote)
            }
          }
        }
      } compactLeading: {
        if context.isStale {
          LiveVoiceActivityView.staleMark()
        } else {
          LiveVoiceActivityView.mark(state)
        }
      } compactTrailing: {
        if context.isStale {
          Image(systemName: "ellipsis")
        } else {
          LiveVoiceActivityView.timer(state.startedAt, locale: locale)
            .font(.caption2)
            .frame(width: 52, alignment: .trailing)
        }
      } minimal: {
        if context.isStale {
          LiveVoiceActivityView.staleMark()
        } else {
          LiveVoiceActivityView.mark(state)
        }
      }
      .widgetURL(LiveVoiceActivityView.appURL)
      .keylineTint(.accentColor)
    }
  }
}

@main
@available(iOS 16.2, *)
struct LiveVoiceActivityWidgetBundle: WidgetBundle {
  var body: some Widget {
    LiveVoiceActivityWidget()
  }
}
