import { bech32m } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { AbiCoder, concat, getBytes, hexlify, sha256, toBeHex } from 'ethers';

export const railgunRecipientTypes = ['bytes32', 'tuple(bytes32[3] encryptedBundle,bytes32 shieldKey)'];
const field = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Public information decoded from a RAILGUN V2 receive address. Never a private viewing key. */
export interface RailgunRecipient {
  masterPublicKey: bigint;
  viewingPublicKey: Uint8Array;
  chainId?: bigint;
}

export function decodeRailgunAddress(address: string, chainId?: bigint): RailgunRecipient {
  try {
    if (!address.startsWith('0zk1') || address.length !== 127) throw new Error();
    const decoded = bech32m.decode(address as `${string}1${string}`, 127);
    const data = bech32m.fromWords(decoded.words);
    if (decoded.prefix !== '0zk' || data.length !== 73 || data[0] !== 1) throw new Error();
    const masterPublicKey = BigInt(hexlify(data.slice(1, 33)));
    if (masterPublicKey <= 0n || masterPublicKey >= field) throw new Error();
    const network = data.slice(33, 41);
    const mask = new TextEncoder().encode('railgun');
    for (let i = 0; i < mask.length; i++) network[i] ^= mask[i];
    const allChains = network.every(byte => byte === 255);
    const embeddedChain = allChains ? undefined : BigInt(hexlify(network.slice(1)));
    if (!allChains && (network[0] !== 0 || embeddedChain === 0n
      || (chainId !== undefined && embeddedChain !== chainId))) throw new Error();
    const viewingPublicKey = data.slice(41);
    const point = ed25519.ExtendedPoint.fromHex(viewingPublicKey);
    if (point.isSmallOrder() || !point.isTorsionFree()) throw new Error();
    return { masterPublicKey, viewingPublicKey, ...(embeddedChain === undefined ? {} : { chainId: embeddedChain }) };
  } catch { throw new Error('Enter a valid RAILGUN address for the destination chain.'); }
}

/**
 * Prepare the V2 shield note locally using Web Crypto and standard curve/hash libraries.
 * Encoding follows engine 9.8.0 ShieldNote.serialize; interoperability is tested against
 * that engine and the real pool. This encoding still requires independent review.
 * Ephemeral encryption material is discarded, never returned or sent to the service.
 */
export async function prepareRailgunRecipient(address: string, chainId: bigint): Promise<string> {
  const { masterPublicKey, viewingPublicKey } = decodeRailgunAddress(address, chainId);
  const random = crypto.getRandomValues(new Uint8Array(16));
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const extended = ed25519.utils.getExtendedPublicKey(seed);
  const shared = ed25519.ExtendedPoint.fromHex(viewingPublicKey).multiply(extended.scalar).toRawBytes();
  const sharedKey = new Uint8Array(getBytes(sha256(shared)));
  const gcmIV = crypto.getRandomValues(new Uint8Array(16));
  const ctrIV = crypto.getRandomValues(new Uint8Array(16));
  try {
    const gcmKey = await crypto.subtle.importKey('raw', sharedKey, 'AES-GCM', false, ['encrypt']);
    const ctrKey = await crypto.subtle.importKey('raw', seed, 'AES-CTR', false, ['encrypt']);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: gcmIV, tagLength: 128 }, gcmKey, random));
    const receiver = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CTR', counter: ctrIV, length: 128 }, ctrKey, new Uint8Array(viewingPublicKey)));
    const npk = toBeHex(poseidon2([masterPublicKey, BigInt(hexlify(random))]), 32);
    return AbiCoder.defaultAbiCoder().encode(railgunRecipientTypes, [npk, {
      encryptedBundle: [concat([gcmIV, encrypted.slice(16)]), concat([encrypted.slice(0, 16), ctrIV]), hexlify(receiver)],
      shieldKey: hexlify(extended.pointBytes),
    }]);
  } finally { seed.fill(0); random.fill(0); sharedKey.fill(0); shared.fill(0); }
}
