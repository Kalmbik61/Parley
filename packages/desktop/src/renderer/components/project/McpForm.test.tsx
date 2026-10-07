import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilitySnapshot } from '@parley/protocol';
import { McpForm, parseMcpReadmeJson } from './McpForm.js';
import type { McpFormProps } from './McpForm.js';
const yes = { allowed: true as const, reason: null }; const no = { allowed: false as const, reason: 'unsupported-scope' as const };
const snapshot = (): CapabilitySnapshot => ({ projectPath: '/project', revision: 5, rows: [], columns: {
  claude: { phase: 'ready', diagnostics: [], mcpAdd: { user: yes, project: yes, local: yes } },
  codex: { phase: 'ready', diagnostics: [], mcpAdd: { user: yes, project: no, local: no } },
} });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() { const submit = vi.fn<McpFormProps['submit']>().mockResolvedValue([{ provider: 'claude', result: { outcome: 'ok', code: 'ok' } }]);
  const onCancel = vi.fn(); render(<McpForm snapshot={snapshot()} submit={submit} onCancel={onCancel} />); return { submit, onCancel }; }
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const send = () => fireEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));

describe('explicit MCP input form', () => {
 it('sends stdio boundaries to both providers with explicit selected Claude scope', async () => {
  const { submit } = setup(); change('Server name', 'example'); change('Command', 'node'); change('Arguments (one per line)', 'server.js\narg with spaces'); change('Environment (JSON object)', '{"TOKEN":"INPUT_SECRET"}'); change('Claude scope', 'local'); send();
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0]?.[0]).toEqual(['claude', 'codex'].map(provider => ({ projectPath: '/project', revision: 5, provider, scope: provider === 'claude' ? 'local' : 'user', name: 'example', input: { kind: 'stdio', command: 'node', args: ['server.js', 'arg with spaces'], env: { TOKEN: 'INPUT_SECRET' } } })));
  await screen.findByText('Claude · Done');
 });
 it('does not silently lose unsupported headers when Codex is selected', () => {
  const { submit } = setup(); change('Server name', 'example'); change('Transport', 'http'); change('URL', 'https://example.test/INPUT_SECRET'); change('Headers (JSON object)', '{"Authorization":"INPUT_SECRET"}'); send();
  expect(submit).not.toHaveBeenCalled(); expect(screen.getByRole('alert').textContent).toBe('Check the input and selected providers. Unsupported fields cannot be added.');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Codex' })); send(); expect(submit).toHaveBeenCalledTimes(1);
  expect(submit.mock.calls[0]?.[0][0]?.input).toEqual({ kind: 'http', url: 'https://example.test/INPUT_SECRET', headers: { Authorization: 'INPUT_SECRET' } });
 });
 it('supports Codex bearer env name and rejects token values or unsafe names', () => {
  const { submit } = setup(); fireEvent.click(screen.getByRole('checkbox', { name: 'Claude' })); change('Server name', 'example'); change('Transport', 'http'); change('URL', 'https://example.test'); change('Codex bearer token environment variable', 'Bearer INPUT_SECRET'); send(); expect(submit).not.toHaveBeenCalled();
  change('Codex bearer token environment variable', 'MCP_TOKEN'); send(); expect(submit.mock.calls[0]?.[0][0]?.input).toEqual({ kind: 'http', url: 'https://example.test', bearerTokenEnvVar: 'MCP_TOKEN' });
 });
 it('requires explicit selection from a multi-server README block and sends only that server', () => {
  const { submit } = setup(); change('Transport', 'json'); change('Server JSON or mcpServers block', JSON.stringify({ mcpServers: { first: { command: 'node' }, second: { command: 'uvx', args: ['package'] } } }));
  fireEvent.click(screen.getByRole('button', { name: 'Use JSON' })); send(); expect(submit).not.toHaveBeenCalled();
  change('Choose a server', 'second'); send();
  expect(submit.mock.calls[0]?.[0][0]).toMatchObject({ name: 'second', input: { kind: 'json', server: { command: 'uvx', args: ['package'] } } });
 });
 it('handles malformed/unsupported/oversized JSON without error excerpts or logs', () => {
  const warn = vi.spyOn(console, 'warn'); const error = vi.spyOn(console, 'error'); setup(); change('Transport', 'json'); change('Server JSON or mcpServers block', '{ INPUT_SECRET'); fireEvent.click(screen.getByRole('button', { name: 'Use JSON' }));
  expect(screen.getByRole('alert').textContent).not.toContain('INPUT_SECRET'); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  for (const value of ['[]', '{"command":"node","cwd":"/secret"}', '{"type":"sse","url":"https://example.test"}', JSON.stringify({ command: 'node', args: ['x'.repeat(65536)] })]) expect(parseMcpReadmeJson(value)).toBeNull();
 });
 it('retains bare one-server input without inventing a name and clears parsed JSON after edits', () => {
  expect(parseMcpReadmeJson('{"command":"node"}')?.[0]?.name).toBeNull(); const { submit, onCancel } = setup(); change('Server name', 'chosen'); change('Transport', 'json'); change('Server JSON or mcpServers block', '{"command":"node"}'); fireEvent.click(screen.getByRole('button', { name: 'Use JSON' }));
  change('Server JSON or mcpServers block', '{"command":"different"}'); send(); expect(submit).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(onCancel).toHaveBeenCalledTimes(1);
 });
 it('disables duplicate submission while queued and ignores completion after unmount', async () => {
  let resolve!: (value: Awaited<ReturnType<McpFormProps['submit']>>) => void; const submit = vi.fn<McpFormProps['submit']>(() => new Promise(done => { resolve = done; }));
  const view = render(<McpForm snapshot={snapshot()} submit={submit} onCancel={vi.fn()} />); change('Server name', 'example'); change('Command', 'node'); send(); send(); expect(submit).toHaveBeenCalledTimes(1); expect(screen.getByRole('button', { name: 'Add MCP server' }).hasAttribute('disabled')).toBe(true);
  view.unmount(); resolve([{ provider: 'claude', result: { outcome: 'ok', code: 'ok' } }]); await Promise.resolve(); expect(screen.queryByText('Claude · Done')).toBeNull();
 });
});
