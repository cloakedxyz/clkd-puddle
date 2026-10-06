export const decimals = 6;
export const gasFee = 200_000n;
export type DemoProtocol = 'railgun' | 'privacy-pools-v1';
export type DemoAsset = 'USDC' | 'ETH';
export const assetDecimals = (asset: DemoAsset) => asset === 'ETH' ? 18 : 6;

export interface Quote {
  amount: string;
  serviceFee: string;
  gasFee: string;
  protocolFee: string;
  received: string;
}

export type Phase = 'ready' | 'funding' | 'funded' | 'shielding' | 'verifying'
  | 'complete' | 'recovering' | 'recovered' | 'error';

export interface DepositView {
  protocol: DemoProtocol;
  asset: DemoAsset;
  address: string;
  quote: Quote;
  phase: Phase;
  fundingTx?: string;
  shieldingTx?: string;
  recoveryTx?: string;
  received?: string;
  commitment?: string;
  error?: string;
}

export interface AppState {
  recipient: string;
  recovery: string;
  relayer: string;
  feeRecipient: string;
  token: string;
  pool: string;
  factory: string;
  privateBalance: string;
  v1: { chainId: string; factory: string; pool: string; token: string; feeRecipient: string };
  deposit: DepositView | null;
}

export function quoteAmount(input: string, protocol: DemoProtocol = 'railgun', asset: DemoAsset = 'USDC'): Quote {
  if (protocol === 'railgun' && asset !== 'USDC') throw new Error('Choose USDC for RAILGUN.');
  const places = assetDecimals(asset);
  if (!new RegExp(`^\\d{1,7}(\\.\\d{1,${places}})?$`).test(input)) {
    throw new Error(`Enter an amount with up to ${places} decimal places.`);
  }
  const [whole, fraction = ''] = input.split('.');
  const scale = 10n ** BigInt(places);
  const amount = BigInt(whole) * scale + BigInt(fraction.padEnd(places, '0'));
  if (amount < (asset === 'ETH' ? scale / 1000n : scale) || amount > (asset === 'ETH' ? 100n : 1_000_000n) * scale) {
    throw new Error(asset === 'ETH' ? 'Choose between 0.001 and 100 ETH for this test.' : 'Choose between 1 and 1,000,000 USDC for this test.');
  }
  const serviceFee = amount / 1_000n;
  const charge = asset === 'ETH' ? 100_000_000_000_000n : gasFee;
  const net = amount - serviceFee - charge;
  const protocolFee = net * (protocol === 'railgun' ? 25n : 100n) / 10_000n;
  return {
    amount: String(amount), serviceFee: String(serviceFee), gasFee: String(charge),
    protocolFee: String(protocolFee), received: String(net - protocolFee),
  };
}

export function formatAmount(units: string, asset: DemoAsset = 'USDC'): string {
  const value = BigInt(units);
  const places = assetDecimals(asset);
  const scale = 10n ** BigInt(places);
  const whole = (value / scale).toLocaleString('en-US');
  const fraction = (value % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
