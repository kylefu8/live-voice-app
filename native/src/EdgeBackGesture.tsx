import React, {useMemo, useRef} from 'react';
import {Animated, PanResponder, Platform, StyleSheet, Text, View} from 'react-native';

/** iOS edge navigation. Android already routes its system back gesture through
 * BackHandler, so it must not compete with another gesture recognizer. */
export function EdgeBackGesture({children, enabled, onBack, color, background}: {
  children: React.ReactNode;
  enabled: boolean;
  onBack: () => void;
  color: string;
  background: string;
}) {
  const current = useRef({enabled, onBack});
  current.current = {enabled, onBack};
  const width = useRef(390);
  const dragging = useRef(false);
  const startedAtEdge = useRef(false);
  const progress = useRef(new Animated.Value(0)).current;
  const responder = useMemo(() => {
    const reset = () => {
      dragging.current = false;
      Animated.timing(progress, {toValue: 0, duration: 120, useNativeDriver: true}).start();
    };
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: event => {
        // PanResponder.x0 is only set AFTER it acquires the responder.
        startedAtEdge.current = event.nativeEvent.touches.length === 1 && event.nativeEvent.pageX <= 28;
        return false;
      },
      onMoveShouldSetPanResponderCapture: (_event, gesture) =>
        Platform.OS === 'ios' && current.current.enabled &&
        gesture.numberActiveTouches === 1 && startedAtEdge.current &&
        gesture.dx > 12 && gesture.dx > Math.abs(gesture.dy) * 1.5,
      onPanResponderGrant: () => {
        dragging.current = true;
        progress.stopAnimation();
      },
      onPanResponderMove: (_event, gesture) => {
        if (gesture.numberActiveTouches !== 1) {startedAtEdge.current = false; reset(); return;}
        progress.setValue(Math.max(0, Math.min(1, gesture.dx / 100)));
      },
      onPanResponderRelease: (_event, gesture) => {
        const shouldReturn = dragging.current && current.current.enabled &&
          gesture.dx > Math.abs(gesture.dy) * 1.5 &&
          (gesture.dx >= Math.min(100, width.current * 0.25) ||
            (gesture.dx > 35 && gesture.vx > 0.5));
        reset();
        if (shouldReturn) current.current.onBack();
      },
      onPanResponderTerminationRequest: () => !dragging.current,
      onPanResponderTerminate: reset,
    });
  }, [progress]);
  return <View style={styles.root} onLayout={event => {width.current = event.nativeEvent.layout.width;}} {...responder.panHandlers}>
    {children}
    <Animated.View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[styles.feedback, {backgroundColor: background, opacity: progress,
        transform: [{translateX: progress.interpolate({inputRange: [0, 1], outputRange: [-20, 8]})}]}]}>
      <Text style={{color, fontSize: 32}}>‹</Text>
    </Animated.View>
  </View>;
}
const styles = StyleSheet.create({
  root: {flex: 1},
  feedback: {position: 'absolute', left: 0, top: '45%', width: 40, height: 56,
    borderRadius: 20, alignItems: 'center', justifyContent: 'center'},
});
