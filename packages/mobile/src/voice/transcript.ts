/** Сборка расшифровки (спека 3.3): финальные результаты с непустым `results`, куски через один пробел. */
export interface ResultEvent {
  isFinal: boolean;
  results: ReadonlyArray<{ transcript: string }>;
}

export function assembleTranscript(events: readonly ResultEvent[]): string {
  const pieces: string[] = [];
  for (const event of events) {
    if (!event.isFinal || event.results.length === 0) continue;
    const piece = (event.results[0]?.transcript ?? '').trim();
    if (piece !== '') pieces.push(piece);
  }
  return pieces.join(' ');
}
