/**
 * Encrypted secrets store types.
 */

export type SecretScope = 'global' | 'repo';

export interface SecretEntry {
  key: string;
  scope: SecretScope;
  repo?: string;
  createdAt: string;
  updatedAt: string;
}
