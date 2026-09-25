import React, {
  ReactNode,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleProp,
  ViewStyle,
} from 'react-native';
import {
  beginTranscriptDrag,
  beginTranscriptMomentum,
  completeTranscriptAutoScroll,
  createTranscriptFollowState,
  endTranscriptDrag,
  endTranscriptMomentum,
  observeTranscriptUserScroll,
  onTranscriptContentSizeChange,
  onTranscriptLayout,
  type TranscriptFollowState,
} from './transcript-follow';

export type LiveTranscriptScrollProps = {
  sessionKey: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
};

function distanceFromBottom(event: NativeSyntheticEvent<NativeScrollEvent>) {
  const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent;
  return Math.max(
    0,
    contentSize.height - (contentOffset.y + layoutMeasurement.height),
  );
}

/**
 * A transcript viewport that follows the newest text until the user scrolls
 * away. A manual move up owns the viewport; reaching the bottom (within 32pt)
 * hands it back to live-follow mode.
 */
export function LiveTranscriptScroll({
  sessionKey,
  children,
  style,
  contentContainerStyle,
  testID,
}: LiveTranscriptScrollProps) {
  const scrollRef = useRef<ScrollView>(null);
  const followRef = useRef<TranscriptFollowState>(
    createTranscriptFollowState(),
  );
  const scheduledRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushAutoScroll = useCallback(() => {
    scheduledRef.current = null;
    const state = followRef.current;
    if (!state.following || state.phase !== 'idle' || !state.pendingAutoScroll)
      return;
    followRef.current = completeTranscriptAutoScroll(state);
    scrollRef.current?.scrollToEnd({animated: false});
  }, []);

  const scheduleAutoScroll = useCallback(() => {
    if (scheduledRef.current !== null) return;
    // Let React Native finish measuring the appended text before snapping.
    scheduledRef.current = setTimeout(flushAutoScroll, 0);
  }, [flushAutoScroll]);

  const applyTransition = useCallback(
    (transition: {
      state: TranscriptFollowState;
      shouldScrollToEnd: boolean;
    }) => {
      followRef.current = transition.state;
      if (transition.shouldScrollToEnd) scheduleAutoScroll();
    },
    [scheduleAutoScroll],
  );

  useEffect(() => {
    followRef.current = createTranscriptFollowState();
    scheduleAutoScroll();
    return () => {
      if (scheduledRef.current !== null) {
        clearTimeout(scheduledRef.current);
        scheduledRef.current = null;
      }
    };
  }, [scheduleAutoScroll, sessionKey]);

  return (
    <ScrollView
      ref={scrollRef}
      testID={testID}
      style={style}
      contentContainerStyle={contentContainerStyle}
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={16}
      // This keeps the user's visible item anchored if a future transcript
      // renderer prunes or inserts older turns above the viewport.
      maintainVisibleContentPosition={{minIndexForVisible: 0}}
      onScroll={event => {
        // Only a drag or momentum gesture may change follow mode. This is the
        // key distinction from scrollToEnd's own onScroll events.
        followRef.current = observeTranscriptUserScroll(
          followRef.current,
          distanceFromBottom(event),
        );
      }}
      onScrollBeginDrag={event => {
        followRef.current = beginTranscriptDrag(
          followRef.current,
          event.nativeEvent.contentOffset.y,
        );
      }}
      onScrollEndDrag={event => {
        applyTransition(
          endTranscriptDrag(
            followRef.current,
            distanceFromBottom(event),
            event.nativeEvent.contentOffset.y,
          ),
        );
      }}
      onMomentumScrollBegin={() => {
        followRef.current = beginTranscriptMomentum(followRef.current);
      }}
      onMomentumScrollEnd={event => {
        applyTransition(
          endTranscriptMomentum(
            followRef.current,
            distanceFromBottom(event),
            event.nativeEvent.contentOffset.y,
          ),
        );
      }}
      onContentSizeChange={() => {
        applyTransition(
          onTranscriptContentSizeChange(followRef.current),
        );
      }}
      onLayout={() => {
        applyTransition(onTranscriptLayout(followRef.current));
      }}
    >
      {children}
    </ScrollView>
  );
}
