// Production wiring of the phone Live controller on react-native-webrtc and react-native-incall-manager (T1). Modelled on
// src/dev/voice-loopback.ts; no logic here: everything testable lives in live-controller.ts.
import InCallManager from 'react-native-incall-manager';
import { RTCPeerConnection, mediaDevices } from 'react-native-webrtc';
import type { LiveControllerDeps, LiveMic, LivePeer } from './live-controller.js';

/** The mic with a mute switch: a disabled track sends silence, the session stays open. */
export type MutableMic = LiveMic & { setEnabled(enabled: boolean): void };

/** Starts the audio session (voice chat route with echo cancellation, loud speaker) and opens the microphone. */
export async function openMic(): Promise<MutableMic> {
  InCallManager.start({ media: 'audio', auto: false });
  InCallManager.setForceSpeakerphoneOn(true);
  try {
    const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
    return {
      addTo: (peer) => {
        for (const track of stream.getTracks()) peer.addTrack(track, stream);
      },
      setEnabled: (enabled) => {
        for (const track of stream.getTracks()) track.enabled = enabled;
      },
      stop: () => {
        stream.getTracks().forEach((track) => track.stop());
        InCallManager.setForceSpeakerphoneOn(false);
        InCallManager.stop();
      },
    };
  } catch (error) {
    InCallManager.setForceSpeakerphoneOn(false);
    InCallManager.stop();
    throw error;
  }
}

/** The peer has no ICE servers: the host answers with its own candidates in the SDP. The remote track plays natively. */
export const createPeer = (): LivePeer => new RTCPeerConnection({ iceServers: [] }) as unknown as LivePeer;

export const livePeerDeps: Pick<LiveControllerDeps, 'openMic' | 'createPeer'> = { openMic, createPeer };
