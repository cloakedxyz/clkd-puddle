import { Contract, getAddress } from 'ethers';
import type { EventLog, Provider, TransactionRequest } from 'ethers';
import { groth16 } from 'snarkjs';
import { inspectRecovery } from './core.ts';
import type { RecoveryArtifacts, RecoveryFile } from './core.ts';
import { decodeV1Recipient, v1ForwarderABI, v1PoolABI } from '../protocols/privacy-pools-v1-data.ts';
import { v1Commitment, v1NullifierHash, v1Precommitment, parseV1NoteBackup } from './v1-note.ts';
import type { V1Note, V1NoteBackup } from './v1-note.ts';

// From the pinned upstream SDK manifest (d494b63e79f33bb2b0c8ece6cdacdca465c3b884).
export const v1RecoveryHashes = {
  wasm: '254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8',
  zkey: '494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3',
};
export async function verifyV1Artifact(data: Uint8Array, kind: keyof typeof v1RecoveryHashes) {
  const digest = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== v1RecoveryHashes[kind]) throw new Error(`Incorrect v1 recovery ${kind} file.`);
}

export async function inspectV1Note(provider: Provider, file: RecoveryFile, artifacts: RecoveryArtifacts,
  backup: V1NoteBackup, fromBlock = 0): Promise<{ note: V1Note; spent: boolean }> {
  if (file.protocol !== 'privacy-pools-v1') throw new Error('Choose a v1 recovery file.');
  backup = parseV1NoteBackup(JSON.stringify(backup));
  const recipient = decodeV1Recipient(file.config.recipient);
  if (backup.chainId !== file.chainId || getAddress(backup.pool) !== recipient.pool) {
    throw new Error('The note backup is for another chain or pool.');
  }
  const status = await inspectRecovery(provider, file, artifacts, recipient.token);
  if (!status.deployed || !await new Contract(file.depositAddress, v1ForwarderABI, provider).getFunction('spent')()) {
    throw new Error('This receiving address has not deposited into the pool. Recover its balance instead.');
  }
  const secrets = { nullifier: BigInt(backup.nullifier), secret: BigInt(backup.secret) };
  const pool = new Contract(recipient.pool, v1PoolABI, provider);
  let note: V1Note;
  if (backup.value !== null && backup.label !== null) {
    note = { ...secrets, value: BigInt(backup.value), label: BigInt(backup.label) };
  } else {
    if (v1Precommitment(secrets) !== recipient.precommitment) throw new Error('The secrets do not match this deposit.');
    if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) throw new Error('Invalid starting block.');
    const latest = await provider.getBlockNumber();
    let found: EventLog | undefined;
    for (let start = fromBlock; start <= latest && !found; start += 10_000) {
      const logs = await pool.queryFilter(pool.filters.Deposited(file.depositAddress), start, Math.min(latest, start + 9999));
      found = logs.find(log => 'args' in log && BigInt(log.args.precommitment) === recipient.precommitment) as EventLog | undefined;
    }
    if (!found) throw new Error('Deposit not found. Check the starting block and pool.');
    note = { ...secrets, value: BigInt(found.args.value), label: BigInt(found.args.label) };
    if (v1Commitment(note) !== BigInt(found.args.commitment)) throw new Error('Deposit does not match the backup.');
  }
  if (getAddress(await pool.getFunction('depositors')(note.label)) !== file.depositAddress) {
    throw new Error('This note belongs to another receiving address.');
  }
  const spent: boolean = await pool.getFunction('nullifierHashes')(v1NullifierHash(note));
  return { note, spent };
}

export async function prepareV1PoolRecovery(provider: Provider, file: RecoveryFile, artifacts: RecoveryArtifacts,
  account: string, backup: V1NoteBackup, files: { wasm: Uint8Array; zkey: Uint8Array }, fromBlock = 0,
): Promise<TransactionRequest> {
  if (getAddress(account) !== file.config.recovery) throw new Error('Connect the recovery wallet shown in the file.');
  const { note, spent } = await inspectV1Note(provider, file, artifacts, backup, fromBlock);
  if (spent) throw new Error('This note was spent. Use the current note backup after a partial withdrawal.');
  await Promise.all([verifyV1Artifact(files.wasm, 'wasm'), verifyV1Artifact(files.zkey, 'zkey')]);
  const result = await groth16.fullProve({ value: note.value, label: note.label,
    nullifier: note.nullifier, secret: note.secret }, files.wasm, files.zkey, undefined, undefined, { singleThread: true });
  const values = JSON.parse('[' + await groth16.exportSolidityCallData(result.proof, result.publicSignals) + ']') as unknown[];
  const expected = [v1Commitment(note), v1NullifierHash(note), note.value, note.label];
  if (result.publicSignals.length !== 4 || result.publicSignals.some((v, i) => BigInt(v) !== expected[i])) {
    throw new Error('Recovery proof does not match the note.');
  }
  const request = { from: file.config.recovery, to: file.depositAddress, chainId: BigInt(file.chainId), value: 0n,
    data: v1ForwarderABI.encodeFunctionData('ragequit', [values]) };
  // Check real pool membership, proof, unspent status and forwarding before requesting a signature.
  await provider.call(request);
  return request;
}
