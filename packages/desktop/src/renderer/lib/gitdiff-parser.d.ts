/**
 * `gitdiff-parser@0.3.1` — CommonJS-пакет (в его `package.json` нет `"type":
 * "module"`), а его собственный `index.d.ts` описывает дефолтный экспорт
 * ESM-синтаксисом (`export default {...}`). Под `moduleResolution: NodeNext`
 * TypeScript в таком случае типизирует дефолтный импорт как весь namespace
 * модуля (с несуществующим в рантайме полем `.default`), а не как реальный
 * `module.exports` — `tsc` не видит `.parse` на импортированном значении,
 * хотя в рантайме `module.exports` — сразу объект с `.parse` (см. index.js
 * пакета: `exports = module.exports = parser`, без вложенного `.default`).
 * Эта декларация — тот же интерфейс, что в оригинальном `index.d.ts`, но
 * объявленный внутри ESM-пакета (`@harnas/desktop`), где `export default`
 * типизируется как обычный дефолтный экспорт, — она полностью замещает типы
 * пакета (объявления для одного и того же имени модуля не сливаются с
 * файловыми) и поведения не меняет, только чинит типизацию.
 */
declare module 'gitdiff-parser' {
  export type ChangeType = 'insert' | 'delete' | 'normal';

  export interface InsertChange {
    type: 'insert';
    content: string;
    lineNumber: number;
    isInsert: true;
  }

  export interface DeleteChange {
    type: 'delete';
    content: string;
    lineNumber: number;
    isDelete: true;
  }

  export interface NormalChange {
    type: 'normal';
    content: string;
    isNormal: true;
    oldLineNumber: number;
    newLineNumber: number;
  }

  export type Change = InsertChange | DeleteChange | NormalChange;

  export interface Hunk {
    content: string;
    oldStart: number;
    newStart: number;
    oldLines: number;
    newLines: number;
    changes: Change[];
  }

  export type FileType = 'add' | 'delete' | 'modify' | 'rename' | 'copy';

  export interface File {
    hunks: Hunk[];
    oldEndingNewLine: boolean;
    newEndingNewLine: boolean;
    oldMode: string;
    newMode: string;
    similarity?: number;
    oldRevision: string;
    newRevision: string;
    oldPath: string;
    newPath: string;
    isBinary?: boolean;
    type: FileType;
  }

  const gitDiffParser: {
    parse(source: string): File[];
  };
  export default gitDiffParser;
}
