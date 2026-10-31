// "Require Face ID to allow" (D1 §11.6): the label depends on the biometry the phone has; turning the switch OFF
// is itself behind biometry. The gate that reads the flag on Allow / Accept is A16's.
import * as LocalAuthentication from 'expo-local-authentication';

export type BiometryKind = 'faceid' | 'touchid' | 'passcode';

export async function biometryKind(): Promise<BiometryKind> {
  if (!(await LocalAuthentication.isEnrolledAsync())) return 'passcode';
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'faceid';
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'touchid';
  return 'passcode';
}

export const biometryLabel = (k: BiometryKind): string => (k === 'touchid' ? 'Touch ID' : 'Face ID');
