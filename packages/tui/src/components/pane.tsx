import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

export interface PaneProps {
  title: string;
  active: boolean;
  children: ReactNode;
  /** Доля высоты внутри колонки; без неё панель занимает остаток. */
  height?: number;
  flexGrow?: number;
  width?: number | string;
  minWidth?: number;
}

/** Рамка с заголовком. Активная панель подсвечена — так требует specs/ui.md. */
export function Pane({
  title,
  active,
  children,
  height,
  flexGrow,
  width,
  minWidth,
}: PaneProps): ReactNode {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={active ? 'cyan' : 'gray'}
      paddingX={1}
      overflow="hidden"
      {...(height === undefined ? {} : { height })}
      {...(flexGrow === undefined ? {} : { flexGrow })}
      {...(width === undefined ? {} : { width })}
      {...(minWidth === undefined ? {} : { minWidth })}
    >
      <Text bold color={active ? 'cyan' : 'gray'}>
        {title}
      </Text>
      {children}
    </Box>
  );
}
