import { ZeroAddress, getAddress } from 'ethers';
import { poseidon1, poseidon2, poseidon3 } from 'poseidon-lite';
import { v1Field } from '../protocols/privacy-pools-v1-data.ts';

export interface V1Secrets { nullifier: bigint; secret: bigint }
export interface V1Note extends V1Secrets { value: bigint; label: bigint }
export function v1Precommitment(secrets: V1Secrets): bigint {
  for (const value of [secrets.nullifier, secrets.secret]) {
    if (value <= 0n || value >= v1Field) throw new Error('Invalid v1 deposit secret.');
  }
  return poseidon2([secrets.nullifier, secrets.secret]);
}
export const v1Commitment = (note: V1Note) => poseidon3([note.value, note.label, v1Precommitment(note)]);
export const v1NullifierHash = (note: V1Secrets) => poseidon1([note.nullifier]);

// Private backup, separate from the non-secret Puddle recovery file. Never upload it.
export interface V1NoteBackup {
  format: 'privacy-pools-v1-note'; version: 1; chainId: string; pool: string;
  nullifier: string; secret: string; value: string | null; label: string | null;
}
export function createV1NoteBackup(chainId: bigint, pool: string, note: V1Secrets | V1Note): V1NoteBackup {
  return parseV1NoteBackup(JSON.stringify({ format: 'privacy-pools-v1-note', version: 1,
    chainId: String(chainId), pool, nullifier: String(note.nullifier), secret: String(note.secret),
    value: 'value' in note ? String(note.value) : null, label: 'label' in note ? String(note.label) : null }));
}
export function parseV1NoteBackup(text: string): V1NoteBackup {
  if (new TextEncoder().encode(text).length > 4096) throw new Error('V1 note backup is too large.');
  const v = JSON.parse(text) as V1NoteBackup;
  const keys = ['format', 'version', 'chainId', 'pool', 'nullifier', 'secret', 'value', 'label'];
  const number = (n: unknown, limit = v1Field): n is string => typeof n === 'string'
    && /^[1-9][0-9]{0,77}$/.test(n) && BigInt(n) < limit;
  if (!v || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))
    || v.format !== 'privacy-pools-v1-note' || v.version !== 1 || !number(v.chainId, 1n << 256n)
    || !number(v.nullifier) || !number(v.secret) || typeof v.pool !== 'string'
    || !/^0x[0-9a-fA-F]{40}$/.test(v.pool) || getAddress(v.pool) === ZeroAddress
    || !((v.value === null && v.label === null) || (number(v.value, 1n << 128n) && number(v.label)))) {
    throw new Error('Invalid v1 note backup.');
  }
  return { ...v, pool: getAddress(v.pool) };
}
