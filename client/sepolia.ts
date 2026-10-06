// Public deployment configuration. No keys or RPC credentials are stored here.
export interface SepoliaConfiguration {
  chainId: string;
  rpcUrl: string;
  pool: string;
  factory: string;
  relayer: string;
  feeRecipient: string;
  gasFee: string;
}
export const sepoliaChainId = 11155111n;
export const sepoliaEntrypoint = '0x34a2068192b1297f2a7f85d7d8cde66f8f0921cb';
