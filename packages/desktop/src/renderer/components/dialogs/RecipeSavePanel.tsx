/**
 * «Save as recipe» диалога «New session or room» (спека рецептов, 5.2): имя, описание, имя файла и плейбук; режим и
 * состав приходят из диалога. Файл пишет main (`app.saveRecipe`) — только в каталог рецептов проекта. Занятое имя
 * файла main не перезаписывает: панель предлагает Rename (поправить имя файла) или Replace (явный выбор человека).
 * Содержимое — вместо тела и подвала диалога: диалог остаётся в окне 800×500.
 */

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type { RecipeAgent } from '@parley/core';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { RECIPE_FILE_STEM, recipeFileStem } from '../../../shared/recipe-save.js';
import { errorText, S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { DialogFooter } from '../../ui/dialog.js';
import { Input } from '../../ui/input.js';
import { Textarea } from '../../ui/textarea.js';

export interface RecipeSavePanelProps {
  bridge: ParleyBridge;
  projectPath: string;
  mode: 'free' | 'checklist' | 'verified';
  /** Состав диалога; `null` — у какой-то строки нет роли, и рецепт из такого состава не собрать. */
  agents: RecipeAgent[] | null;
  /** Плейбук выбранного рецепта или шаблон этапов. */
  playbook: string;
  onBack: () => void;
  onSaved: (id: string) => void;
}

export function RecipeSavePanel({ bridge, projectPath, mode, agents, playbook, onBack, onSaved }: RecipeSavePanelProps): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState('');
  const [fileTouched, setFileTouched] = useState(false);
  const [text, setText] = useState(playbook);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const R = S.recipes;

  const save = async (replace: boolean): Promise<void> => {
    if (busy) return;
    if (agents === null) { setError(R.needRoles); return; }
    if (agents.length < 2) { setError(R.needAgents); return; }
    if (name.trim() === '' || description.trim() === '') { setError(R.nameRequired); return; }
    if (!RECIPE_FILE_STEM.test(file)) { setError(R.fileInvalid); return; }
    setBusy(true); setError(null);
    try {
      const result = await bridge.app.saveRecipe({
        projectPath, file, name: name.trim(), description: description.trim(), mode, agents,
        playbook: text.trim() === '' ? '' : `${text.trimEnd()}\n`, replace,
      });
      if (result.status === 'exists') { setExists(true); return; }
      toast(result.opened ? R.saved(name.trim()) : R.savedNotOpened(name.trim()));
      onSaved(result.id);
    } catch (err) {
      console.warn('[parley] saveRecipe', err);
      setError(errorText(decodeIpcError(err).code, S.errors.actions.saveRecipe));
    } finally { setBusy(false); }
  };

  const renameFile = (): void => { setExists(false); fileInput.current?.focus(); fileInput.current?.select(); };

  return (
    <>
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        <p className="m-0 text-xs text-neutral-700">{R.saveHint}</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex min-w-0 flex-col gap-1">
            {R.nameField}
            <Input value={name} disabled={busy} onChange={(event) => { setName(event.target.value); if (!fileTouched) { setFile(recipeFileStem(event.target.value)); setExists(false); } }} />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            {R.fileField}
            <Input ref={fileInput} value={file} disabled={busy} spellCheck={false}
              onChange={(event) => { setFile(event.target.value); setFileTouched(true); setExists(false); }} />
          </label>
        </div>
        <label className="flex min-w-0 flex-col gap-1">
          {R.descriptionField}
          <Input value={description} disabled={busy} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          {R.playbookField}
          <Textarea value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
        </label>
      </div>
      <DialogFooter className="items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
          {error !== null ? <p role="alert" className="break-words text-destructive">{error}</p> : null}
          {exists ? <p role="alert" data-recipe-exists className="break-words text-destructive">{R.exists(file)}</p> : null}
        </div>
        <Button type="button" variant="outline" disabled={busy} onClick={onBack}>{R.back}</Button>
        {exists ? (
          <>
            <Button type="button" variant="outline" disabled={busy} onClick={renameFile}>{R.rename}</Button>
            <Button type="button" disabled={busy} onClick={() => void save(true)}>{R.replace}</Button>
          </>
        ) : (
          <Button type="button" disabled={busy} onClick={() => void save(false)}>{R.confirmSave}</Button>
        )}
      </DialogFooter>
    </>
  );
}
