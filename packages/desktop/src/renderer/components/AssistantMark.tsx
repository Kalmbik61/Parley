/**
 * Знак помощника (спека 2026-10-14): тёплое светящееся пятно — мини-рой без отдельных душ. На этапе 1 — и облик
 * помощника на острове; в комнате и Chat — значок письма, отправленного через помощника.
 */
export function AssistantMark({ size = 16, busy = false }: { size?: number; busy?: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      data-assistant-mark=""
      className={`inline-block shrink-0 rounded-full ${busy ? 'assistant-pulse' : ''}`}
      style={{
        width: size,
        height: size,
        background: 'radial-gradient(circle, #F0DDA5 0%, #EFB05C 36%, rgba(239, 176, 92, 0.35) 58%, rgba(239, 176, 92, 0) 72%)',
      }}
    />
  );
}
