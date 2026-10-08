// packages/desktop/src/renderer/browser/ViewportMenu.tsx
/**
 * Меню размера вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.2): Fit, пресеты как в device
 * toolbar Chrome, Custom… (W × H в пределах `DEVTOOLS_LIMITS`), Rotate и DPR 1x/2x/3x. Выбор уходит колбэком: размер
 * хранит раскладка (`TabSpec.viewport`), эмуляцию ставит поверхность. Подпись кнопки прячется на узкой строке —
 * контейнерный запрос строки вкладки (`@container` в `BrowserChrome.tsx`).
 */
import { MonitorSmartphone } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  DEVTOOLS_LIMITS,
  VIEWPORT_PRESETS,
  viewportSize,
  type ViewportDpr,
  type ViewportPreset,
  type ViewportSpec,
} from '../../shared/browser-devtools.js';
import { S } from '../../shared/strings.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover.js';

const PRESETS: readonly ViewportPreset[] = ['mobile-s', 'mobile-m', 'mobile-l', 'tablet', 'laptop', 'desktop'];
const DPRS: readonly ViewportDpr[] = [1, 2, 3];
const FIELD =
  'h-7 w-full rounded border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring';

function isPreset(value: string): value is ViewportPreset {
  return (PRESETS as readonly string[]).includes(value);
}

function isDpr(value: number): value is ViewportDpr {
  return value === 1 || value === 2 || value === 3;
}

/** Пресет с DPR прежнего размера; из Fit — 2x у мобильных, 1x у прочих. */
export function presetSpec(preset: ViewportPreset, current: ViewportSpec | null): ViewportSpec {
  return { preset, rotated: false, dpr: current?.dpr ?? (VIEWPORT_PRESETS[preset].mobile ? 2 : 1) };
}

/** Повёрнутый размер; свой размер, который после поворота вышел бы за пределы раздела 8, — null. */
export function rotatedSpec(spec: ViewportSpec): ViewportSpec | null {
  if ('preset' in spec) return { ...spec, rotated: !spec.rotated };
  if (spec.height > DEVTOOLS_LIMITS.customMaxWidth || spec.width > DEVTOOLS_LIMITS.customMaxHeight) return null;
  return { ...spec, width: spec.height, height: spec.width };
}

/** Поля Custom… → размер в пределах 200–3840 × 200–2400; иначе null. Только цифры: `1e3`, `0x400`, `+500`, `500.0` — нет. */
export function customSize(widthText: string, heightText: string): { width: number; height: number } | null {
  const digits = /^\d+$/;
  if (!digits.test(widthText.trim()) || !digits.test(heightText.trim())) return null;
  const width = Number(widthText.trim());
  const height = Number(heightText.trim());
  const ok = (value: number, max: number): boolean => Number.isInteger(value) && value >= DEVTOOLS_LIMITS.customMin && value <= max;
  return ok(width, DEVTOOLS_LIMITS.customMaxWidth) && ok(height, DEVTOOLS_LIMITS.customMaxHeight) ? { width, height } : null;
}

/** Подпись кнопки: Fit, имя пресета или W×H. */
export function viewportName(spec: ViewportSpec | null): string {
  if (spec === null) return S.browser.viewport.fit;
  if ('preset' in spec) return S.browser.viewport.presets[spec.preset];
  return S.browser.viewport.size(spec.width, spec.height);
}

export interface ViewportMenuProps {
  viewport: ViewportSpec | null;
  /** Страницы ещё нет — эмулировать нечего. */
  disabled: boolean;
  onChange(spec: ViewportSpec | null): void;
}

export function ViewportMenu({ viewport, disabled, onChange }: ViewportMenuProps): JSX.Element {
  const [customOpen, setCustomOpen] = useState(false);
  const [widthText, setWidthText] = useState('');
  const [heightText, setHeightText] = useState('');
  // Custom… закрывает меню: фокус уходит в поля поповера, а не обратно на кнопку.
  const toCustom = useRef(false);
  // `PopoverAnchor` не заводит `triggerRef` поповера, поэтому Radix сам фокус на кнопку не вернёт — возвращаем руками.
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Клик мимо поповера отдаёт фокус тому, по чему кликнули, — кнопка его не забирает.
  const outside = useRef(false);
  const selected = viewport === null ? 'fit' : 'preset' in viewport ? viewport.preset : 'custom';
  const rotated = viewport === null ? null : rotatedSpec(viewport);
  const size = customSize(widthText, heightText);

  const openCustom = (): void => {
    const current = viewport === null ? VIEWPORT_PRESETS.laptop : viewportSize(viewport);
    setWidthText(String(current.width));
    setHeightText(String(current.height));
    toCustom.current = true;
    setCustomOpen(true);
  };

  const apply = (): void => {
    if (size === null) return;
    onChange({ width: size.width, height: size.height, mobile: false, dpr: viewport?.dpr ?? 1 });
    setCustomOpen(false);
  };

  return (
    <Popover open={customOpen} onOpenChange={setCustomOpen}>
      <DropdownMenu>
        <PopoverAnchor asChild>
          <DropdownMenuTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              aria-label={S.browser.viewport.menu}
              title={viewportName(viewport)}
              disabled={disabled}
              className="flex h-6 shrink-0 items-center gap-1 rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <MonitorSmartphone className="size-3.5 shrink-0" aria-hidden="true" />
              <span data-viewport-name className="hidden max-w-24 truncate @min-[560px]:inline">
                {viewportName(viewport)}
              </span>
            </button>
          </DropdownMenuTrigger>
        </PopoverAnchor>
        <DropdownMenuContent
          align="end"
          className="w-56"
          onCloseAutoFocus={(event) => {
            if (!toCustom.current) return;
            toCustom.current = false;
            event.preventDefault();
          }}
        >
          <DropdownMenuRadioGroup
            value={selected}
            onValueChange={(value) => {
              if (value === 'fit') onChange(null);
              else if (isPreset(value)) onChange(presetSpec(value, viewport));
            }}
          >
            <DropdownMenuRadioItem value="fit">{S.browser.viewport.fit}</DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            {PRESETS.map((preset) => (
              <DropdownMenuRadioItem key={preset} value={preset}>
                {S.browser.viewport.presets[preset]}
                <span className="ml-auto text-muted-foreground">
                  {S.browser.viewport.size(VIEWPORT_PRESETS[preset].width, VIEWPORT_PRESETS[preset].height)}
                </span>
              </DropdownMenuRadioItem>
            ))}
            {/* Custom… только открывает поля: onSelect, а не onValueChange — повторный выбор своего размера тоже их открывает. */}
            <DropdownMenuRadioItem value="custom" onSelect={openCustom}>
              {S.browser.viewport.custom}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={rotated === null}
            onSelect={() => {
              if (rotated !== null) onChange(rotated);
            }}
          >
            {S.browser.viewport.rotate}
          </DropdownMenuItem>
          <DropdownMenuRadioGroup
            value={viewport === null ? '' : String(viewport.dpr)}
            onValueChange={(value) => {
              const dpr = Number(value);
              if (viewport !== null && isDpr(dpr)) onChange({ ...viewport, dpr });
            }}
          >
            {DPRS.map((dpr) => (
              <DropdownMenuRadioItem key={dpr} value={String(dpr)} disabled={viewport === null}>
                {S.browser.viewport.dpr(dpr)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <PopoverContent
        align="end"
        className="w-64 p-3"
        onInteractOutside={() => {
          outside.current = true;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!outside.current) triggerRef.current?.focus();
          outside.current = false;
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
          className="flex flex-col gap-2"
        >
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
              {S.browser.viewport.width}
              <input
                aria-label={S.browser.viewport.width}
                inputMode="numeric"
                value={widthText}
                onChange={(event) => setWidthText(event.target.value)}
                className={FIELD}
              />
            </label>
            <span className="pb-1.5 text-xs text-muted-foreground" aria-hidden="true">
              ×
            </span>
            <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
              {S.browser.viewport.height}
              <input
                aria-label={S.browser.viewport.height}
                inputMode="numeric"
                value={heightText}
                onChange={(event) => setHeightText(event.target.value)}
                className={FIELD}
              />
            </label>
          </div>
          {size === null ? (
            <p role="alert" className="text-xs text-destructive">
              {S.browser.viewport.customRange(DEVTOOLS_LIMITS.customMin, DEVTOOLS_LIMITS.customMaxWidth, DEVTOOLS_LIMITS.customMaxHeight)}
            </p>
          ) : null}
          <button type="submit" disabled={size === null} className="h-7 rounded bg-primary px-3 text-xs text-primary-foreground disabled:opacity-40">
            {S.browser.viewport.apply}
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
