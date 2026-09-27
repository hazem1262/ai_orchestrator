export interface SecretStore {
  get(key: string): Promise<string | null>;
}
