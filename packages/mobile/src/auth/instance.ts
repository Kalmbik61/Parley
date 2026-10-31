// The app's single gate, on the real modules.
import * as LocalAuthentication from 'expo-local-authentication';
import { createApprove } from './approve';
import { runtime } from '../runtime/instance';

export const approve = createApprove({ auth: LocalAuthentication, isRequired: () => runtime.requireBiometric() });

/**
 * The gate in the shape A15's cards expect (`Approve = (kind: 'allow' | 'always' | 'plan') => Promise<boolean>`):
 * "Always" is an Allow, so it asks as one. Provide it with `<ApproveContext.Provider value={cardsApprove}>`.
 */
export const cardsApprove = async (kind: 'allow' | 'always' | 'plan'): Promise<boolean> =>
  (await approve(kind === 'plan' ? 'plan' : 'allow')) === 'ok';
