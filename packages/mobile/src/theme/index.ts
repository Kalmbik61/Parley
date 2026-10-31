import { useColorScheme } from 'react-native';
import { darkColors, lightColors, type Colors } from './tokens';

export * from './tokens';

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? darkColors : lightColors;
}
