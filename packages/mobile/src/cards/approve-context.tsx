import { createContext, useContext } from 'react';
import Constants from 'expo-constants';
import { passThroughApprove, type Approve } from './model';

/**
 * Fails closed: without a provider no approval goes through (a screen outside the tree, a modal stack, a test build
 * must never skip Face ID silently). A16 provides the real gate. Developer builds started with
 * PARLEY_MOBILE_DEV_APPROVE=1 pass everything through, for simulator runs before the gate is wired.
 */
const failClosed: Approve = async () => {
  if (__DEV__ && Constants.expoConfig?.extra?.devApprove === true) return passThroughApprove('allow');
  console.warn('[approve] no ApproveContext provider: approval refused');
  return false;
};

export const ApproveContext = createContext<Approve>(failClosed);
export const useApprove = (): Approve => useContext(ApproveContext);
