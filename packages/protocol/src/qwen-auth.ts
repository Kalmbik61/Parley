/** Sign-in hints of Qwen Code in `providers.list` (spec 2026-11-11, 3.6): hints, never an authentication verdict. */
export interface QwenAuthHints {
  /** `security.auth.selectedType` of the Qwen home's settings file; `null` — not set or the file is unreadable. */
  selectedType: string | null;
  /** `model.name` of the same file; `null` — not set. */
  model: string | null;
  /** `oauth_creds.json` exists in the Qwen home (presence only; never read). */
  oauthFilePresent: boolean;
  /** `OPENAI_API_KEY` is set in the host environment (presence only; never sent). */
  envKeyPresent: boolean;
  /** The first matching hint, in the precedence of the spec table. */
  hint: 'configured' | 'qwen-account' | 'env-key' | 'not-detected';
}
