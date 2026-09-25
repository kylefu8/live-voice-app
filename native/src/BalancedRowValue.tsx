import React, {useEffect, useState} from 'react';
import {StyleSheet, Text, useWindowDimensions, View} from 'react-native';

type Measure = {key: string; low: number; high: number; probe: number; lines: number; step: number; done: boolean};

/** Find the narrowest native text layout that preserves the original line count.
 * Measuring offscreen avoids changing the visible wrapping on every probe.
 * This also handles CJK, proportional Latin fonts and system font scaling. */
export function BalancedRowValue({value, color}: {value: string; color: string}) {
  const [width, setWidth] = useState(0);
  const {fontScale} = useWindowDimensions();
  const key = `${width}:${fontScale}:${value}`;
  const [measure, setMeasure] = useState<Measure | null>(null);
  useEffect(() => {
    if (width > 0) setMeasure({key, low: 0, high: width, probe: width, lines: 0, step: 0, done: false});
  }, [key, width]);
  const current = measure?.key === key ? measure : null;
  return <View style={styles.container} onLayout={event => {
    const next = event.nativeEvent.layout.width;
    setWidth(previous => Math.abs(previous - next) > 0.5 ? next : previous);
  }}>
    {/* Leave room for native pixel rounding at the exact wrapping threshold. */}
    <Text style={[styles.text, {color, width: current?.done && current.lines > 1 ? Math.min(width, current.high + 2) : '100%'}]}
      textBreakStrategy="simple" lineBreakStrategyIOS="none">{value}</Text>
    {current && !current.done && <Text key={`${key}:${current.step}`}
      accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none"
      style={[styles.text, styles.measure, {width: current.probe}]}
      textBreakStrategy="simple" lineBreakStrategyIOS="none"
      onTextLayout={event => {
        const count = event.nativeEvent.lines.length;
        setMeasure(previous => {
          if (previous !== current) return previous;
          if (current.lines === 0) {
            if (count <= 1) return {...current, done: true};
            return {...current, lines: count, probe: width / 2, step: 1};
          }
          const low = count > current.lines ? current.probe : current.low;
          const high = count <= current.lines ? current.probe : current.high;
          const done = current.step >= 8 || high - low < 1;
          return {...current, low, high, probe: (low + high) / 2, step: current.step + 1, done};
        });
      }}>{value}</Text>}
  </View>;
}
const styles = StyleSheet.create({
  container: {flex: 1, alignItems: 'flex-end'},
  text: {fontSize: 14, textAlign: 'right'},
  measure: {position: 'absolute', top: 0, right: 0, opacity: 0},
});
