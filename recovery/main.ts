import { BrowserProvider, ZeroAddress, formatUnits, getAddress, isError } from 'ethers';
import type { Eip1193Provider } from 'ethers';
import { recoveryAsset, checkRecoveryAddress, inspectRecovery, maxRecoveryFileBytes, parseRecoveryFile,
  recoveryTransaction } from './core.ts';
import type { RecoveryArtifacts, RecoveryFile, RecoveryStatus } from './core.ts';
import { inspectV1Note, prepareV1PoolRecovery } from './v1.ts';
import { decodeV1Recipient } from '../protocols/privacy-pools-v1-data.ts';
import { parseV1NoteBackup } from './v1-note.ts';
import type { V1NoteBackup } from './v1-note.ts';

interface WalletProvider extends Eip1193Provider {
  on?(event: string, listener: () => void): void;
}
declare global { interface Window { ethereum?: WalletProvider } }

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

let artifacts: RecoveryArtifacts;
let file: RecoveryFile | undefined;
let wallet: WalletProvider | undefined;
let provider: BrowserProvider | undefined;
let status: RecoveryStatus | undefined;
let revision = 0;
let busy = false;
let noteBackup: V1NoteBackup | undefined;

function message(text: string, error = false) {
  const output = element('status');
  output.textContent = text;
  output.classList.toggle('error', error);
}

function invalidate() {
  revision++;
  status = undefined;
  element<HTMLButtonElement>('submit').hidden = true;
  element<HTMLButtonElement>('pool-submit').hidden = true;
  element('pool-balance').textContent = '—';
  element('balance').textContent = '—';
}

function asset(): string {
  return element<HTMLSelectElement>('asset-kind').value === 'native'
    ? ZeroAddress : getAddress(element<HTMLInputElement>('asset-address').value.trim());
}

function load(text: string) {
  invalidate();
  noteBackup = undefined;
  element<HTMLInputElement>('note-file').value = '';
  file = undefined;
  element('review').hidden = true;
  const parsed = parseRecoveryFile(text);
  checkRecoveryAddress(parsed, artifacts);
  file = parsed;
  element('v1-recovery').hidden = file.protocol !== 'privacy-pools-v1';
  for (const [id, value] of [
    ['chain', file.chainId], ['deposit', file.depositAddress], ['owner', file.config.recovery], ['factory', file.factory],
  ]) element(id).textContent = value;
  element<HTMLInputElement>('asset-address').value = recoveryAsset(file);
  element<HTMLSelectElement>('asset-kind').value = file.asset === ZeroAddress ? 'native' : 'token';
  element('token-field').hidden = file.asset === ZeroAddress;
  element('review').hidden = false;
  message('File loaded. Connect the recovery wallet to check the contract and balance.');
}

async function run(work: () => Promise<void>) {
  if (busy) return;
  busy = true;
  element<HTMLFieldSetElement>('controls').disabled = true;
  try { await work(); }
  catch (error) {
    invalidate();
    const text = isError(error, 'ACTION_REJECTED') ? 'Cancelled in your wallet. You can try again.'
      : isError(error, 'NETWORK_ERROR') ? 'The wallet network changed. Check the balance again.'
        : error instanceof Error ? error.message : 'Could not complete this action.';
    message(text.slice(0, 400), true);
  } finally { busy = false; element<HTMLFieldSetElement>('controls').disabled = false; }
}

async function connect() {
  if (provider) return;
  wallet = window.ethereum;
  if (!wallet) throw new Error('Open this page in a browser with your Ethereum wallet installed.');
  await wallet.request({ method: 'eth_requestAccounts' });
  provider = new BrowserProvider(wallet, 'any', { cacheTimeout: -1 });
  const changed = () => {
    invalidate();
    message('Wallet changed. Check the balance again.');
  };
  wallet.on?.('accountsChanged', changed);
  wallet.on?.('chainChanged', changed);
  wallet.on?.('disconnect', changed);
  element('check').textContent = 'Check balance';
}

async function account(): Promise<string> {
  if (!provider || !file) throw new Error('Load your file and connect your recovery wallet.');
  const accounts: string[] = await provider.send('eth_accounts', []);
  if (!accounts[0] || getAddress(accounts[0]) !== file.config.recovery) {
    throw new Error('Select the recovery wallet shown above, then check again.');
  }
  return getAddress(accounts[0]);
}

async function check() {
  if (!file) throw new Error('Load a recovery file first.');
  invalidate();
  const currentRevision = revision;
  await connect();
  await account();
  const checked = await inspectRecovery(provider!, file, artifacts, asset());
  if (currentRevision !== revision) return;
  status = checked;
  element('balance').textContent = `${formatUnits(status.balance, status.decimals)} ${status.symbol}`;
  const submit = element<HTMLButtonElement>('submit');
  submit.hidden = status.balance === 0n;
  submit.textContent = status.deployed ? 'Recover to your wallet' : 'Deploy recovery contract';
  message(status.balance === 0n
    ? file.protocol === 'privacy-pools-v1' ? 'No balance at the receive address. Load your private note backup below to check the pool.'
      : 'No balance for this asset. Funds already shielded stay in your protocol wallet.'
    : status.deployed ? 'Ready. Recovery returns this balance to the wallet shown above.'
      : 'Two wallet transactions: deploy the contract, then recover your funds.');
}

element<HTMLInputElement>('file').addEventListener('change', () => { void run(async () => {
  const selected = element<HTMLInputElement>('file').files?.[0];
  if (!selected) return;
  invalidate(); file = undefined; element('review').hidden = true;
  if (selected.size > maxRecoveryFileBytes) throw new Error('Recovery file is too large.');
  load(await selected.text());
}); });

element<HTMLInputElement>('note-file').addEventListener('change', () => { void run(async () => {
  invalidate(); noteBackup = undefined;
  const selected = element<HTMLInputElement>('note-file').files?.[0];
  if (!selected) return;
  if (selected.size > 4096) throw new Error('V1 note backup is too large.');
  noteBackup = parseV1NoteBackup(await selected.text());
  message('Private note loaded on this device. Check the pool balance.');
}); });
element('pool-check').addEventListener('click', () => { void run(async () => {
  if (!file || !noteBackup) throw new Error('Load the recovery file and private note backup first.');
  invalidate();
  const currentRevision = revision;
  await connect(); await account();
  const result = await inspectV1Note(provider!, file, artifacts, noteBackup,
    Number(element<HTMLInputElement>('from-block').value));
  const metadata = await inspectRecovery(provider!, file, artifacts, decodeV1Recipient(file.config.recipient).token);
  if (currentRevision !== revision) return;
  element('pool-balance').textContent = result.spent ? 'Note already spent'
    : `${formatUnits(result.note.value, metadata.decimals)} ${metadata.symbol}`;
  element<HTMLButtonElement>('pool-submit').hidden = result.spent;
  message(result.spent ? 'Use your current note backup after a partial withdrawal. A fully withdrawn note has nothing left to recover.'
    : 'Ready for public pool recovery. This links the withdrawal to the deposit. Paid fees are not refunded.');
}); });
element('from-block').addEventListener('input', invalidate);
element('pool-submit').addEventListener('click', () => { void run(async () => {
  if (!file || !provider || !noteBackup) throw new Error('Load and check your note first.');
  const currentRevision = revision;
  const owner = await account();
  message('Building the recovery proof on this device…');
  const buffers = await Promise.all(['wasm', 'zkey'].map(async extension => {
    const response = await fetch(`./v1/commitment.${extension}`);
    if (!response.ok) throw new Error('Recovery proof files are missing. Rebuild or restore this recovery site.');
    return new Uint8Array(await response.arrayBuffer());
  }));
  const request = await prepareV1PoolRecovery(provider, file, artifacts, owner, noteBackup,
    { wasm: buffers[0], zkey: buffers[1] }, Number(element<HTMLInputElement>('from-block').value));
  if (revision !== currentRevision) throw new Error('Wallet changed. Check the pool again.');
  await account();
  const signer = await provider.getSigner(owner);
  await provider.estimateGas(request);
  if (revision !== currentRevision) throw new Error('Wallet changed. Check the pool again.');
  message('Confirm the public pool recovery in your wallet.');
  const tx = await signer.sendTransaction(request);
  element('transaction').textContent = tx.hash;
  element('transaction-row').hidden = false;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error('Pool recovery failed. Check and retry.');
  invalidate();
  message('Pool recovery confirmed. Funds returned to the recovery wallet. Check the receive address for any remaining balance.');
}); });
element('load-paste').addEventListener('click', () => { void run(async () => {
  load(element<HTMLTextAreaElement>('paste').value);
}); });
element('asset-kind').addEventListener('change', () => {
  invalidate();
  element('token-field').hidden = element<HTMLSelectElement>('asset-kind').value === 'native';
  message('Check the balance for the selected asset.');
});
element('asset-address').addEventListener('input', () => { invalidate(); message('Check the balance for this token.'); });
element('check').addEventListener('click', () => { void run(check); });
element('submit').addEventListener('click', () => { void run(async () => {
  if (!file || !provider || !status) throw new Error('Check the balance first.');
  const action = status.deployed ? 'recover' : 'deploy';
  const currentRevision = revision;
  const owner = await account();
  const request = await recoveryTransaction(provider, file, artifacts, owner, asset(), action);
  // Recheck immediately before requesting a signature; never reuse an old transaction.
  const signer = await provider.getSigner(owner);
  if (currentRevision !== revision) throw new Error('Wallet changed. Check the balance again.');
  await account();
  await provider.estimateGas(request);
  if (currentRevision !== revision) throw new Error('Wallet changed. Check the balance again.');
  message('Review and confirm the transaction in your wallet.');
  const transaction = await signer.sendTransaction(request);
  element('transaction').textContent = transaction.hash;
  element('transaction-row').hidden = false;
  message('Transaction submitted. Waiting for confirmation…');
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error('Transaction did not succeed. Check the balance again.');
  if (currentRevision !== revision) return;
  await check();
  if (action === 'recover' && status?.balance === 0n) {
    message('Recovery confirmed. The funds were returned to your recovery wallet.');
  }
}); });

try {
  const response = await fetch('./contracts.json');
  if (!response.ok) throw new Error('Could not load this tool’s contract build. Reload the page.');
  artifacts = await response.json() as RecoveryArtifacts;
  element<HTMLFieldSetElement>('controls').disabled = false;
} catch (error) { message(error instanceof Error ? error.message : 'Could not load the recovery tool.', true); }
