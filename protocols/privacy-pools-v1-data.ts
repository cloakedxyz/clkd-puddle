import { AbiCoder, Interface, ZeroAddress, getAddress } from 'ethers';

export const v1Field = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const v1Native = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const v1PoolAsset = (token: string) => getAddress(token) === ZeroAddress ? v1Native : getAddress(token);
export const v1RecipientTypes = ['address', 'address', 'uint256'];
export const v1ProofTuple = 'tuple(uint256[2] pA,uint256[2][2] pB,uint256[2] pC,uint256[4] pubSignals)';
export const v1EntrypointABI = new Interface([
  'function assetConfig(address) view returns (address pool,uint256 minimumDepositAmount,uint256 vettingFeeBPS,uint256 maxRelayFeeBPS)',
  'function usedPrecommitments(uint256) view returns (bool)',
]);
export const v1PoolABI = new Interface([
  'function ASSET() view returns (address)', 'function ENTRYPOINT() view returns (address)',
  'function dead() view returns (bool)', 'function depositors(uint256) view returns (address)',
  'function SCOPE() view returns (uint256)',
  'function nullifierHashes(uint256) view returns (bool)',
  'event Deposited(address indexed depositor,uint256 commitment,uint256 label,uint256 value,uint256 precommitment)',
  'event LeafInserted(uint256 index,uint256 leaf,uint256 root)',
]);
export const v1ForwarderABI = new Interface([
  `function ragequit(${v1ProofTuple} proof)`, 'function spent() view returns (bool)',
  'function assetPool() view returns (address)',
]);

export function decodeV1Recipient(recipient: string) {
  if (!/^0x[0-9a-fA-F]{192}$/.test(recipient)) throw new Error('Invalid v1 deposit instructions.');
  const [token, pool, precommitment] = AbiCoder.defaultAbiCoder().decode(v1RecipientTypes, recipient) as unknown as [string, string, bigint];
  if (pool === ZeroAddress || precommitment <= 0n || precommitment >= v1Field
    || AbiCoder.defaultAbiCoder().encode(v1RecipientTypes, [token, pool, precommitment]).toLowerCase() !== recipient.toLowerCase()) {
    throw new Error('Invalid v1 deposit instructions.');
  }
  return { token, pool, precommitment };
}
