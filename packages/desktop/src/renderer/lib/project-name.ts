/** Имя проекта для подписей — последний сегмент пути (хвостовые слеши не считаются). */
export function projectName(projectPath: string): string {
  return projectPath.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) ?? projectPath;
}
