// Voice loopback (B1, developer builds only): two RTCPeerConnection in one process, the microphone track of one is played
// out of the other. No signalling and no network: offer, answer and ICE candidates are handed over in memory. It proves that
// the native WebRTC module, the microphone permission and the loud-speaker route with echo cancellation work on the phone.
import InCallManager from 'react-native-incall-manager';
import { MediaStream, RTCPeerConnection, mediaDevices } from 'react-native-webrtc';

export type LoopbackState = 'idle' | 'starting' | 'connecting' | 'connected' | 'failed' | 'closed';

export type Loopback = { stop: () => void };

/**
 * Starts the loopback. `onState` gets the sending side's state; the first non-idle value is `starting`.
 * Rejects (after cleaning up) when the microphone is refused or the offer/answer exchange throws.
 */
export async function startLoopback(onState: (state: LoopbackState) => void): Promise<Loopback> {
  let stopped = false;
  let mic: MediaStream | null = null;
  const received: MediaStream[] = [];
  const sender = new RTCPeerConnection({ iceServers: [] });
  const receiver = new RTCPeerConnection({ iceServers: [] });
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const s of [mic, ...received]) s?.getTracks().forEach((t) => t.stop());
    sender.close();
    receiver.close();
    InCallManager.setForceSpeakerphoneOn(false);
    InCallManager.stop();
    onState('closed');
  };
  try {
    onState('starting');
    // playAndRecord + voiceChat (echo cancellation), then the loud-speaker route instead of the earpiece.
    // auto: false keeps the proximity sensor off (the screen must not go dark during a speaker test).
    InCallManager.start({ media: 'audio', auto: false });
    InCallManager.setForceSpeakerphoneOn(true);
    // The iOS audio unit WebRTC opens is the voice-processing one: echo cancellation is on by default.
    mic = await mediaDevices.getUserMedia({ audio: true, video: false });
    sender.addEventListener('connectionstatechange', () => {
      if (stopped) return;
      const s = sender.connectionState;
      onState(s === 'connected' ? 'connected' : s === 'failed' ? 'failed' : s === 'closed' ? 'closed' : 'connecting');
    });
    // Candidates cross over in memory.
    sender.addEventListener('icecandidate', (e) => {
      if (e.candidate) void receiver.addIceCandidate(e.candidate).catch(() => undefined);
    });
    receiver.addEventListener('icecandidate', (e) => {
      if (e.candidate) void sender.addIceCandidate(e.candidate).catch(() => undefined);
    });
    // The received track is played natively; keep the stream so Stop can end its tracks.
    receiver.addEventListener('track', (e) => {
      for (const s of e.streams) received.push(s);
    });
    for (const track of mic.getTracks()) sender.addTrack(track, mic);
    onState('connecting');
    const offer = await sender.createOffer({});
    await sender.setLocalDescription(offer);
    await receiver.setRemoteDescription(offer);
    const answer = await receiver.createAnswer();
    await receiver.setLocalDescription(answer);
    await sender.setRemoteDescription(answer);
    if (stopped) throw new Error('stopped');
    InCallManager.setForceSpeakerphoneOn(true);
  } catch (e) {
    stop();
    throw e;
  }
  return { stop };
}
