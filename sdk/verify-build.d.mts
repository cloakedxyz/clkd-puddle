export function buildHash(value: Uint8Array | string): string;
export function verifySdkBuild(root?: string): Promise<{ outputs: number; sourceChecked: boolean }>;
