import { BrowserProvider, JsonRpcProvider, ZeroAddress, formatEther, getAddress, parseEther } from 'ethers';
import type { Eip1193Provider } from 'ethers';
import { createPrivacyPoolsV1Adapter, inspectDeposit, minimumV1Funding, parseRecoveryFile,
  parseV1ReceiveCode, prepareV1PublicReceive, readV1Pool, relayDeposit, mined } from '../client/index.ts';
import type { DepositExecution, RecoveryFile } from '../client/index.ts';
import { inspectRecovery, recoveryTransaction } from '../recovery/core.ts';
import type { RecoveryArtifacts } from '../recovery/core.ts';
import type { SepoliaConfiguration } from '../client/sepolia.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const configuration: SepoliaConfiguration = await (await fetch('/configuration.json')).json();
const artifacts: RecoveryArtifacts = await (await fetch('/contracts.json')).json();
const deployment = { ...configuration, chainId: BigInt(configuration.chainId) };
const adapter = createPrivacyPoolsV1Adapter(deployment);
const reader = new JsonRpcProvider(configuration.rpcUrl, undefined, { cacheTimeout: -1 });
let wallet: BrowserProvider | undefined;
let file: RecoveryFile | undefined;
let deposit: DepositExecution<'privacy-pools-v1'> | undefined;
let saved = false;
let busy = false;
let minimum = 0n;
let spent = false;
const wallets = new Map<string, Eip1193Provider>();
const walletSelect = el<HTMLSelectElement>('wallet');
// EIP-6963 lets Cloaked coexist with another wallet. Names are display text, never trust signals.
window.addEventListener('eip6963:announceProvider', event => {
  const detail = (event as CustomEvent<{info?: {uuid?: string; name?: string}; provider?: Eip1193Provider}>).detail;
  const id = detail?.info?.uuid;
  const name = detail?.info?.name;
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id) || typeof name !== 'string'
    || !name.trim() || typeof detail?.provider?.request !== 'function' || wallets.has(id)) return;
  if (wallets.size === 0) walletSelect.replaceChildren();
  wallets.set(id, detail.provider);
  const option = document.createElement('option');
  option.value = id; option.textContent = name.slice(0, 80); walletSelect.append(option);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
walletSelect.addEventListener('change', () => {
  wallet?.destroy(); wallet = undefined;
  input('relay').disabled = true;
  el('status').textContent = 'Connect the selected wallet to continue.';
  render();
});

function error(value: unknown) {
  el('error').textContent = value instanceof Error ? value.message : String(value);
  el('error').hidden = !value;
}
function render() {
  el('create-form').hidden = !!file;
  el('deposit').hidden = !file;
  el('refresh').hidden = false;
  el('wallet-tools').hidden = !file;
  if (file) {
    el('address').textContent = file.depositAddress;
    el('recovery-wallet').textContent = `Recovery wallet: ${file.config.recovery}`;
    el('pool-note').hidden = !spent;
    el('relay-note').textContent = `Manual relay wallet: ${file.config.relayer}`;
    el('backup-note').textContent = saved ? 'Recovery file saved. Share it with the recipient and keep it until recovery is no longer needed.'
      : 'Save this public configuration before sending funds. The recipient needs it for recovery.';
  }
}
async function act(work: () => Promise<void>) {
  if (busy) return;
  busy = true; error('');
  walletSelect.disabled = true;
  for (const button of document.querySelectorAll<HTMLButtonElement>('button')) button.disabled = true;
  try { await work(); }
  catch (cause) { error(cause); }
  finally {
    let relayReady = false;
    if (file) {
      try { relayReady = await refreshBalance(); }
      catch (cause) { error(cause); }
    }
    busy = false;
    walletSelect.disabled = false;
    for (const button of document.querySelectorAll<HTMLButtonElement>('button')) button.disabled = false;
    input('relay').disabled = !relayReady;
    render();
  }
}
async function getWalletSigner() {
  if (!wallet) throw new Error('Connect the manual relay or recovery wallet below.');
  if ((await wallet.getNetwork()).chainId !== deployment.chainId) throw new Error('Switch your wallet to Sepolia.');
  return wallet.getSigner();
}
async function poolRules() {
  const pool = await readV1Pool(reader, deployment, ZeroAddress);
  minimum = minimumV1Funding(pool.minimumDepositAmount, BigInt(configuration.gasFee));
  el('minimum').textContent = `Minimum to send: ${formatEther(minimum)} ETH, including Puddle and relay fees.`;
  el('fees').textContent = `Puddle: 0.1%. Relay: ${formatEther(configuration.gasFee)} ETH. Privacy Pools: ${Number(pool.vettingFeeBPS) / 100}%.`;
  if (!input('amount').value) input('amount').value = formatEther(minimum);
  return pool;
}
async function refreshBalance() {
  if (!file) return false;
  // Verify the compiled factory, implementation, clone and recovery owner before trusting balances.
  await inspectRecovery(reader, file, artifacts);
  const amount = deposit?.quote.amount ?? 0n;
  const record = { protocol: 'privacy-pools-v1' as const, ...deployment, address: file.depositAddress,
    salt: file.salt, config: file.config };
  const state = await inspectDeposit(adapter, { ...record, quote: { token: ZeroAddress, amount,
    gasFee: 0n, deadline: 0n }, data: '0x' }, reader);
  spent = state.spent;
  const shortfall = amount > state.balance ? amount - state.balance : 0n;
  el('funding').textContent = spent ? `Pool deposit completed. ${formatEther(state.balance)} ETH remains at this address.`
    : !deposit ? `${formatEther(state.balance)} ETH is available at this address. The saved file restores recovery; it does not restore a relay quote.`
    : `Received ${formatEther(state.balance)} of ${formatEther(amount)} ETH.${shortfall ? ` Send another ${formatEther(shortfall)} ETH to continue, or recover.` : ' Ready for manual relay.'}`;
  render();
  return !!wallet && saved && !!deposit && state.ready;
}
function consumeLink() {
  if (!location.hash) return;
  const link = location.href;
  history.replaceState(null, '', location.pathname);
  if (file) { error('Finish the current deposit before opening another receive link.'); return; }
  try { input('receive-code').value = JSON.stringify(parseV1ReceiveCode(link)); }
  catch (cause) { error(cause); }
}
consumeLink();
window.addEventListener('hashchange', consumeLink);

el('connect').addEventListener('click', () => void act(async () => {
  const ethereum = wallets.get(walletSelect.value)
    ?? (wallets.size === 0 ? (window as unknown as { ethereum?: Eip1193Provider }).ethereum : undefined);
  if (!ethereum) throw new Error('Open this page with an Ethereum browser wallet.');
  await ethereum.request({ method: 'eth_requestAccounts' });
  wallet?.destroy();
  wallet = new BrowserProvider(ethereum, undefined, { cacheTimeout: -1 });
  if ((await wallet.getNetwork()).chainId !== deployment.chainId) {
    wallet.destroy(); wallet = undefined;
    throw new Error('Switch your wallet to Sepolia, then connect again.');
  }
  el('status').textContent = `Connected: ${await (await getWalletSigner()).getAddress()}`;
}));
el('create-form').addEventListener('submit', event => {
  event.preventDefault();
  void act(async () => {
    const pool = await poolRules();
    const code = parseV1ReceiveCode(input('receive-code').value.trim());
    if (code.asset !== ZeroAddress) throw new Error('This test supports Sepolia ETH only.');
    const amount = parseEther(input('amount').value);
    if (amount < minimum) throw new Error(`Send at least ${formatEther(minimum)} ETH, including fees.`);
    const block = await reader.getBlock('latest');
    if (!block) throw new Error('Could not read the chain.');
    const prepared = await prepareV1PublicReceive(reader, deployment, {
      relayer: configuration.relayer, feeRecipient: configuration.feeRecipient, token: ZeroAddress,
      amount, gasFee: BigInt(configuration.gasFee), deadline: BigInt(block.timestamp + 3600),
    }, code);
    await inspectRecovery(reader, prepared.recovery, artifacts);
    file = prepared.recovery; deposit = prepared.deposit; saved = false;
    const value = amount - amount / 1000n - BigInt(configuration.gasFee);
    el('status').textContent = `Expected pool balance: ${formatEther(value - value * pool.vettingFeeBPS / 10000n)} ETH, pending approval.`;
  });
});
el('save').addEventListener('click', () => void act(async () => {
  if (!file) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `puddle-${file.depositAddress}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
  saved = true;
}));
el('relay').addEventListener('click', () => void act(async () => {
  if (!deposit || !file || !saved) throw new Error('Save the recovery file before relaying.');
  await inspectRecovery(reader, file, artifacts);
  const tx = await relayDeposit(adapter, deposit, await getWalletSigner());
  el('status').textContent = `Relay submitted: ${tx.hash}`;
  await mined(Promise.resolve(tx));
  el('status').textContent = `Pool deposit confirmed: ${tx.hash}`;
}));
el('recover').addEventListener('click', () => void act(async () => {
  if (!file) throw new Error('Open a recovery file first.');
  const asset = input('recover-asset').value.trim() ? getAddress(input('recover-asset').value.trim()) : ZeroAddress;
  const signer = await getWalletSigner();
  const account = await signer.getAddress();
  const status = await inspectRecovery(reader, file, artifacts, asset);
  if (!status.deployed) {
    await mined(signer.sendTransaction({ ...await recoveryTransaction(reader, file, artifacts, account, asset, 'deploy'), chainId: deployment.chainId }));
  }
  const tx = await signer.sendTransaction({ ...await recoveryTransaction(reader, file, artifacts, account, asset, 'recover'), chainId: deployment.chainId });
  el('status').textContent = `Recovery submitted: ${tx.hash}`;
  await mined(Promise.resolve(tx));
  el('status').textContent = `Recovered to ${file.config.recovery}. Transaction: ${tx.hash}`;
}));
el('restore').addEventListener('change', () => void act(async () => {
  const selected = input('restore').files?.[0];
  if (!selected) return;
  if (selected.size > 16_384) throw new Error('Recovery file is too large.');
  const restored = parseRecoveryFile(await selected.text());
  if (restored.protocol !== 'privacy-pools-v1' || restored.chainId !== configuration.chainId
    || restored.pool !== getAddress(configuration.pool) || restored.factory !== getAddress(configuration.factory)
    || restored.asset !== ZeroAddress) throw new Error('This recovery file belongs to another deployment.');
  await inspectRecovery(reader, restored, artifacts);
  file = restored; saved = true; deposit = undefined;
  el('status').textContent = 'Recovery file restored. Funds at the address can be recovered without Privacy Pools secrets.';
}));
el('refresh').addEventListener('click', () => void act(async () => {
  // A closed pool must not prevent recovery of funds still at the receive address.
  await poolRules();
}));
render();
void act(async () => { await poolRules(); });
