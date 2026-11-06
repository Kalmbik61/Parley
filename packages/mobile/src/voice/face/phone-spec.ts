// Облик роя на телефоне: те же правила, что у острова, но без лица и рта. `face` становится сферой с палитрой и `dim`
// эмоции — как мини-вид острова; нет связи с Mac — облик «offline» острова.
import { swarmSpecFor, swarmSpecForLive, type SwarmLive, type SwarmSpec } from '@parley/core/swarm';

export interface PhoneSwarmState {
  link: 'online' | 'offline';
  live: SwarmLive;
}

export function phoneSwarmSpec({ link, live }: PhoneSwarmState): SwarmSpec {
  if (link === 'offline') return swarmSpecFor({ phase: 'offline', mood: 'calm' }, 'idle', false);
  const spec = swarmSpecForLive(live, false);
  return spec.shape === 'face' ? { ...spec, shape: 'sphere', emo: null } : spec;
}
