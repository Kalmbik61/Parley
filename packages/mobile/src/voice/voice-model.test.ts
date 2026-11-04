import { describe, expect, it } from 'vitest';
import {
  INITIAL_VOICE,
  canDelegate,
  fallbackScreen,
  orbStateOf,
  reduceVoice,
  type VoiceEvent,
  type VoiceJobView,
  type VoiceModel,
  type VoiceState,
} from './voice-model.js';

const m = (state: VoiceState, extra: Partial<VoiceModel> = {}): VoiceModel => ({ state, thinking: false, delegations: 0, macReachable: true, ...extra });
const run = (events: VoiceEvent['type'][], from: VoiceModel = INITIAL_VOICE): VoiceModel => events.reduce((acc, type) => reduceVoice(acc, { type }), from);

describe('reduceVoice', () => {
  it('нормальный путь: idle → connecting → listening → speaking → listening → idle', () => {
    expect(run(['start']).state).toBe('connecting');
    expect(run(['start', 'connected']).state).toBe('listening');
    expect(run(['start', 'connected', 'speechStart']).state).toBe('speaking');
    expect(run(['start', 'connected', 'speechStart', 'speechEnd']).state).toBe('listening');
    expect(run(['start', 'connected', 'stop']).state).toBe('idle');
  });

  it('делегирование: delegating до конца работы, речь посреди не теряет счётчик', () => {
    const delegating = run(['start', 'connected', 'delegateStart']);
    expect(delegating).toMatchObject({ state: 'delegating', delegations: 1 });
    const spoke = run(['speechStart', 'speechEnd'], delegating);
    expect(spoke.state).toBe('delegating');
    expect(run(['delegateEnd'], spoke).state).toBe('listening');
    expect(run(['delegateStart', 'delegateEnd'], delegating).state).toBe('delegating');
  });

  it('пауза и возврат: возвращаемся в delegating, если работа идёт', () => {
    expect(run(['pause', 'resume'], m('listening')).state).toBe('listening');
    expect(run(['pause', 'resume'], m('delegating', { delegations: 1 })).state).toBe('delegating');
  });

  it('thinking: флаг в listening, сбрасывается началом речи', () => {
    const thinking = run(['thinking'], m('listening'));
    expect(thinking.thinking).toBe(true);
    expect(run(['speechStart'], thinking).thinking).toBe(false);
    expect(run(['thinking'], m('idle')).thinking).toBe(false);
  });

  it('Mac пропал вне сессии: idle и connecting уходят в offline; macBack возвращает в idle', () => {
    const off = run(['macLost'], m('idle'));
    expect(off.state).toBe('offline');
    expect(orbStateOf(off, [])).toEqual({ orb: '10', caption: 'Mac not reachable' });
    expect(run(['macLost'], m('connecting')).state).toBe('offline');
    const back = run(['macBack'], off);
    expect(back).toMatchObject({ state: 'idle', macReachable: true });
    expect(canDelegate(m('listening'))).toBe(true);
  });

  it('Mac пропал посреди сессии: Live говорит дальше, делегирование отказано, подпись «Mac not reachable»', () => {
    for (const s of ['listening', 'speaking'] as const) {
      const lost = run(['macLost'], m(s));
      expect(lost).toMatchObject({ state: s, macReachable: false });
      expect(canDelegate(lost)).toBe(false);
      expect(reduceVoice(lost, { type: 'delegateStart' })).toBe(lost);
      expect(orbStateOf(lost, []).caption).toBe('Mac not reachable');
    }
    expect(orbStateOf(run(['macLost'], m('listening')), [])).toEqual({ orb: '02', caption: 'Mac not reachable' });
    const busy = run(['macLost'], m('delegating', { delegations: 2 }));
    expect(busy).toMatchObject({ state: 'delegating', delegations: 2 });
    expect(orbStateOf(busy, [running]).caption).toBe('Reading the room');
    expect(orbStateOf(busy, [{ state: 'running' }]).caption).toBe('Mac not reachable');
    expect(orbStateOf(run(['macLost'], m('paused')), []).caption).toBe('microphone off');
  });

  it('macBack возвращает делегирование; start без Mac не уходит в connecting', () => {
    const lost = run(['macLost'], m('listening'));
    const back = run(['macBack'], lost);
    expect(back.macReachable).toBe(true);
    expect(canDelegate(back)).toBe(true);
    expect(run(['delegateStart'], back).state).toBe('delegating');
    const idleNoMac = run(['stop'], lost);
    expect(idleNoMac).toMatchObject({ state: 'idle', macReachable: false });
    expect(reduceVoice(idleNoMac, { type: 'start' })).toBe(idleNoMac);
  });

  it('limitReached, fail, повторный start из error', () => {
    expect(run(['limitReached'], m('connecting')).state).toBe('limit_reached');
    expect(run(['limitReached'], m('listening')).state).toBe('limit_reached');
    expect(run(['fail'], m('speaking')).state).toBe('error');
    expect(run(['start'], m('error')).state).toBe('connecting');
    expect(run(['stop'], m('limit_reached')).state).toBe('idle');
  });

  it('недопустимые события игнорируются', () => {
    const idle = INITIAL_VOICE;
    expect(reduceVoice(idle, { type: 'connected' })).toBe(idle);
    expect(reduceVoice(idle, { type: 'speechEnd' })).toBe(idle);
    const lim = m('limit_reached');
    expect(reduceVoice(lim, { type: 'start' })).toBe(lim);
    expect(reduceVoice(m('offline'), { type: 'start' }).state).toBe('offline');
  });
});

const running: VoiceJobView = { state: 'running', step: 'Reading the room' };
const confirm: VoiceJobView = { state: 'needs_confirmation' };

describe('orbStateOf: десять соответствий', () => {
  const table: Array<[string, VoiceModel, VoiceJobView[], { orb: string; caption: string | null }]> = [
    ['1 idle → 01', m('idle'), [], { orb: '01', caption: null }],
    ['2 connecting → 03 «connecting»', m('connecting'), [], { orb: '03', caption: 'connecting' }],
    ['3 listening → 02', m('listening'), [], { orb: '02', caption: null }],
    ['4 thinking → 03', m('listening', { thinking: true }), [], { orb: '03', caption: null }],
    ['5 delegating → 04, подпись = шаг job', m('delegating', { delegations: 1 }), [running], { orb: '04', caption: 'Reading the room' }],
    ['6 needs_confirmation → 07', m('delegating', { delegations: 1 }), [running, confirm], { orb: '07', caption: null }],
    ['7 speaking → 06', m('speaking'), [], { orb: '06', caption: null }],
    ['8 paused → 01 «microphone off»', m('paused'), [], { orb: '01', caption: 'microphone off' }],
    ['9 offline → 10 «Mac not reachable»', m('offline'), [], { orb: '10', caption: 'Mac not reachable' }],
    ['10 error → 09', m('error'), [], { orb: '09', caption: null }],
  ];
  it.each(table)('%s', (_name, voice, jobs, expected) => {
    expect(orbStateOf(voice, jobs)).toEqual(expected);
  });

  it('needs_confirmation перекрывает delegating, но не пустой список и не паузу', () => {
    const voice = m('delegating', { delegations: 1 });
    expect(orbStateOf(voice, [running]).orb).toBe('04');
    expect(orbStateOf(voice, [running, confirm]).orb).toBe('07');
    expect(orbStateOf(m('paused'), [confirm]).orb).toBe('01');
    expect(orbStateOf(m('idle'), [confirm]).orb).toBe('01');
  });

  it('подпись delegating берётся из шага job, без шага — пустая', () => {
    expect(orbStateOf(m('delegating'), [{ state: 'running' }]).caption).toBeNull();
    expect(orbStateOf(m('delegating'), [{ state: 'completed', step: 'old' }, running]).caption).toBe('Reading the room');
  });

  it('05 и 08 никогда не выдаются', () => {
    const states: VoiceState[] = ['idle', 'connecting', 'listening', 'speaking', 'delegating', 'paused', 'offline', 'limit_reached', 'error'];
    for (const s of states) for (const t of [false, true]) for (const jobs of [[], [running], [confirm]]) {
      expect(['05', '08']).not.toContain(orbStateOf(m(s, { thinking: t }), jobs).orb);
    }
  });
});

describe('fallbackScreen (R15, VO-07)', () => {
  it('limit_reached ведёт на R15', () => {
    expect(fallbackScreen(m('limit_reached'))).toEqual({ reason: 'limit_reached' });
  });
  it('нет ключа на Mac ведёт на R15 даже в idle', () => {
    expect(fallbackScreen(m('idle'), { noKey: true })).toEqual({ reason: 'no_key' });
  });
  it('remoteVoice выключен ведёт на R15 с отдельной причиной', () => {
    expect(fallbackScreen(m('idle'), { remoteVoiceOff: true, noKey: true })).toEqual({ reason: 'remote_voice_off' });
  });
  it('в обычных состояниях R15 не нужен', () => {
    expect(fallbackScreen(m('listening'))).toBeNull();
    expect(fallbackScreen(m('error'), {})).toBeNull();
  });
});
