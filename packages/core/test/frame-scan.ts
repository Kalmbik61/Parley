/**
 * Правила рамочного теста (спека 14.4, юридическая рамка 15.1) — что не должно
 * попасть в исходники окна и хоста ни в каком виде: учётные данные агентов,
 * запись в их каталоги настроек, обращения к API провайдеров напрямую и
 * YOLO-флаги. Список плоский, а не по категориям: находка называет ровно то
 * правило, которое сработало. Добровольно введённый ключ GLM допускается
 * только через перечисленные ниже узкие исключения (спека провайдеров, 4.2–5).
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

export interface FrameHit {
  file: string;
  line: number;
  rule: string;
  text: string;
}

export const FRAME_RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  {
    rule: 'учётные данные агентов',
    pattern: /\.credentials\.json|Claude Code-credentials|find-generic-password|codex\/auth\.json/,
  },
  {
    // Срабатывает и при чтении того же пути, не только при записи (план куска
    // 1.1, тест 5): регэксп не может надёжно отличить вызов записи от чтения во
    // всех формах (`writeFile`, `fs.writeFileSync`, шаблонные строки и т.д.), а
    // чтения этих файлов рамка 15.1 не предполагает — кроме одного явного
    // исключения из `FRAME_EXCEPTIONS`: скрипт строки статуса читает
    // `settings.json` человека и проекта (спека комнат Organic, 3.5).
    rule: 'запись в каталоги агентов',
    pattern: /\.claude\/settings\.json|\.claude\.json|\.codex\/config\.toml/,
  },
  {
    rule: 'API провайдеров',
    pattern: /api\.anthropic\.com|chatgpt\.com\/backend-api|api\.z\.ai/,
  },
  {
    rule: 'YOLO-флаги',
    pattern:
      /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|bypassPermissions/,
  },
  {
    rule: 'секрет GLM вне хранилища',
    pattern: /secrets\.json/,
  },
  {
    rule: 'ключ GLM вне окружения процесса',
    pattern: /ANTHROPIC_AUTH_TOKEN/,
  },
];

/**
 * Явное исключение из правила: узкое — один файл, одно правило, одна строка целиком. Любая другая
 * строка того же файла (в том числе запись в каталог агента) ловится по-прежнему, а то же
 * объявление в другом файле — тоже. Исключение стоит на объявлении константы пути, а запись через
 * константу сканер не видит, поэтому её использования закреплены отдельно (`PINNED_USES`). Новое
 * исключение — решение контролёра, а не удобство: рамка 15.1 и так пропускает только то, что
 * названо здесь.
 */
export interface FrameException {
  /** Путь от корня репозитория, через `/`. */
  file: string;
  /** Правило из `FRAME_RULES`, которое исключение снимает; остальные правила в файле действуют. */
  rule: string;
  /** Строка исходника целиком, после `trim`. */
  line: string;
  /** Одной строкой: почему можно и на какой пункт спеки опирается. */
  reason: string;
}

export const FRAME_EXCEPTIONS: readonly FrameException[] = [
  {
    file: 'packages/core/src/work/statusline.ts',
    rule: 'запись в каталоги агентов',
    line: "const SETTINGS_FILE = '.claude/settings.json';",
    reason:
      'спека комнат Organic 3.5: скрипт строки статуса только читает settings.json человека и проекта, чтобы вызвать их statusLine',
  },
  {
    file: 'packages/core/src/providers.ts',
    rule: 'API провайдеров',
    line: "ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',",
    reason:
      'спека провайдеров 4.2: встроенная запись GLM задаёт Coding Plan endpoint официальному CLI; Parley не делает запрос к нему',
  },
  {
    file: 'packages/core/src/secrets.ts',
    rule: 'секрет GLM вне хранилища',
    line: "const secretsPath = (): string => path.join(parleyHome(), 'secrets.json');",
    reason:
      'спека провайдеров 5: только модуль хранилища читает и атомарно пишет добровольно введённый ключ Z.ai в доме Parley с правами 0600',
  },
  {
    file: 'packages/host/src/sessions/provider-env.ts',
    rule: 'ключ GLM вне окружения процесса',
    line: 'if (key !== null) env.ANTHROPIC_AUTH_TOKEN = key;',
    reason:
      'спека провайдеров 4.3: свежий ключ добавляется только в финальное окружение процесса GLM после очистки, не в план или настройки',
  },
];

/** Снимает ли явное исключение эту находку: файл, правило и строка (после `trim`) совпадают. */
export function isFrameException(file: string, rule: string, text: string): boolean {
  const relative = file.split(path.sep).join('/');
  return FRAME_EXCEPTIONS.some(
    (exception) =>
      exception.file === relative && exception.rule === rule && exception.line === text.trim(),
  );
}

/**
 * Закрепление использований константы пути, чьё объявление снято с правила исключением. Исключение
 * снимает правило только со СТРОКИ ОБЪЯВЛЕНИЯ, а запись через константу
 * (`writeFile(path.join(home, SETTINGS_FILE), …)`, `rename(…, SETTINGS_FILE)`,
 * `SETTINGS_FILE + '.bak'`) сканер не видит: в такой строке самого пути уже нет. Поэтому рамочный
 * тест держит и использования: строки файла, где названа константа, — ровно перечисленные здесь.
 * Новая ссылка краснит тест, пока человек не обновит закрепление осознанно — прочитав новую строку
 * и решив, что она только читает.
 */
export interface PinnedUses {
  /** Путь от корня репозитория, через `/`. */
  file: string;
  /**
   * Имя константы. Ищется подстрокой в каждой строке файла, в комментариях тоже (упоминание имени —
   * такая же ссылка), поэтому под `SETTINGS_FILE` попадает и `LOCAL_SETTINGS_FILE`.
   */
  name: string;
  /** Строки объявлений (после `trim`): ровно те, что есть в файле. */
  declarations: readonly string[];
  /** Строки чтения (после `trim`): только строят путь, по которому скрипт потом читает файл. */
  reads: readonly string[];
}

export const PINNED_USES: readonly PinnedUses[] = [
  {
    file: 'packages/core/src/work/statusline.ts',
    name: 'SETTINGS_FILE',
    declarations: [
      "const SETTINGS_FILE = '.claude/settings.json';",
      "const LOCAL_SETTINGS_FILE = '.claude/settings.local.json';",
    ],
    // `settingsFiles`: пути настроек проекта и человека, откуда `humanCommand` только читает.
    reads: [
      'dir === null ? [] : [path.join(dir, LOCAL_SETTINGS_FILE), path.join(dir, SETTINGS_FILE)];',
      'return [...project, path.join(home, SETTINGS_FILE)];',
    ],
  },
];

/**
 * Сверяет использования константы в исходнике с закреплением. `added` — строки, где имя названо, а
 * закрепления для них нет (лишняя копия закреплённой строки тоже), `removed` — закреплённые
 * строки, которых в файле нет. Оба списка пусты — использования ровно закреплённые.
 */
export function pinDrift(source: string, pin: PinnedUses): { added: string[]; removed: string[] } {
  const unseen = [...pin.declarations, ...pin.reads];
  const added: string[] = [];
  for (const line of source.split('\n')) {
    const text = line.trim();
    if (!text.includes(pin.name)) continue;
    const index = unseen.indexOf(text);
    if (index === -1) added.push(text);
    else unseen.splice(index, 1);
  }
  return { added, removed: unseen };
}

/**
 * Проверяет исходник построчно; строки-комментарии пропускаются. Явные исключения
 * (`FRAME_EXCEPTIONS`) находкой не считаются.
 *
 * Блочный комментарий (`/* … *`+`/`) отслеживается СОСТОЯНИЕМ между строками,
 * а не только видом текущей строки (раунд исправлений 1, находка I5/тест 15):
 * прежняя эвристика «строка, начатая с `*`, — комментарий» ложно молчала на
 * однострочном генераторе (`*gen() { … }`) и ложно молчала бы и на любом коде,
 * перенесённом на новую строку с ведущим `*` не как часть комментария, а
 * заодно давала обратный эффект — не находила код внутри настоящего блока,
 * если его продолжение оформлено без ведущего `* `.
 */
export function scanSource(file: string, source: string): FrameHit[] {
  const hits: FrameHit[] = [];
  const lines = source.split('\n');
  let inBlockComment = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const trimmed = line.trim();

    if (inBlockComment) {
      // Строка, закрывающая блок, тоже считается комментарием целиком — код
      // сразу после `*/` на той же строке этот сканер не разбирает (в стиле
      // проекта такого не встречается, а ловить только ПРОПУСК опаснее, чем
      // редкую нераспознанную строку сразу после закрытия).
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }

    if (trimmed.startsWith('//')) continue;

    if (trimmed.startsWith('/*')) {
      // Однострочный `/* … */` не открывает блок для следующих строк.
      if (!trimmed.slice(2).includes('*/')) inBlockComment = true;
      continue;
    }

    for (const { rule, pattern } of FRAME_RULES) {
      if (pattern.test(line) && !isFrameException(file, rule, line)) {
        hits.push({ file, line: index + 1, rule, text: trimmed });
      }
    }
  }
  return hits;
}

/** Расширения, которые рамочный тест вообще пробует читать как исходник. */
export const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out']);

function isSourceFile(name: string): boolean {
  if (name.includes('.test.')) return false;
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Исходники под `dir` для рамочного теста: только `SOURCE_EXTENSIONS`, без
 * `*.test.*`, без `node_modules`/`dist`/`out` и без любых каталогов, чьё имя
 * начинается с точки — `.omc/` хуки кладут туда JSON с выводом упавших
 * команд, где попадаются запрещённые строки не по вине исходников (раунд
 * исправлений 1, находка M1/тест 10).
 */
export async function collectSourceFiles(dir: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Каталога нет (например, у пакета нет tools/) — обходить нечего.
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await collectSourceFiles(path.join(dir, entry.name))));
      continue;
    }
    if (!entry.isFile() || !isSourceFile(entry.name)) continue;
    files.push(path.join(dir, entry.name));
  }
  return files;
}
