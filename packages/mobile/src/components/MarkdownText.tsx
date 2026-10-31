import { Text, View } from 'react-native';
import { typography, useColors } from '../theme';

/** Plain Markdown subset for decisions and letters: `#` headings, `-` bullets, paragraphs. No links, no HTML. */
export function MarkdownText({ text }: { text: string }) {
  const colors = useColors();
  return (
    <View style={{ gap: 8 }}>
      {text.split('\n').map((line, i) => {
        if (line.trim() === '') return null;
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) {
          return (
            <Text key={i} accessibilityRole="header" allowFontScaling style={[typography.headline, { color: colors.label }]}>
              {h[2]}
            </Text>
          );
        }
        const b = /^\s*[-*]\s+(.*)$/.exec(line);
        return (
          <Text key={i} selectable allowFontScaling style={[typography.body, { color: colors.label }]}>
            {b ? `•  ${b[1]}` : line}
          </Text>
        );
      })}
    </View>
  );
}
