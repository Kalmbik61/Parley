/**
 * Поле сочетания клавиш: человек нажимает комбинацию, а не печатает текст. Поэтому кнопка, а не `input`: нажатия не
 * должны печататься в поле. `stopPropagation` нужен, чтобы ⌘-сочетания не доходили до обработчика клавиш окна
 * (`renderer/keys/handler.ts`) и не выполняли команды, пока идёт запись.
 */
import { useState } from 'react';
import { acceleratorFromPress, hotkeyLabel } from '../../../shared/hotkey.js';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';

export interface ShortcutFieldProps {
  value: string;
  label: string;
  onChange(accelerator: string): void;
}

const MAC = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');

export function ShortcutField(props: ShortcutFieldProps): JSX.Element {
  const [recording, setRecording] = useState(false);

  return (
    <button
      type="button"
      data-testid="shortcut-field"
      aria-label={props.label}
      className={cn(
        'flex h-9 w-full items-center rounded-full border border-input bg-background px-[14px] py-[6px] text-left text-sm transition-colors hover:border-foreground/45 focus-visible:border-ring focus-visible:outline-offset-0',
        recording ? 'ring-1 ring-ring' : '',
      )}
      onClick={() => setRecording(true)}
      onFocus={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(event) => {
        if (!recording) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.code === 'Escape') {
          setRecording(false);
          return;
        }
        const accelerator = acceleratorFromPress(event, MAC);
        if (accelerator === null) return;
        props.onChange(accelerator);
        setRecording(false);
        event.currentTarget.blur();
      }}
    >
      {recording ? S.assistant.settings.shortcutRecording : hotkeyLabel(props.value)}
    </button>
  );
}
