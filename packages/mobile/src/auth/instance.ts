// The app's single gate, on the real modules.
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { createApprove } from './approve';
import { createFaceIdSetting } from './face-id-setting';

export const faceIdSetting = createFaceIdSetting({
  getItemAsync: (key) => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
});

export const approve = createApprove({ auth: LocalAuthentication, isRequired: () => faceIdSetting.get() });

/**
 * The gate in the shape A15's cards expect (`Approve = (kind: 'allow' | 'always' | 'plan') => Promise<boolean>`):
 * "Always" is an Allow, so it asks as one. Provide it with `<ApproveContext.Provider value={cardsApprove}>`.
 */
export const cardsApprove = async (kind: 'allow' | 'always' | 'plan'): Promise<boolean> =>
  (await approve(kind === 'plan' ? 'plan' : 'allow')) === 'ok';
