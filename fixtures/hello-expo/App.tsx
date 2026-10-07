import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import Svg, { Circle } from 'react-native-svg';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Reanimated on the UI thread: an endless rotation that never touches JS. */
function Spinner() {
  const turn = useSharedValue(0);
  useEffect(() => {
    turn.value = withRepeat(withTiming(1, { duration: 1600, easing: Easing.linear }), -1);
  }, [turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  return <Animated.View style={[styles.square, style]} />;
}

/** react-native-svg + Reanimated animated props: a pulsing ring. */
function Pulse() {
  const r = useSharedValue(18);
  useEffect(() => {
    r.value = withRepeat(withTiming(34, { duration: 900 }), -1, true);
  }, [r]);
  const props = useAnimatedProps(() => ({ r: r.value }));
  return (
    <Svg width={80} height={80}>
      <AnimatedCircle cx={40} cy={40} animatedProps={props} stroke="#D2691E" strokeWidth={4} fill="none" />
    </Svg>
  );
}

/** Gesture handler + worklets: the pan runs on the UI thread and reports drops back to React. */
function Draggable({ onDrop }: { onDrop: () => void }) {
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const pan = Gesture.Pan()
    .onChange((e) => {
      x.value += e.changeX;
      y.value += e.changeY;
    })
    .onEnd(() => {
      x.value = withSpring(0);
      y.value = withSpring(0);
      scheduleOnRN(onDrop);
    });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }] }));
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.ball, style]} />
    </GestureDetector>
  );
}

export default function App() {
  const [taps, setTaps] = useState(0);
  const [drops, setDrops] = useState(0);
  return (
    <GestureHandlerRootView style={styles.container}>
      <Text style={styles.title}>Built on Windows</Text>
      <Text style={styles.body}>WSL, Swift 6.4, no Mac</Text>
      <Text style={styles.body}>
        {Platform.OS} {String(Platform.Version)} · Expo {Constants.expoConfig?.sdkVersion ?? '?'}
      </Text>
      <View style={styles.row}>
        <Spinner />
        <Pulse />
      </View>
      <Draggable onDrop={() => setDrops((n) => n + 1)} />
      <Text style={styles.body}>Dragged {drops}×</Text>
      <Pressable style={styles.button} onPress={() => setTaps((n) => n + 1)}>
        <Text style={styles.buttonText}>Tapped {taps}×</Text>
      </Pressable>
      <StatusBar style="auto" />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: '#FBF4E4' },
  title: { fontSize: 32, fontWeight: '700' },
  body: { fontSize: 17, color: '#555' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 32, marginVertical: 16 },
  square: { width: 56, height: 56, borderRadius: 10, backgroundColor: '#2E6B5E' },
  ball: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#3A5BA0' },
  button: { marginTop: 24, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, backgroundColor: '#222' },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
});
