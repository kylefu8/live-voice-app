import React, {
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  GestureResponderEvent,
  LayoutChangeEvent,
  PanResponder,
  PanResponderGestureState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {shouldKeepHistoryActionsOpen} from './history-swipe';

type Palette = {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  button: string;
};

export type SwipeHistoryAction = {
  id: string;
  label: string;
  onPress: () => void;
};

export type SwipeHistoryRowProps = {
  children: ReactNode;
  open: boolean;
  enabled: boolean;
  onOpenChange: (open: boolean) => void;
  onSwipeActiveChange: (active: boolean) => void;
  actions: SwipeHistoryAction[];
  palette: Palette;
};

const MAX_ACTION_WIDTH = 88;
const MIN_HORIZONTAL_DISTANCE = 12;
const HORIZONTAL_DOMINANCE = 1.5;

/**
 * A small iOS-friendly trailing-action row. It deliberately leaves tap
 * handling to the child row so a normal tap still opens the conversation.
 */
export function SwipeHistoryRow({
  children,
  open,
  enabled,
  onOpenChange,
  onSwipeActiveChange,
  actions,
  palette: p,
}: SwipeHistoryRowProps) {
  const translateX = useRef(new Animated.Value(0)).current;
  const [rowWidth, setRowWidth] = useState(0);
  const openRef = useRef(open);
  const enabledRef = useRef(enabled);
  const actionWidthRef = useRef(0);
  const draggingRef = useRef(false);
  const settlingTargetRef = useRef<boolean | null>(null);
  const gestureStartedOpenRef = useRef(false);
  const gestureStartOffsetRef = useRef(0);
  const callbacksRef = useRef({onOpenChange, onSwipeActiveChange, actions});

  openRef.current = open;
  enabledRef.current = enabled;
  callbacksRef.current = {onOpenChange, onSwipeActiveChange, actions};

  const actionWidth =
    rowWidth > 0 && actions.length > 0
      ? Math.min(rowWidth * 0.8, actions.length * MAX_ACTION_WIDTH)
      : 0;
  actionWidthRef.current = actionWidth;

  const animateTo = useCallback(
    (nextOpen: boolean) => {
      const target = nextOpen ? -actionWidthRef.current : 0;
      settlingTargetRef.current = nextOpen;
      translateX.stopAnimation();
      Animated.spring(translateX, {
        damping: 22,
        mass: 0.8,
        stiffness: 260,
        toValue: target,
        useNativeDriver: true,
      }).start(({finished}) => {
        if (finished && settlingTargetRef.current === nextOpen) {
          settlingTargetRef.current = null;
        }
      });
    },
    [translateX],
  );

  const clampOffset = useCallback((value: number) => {
    const width = actionWidthRef.current;
    return Math.max(-width, Math.min(0, value));
  }, []);

  const finishGesture = useCallback(
    (nextOpen: boolean) => {
      draggingRef.current = false;
      callbacksRef.current.onSwipeActiveChange(false);
      animateTo(nextOpen);
      callbacksRef.current.onOpenChange(nextOpen);
    },
    [animateTo],
  );

  const settleGesture = useCallback((_event: GestureResponderEvent, gesture: PanResponderGestureState) => {
    if (!draggingRef.current) return;
    finishGesture(enabledRef.current && shouldKeepHistoryActionsOpen(
      gestureStartedOpenRef.current, gesture.dx, gesture.vx, actionWidthRef.current,
    ));
  }, [finishGesture]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (
          _event: GestureResponderEvent,
          gestureState: PanResponderGestureState,
        ) => {
          if (!enabledRef.current || actionWidthRef.current <= 0) return false;
          const horizontal =
            Math.abs(gestureState.dx) > MIN_HORIZONTAL_DISTANCE &&
            Math.abs(gestureState.dx) >
              HORIZONTAL_DOMINANCE * Math.abs(gestureState.dy);
          if (!horizontal) return false;
          return openRef.current ? gestureState.dx > 0 : gestureState.dx < 0;
        },
        onMoveShouldSetPanResponderCapture: (
          _event: GestureResponderEvent,
          gestureState: PanResponderGestureState,
        ) => {
          if (!enabledRef.current || actionWidthRef.current <= 0) return false;
          const horizontal =
            Math.abs(gestureState.dx) > MIN_HORIZONTAL_DISTANCE &&
            Math.abs(gestureState.dx) >
              HORIZONTAL_DOMINANCE * Math.abs(gestureState.dy);
          if (!horizontal) return false;
          return openRef.current ? gestureState.dx > 0 : gestureState.dx < 0;
        },
        onPanResponderGrant: () => {
          if (!enabledRef.current || actionWidthRef.current <= 0) return;
          gestureStartedOpenRef.current = openRef.current;
          draggingRef.current = true;
          // Once direction is horizontal, keep the enclosing list from taking
          // over the gesture because of a small vertical wobble.
          callbacksRef.current.onSwipeActiveChange(true);
          settlingTargetRef.current = null;
          gestureStartOffsetRef.current = clampOffset(
            gestureStartedOpenRef.current ? -actionWidthRef.current : 0,
          );
          translateX.stopAnimation();
          translateX.setValue(gestureStartOffsetRef.current);
          // Let the parent close another open row as soon as this row claims
          // the gesture. The controlled prop is still the final authority.
          if (!gestureStartedOpenRef.current) {
            callbacksRef.current.onOpenChange(true);
          }
        },
        onPanResponderMove: (_event, gestureState) => {
          if (!draggingRef.current) return;
          translateX.setValue(
            clampOffset(gestureStartOffsetRef.current + gestureState.dx),
          );
        },
        onPanResponderRelease: settleGesture,
        onPanResponderTerminate: settleGesture,
        onPanResponderTerminationRequest: () => !draggingRef.current,
      }),
    [clampOffset, settleGesture, translateX],
  );

  useEffect(() => {
    if (!enabled) {
      if (draggingRef.current) callbacksRef.current.onSwipeActiveChange(false);
      draggingRef.current = false;
      settlingTargetRef.current = null;
      translateX.stopAnimation();
      translateX.setValue(0);
      if (open) callbacksRef.current.onOpenChange(false);
      return;
    }
    if (actionWidth === 0 && open) {
      callbacksRef.current.onOpenChange(false);
      return;
    }
    if (draggingRef.current || settlingTargetRef.current === open) return;
    animateTo(open);
  }, [
    actionWidth,
    animateTo,
    enabled,
    open,
    translateX,
  ]);

  useEffect(
    () => () => {
      if (draggingRef.current) callbacksRef.current.onSwipeActiveChange(false);
      draggingRef.current = false;
      settlingTargetRef.current = null;
      translateX.stopAnimation();
      translateX.setValue(0);
    },
    [translateX],
  );

  const onLayout = (event: LayoutChangeEvent) => {
    const width = Math.max(0, event.nativeEvent.layout.width);
    setRowWidth(previous => (previous === width ? previous : width));
  };

  const invokeAction = (id: string) => {
    if (!enabledRef.current || !openRef.current) return;
    openRef.current = false;
    callbacksRef.current.onOpenChange(false);
    callbacksRef.current.actions.find(action => action.id === id)?.onPress();
  };

  const actionsInteractive = open && enabled;

  return (
    <View
      onLayout={onLayout}
      style={[styles.root, {backgroundColor: p.surface}]}
      {...panResponder.panHandlers}
    >
      <View
        accessibilityElementsHidden={!actionsInteractive}
        importantForAccessibility={
          actionsInteractive ? 'yes' : 'no-hide-descendants'
        }
        pointerEvents={actionsInteractive ? 'auto' : 'none'}
        style={[styles.actions, {width: actionWidth}]}
      >
        {actions.map(action => {
          const destructive = !action.id.endsWith('-rename');
          return (
            <Pressable
              accessibilityLabel={action.label}
              accessibilityRole="button"
              accessibilityState={{disabled: !actionsInteractive}}
              disabled={!actionsInteractive}
              key={action.id}
              onPress={() => invokeAction(action.id)}
              testID={`history-swipe-${action.id}`}
              style={({pressed}) => [
                styles.action,
                {
                  backgroundColor: destructive ? p.accent : p.surface,
                  borderColor: destructive ? p.accent : p.border,
                  opacity: pressed ? 0.72 : 1,
                },
              ]}
            >
              <Text
                numberOfLines={2}
                ellipsizeMode="tail"
                style={[
                  styles.actionText,
                  {color: destructive ? p.button : p.text},
                ]}
              >
                {action.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Animated.View
        style={[styles.content, {backgroundColor: p.bg, transform: [{translateX}]}]}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    overflow: 'hidden',
    position: 'relative',
  },
  actions: {
    bottom: 0,
    flexDirection: 'row',
    position: 'absolute',
    right: 0,
    top: 0,
  },
  action: {
    alignItems: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    flex: 1,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 6,
  },
  actionText: {
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
    textAlign: 'center',
  },
  content: {
    width: '100%',
  },
});

export default SwipeHistoryRow;
