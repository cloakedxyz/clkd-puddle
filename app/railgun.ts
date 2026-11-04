import { BrowserProvider, Contract, JsonRpcProvider, formatUnits, getAddress, parseUnits } from 'ethers';
import type { Eip1193Provider } from 'ethers';
import { createRailgunAdapter, prepareRailgunReceive, inspectDeposit, inspectRecovery,
  parseRecoveryFile, recoveryTransaction, recoveryRecord, relayDeposit, mined } from '../sdk/index.ts';
import type { DepositExecution, RecoveryArtifacts, RecoveryFile } from '../sdk/index.ts';
import { validateRailgunSiteConfiguration, siteDeployment } from './configuration.ts';
import { minimumMatchingAssetOutput, validateRelayFundingQuote } from '../sdk/relay.ts';
import type { RelayFundingQuote } from '../sdk/relay.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
};
const field = (id: string) => el<HTMLInputElement>(id);
const configuration = validateRailgunSiteConfiguration(await (await fetch('/configuration.json')).json());
const artifacts: RecoveryArtifacts = await (await fetch('/contracts.json')).json();
const deployment = siteDeployment(configuration);
const adapter = createRailgunAdapter(deployment);
const reader = new JsonRpcProvider(configuration.rpcTransport === 'direct' ? configuration.rpcUrl : `${location.origin}/api/rpc`,
  undefined, { batchMaxCount: 1, cacheTimeout: -1 });
const format = (value: bigint) => `${formatUnits(value, configuration.decimals)} ${configuration.symbol}`;
let deposit: DepositExecution | undefined;
let backup: RecoveryFile | undefined;
let saved = false;
let busy = false;
let wallet: BrowserProvider | undefined;
let connectedAddress: string | undefined;
let spent = false;
let ready = false;
let depositVerified = false;
let automaticFinished = false;
let remaining = 0n;
let bridge: RelayFundingQuote | undefined;
let bridgeSaved = false;
let bridgePreparedAt = 0;
const sources = el<HTMLSelectElement>('source-chain');
for (const origin of configuration.bridgeOrigins ?? []) {
  const option = document.createElement('option'); option.value = String(origin.chainId);
  option.textContent = `${origin.chainName} · via Relay`; sources.append(option);
}
sources.options[0].textContent = configuration.chainName;
const providers = new Map<string, Eip1193Provider>();
const wallets = el<HTMLSelectElement>('wallet-choice');

function report(error: unknown) {
  el('error').textContent = error instanceof Error ? error.message : String(error);
  el('error').hidden = !error;
}
function render() {
  const staleBridge = !!bridge && Date.now() - bridgePreparedAt > 90000 && remaining === 0n && !spent;
  el('receive-form').hidden = !!backup;
  el('receive-details').hidden = !backup;
  el('funding-instructions').hidden = !deposit || !depositVerified || spent || remaining > 0n
    || !saved || (!!bridge && !bridgeSaved) || staleBridge;
  el('save-bridge').hidden = !bridge;
  el('bridge-note').hidden = !bridge;
  el('bridge-fee-row').hidden = !bridge;
  field('send-from-wallet').disabled = busy || !wallet || !deposit || !depositVerified || !saved || spent || remaining > 0n || staleBridge || (!!bridge && !bridgeSaved);
  field('relay-from-wallet').disabled = busy || !wallet || !deposit || !saved || !ready;
  field('relay-from-wallet').hidden = !!configuration.automaticRelay;
  field('prepare-manual-relay').hidden = !!configuration.automaticRelay || !backup || !!deposit || connectedAddress !== backup.config.relayer;
  field('prepare-manual-relay').disabled = busy || !wallet || !backup || !saved || remaining === 0n;
  field('recover-from-wallet').disabled = busy || !wallet || !backup || remaining === 0n;
  field('demo-fund').disabled = busy || !saved || !deposit || !depositVerified || spent || remaining > 0n;
  field('demo-relay').disabled = busy || !saved || !deposit || !ready;
  field('demo-relay').hidden = !!configuration.automaticRelay;
}
async function act(work: () => Promise<void>) {
  if (busy) return;
  busy = true; report('');
  for (const button of document.querySelectorAll<HTMLButtonElement>('.railgun-card button')) button.disabled = true;
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('.railgun-card input, .railgun-card select, .railgun-card textarea')) control.disabled = true;
  wallets.disabled = true;
  try { await work(); }
  catch (cause) { report(cause); }
  finally {
    busy = false;
    for (const button of document.querySelectorAll<HTMLButtonElement>('.railgun-card button')) button.disabled = false;
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('.railgun-card input, .railgun-card select, .railgun-card textarea')) control.disabled = false;
    wallets.disabled = false;
    render();
  }
}
async function refresh() {
  if (!backup) return;
  remaining = 0n; ready = false; spent = false; depositVerified = false;
  const balance = await inspectRecovery(reader, backup, artifacts);
  remaining = balance.balance;
  if (!deposit) {
    el('balance-status').textContent = `Recovery restored. ${format(remaining)} remains recoverable.`;
    render(); return;
  }
  try {
    const current = await inspectDeposit(adapter, deposit, reader);
    spent = current.spent; ready = current.ready;
    if (!spent && current.balance > BigInt(configuration.maxAmount)) {
      throw new Error('Received amount exceeds this pilot limit. Recover the funds instead.');
    }
    if (!spent && current.balance > 0n && (!bridge || ready)
      && (!configuration.automaticRelay || current.balance >= BigInt(configuration.minAmount!))) {
      const block = await reader.getBlock('latest'); if (!block) throw new Error('Could not read the chain.');
      // Refresh amount and expiry without changing recipient or recovery.
      deposit = await adapter.quote(reader, deposit, { ...deposit.quote, amount: current.balance, deadline: BigInt(block.timestamp + 3600) });
      ready = true;
      await showFees();
    }
    if (configuration.automaticRelay && saved) {
      const response = await fetch('/api/relay-status', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({address: deposit.address})});
      if (!response.ok) throw new Error('Automatic deposit status is unavailable. Recovery remains available.');
      const status: {stopped: boolean; job: {status: string; reason?: string; hash?: string; amount?: string; gasFee?: string} | null} = await response.json();
      if (!status.job || status.stopped) { automaticFinished = true; throw new Error('Automatic deposit is stopped. Use recovery or contact the operator.'); }
      const job = status.job;
      automaticFinished = ['confirmed', 'failed', 'review'].includes(job.status);
      if (job.gasFee !== undefined && job.amount !== undefined) {
        if (!/^(0|[1-9][0-9]{0,35})$/.test(job.gasFee) || !/^[1-9][0-9]{0,35}$/.test(job.amount)
          || BigInt(job.gasFee) > deployment.maxGasFee || BigInt(job.amount) > BigInt(configuration.maxAmount)
          || BigInt(job.gasFee) + BigInt(job.amount) / 1000n >= BigInt(job.amount)) throw new Error('Invalid automatic deposit fee.');
        deposit = {...deposit, quote: {...deposit.quote, amount: BigInt(job.amount), gasFee: BigInt(job.gasFee)}};
        await showFees();
      }
      el('automatic-status').textContent = job.reason ?? ({waiting: `The operator deposits automatically after at least ${format(BigInt(configuration.minAmount!))} arrives.`,
        blocked: 'Automatic deposit is waiting.', submitted: 'Automatic deposit submitted.',
        confirmed: 'Automatic deposit confirmed. Check your RAILGUN wallet.', failed: 'Automatic deposit failed. Use recovery or contact the operator.',
        review: 'Automatic deposit needs operator review. Recovery remains available.'}[job.status] ?? 'Unknown automatic deposit status.');
      if (job.hash && /^0x[\da-fA-F]{64}$/.test(job.hash)) el('transaction-status').textContent = `Deposit transaction: ${job.hash}`;
      if (['failed', 'review'].includes(job.status)) throw new Error('Automatic deposit needs review. Use recovery for remaining funds.');
    }
    depositVerified = true;
    el('balance-status').textContent = spent
      ? `Pool deposit executed. ${format(remaining)} remains recoverable. Check your RAILGUN wallet for receipt and spendability.`
      : `${format(remaining)} received.${ready ? ' Ready to deposit into RAILGUN.' : ` Waiting for ${format(deposit.quote.amount)} in total.`}`;
  } catch (error) {
    ready = false; depositVerified = false;
    report(error);
    el('balance-status').textContent = `Depositing is unavailable. ${format(remaining)} remains recoverable with your recovery wallet.`;
  }
  render();
}
async function signer(requiredChain = deployment.chainId) {
  if (!wallet) throw new Error('Connect your wallet first.');
  // Check the current injected provider, rather than a cached connection after a network switch.
  if (BigInt(await wallet.send('eth_chainId', [])) !== requiredChain) {
    throw new Error(`Switch your wallet to chain ${requiredChain}.`);
  }
  return wallet.getSigner();
}
function showBackup() {
  if (!backup) return;
  el('receiving-address').textContent = bridge?.depositAddress ?? backup.depositAddress;
  el('recovery-summary').textContent = `Recovery: ${backup.config.recovery}`;
  const origin = configuration.bridgeOrigins?.find(source => source.chainId === bridge?.originChainId);
  el('send-instructions').textContent = bridge && origin
    ? `Send exactly ${format(BigInt(bridge.amount))} on ${origin.chainName}. Relay delivers to ${backup.depositAddress} on ${configuration.chainName}; Puddle then shields there. Do not reuse this bridge address.`
    : `Send only ${configuration.symbol} on ${configuration.chainName}. This address accepts one private deposit; excess and later transfers remain recoverable.`;
  el('bridge-note').textContent = bridge ? `Bridge recovery depends on Relay. Refund/recovery owner: ${bridge.recoveryOwner}. Save both files. Relay's recovery page is https://relay.link/withdraw. Maximum bridge shortfall: 2%. Use these instructions within 90 seconds; create new instructions if they expire.` : '';
  render();
}
async function showFees() {
  if (!deposit) return;
  const amount = deposit.quote.amount;
  const feeBps: bigint = await new Contract(configuration.pool, ['function shieldFee() view returns(uint256)'], reader).getFunction('shieldFee')();
  if (feeBps < 0n || feeBps >= 10000n) throw new Error('Unexpected RAILGUN fee.');
  const serviceFee = amount / 1000n;
  const poolAmount = amount - serviceFee - deposit.quote.gasFee;
  const protocolFee = poolAmount * feeBps / 10000n;
  el('puddle-fee').textContent = format(serviceFee);
  el('relay-fee').textContent = format(deposit.quote.gasFee);
  const effectiveCap = amount - serviceFee - 1n;
  el('relay-cap').textContent = format(deployment.maxGasFee < effectiveCap ? deployment.maxGasFee : effectiveCap);
  el('pool-fee').textContent = format(protocolFee);
  el('net-amount').textContent = format(poolAmount - protocolFee);
  el('net-label').textContent = bridge && remaining === 0n ? 'Minimum private balance after bridge' : 'Expected private balance';
  if (bridge) {
    const difference = BigInt(bridge.amount) - BigInt(bridge.expectedOutput);
    el('bridge-fee').textContent = format(difference > 0n ? difference : 0n);
  }
}
function downloadJSON(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}

window.addEventListener('eip6963:announceProvider', event => {
  const detail = (event as CustomEvent<{info?: {uuid?: string; name?: string}; provider?: Eip1193Provider}>).detail;
  const id = detail?.info?.uuid;
  const name = detail?.info?.name;
  if (!id || !/^[a-f0-9-]{36}$/i.test(id) || typeof name !== 'string' || !name.trim()
    || typeof detail?.provider?.request !== 'function' || providers.has(id) || providers.size >= 20) return;
  providers.set(id, detail.provider);
  const option = document.createElement('option'); option.value = id; option.textContent = name.slice(0, 80);
  wallets.append(option);
  if (providers.size === 1) wallets.value = id;
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
wallets.addEventListener('change', () => { wallet?.destroy(); wallet = undefined; connectedAddress = undefined; el('connected-wallet').textContent = ''; render(); });

el('receive-form').addEventListener('submit', event => {
  event.preventDefault();
  void act(async () => {
    // Capture all intended terms before the first network call. Display the same
    // recipient that was used to prepare the encrypted instructions.
    const recipient = field('private-recipient').value.trim();
    const recovery = getAddress(field('recovery-owner').value.trim());
    const sourceChain = sources.value;
    const value = field('send-amount').value.trim();
    if (!/^[0-9]{1,36}(\.[0-9]{1,18})?$/.test(value)) throw new Error('Enter a decimal token amount.');
    const amount = parseUnits(value, configuration.decimals);
    if (amount < BigInt(configuration.minAmount ?? '1') || amount > BigInt(configuration.maxAmount)) {
      throw new Error(`Choose an amount from ${format(BigInt(configuration.minAmount ?? '1'))} to ${format(BigInt(configuration.maxAmount))}.`);
    }
    const block = await reader.getBlock('latest'); if (!block) throw new Error('Could not read the chain.');
    const prepared = await prepareRailgunReceive(reader, deployment, {
      recipient, recovery,
      relayer: configuration.relayer, feeRecipient: configuration.feeRecipient,
    }, { token: configuration.token, amount, gasFee: BigInt(configuration.gasFee), deadline: BigInt(block.timestamp + 3600) }, artifacts);
    bridge = undefined; bridgeSaved = false;
    const origin = configuration.bridgeOrigins?.find(source => String(source.chainId) === sourceChain);
    if (sourceChain && !origin) throw new Error('Unsupported source chain.');
    if (origin) {
      const bridgeFloor = minimumMatchingAssetOutput(amount, BigInt(configuration.gasFee));
      const minimumOutput = BigInt(configuration.minAmount ?? '0') > bridgeFloor ? BigInt(configuration.minAmount!) : bridgeFloor;
      const response = await fetch('/api/bridge-quote', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recovery: prepared.recovery, originChainId: origin.chainId, amount: String(amount) }) });
      if (!response.ok) throw new Error('Bridge quote unavailable. No funds have moved.');
      const quoted: {providerResponse: unknown} = await response.json();
      bridge = validateRelayFundingQuote({ originChainId: origin.chainId, originToken: origin.token,
        destinationChainId: Number(configuration.chainId), destinationToken: configuration.token,
        destinationAddress: prepared.deposit.address, recoveryOwner: prepared.recovery.config.recovery,
        amount, minimumOutput, slippageBps: 50 }, quoted.providerResponse);
      prepared.deposit = await adapter.quote(reader, prepared.deposit, { ...prepared.deposit.quote, amount: BigInt(bridge.minimumOutput) });
      bridgePreparedAt = Date.now();
      setTimeout(() => {
        if (!bridge || Date.now() - bridgePreparedAt < 90000 || spent || remaining > 0n) return;
        el('funding-instructions').hidden = true;
        report('The bridge funding quote is stale. Create fresh instructions before sending. Existing funds remain recoverable.');
      }, 90000);
    }
    deposit = prepared.deposit; backup = prepared.recovery; saved = false; spent = false; remaining = 0n; depositVerified = false; automaticFinished = false;
    el('recipient-summary').textContent = `Recipient: ${recipient}`;
    await showFees();
    el('backup-status').textContent = 'Save your recovery file to reveal the funding address.';
    showBackup(); await refresh();
  });
});
el('save-backup').addEventListener('click', () => void act(async () => {
  if (!backup) return;
  downloadJSON(backup, `puddle-${backup.depositAddress}.json`);
  if (configuration.automaticRelay && deposit) {
    saved = false;
    const response = await fetch('/api/relay-register', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({recovery: backup})});
    if (!response.ok) throw new Error('Could not register automatic deposit. Your recovery file was saved; funding instructions remain hidden.');
    const result = await response.json();
    if (result.address !== deposit.address) throw new Error('Automatic deposit registered another address.');
  }
  saved = true; el('backup-status').textContent = 'Keep this recovery file private and retain it for excess or late transfers.';
  if (configuration.automaticRelay && deposit) await refresh();
}));
el('save-bridge').addEventListener('click', () => void act(async () => {
  if (!bridge || !backup) return;
  downloadJSON({ format: 'puddle-relay-funding', version: 1, preparedAt: new Date(bridgePreparedAt).toISOString(),
    funding: bridge, destinationRecovery: backup }, `puddle-bridge-${bridge.requestId}.json`);
  bridgeSaved = true;
}));
el('copy-address').addEventListener('click', () => void act(async () => {
  if (bridge && Date.now() - bridgePreparedAt > 90000) throw new Error('This bridge quote is stale. Create fresh receiving instructions before funding.');
  if (deposit && depositVerified && !spent && remaining === 0n && saved && (!bridge || bridgeSaved)) {
    await navigator.clipboard.writeText(bridge?.depositAddress ?? deposit.address);
  }
}));
el('connect-wallet').addEventListener('click', () => void act(async () => {
  const provider = providers.get(wallets.value) ?? (!providers.size ? (window as unknown as {ethereum?: Eip1193Provider}).ethereum : undefined);
  if (!provider) throw new Error('Open this page with an Ethereum wallet.');
  await provider.request({ method: 'eth_requestAccounts' });
  wallet?.destroy(); wallet = new BrowserProvider(provider, undefined, { cacheTimeout: -1 });
  connectedAddress = await (await wallet.getSigner()).getAddress();
  el('connected-wallet').textContent = `Connected: ${connectedAddress}`;
  await refresh();
}));
el('prepare-manual-relay').addEventListener('click', () => void act(async () => {
  if (!backup || !saved || configuration.automaticRelay) return;
  if (await (await signer()).getAddress() !== backup.config.relayer) throw new Error('Connect the configured operator wallet.');
  const state = await inspectRecovery(reader, backup, artifacts);
  if (state.balance === 0n || state.balance > BigInt(configuration.maxAmount)) throw new Error('No funded amount within this pilot limit.');
  const block = await reader.getBlock('latest'); if (!block) throw new Error('Could not read the chain.');
  const proposed = await adapter.quote(reader, recoveryRecord(backup), {token: backup.asset, amount: state.balance,
    gasFee: BigInt(configuration.gasFee), deadline: BigInt(block.timestamp + 3600)});
  if ((await inspectDeposit(adapter, proposed, reader)).spent) throw new Error('This account already deposited. Recover remaining funds instead.');
  deposit = proposed; await showFees(); await refresh();
}));
el('send-from-wallet').addEventListener('click', () => void act(async () => {
  if (!deposit || !backup || !saved) throw new Error('Prepare and save recovery before sending.');
  // Recheck immediately before asking the wallet to send, including when funding
  // or shielding happened outside this page since the last balance refresh.
  await refresh();
  if (!depositVerified) throw new Error('Deposit checks failed. Use recovery or create fresh receiving instructions.');
  if (spent) throw new Error('This address has already deposited. Create a new receiving address.');
  if (remaining > 0n) throw new Error('Funds have already arrived. Check the deposit or recover before sending again.');
  if (bridge && (!bridgeSaved || Date.now() - bridgePreparedAt > 90000)) throw new Error('Save fresh bridge instructions before sending.');
  const token = new Contract(bridge?.originToken ?? configuration.token, ['function transfer(address,uint256) returns(bool)'],
    await signer(bridge ? BigInt(bridge.originChainId) : deployment.chainId));
  const tx = await token.getFunction('transfer')(bridge?.depositAddress ?? deposit.address, bridge ? BigInt(bridge.amount) : deposit.quote.amount);
  el('transaction-status').textContent = `Funding submitted: ${tx.hash}`;
  await mined(Promise.resolve(tx)); await refresh();
}));
el('relay-from-wallet').addEventListener('click', () => void act(async () => {
  if (!deposit || !backup || !saved) throw new Error('Prepare and save recovery first.');
  await inspectRecovery(reader, backup, artifacts);
  const tx = await relayDeposit(adapter, deposit, await signer());
  el('transaction-status').textContent = `Shielding submitted: ${tx.hash}`;
  await mined(Promise.resolve(tx)); await refresh();
}));
el('recover-from-wallet').addEventListener('click', () => void act(async () => {
  if (!backup) return;
  const owner = await signer(); const account = await owner.getAddress();
  const status = await inspectRecovery(reader, backup, artifacts);
  if (!status.deployed) await mined(owner.sendTransaction(await recoveryTransaction(reader, backup, artifacts, account, backup.asset, 'deploy')));
  const tx = await owner.sendTransaction(await recoveryTransaction(reader, backup, artifacts, account, backup.asset, 'recover'));
  el('transaction-status').textContent = `Recovery submitted: ${tx.hash}`;
  await mined(Promise.resolve(tx)); await refresh();
}));
el('refresh-deposit').addEventListener('click', () => void act(refresh));
el('restore-backup').addEventListener('change', () => void act(async () => {
  const file = field('restore-backup').files?.[0]; if (!file) return;
  if (file.size > 16384) throw new Error('Recovery file is too large.');
  const restored = parseRecoveryFile(await file.text());
  if (restored.protocol !== 'railgun' || restored.chainId !== configuration.chainId || restored.factory !== configuration.factory
    || restored.pool !== configuration.pool || restored.asset !== configuration.token) throw new Error('This recovery file belongs to another route.');
  await inspectRecovery(reader, restored, artifacts);
  backup = restored; deposit = undefined; saved = true;
  bridge = undefined; bridgeSaved = false;
  el('automatic-status').textContent = ''; el('transaction-status').textContent = '';
  el('recipient-summary').textContent = 'Recovery restored from saved public configuration.';
  for (const id of ['puddle-fee', 'relay-fee', 'relay-cap', 'pool-fee', 'net-amount']) el(id).textContent = '—';
  showBackup(); await refresh();
}));
el('new-receive').addEventListener('click', () => void act(async () => {
  if (backup && !saved) throw new Error('Save recovery before creating another address.');
  backup = undefined; deposit = undefined; saved = false; spent = false; ready = false; remaining = 0n; depositVerified = false;
  bridge = undefined; bridgeSaved = false;
  el('automatic-status').textContent = '';
  el('transaction-status').textContent = ''; render();
}));
el('railgun-mode').textContent = configuration.mode === 'local' ? 'Local demo · test funds only'
  : configuration.automaticRelay ? 'Receiving preview' : 'Receiving preview · manual deposit';
el('route-description').textContent = `${configuration.symbol} on ${configuration.chainName}. No wallet connection needed to create your address.`;
el('asset-symbol').textContent = configuration.symbol;
el('automatic-status').hidden = !configuration.automaticRelay;
render();
if (configuration.automaticRelay) setInterval(() => {
  if (backup && deposit && saved && (!spent || !automaticFinished) && !busy) void act(refresh);
}, 5000);
if (configuration.mode === 'local') {
  void act(async () => {
    const demo: {recipient: string; recovery: string; amount: string} = await (await fetch('/demo.json')).json();
    field('private-recipient').value = demo.recipient;
    field('recovery-owner').value = demo.recovery;
    field('send-amount').value = demo.amount;
    el('demo-actions').hidden = false;
  });
  for (const [id, path] of [['demo-fund', '/api/demo-fund'], ['demo-relay', '/api/demo-relay']]) {
    el(id).addEventListener('click', () => void act(async () => {
      if (!backup || !deposit || !saved) throw new Error('Save recovery first.');
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recovery: backup, amount: String(deposit.quote.amount) }) });
      if (!response.ok) throw new Error('The local test action failed.');
      const result: {transactionHash: string} = await response.json();
      el('transaction-status').textContent = `Test transaction: ${result.transactionHash}`;
      await refresh();
    }));
  }
}
