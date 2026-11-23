import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { refKey, type KimiConfigOption, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';

function supported(option: KimiConfigOption): boolean {
  const kind = option.category ?? option.id;
  return kind === 'model' || kind === 'thought_level' || kind === 'thinking' || kind === 'mode';
}

function currentLabel(option: KimiConfigOption): string {
  if (option.type === 'boolean') return S.chat.kimi.booleanValue(option.name, option.currentValue);
  const options = option.options.flatMap((item) => 'group' in item ? item.options : [item]);
  return options.find((item) => item.value === option.currentValue)?.name || option.currentValue;
}

export function KimiConfigMenu({ bridge, sessionRef, disabledReason }: {
  bridge: ParleyBridge;
  sessionRef: SessionRef;
  disabledReason: string | null;
}): JSX.Element | null {
  const { projectPath, workId, sessionId } = sessionRef;
  const [config, setConfig] = useState<KimiConfigOption[]>([]);
  const [busy, setBusy] = useState(false);
  const connection = useRef<{ revision: number; changing: boolean } | null>(null);

  useEffect(() => {
    const ref = { projectPath, workId, sessionId };
    const key = refKey(ref);
    const current = { revision: 0, changing: false };
    connection.current = current;
    const off = bridge.on('kimi.configChanged', (update) => {
      if (refKey(update.ref) !== key) return;
      current.revision++;
      setConfig(update.config);
    });
    // Subscribe before taking the snapshot so a concurrent ACP update wins over a stale reply.
    void bridge.call('kimi.getState', { ref }).then((result) => {
      if (connection.current === current && current.revision === 0) setConfig(result.config);
    }).catch((error: unknown) => {
      if (connection.current === current) console.warn('[parley] kimi.getState', decodeIpcError(error).message);
    });
    return () => {
      connection.current = null;
      off();
    };
  }, [bridge, projectPath, workId, sessionId]);

  const change = async (option: KimiConfigOption, value: string | boolean): Promise<void> => {
    const current = connection.current;
    if (current === null || current.changing || disabledReason !== null || value === option.currentValue) return;
    current.changing = true;
    setBusy(true);
    const revision = current.revision;
    try {
      const result = await bridge.call('kimi.setConfig', { ref: sessionRef, configId: option.id, value });
      if (connection.current === current && current.revision === revision) setConfig(result.config);
    } catch (error: unknown) {
      if (connection.current === current) toast.error(S.chat.kimi.refused(decodeIpcError(error).message));
    } finally {
      if (connection.current === current) {
        current.changing = false;
        setBusy(false);
      }
    }
  };

  const options = config.filter(supported);
  if (options.length === 0) return null;
  const label = options.map(currentLabel).join(' · ');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={busy}>
        <Button type="button" size="xs" variant="outline" className="min-w-0 max-w-[40%] shrink"
          aria-label={S.chat.kimi.settings(label)} title={label}>
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {disabledReason === null ? null : <DropdownMenuLabel>{disabledReason}</DropdownMenuLabel>}
        {options.map((option, index) => (
          <Fragment key={option.id}>
            {index === 0 ? null : <DropdownMenuSeparator />}
            {option.type === 'boolean' ? (
              <DropdownMenuCheckboxItem checked={option.currentValue} disabled={disabledReason !== null}
                title={option.description ?? undefined} onCheckedChange={(checked) => void change(option, checked)}>
                {option.name}
              </DropdownMenuCheckboxItem>
            ) : (
              <>
                <DropdownMenuLabel title={option.description ?? undefined}>{option.name}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={option.currentValue} onValueChange={(value) => void change(option, value)}>
                  {option.options.map((item) => 'group' in item ? (
                    <Fragment key={item.group}>
                      <DropdownMenuLabel inset>{item.name}</DropdownMenuLabel>
                      {item.options.map((choice) => (
                        <DropdownMenuRadioItem key={choice.value} value={choice.value} disabled={disabledReason !== null}
                          title={choice.description ?? undefined}>{choice.name || choice.value}</DropdownMenuRadioItem>
                      ))}
                    </Fragment>
                  ) : (
                    <DropdownMenuRadioItem key={item.value} value={item.value} disabled={disabledReason !== null}
                      title={item.description ?? undefined}>{item.name || item.value}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </>
            )}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
