// In-memory SecureStore double for tests.
import type { SecureStoreLike } from '../platform/key-store';

export const memoryStore = (): SecureStoreLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItemAsync: async (k) => data.get(k) ?? null,
    setItemAsync: async (k, v) => void data.set(k, v),
    deleteItemAsync: async (k) => void data.delete(k),
  };
};
