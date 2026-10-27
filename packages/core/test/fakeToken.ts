/** Builds a token-shaped fake at runtime, so no token-shaped literal ever appears in source. */
export const fakeToken = (prefix: string, seed: string) => `${prefix}_${seed.padEnd(36, "0")}`;
