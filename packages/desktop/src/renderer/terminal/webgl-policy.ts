/**
 * Кому держать WebGL-контекст (кусок 5.3, спека 8.1): видимым терминалам и шести
 * последним скрытым. У Chromium около 16 контекстов на процесс, а в слое поверхностей
 * смонтированы терминалы трёх работ — без политики новый контекст отнял бы старый сам,
 * и терминал остался бы с чёрной канвой.
 *
 * Решение шлётся подписчику на каждую перемену, в том числе давно скрытому терминалу:
 * когда прячется седьмой, самый старый скрытый теряет контекст, хотя его собственная
 * видимость не менялась. Спрашивай терминал только «при смене своей видимости» —
 * предел «видимые и 6 скрытых» не держался бы.
 */

export interface WebglPolicy {
  /** Видимость терминала key; перемены решений политика шлёт подписчикам — в том числе давно скрытым. */
  update(key: string, visible: boolean): void;
  /** Решение для key: текущее — сразу, дальше — каждая перемена. want: false — освободить WebglAddon. */
  subscribe(key: string, listener: (want: boolean) => void): () => void;
  /** Терминал размонтирован: уходит из LRU, его место получает следующий скрытый. */
  forget(key: string): void;
  /** 'dom' после 3 потерь за 60 с: дальше want для key — всегда false, до перезагрузки окна. */
  onContextLoss(key: string): 'retry' | 'dom';
  /** Освобождение WebGL у key не удалось: дальше want — всегда false, как после 'dom'. */
  forceDom(key: string): void;
}

export function createWebglPolicy(
  options: { keepHidden?: number; maxLosses?: number; windowMs?: number; now?: () => number } = {},
): WebglPolicy {
  const keepHidden = options.keepHidden ?? 6;
  const maxLosses = options.maxLosses ?? 3;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? (() => Date.now());

  const visible = new Set<string>();
  /** Скрытые по времени скрытия: последний — самый свежий. */
  const hidden: string[] = [];
  const domOnly = new Set<string>();
  const losses = new Map<string, number[]>();
  const decisions = new Map<string, boolean>();
  const listeners = new Map<string, Set<(want: boolean) => void>>();

  const wants = (key: string): boolean => {
    if (domOnly.has(key)) return false;
    if (visible.has(key)) return true;
    const index = hidden.indexOf(key);
    return index !== -1 && index >= hidden.length - keepHidden;
  };

  const recompute = (): void => {
    for (const key of new Set([...visible, ...hidden, ...decisions.keys()])) {
      const next = wants(key);
      if (decisions.get(key) === next) continue;
      decisions.set(key, next);
      for (const listener of [...(listeners.get(key) ?? [])]) listener(next);
    }
  };

  const drop = (key: string): void => {
    visible.delete(key);
    const index = hidden.indexOf(key);
    if (index !== -1) hidden.splice(index, 1);
  };

  return {
    update(key, isVisible) {
      if (isVisible) {
        drop(key);
        visible.add(key);
      } else if (!hidden.includes(key)) {
        // Повторное «скрыт» место в очереди не освежает: давность — с момента скрытия.
        visible.delete(key);
        hidden.push(key);
      }
      recompute();
    },
    subscribe(key, listener) {
      let set = listeners.get(key);
      if (set === undefined) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      listener(wants(key));
      return () => {
        const current = listeners.get(key);
        current?.delete(listener);
        if (current?.size === 0) listeners.delete(key);
      };
    },
    forget(key) {
      drop(key);
      decisions.delete(key);
      recompute();
    },
    onContextLoss(key) {
      const at = now();
      const recent = (losses.get(key) ?? []).filter((t) => at - t < windowMs);
      recent.push(at);
      losses.set(key, recent);
      if (recent.length < maxLosses) return 'retry';
      domOnly.add(key);
      recompute();
      return 'dom';
    },
    forceDom(key) {
      domOnly.add(key);
      recompute();
    },
  };
}

/** Один экземпляр на окно: его берут все use-terminal, ключ — refKey сессии. */
export const webglPolicy: WebglPolicy = createWebglPolicy();
