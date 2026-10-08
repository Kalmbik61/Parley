import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { parse as parseToml, TomlError } from 'smol-toml';
import { LineCounter, parseDocument } from 'yaml';
import type {
  FrontmatterResult,
  InvalidMetadata,
  MetadataDiagnosticCode,
  MetadataResult,
} from './types.js';

/** Inclusive ceiling for the whole SKILL.md, including its Markdown body. */
export const SKILL_DOCUMENT_MAX_BYTES = 65536;

function invalid(code: MetadataDiagnosticCode, line?: number, column?: number): InvalidMetadata {
  const diagnostic: InvalidMetadata['diagnostic'] = { code };
  if (line !== undefined && Number.isSafeInteger(line) && line > 0) diagnostic.line = line;
  if (column !== undefined && Number.isSafeInteger(column) && column > 0)
    diagnostic.column = column;
  return { status: 'invalid', diagnostic };
}

function mapping(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Full YAML parsing; semantic fields remain untouched for the caller's schema. */
export function parseYamlDocument(text: string): MetadataResult {
  try {
    const lineCounter = new LineCounter();
    const document = parseDocument(text, {
      version: '1.2',
      strict: true,
      uniqueKeys: true,
      lineCounter,
      prettyErrors: false,
    });
    const error = document.errors[0];
    if (error !== undefined) {
      const position = lineCounter.linePos(error.pos[0]);
      return invalid('invalid-yaml', position.line, position.col);
    }
    const data: unknown = document.toJS({ maxAliasCount: 100 });
    return mapping(data) ? { status: 'valid', data } : invalid('invalid-yaml');
  } catch {
    // Alias expansion errors may include source details; never return the exception.
    return invalid('invalid-yaml');
  }
}

/** Shared by native settings and roles; no merging or field coercion happens here. */
export function parseTomlDocument(text: string): MetadataResult {
  try {
    const data: unknown = parseToml(text, {
      integersAsBigInt: 'asNeeded',
      useLegacyDate: true,
      unsafeKeyBehaviour: 'throw',
      maxDepth: 100,
    });
    return mapping(data) ? { status: 'valid', data } : invalid('invalid-toml');
  } catch (error) {
    return error instanceof TomlError
      ? invalid('invalid-toml', error.line, error.column)
      : invalid('invalid-toml');
  }
}

/** Only the initial closed, unindented YAML header is parsed; the body is discarded. */
export function parseMarkdownFrontmatter(text: string): FrontmatterResult {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  const delimiter = /^---[ \t]*$/;
  if (!delimiter.test(lines[0] ?? '')) return { status: 'missing' };
  const end = lines.findIndex((line, index) => index > 0 && delimiter.test(line));
  if (end < 0) return invalid('invalid-yaml');
  const result = parseYamlDocument(lines.slice(1, end).join('\n') + '\n');
  if (result.status === 'invalid' && result.diagnostic.line !== undefined) {
    return invalid(result.diagnostic.code, result.diagnostic.line + 1, result.diagnostic.column);
  }
  return result;
}

async function readDocument<T extends FrontmatterResult>(
  file: string,
  maxBytes: number,
  parse: (text: string) => T,
): Promise<T | InvalidMetadata> {
  try {
    // Nonblocking open prevents FIFOs from waiting for a writer before descriptor validation.
    // fstat checks the opened object, so a path swap cannot bypass special-file rejection.
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return invalid('unreadable');
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      // FileHandle.read may return a partial read; keep the entire limit-plus-one bounded.
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maxBytes) return invalid('file-too-large');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
      } catch {
        return invalid('invalid-utf8');
      }
      return parse(text);
    } finally {
      await handle.close();
    }
  } catch {
    return invalid('unreadable');
  }
}

/** Commands may return missing; SKILL.md consumers apply their own metadata schema. */
export function readMarkdownFrontmatter(
  file: string,
  maxBytes = SKILL_DOCUMENT_MAX_BYTES,
): Promise<FrontmatterResult> {
  return readDocument(file, maxBytes, parseMarkdownFrontmatter);
}

/** Callers choose their policy/settings input ceiling instead of inheriting the skill limit. */
export function readYamlDocument(file: string, maxBytes: number): Promise<MetadataResult> {
  return readDocument(file, maxBytes, parseYamlDocument);
}

export function readTomlDocument(file: string, maxBytes: number): Promise<MetadataResult> {
  return readDocument(file, maxBytes, parseTomlDocument);
}
