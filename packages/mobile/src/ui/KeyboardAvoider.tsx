// Keeps the bottom of a screen above the keyboard (plan A35e, the human's screenshot IMG_5237: in New session the keyboard
// covered "Start session").
//
// Why not RN `KeyboardAvoidingView` here: it takes the overlap as `frame.y + frame.height - keyboard.screenY`, with the
// view's frame from layout. In a sheet that frame starts at 0 while the sheet itself sits lower on the screen (its native
// offset is not in the layout tree — `measureInWindow` does not see it either on Fabric), so the footer stopped short by
// exactly the sheet offset. Contract instead: this view ends at the bottom of the screen (a screen or sheet body), so the
// keyboard covers it by how far the keyboard reaches up from the screen bottom. The padding follows the keyboard with
// `Animated` (layout animations crash with Fabric, see no-layout-animation.test.ts).
import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Dimensions, Easing, Keyboard, Platform, type KeyboardEvent, type StyleProp, type ViewStyle } from 'react-native';
import { keyboardRise } from './keyboard-overlap';

/** Use only for a view whose bottom is the bottom of the screen. */
export function KeyboardAvoider({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const bottom = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const to = (value: number, e: KeyboardEvent): void => {
      Animated.timing(bottom, { toValue: value, duration: e.duration, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    };
    // iPhone only: `keyboardWillShow` also comes when the shown keyboard changes height (the suggestions bar).
    const show = Keyboard.addListener('keyboardWillShow', (e) => to(keyboardRise(Dimensions.get('window').height, e.endCoordinates.screenY), e));
    const hide = Keyboard.addListener('keyboardWillHide', (e) => to(0, e));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [bottom]);

  return <Animated.View style={[{ flex: 1 }, style, { paddingBottom: bottom }]}>{children}</Animated.View>;
}
