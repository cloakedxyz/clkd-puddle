import {BrowserProvider, Contract, JsonRpcProvider, ZeroAddress, formatUnits, getAddress, parseUnits} from 'ethers';
import type {Eip1193Provider} from 'ethers';
import {prepareFlexibleReceive, discoverFunding, quoteFunding, createRailgunAdapter,
  inspectRecovery, recoveryRecord, parseRecoveryFile, recoveryTransaction, relayDeposit, mined} from '../sdk/index.ts';
import type {DepositRecord, DepositExecution, RecoveryFile, RecoveryArtifacts, FundingAsset, TokenApproval} from '../sdk/index.ts';
import {siteDeployment, validateRailgunSiteConfiguration} from './configuration.ts';
import {renderReceiveSteps, showReceivingCode} from './receive-card.ts';
import {setupProtocolPicker} from './protocols.ts';
import {setupNetworkPicker} from './networks.ts';

const el = (id: string) => document.getElementById(id)!;
const field = (id: string) => el(id) as HTMLInputElement;
const configuration = validateRailgunSiteConfiguration(await (await fetch('/configuration.json')).json());
if (!configuration.multiAsset) throw new Error('A multi-asset route is required.');
const deployment = siteDeployment(configuration);
const artifacts: RecoveryArtifacts = await (await fetch('/contracts.json')).json();
const reader = new JsonRpcProvider(configuration.rpcTransport === 'direct' ? configuration.rpcUrl : `${location.origin}/api/rpc`,
  undefined, {batchMaxCount: 1, cacheTimeout: -1});
const sources = el('source-chain') as HTMLSelectElement;
sources.options[0].textContent = configuration.chainName;
let busy = false, saved = false, spent = false;
let record: DepositRecord | undefined, backup: RecoveryFile | undefined, deposit: DepositExecution | undefined;
let unreadable: string[] = [];
let assets: FundingAsset[] = [], candidates: string[] = [], scanBlock: number | undefined;
let approvedToken: TokenApproval | undefined;
let scanComplete = true;
let wallet: BrowserProvider | undefined, connected: string | undefined;
const picker = setupNetworkPicker(sources, Number(configuration.chainId), () => busy || !!backup);
const protocolPicker = setupProtocolPicker(configuration.chainName, () => busy || !!backup);
const selected = () => assets.find(asset => asset.token === (el('funded-asset') as HTMLSelectElement).value);
const format = (value: bigint, asset: FundingAsset) => asset.decimals === null || asset.decimals > 36
  ? `${value} base units (${asset.symbol})` : `${formatUnits(value, asset.decimals)} ${asset.symbol}`;
function report(error: unknown) {el('error').textContent = error instanceof Error ? error.message : String(error); el('error').hidden = !error;}
function render() {
  picker.render(); protocolPicker.render();
  renderReceiveSteps(!!backup, saved, spent, !!deposit, !!backup && !backup.multiAsset);
  el('manual-deposit-note').hidden = !saved || configuration.mode === 'local';
  el('receive-form').hidden = !!backup; el('receive-details').hidden = !backup;
  el('funding-instructions').hidden = !backup || !saved || spent || !backup.multiAsset;
  el('detected-funds').hidden = assets.length === 0 && unreadable.length === 0;
  el('deposit-review').hidden = !deposit;
  el('prepare-manual-relay').hidden = !backup?.multiAsset || connected !== backup.config.relayer || spent;
  field('prepare-manual-relay').disabled = busy || !saved || !selected();
  field('relay-from-wallet').disabled = busy || !deposit || !saved || spent || connected !== backup?.config.relayer;
  field('recover-from-wallet').disabled = busy || !backup || connected !== backup.config.recovery;
  field('demo-fund').disabled = busy || !saved || spent;
  el('demo-relay').hidden = configuration.mode !== 'local' || !selected()
    || ![ZeroAddress, deployment.asset].includes(selected()!.token);
  field('demo-relay').disabled = busy || !saved || spent;
}
async function act(work: () => Promise<void>) {
  if (busy) return;
  busy = true; report(''); picker.render(); protocolPicker.render();
  for (const control of document.querySelectorAll<HTMLInputElement>('.railgun-card button, .railgun-card input, .railgun-card select, .railgun-card textarea')) control.disabled = true;
  try {await work();} catch (error) {report(error);} finally {
    busy = false;
    for (const control of document.querySelectorAll<HTMLInputElement>('.railgun-card button, .railgun-card input, .railgun-card select, .railgun-card textarea')) control.disabled = false;
    render();
  }
}
function clearQuote() {
  deposit = undefined;
  for (const id of ['puddle-fee', 'relay-fee', 'pool-fee', 'net-amount']) el(id).textContent = 'Quoted after funding';
  el('relay-cap').textContent = `5% of the deposit; ETH/WETH also capped at ${formatUnits(deployment.maxGasFee, 18)} ETH.`;
}
async function refresh() {
  if (!record || !backup) return;
  await inspectRecovery(reader, backup, artifacts);
  spent = await new Contract(record.executor, ['function spent(address) view returns(bool)'], reader).spent(record.address);
  const tip = await reader.getBlockNumber();
  const fromBlock = scanBlock ?? record.fundingBlock ?? tip;
  // Keep previous token candidates when advancing the log cursor, including after recovery imports.
  const recoveryAsset = field('recovery-asset').value.trim();
  if (/^0x[\da-fA-F]{40}$/.test(recoveryAsset)) candidates = [...new Set([...candidates, getAddress(recoveryAsset)])];
  const found = await discoverFunding(reader, record, {fromBlock, toBlock: Math.min(tip, fromBlock + 19_999), tokens: candidates});
  scanBlock = Math.min(tip, found.nextBlock); candidates = [...new Set([...candidates, ...found.assets.map(asset => asset.token), ...found.unreadable])];
  const selector = el('funded-asset') as HTMLSelectElement, previous = selector.value;
  scanComplete = found.nextBlock > tip;
  assets = found.assets; unreadable = found.unreadable; selector.replaceChildren();
  if (assets.length > 1) {const choice = document.createElement('option'); choice.value = ''; choice.textContent = 'Choose funds for this deposit'; selector.append(choice);}
  for (const asset of assets) {const choice = document.createElement('option'); choice.value = asset.token;
    choice.textContent = `${format(asset.balance, asset)}${asset.token === ZeroAddress ? '' : ` · ${asset.token}`}`; selector.append(choice);}
  if (assets.some(asset => asset.token === previous)) selector.value = previous;
  if (approvedToken) {
    const current = assets.find(asset => asset.token === approvedToken!.token);
    if (!current || current.codeHash !== approvedToken.codeHash || JSON.stringify(current.implementation) !== JSON.stringify(approvedToken.implementation)) {
      approvedToken = undefined; field('review-standard-token').checked = false; clearQuote();
    }
  }
  if (deposit && (!selected() || selected()!.token !== (deposit.quote.native ? ZeroAddress : deposit.quote.token)
    || selected()!.balance !== deposit.quote.amount)) clearQuote();
  el('balance-status').textContent = !record.multiAsset ? 'Recovery restored. Recover ETH or enter a token contract address below.' : spent ? 'Pool deposit executed. Check your RAILGUN wallet for receipt and screening. Other funds remain recoverable.'
    : !scanComplete ? 'Checking earlier transfers… Keep this page open.' : assets.length ? 'Funds received. The operator reviews and completes this deposit.' : 'Waiting for ETH or tokens.';
  el('asset-review-status').textContent = found.unreadable.length ? `Unreadable token balances: ${found.unreadable.join(', ')}. You can enter their contract addresses for recovery.`
    : 'One asset is deposited per address. Other assets remain recoverable. Rebasing, lottery and taxed tokens are unsupported.';
  if (selected() && !field('recovery-asset').value) field('recovery-asset').value = selected()!.token === ZeroAddress ? 'ETH' : selected()!.token;
}
async function ownerSigner() {
  if (!wallet) throw new Error('Connect your wallet first.');
  if (BigInt(await wallet.send('eth_chainId', [])) !== deployment.chainId) throw new Error(`Switch to ${configuration.chainName}.`);
  return wallet.getSigner();
}
function showBackup(recipient: string) {
  field('recovery-asset').value = ''; field('operator-gas-fee').value = '0'; approvedToken = undefined; field('review-standard-token').checked = false;
  el('recipient-summary').textContent = recipient;
  el('recovery-summary').textContent = `Recovery: ${backup!.config.recovery}`;
  el('receiving-address').textContent = backup!.depositAddress;
  showReceivingCode(backup!.depositAddress, Number(configuration.chainId), configuration.chainName);
  el('send-instructions').textContent = `ETH or standard ERC-20s · One deposit per address.`;
  el('backup-status').textContent = saved ? 'Keep this recovery file private.' : 'Save your recovery file to reveal the funding address.';
  clearQuote();
}
el('receive-form').addEventListener('submit', event => {event.preventDefault(); void act(async () => {
  const recipient = field('private-recipient').value.trim(), recovery = getAddress(field('recovery-owner').value.trim());
  const prepared = await prepareFlexibleReceive(reader, deployment, {recipient, recovery, relayer: configuration.relayer,
    feeRecipient: configuration.feeRecipient}, artifacts);
  record = prepared.record; backup = prepared.recovery; saved = false; spent = false; assets = []; unreadable = []; candidates = []; scanBlock = undefined; approvedToken = undefined; field('review-standard-token').checked = false;
  showBackup(`Recipient: ${recipient}`); await refresh();
});});
el('save-backup').addEventListener('click', () => void act(async () => {
  if (!backup) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = `puddle-${backup.depositAddress}.json`; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000); saved = true;
  el('backup-status').textContent = 'Keep this recovery file private.';
}));
el('copy-address').addEventListener('click', () => void act(async () => {
  if (backup && saved && !spent) {
    await navigator.clipboard.writeText(backup.depositAddress);
    el('copy-address').lastChild!.textContent = 'Copied';
    setTimeout(() => {el('copy-address').lastChild!.textContent = 'Copy address';}, 1800);
  }
}));
el('funded-asset').addEventListener('change', () => {clearQuote(); approvedToken = undefined; field('review-standard-token').checked = false; field('operator-gas-fee').value = '0';
  if (selected()) field('recovery-asset').value = selected()!.token === ZeroAddress ? 'ETH' : selected()!.token; render();});
el('operator-gas-fee').addEventListener('input', () => {clearQuote(); render();});
el('review-standard-token').addEventListener('change', () => {
  const asset = selected(); approvedToken = field('review-standard-token').checked && asset && asset.token !== ZeroAddress
    ? {token: asset.token, codeHash: asset.codeHash, implementation: asset.implementation, standard: true} : undefined;
  clearQuote(); render();
});
el('connect-wallet').addEventListener('click', () => void act(async () => {
  const injected = (window as unknown as {ethereum?: Eip1193Provider}).ethereum;
  if (!injected) throw new Error('Open this page with an Ethereum wallet.');
  await injected.request({method: 'eth_requestAccounts'}); wallet?.destroy(); wallet = new BrowserProvider(injected, undefined, {cacheTimeout: -1});
  connected = await (await ownerSigner()).getAddress(); el('connected-wallet').textContent = `Connected: ${connected}`;
}));
el('prepare-manual-relay').addEventListener('click', () => void act(async () => {
  const operator = await ownerSigner();
  if (!record || !saved || await operator.getAddress() !== record.config.relayer) throw new Error('Connect the configured operator.');
  await refresh(); const funding = selected(); if (!funding || spent || !scanComplete) throw new Error('Finish checking transfers and choose received funds.');
  const native = funding.token === ZeroAddress, token = native ? record.asset : funding.token;
  if (token !== record.asset && (!approvedToken || approvedToken.token !== token)) throw new Error('The operator must review token behavior before approving it.');
  const approval: TokenApproval = token === record.asset
    ? {token, codeHash: record.codeHashes.asset, implementation: record.assetImplementation ?? null, standard: true}
    : approvedToken!;
  const gasText = field('operator-gas-fee').value.trim();
  const rawUnits = funding.decimals === null || funding.decimals > 36;
  if (rawUnits && !/^[0-9]+$/.test(gasText)) throw new Error('Enter gas reimbursement in whole token base units.');
  const gasFee = rawUnits ? BigInt(gasText) : parseUnits(gasText, funding.decimals!);
  const proposed = await quoteFunding(reader, record, funding, approval, gasFee);
  const feeBps: bigint = await new Contract(record.pool, ['function shieldFee() view returns(uint256)'], reader).shieldFee();
  if (feeBps < 0n || feeBps >= 10000n) throw new Error('Unexpected RAILGUN fee.');
  const serviceFee = funding.balance / 1000n, poolAmount = funding.balance - serviceFee - gasFee, poolFee = poolAmount * feeBps / 10000n;
  el('review-amount').textContent = format(funding.balance, funding); el('review-network').textContent = configuration.chainName;
  el('puddle-fee').textContent = format(serviceFee, funding); el('relay-fee').textContent = format(gasFee, funding);
  el('pool-fee').textContent = format(poolFee, funding); el('net-amount').textContent = format(poolAmount - poolFee, funding);
  deposit = proposed; (el('receive-info') as HTMLDetailsElement).open = true;
}));
el('relay-from-wallet').addEventListener('click', () => void act(async () => {
  if (!record || !deposit || !saved) throw new Error('Prepare an operator quote first.');
  await refresh(); if (!deposit) throw new Error('Funding changed. Prepare a fresh quote.');
  const tx = await relayDeposit(createRailgunAdapter(deployment), deposit, await ownerSigner());
  el('transaction-status').textContent = `Shielding submitted: ${tx.hash}`; await mined(Promise.resolve(tx)); await refresh();
}));
el('recover-from-wallet').addEventListener('click', () => void act(async () => {
  if (!backup) return;
  const signer = await ownerSigner(), owner = await signer.getAddress();
  const value = field('recovery-asset').value.trim(), token = /^ETH$/i.test(value) ? ZeroAddress : getAddress(value);
  const state = await inspectRecovery(reader, backup, artifacts, token);
  if (!state.deployed) await mined(signer.sendTransaction(await recoveryTransaction(reader, backup, artifacts, owner, token, 'deploy')));
  const tx = await signer.sendTransaction(await recoveryTransaction(reader, backup, artifacts, owner, token));
  el('transaction-status').textContent = `Recovery submitted: ${tx.hash}`; await mined(Promise.resolve(tx)); await refresh();
}));
el('restore-backup').addEventListener('change', () => void act(async () => {
  const file = field('restore-backup').files?.[0]; if (!file) return;
  if (file.size > 16_384) throw new Error('Recovery file is too large.');
  const restored = parseRecoveryFile(await file.text());
  if (restored.chainId !== configuration.chainId || restored.factory !== configuration.factory || restored.implementation !== configuration.implementation
    || restored.validator !== configuration.validator || restored.pool !== configuration.pool || restored.asset !== configuration.token
    || restored.multiAsset && restored.executor !== configuration.executor) throw new Error('This file belongs to another route.');
  await inspectRecovery(reader, restored, artifacts); backup = restored; record = recoveryRecord(restored); saved = true; spent = false;
  candidates = []; scanBlock = undefined; showBackup('Recovery restored.'); await refresh();
}));
el('refresh-deposit').addEventListener('click', () => void act(refresh));
el('new-receive').addEventListener('click', () => void act(async () => {
  record = undefined; backup = undefined; deposit = undefined; saved = false; spent = false; assets = []; unreadable = []; candidates = []; scanBlock = undefined;
  approvedToken = undefined; field('review-standard-token').checked = false;
  el('transaction-status').textContent = '';
}));
el('amount-entry').hidden = true; field('send-amount').required = false;
el('send-from-wallet').hidden = true; el('wallet-choice').hidden = true;
el('asset-operator-tools').hidden = false; el('recover-from-wallet').textContent = 'Recover funds';
el('manual-deposit-note').textContent = 'Arrange manual completion before sending.';
el('route-description').textContent = 'ETH and tokens.';
clearQuote(); render();
setInterval(() => {if (backup && saved && !spent && !busy && !el('wallet-tools').contains(document.activeElement)) void act(refresh);}, 15_000);
if (configuration.mode === 'local') {
  const demo = await (await fetch('/demo.json')).json(); field('private-recipient').value = demo.recipient; field('recovery-owner').value = demo.recovery;
  // Local faucet funds a known token; arbitrary tokens/ETH can also arrive from a normal wallet.
  el('demo-actions').hidden = false;
  el('demo-relay').textContent = 'Complete test deposit';
  el('demo-relay').addEventListener('click', () => void act(async () => {
    if (!backup || !saved || !selected()) throw new Error('Save recovery and select received funds.');
    const response = await fetch('/api/demo-relay', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({recovery: backup, amount: String(selected()!.balance), asset: selected()!.token})});
    if (!response.ok) throw new Error('Local deposit failed.');
    const result = await response.json(); el('transaction-status').textContent = `Test deposit: ${result.transactionHash}`; await refresh();
  }));
  el('demo-fund').addEventListener('click', () => void act(async () => {
    if (!backup || !saved) throw new Error('Save recovery first.');
    const response = await fetch('/api/demo-fund', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({recovery: backup, amount: String(parseUnits('0.01', 18))})});
    if (!response.ok) throw new Error('Local funding failed.'); await refresh();
  }));
}
