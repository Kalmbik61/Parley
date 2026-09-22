import { Box, Text, useInput } from 'ink';
import { useRef, useState, type ReactNode } from 'react';
import { truncate, truncateLeft, wrapText } from '../format.js';
import { glyphs } from '../glyphs.js';
import { theme } from '../theme/index.js';
import { withoutMouse } from '../use-prefix-input.js';

/** Вариант селектора `‹ ›`. Недоступный показывается, но не выбирается (дизайн 4.2). */
export interface DialogOption {
  id: string;
  label: string;
  disabled?: boolean;
  /** Почему недоступен: `нет в PATH` рядом с самим вариантом. */
  note?: string;
}

export interface DialogField {
  key: string;
  label: string;
  /** Есть варианты — поле становится селектором `‹ ›` (←→). */
  options?: readonly DialogOption[];
  /** Начальное значение; у селектора — id варианта. */
  value?: string;
  /** Пустым можно оставить только необязательное поле. */
  optional?: boolean;
  /** Длинный текст переносится на несколько строк (макеты 4.1 и 4.2). */
  multiline?: boolean;
}

export interface DialogProps {
  /** Поля по порядку; пустой список — диалог только подтверждает (4.3, 4.4). */
  fields?: readonly DialogField[];
  /** Строки над телом: путь брифа, команда возобновления, код выхода. */
  info?: readonly string[];
  /** Тело-цитата: первые строки брифа, листается `↑↓` (дизайн 4.3). */
  quote?: readonly string[];
  footer: string;
  width: number;
  height: number;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}

/** Сколько строк занимает многострочное поле. */
const FIELD_LINES = 3;

const firstEnabled = (options: readonly DialogOption[]): string =>
  options.find((option) => option.disabled !== true)?.id ?? '';

const initialValues = (fields: readonly DialogField[]): Record<string, string> =>
  Object.fromEntries(
    fields.map((field) => [
      field.key,
      field.value ?? (field.options === undefined ? '' : firstEnabled(field.options)),
    ]),
  );

const clamp = (value: number, count: number): number =>
  count === 0 ? 0 : Math.max(0, Math.min(value, count - 1));

/**
 * Диалог на месте нижней левой панели (дизайн координации TUI, раздел 4).
 *
 * Модален для левой колонки: пока он открыт, клавиши списков не действуют, и
 * весь ввод принадлежит ему. Правая колонка при этом не трогается вовсе.
 */
export function Dialog({
  fields = [],
  info = [],
  quote = [],
  footer,
  width,
  height,
  onSubmit,
  onCancel,
}: DialogProps): ReactNode {
  const g = glyphs();
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(fields));
  const [at, setAt] = useState(0);
  const [scroll, setScroll] = useState(0);
  const maxScroll = useRef(0);

  const active = fields[clamp(at, fields.length)];
  const cursor = g.ascii ? '_' : '▌';

  const type = (field: DialogField, next: (current: string) => string): void => {
    setValues((current) => ({ ...current, [field.key]: next(current[field.key] ?? '') }));
  };

  // Кольцо проходит и по недоступным: иначе не видно, где в нём пропуск
  // (дизайн 4.2). Подтвердить такой вариант всё равно нельзя — см. submit.
  const cycle = (field: DialogField, step: number): void => {
    const options = field.options ?? [];
    if (options.length === 0) return;
    const current = options.findIndex((option) => option.id === values[field.key]);
    const next = options[(current + step + options.length) % options.length];
    if (next !== undefined) type(field, () => next.id);
  };

  const chosen = (field: DialogField): DialogOption | undefined =>
    field.options?.find((option) => option.id === values[field.key]);

  const submit = (): void => {
    // Пустое обязательное поле и недоступный вариант — не отказ молчанием:
    // выбор переезжает на них.
    const gap = fields.findIndex(
      (field) =>
        (field.optional !== true && (values[field.key] ?? '') === '') ||
        chosen(field)?.disabled === true,
    );
    if (gap !== -1) {
      setAt(gap);
      return;
    }
    onSubmit(values);
  };

  useInput((raw, key) => {
    // Ink разбирает stdin параллельно с харнессом и отдаёт клик мышью обычным
    // текстом: без чистки он печатался бы в поле. Пока диалог открыт, мышь не
    // делает ничего (дизайн 3.1).
    const input = withoutMouse(raw);
    if (raw !== '' && input === '') return;

    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (at < fields.length - 1) setAt(at + 1);
      else submit();
      return;
    }
    if (key.tab) {
      if (fields.length > 0) setAt((at + 1) % fields.length);
      return;
    }
    if (key.upArrow || key.downArrow) {
      const step = key.downArrow ? 1 : -1;
      // Поля есть — `↑↓` ходят по ним; иначе листают тело (дизайн 4.3).
      if (fields.length > 1) setAt(clamp(at + step, fields.length));
      // Счётчик прокрутки держим в границах тела: убежав за конец, он съедал бы
      // первые нажатия `↑` — картинка стояла бы на месте.
      else setScroll((current) => Math.min(Math.max(0, current + step), maxScroll.current));
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      if (active?.options !== undefined) cycle(active, key.rightArrow ? 1 : -1);
      return;
    }
    if (key.backspace || key.delete) {
      if (active !== undefined && active.options === undefined) {
        type(active, (current) => [...current].slice(0, -1).join(''));
      }
      return;
    }
    // Управляющие сочетания в поля не попадают: это команды, а не текст.
    if (key.ctrl || key.meta || input === '') return;
    if (active !== undefined && active.options === undefined) {
      type(active, (current) => current + input);
    }
  });

  const lines: ReactNode[] = [];
  for (const [index, text] of info.entries()) {
    lines.push(
      <Text key={`info-${index}`} {...theme().fg.muted} wrap="truncate">
        {truncate(text, width, g.ellipsis)}
      </Text>,
    );
  }

  for (const [index, field] of fields.entries()) {
    const selected = index === at;
    const value = values[field.key] ?? '';
    const label = `${field.label}: `;

    if (field.options !== undefined) {
      const option = field.options.find((item) => item.id === value);
      const off = option?.disabled === true;
      const note = off && option.note !== undefined ? ` · ${option.note}` : '';
      lines.push(
        <Text
          key={field.key}
          wrap="truncate"
          {...(off ? theme().fg.muted : {})}
          {...(selected ? { bold: true } : {})}
        >
          {truncate(`${label}‹ ${option?.label ?? '—'} ›${note}`, width, g.ellipsis)}
        </Text>,
      );
      continue;
    }

    const tail = selected ? cursor : '';
    if (field.multiline === true) {
      const rows = wrapText(`${label}${value}${tail}`, width, FIELD_LINES, g.ellipsis);
      for (const [row, text] of (rows.length === 0 ? [label] : rows).entries()) {
        lines.push(
          <Text key={`${field.key}-${row}`} wrap="truncate" {...(selected ? { bold: true } : {})}>
            {text}
          </Text>,
        );
      }
      continue;
    }
    lines.push(
      <Text key={field.key} wrap="truncate" {...(selected ? { bold: true } : {})}>
        {truncateLeft(`${label}${value}${tail}`, width, g.ellipsis)}
      </Text>,
    );
  }

  // Тело-цитата занимает то, что осталось от полей и подсказки.
  const room = Math.max(0, height - lines.length - 1);
  // Предел прокрутки известен только здесь: он зависит от того, сколько строк
  // заняли поля. Обработчик клавиш читает его через ref.
  maxScroll.current = Math.max(0, quote.length - room);
  const start = Math.min(scroll, maxScroll.current);
  for (const [index, text] of quote.slice(start, start + room).entries()) {
    lines.push(
      <Text key={`quote-${start + index}`} wrap="truncate">
        {truncate(`${g.quote}${text}`, width, g.ellipsis)}
      </Text>,
    );
  }

  return (
    <Box flexDirection="column">
      {lines}
      <Text {...theme().fg.muted} wrap="truncate">
        {truncate(footer, width, g.ellipsis)}
      </Text>
    </Box>
  );
}
