import * as bip39 from "bip39";

export function generateSeed(): string {
  return bip39.generateMnemonic();
}
