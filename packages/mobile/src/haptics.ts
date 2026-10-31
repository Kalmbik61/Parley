// Haptics of D1 §16 used by A14. expo-haptics respects the system setting.
import * as Haptics from 'expo-haptics';

export const haptic = {
  qrRecognized: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  sasShown: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  success: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  paired: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  selection: () => void Haptics.selectionAsync(),
  success: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  warning: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  error: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
};
