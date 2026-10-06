import { formatAmount, quoteAmount } from './shared.js';
import type { AppState, DemoProtocol, DemoAsset } from './shared.js';
import { JsonRpcProvider, ZeroAddress } from 'ethers';
import { prepareV1PublicReceive, parseV1ReceiveCode } from '../client/index.ts';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

const amount = element<HTMLInputElement>('amount');
const form = element<HTMLFormElement>('deposit-form');
const protocolSelect = element<HTMLSelectElement>('protocol');
const assetSelect = element<HTMLSelectElement>('asset');
const selectedProtocol = () => protocolSelect.value as DemoProtocol;
const selectedAsset = () => assetSelect.value as DemoAsset;
const provider = new JsonRpcProvider(`${location.origin}/api/rpc`, 31337, { batchMaxCount: 1, cacheTimeout: -1 });
const receiveCode = element<HTMLTextAreaElement>('v1-receive-code');
function consumeReceiveLink() {
  if (!location.hash) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has('request')) {
    receiveCode.value = location.href;
    protocolSelect.value = 'privacy-pools-v1';
    assetSelect.querySelector<HTMLOptionElement>('[value="ETH"]')!.disabled = false;
    try {
      const code = parseV1ReceiveCode(receiveCode.value);
      receiveCode.value = JSON.stringify(code);
      if (code.asset === ZeroAddress) { assetSelect.value = 'ETH'; amount.value = '0.1'; }
    } catch { /* Keep malformed input visible for correction; validate before creating. */ }
  }
  // Retain only the public code in memory, not in the next copied page URL.
  history.replaceState(null, '', location.pathname + location.search);
  return params.has('request');
}
consumeReceiveLink();
const menu = element<HTMLDetailsElement>('site-menu');
const menuToggle = element('menu-toggle');

document.addEventListener('click', event => {
  if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.open) {
    menu.open = false;
    menuToggle.focus();
  }
});
menu.addEventListener('focusout', event => {
  if (event.relatedTarget instanceof Node && !menu.contains(event.relatedTarget)) menu.open = false;
});
menu.addEventListener('click', event => {
  if (event.target instanceof Element && event.target.closest('a')) {
    menu.open = false;
    menuToggle.focus();
  }
});

// Same blur/slide rhythm as clkd's hero, with a stable width for both logos.
function startProtocolRotation() {
  const protocols = element('protocols');
  const links = Array.from(protocols.querySelectorAll<HTMLAnchorElement>('a'));
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let current = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function show(index: number) {
    links[current]!.dataset.state = 'outgoing';
    current = index;
    links[current]!.dataset.state = 'active';
  }

  function schedule() {
    clearTimeout(timer);
    if (reducedMotion.matches || document.hidden
        || protocols.matches(':hover, :focus-within')) return;
    timer = setTimeout(() => {
      show((current + 1) % links.length);
      schedule();
    }, 2_800);
  }

  function configure() {
    protocols.toggleAttribute('data-rotating', !reducedMotion.matches);
    for (const [index, link] of links.entries()) {
      link.dataset.state = index === current ? 'active' : 'idle';
    }
    schedule();
  }

  protocols.addEventListener('pointerenter', () => clearTimeout(timer));
  protocols.addEventListener('pointerleave', schedule);
  protocols.addEventListener('focusin', event => {
    clearTimeout(timer);
    // Both links remain keyboard-accessible; focus reveals its destination.
    const index = links.findIndex(link => link === event.target);
    if (index >= 0) show(index);
  });
  protocols.addEventListener('focusout', () => queueMicrotask(schedule));
  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener('change', configure);
  configure();
}
startProtocolRotation();

let state: AppState | undefined;
let editing = true;
let submitting = false;
let connected = false;
let actionVersion = 0;
let toastTimer: ReturnType<typeof setTimeout>;
const savedRecoveries = new Set<string>();
window.addEventListener('hashchange', () => {
  if (!consumeReceiveLink()) return;
  if (submitting || (state?.deposit && !['complete', 'recovered'].includes(state.deposit.phase))) {
    message('Finish the current deposit before using this new receive code.');
  } else {
    editing = true;
    message('');
  }
  render();
});

function message(text: string) {
  element('error').textContent = text;
  element('error').hidden = !text;
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    element('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element('toast').hidden = true; }, 1_700);
  } catch { message('Copy was unavailable. Select and copy the address manually.'); }
}

function preview() {
  try {
    const asset = selectedAsset();
    const quote = quoteAmount(amount.value.trim(), selectedProtocol(), asset);
    for (const [id, value] of [['service-fee', quote.serviceFee], ['gas-fee', quote.gasFee],
      ['protocol-fee', quote.protocolFee], ['receive-amount', quote.received],
      ['total-fee', String(BigInt(quote.amount) - BigInt(quote.received))]]) {
      element(id).textContent = `${formatAmount(value, asset)} ${asset}`;
    }
    amount.removeAttribute('aria-invalid');
    element('amount-hint').textContent = '';
    element('amount-hint').hidden = true;
    element<HTMLButtonElement>('create').disabled = submitting || !connected;
  } catch (error) {
    for (const id of ['service-fee', 'gas-fee', 'protocol-fee', 'receive-amount', 'total-fee']) element(id).textContent = '—';
    element<HTMLButtonElement>('create').disabled = true;
    amount.setAttribute('aria-invalid', 'true');
    element('amount-hint').textContent = error instanceof Error ? error.message : 'Enter a valid amount.';
    element('amount-hint').hidden = false;
  }
}

function receiptRow(label: string, value: string) {
  const row = document.createElement('div');
  const title = document.createElement('dt');
  title.textContent = label;
  const data = document.createElement('dd');
  const code = document.createElement('span');
  code.textContent = `${value.slice(0, 8)}…${value.slice(-6)}`;
  code.title = value;
  const button = document.createElement('button');
  button.className = 'copy-icon';
  button.textContent = '⧉';
  button.setAttribute('aria-label', `Copy ${label.toLowerCase()}`);
  button.addEventListener('click', () => { void copy(value); });
  data.append(code, button);
  row.append(title, data);
  return row;
}

function render() {
  if (!state) return;
  element('loading').hidden = true;
  form.hidden = !editing;
  element('deposit-panel').hidden = editing;
  const recipient = element<HTMLOutputElement>('recipient');
  const v1Selected = selectedProtocol() === 'privacy-pools-v1';
  recipient.value = `${state.recipient.slice(0, 10)}…${state.recipient.slice(-8)}`;
  recipient.title = state.recipient;
  recipient.setAttribute('aria-label', recipient.value);
  element('copy-recipient').hidden = v1Selected;
  element('v1-code-field').hidden = !v1Selected;
  element('railgun-recipient').hidden = v1Selected;
  element('protocol-fee-label').textContent = v1Selected ? 'Privacy Pools v1 · 1% test fee' : 'RAILGUN · 0.25%';
  preview();
  const deposit = editing ? null : state.deposit;
  const phase = deposit?.phase;
  const complete = phase === 'complete';
  const recovered = phase === 'recovered';
  const active = !!phase && ['funding', 'shielding', 'verifying', 'recovering'].includes(phase);
  element('card-label').textContent = editing ? 'NEW DEPOSIT' : complete ? 'DEPOSIT COMPLETE' : recovered ? 'FUNDS RECOVERED' : 'YOUR DEPOSIT';
  if (!deposit) return;
  const isV1 = deposit.protocol === 'privacy-pools-v1';
  const display = (value: string) => formatAmount(value, deposit.asset);
  element('deposit-title').textContent = complete ? 'Received privately.' : recovered ? 'Back in your wallet.'
    : active ? 'On its way.' : phase === 'funded' ? 'Ready to relay.' : phase === 'error' ? 'A little help needed.' : 'Your address is ready.';
  element('deposit-description').textContent = complete ? (isV1 ? 'Your deposit is in the test Privacy Pools v1 account. Private spending requires pool approval.' : 'Your deposit is in the test RAILGUN wallet.')
    : recovered ? 'Your test funds were returned to the recovery wallet.'
      : phase === 'funded' ? 'Your transfer is confirmed. Choose when to relay it into the pool.'
      : active ? 'Your deposit is being shielded.'
        : phase === 'error' ? 'Your deposit stays tied to its fixed recipient and recovery wallet.'
          : 'Send your test tokens here.';
  element('status-icon').textContent = complete || recovered ? '✓' : '↘';
  element('status-icon').classList.toggle('success', complete || recovered);
  element('received-block').hidden = !complete;
  if (deposit.received) element('received-value').textContent = display(deposit.received);
  element('received-unit').textContent = deposit.asset;
  element('verified-label').textContent = isV1 ? '✓ Pool deposit confirmed' : '✓ Receipt decrypted and verified';
  element('deposit-address-block').hidden = complete || recovered;
  element('deposit-address').textContent = deposit.address;
  const progress = element('progress-status');
  const descriptions = {
    ready: `Send ${display(deposit.quote.amount)} ${deposit.asset} · receive ${display(deposit.quote.received)} ${deposit.asset}`,
    funding: 'Sending a normal transfer…', funded: 'Funds are at the receiving address. Relay when ready.',
    shielding: 'Shielding your deposit…', verifying: 'Checking your private receipt…',
    complete: deposit.error ?? (isV1 ? 'Deposit confirmed. Open your receiving wallet to view it.' : 'Destination, fees and receipt verified.'), recovering: 'Returning your test funds…',
    recovered: deposit.shieldingTx ? 'Pool recovery complete. Paid fees were not refunded.' : 'Recovery complete. No service fee charged.', error: deposit.error ?? 'Deposit paused.',
  };
  progress.replaceChildren();
  if (active) { const spinner = document.createElement('span'); spinner.className = 'spinner'; progress.append(spinner); }
  progress.append(document.createTextNode(descriptions[deposit.phase]));
  element('fund').hidden = phase !== 'ready';
  element<HTMLButtonElement>('fund').disabled = submitting || !connected || !savedRecoveries.has(deposit.address);
  element<HTMLButtonElement>('save-recovery').disabled = submitting || !connected;
  element('save-recovery').textContent = savedRecoveries.has(deposit.address) ? 'Download recovery file again' : 'Save recovery file';
  element('recovery-note').textContent = savedRecoveries.has(deposit.address)
    ? 'Keep this file until all funds have arrived or been recovered.' : 'Save this before sending. Keep it private.';
  element('fund-label').textContent = `Send ${display(deposit.quote.amount)} test ${deposit.asset}`;
  element('relay').hidden = phase !== 'funded';
  element('fund-note').hidden = phase !== 'ready';
  element('retry').hidden = phase !== 'error' || !deposit.fundingTx;
  element('retry').textContent = deposit.shieldingTx ? 'Retry verification' : 'Retry shielding';
  element('recover').hidden = !['funded', 'error'].includes(phase ?? '') || !!deposit.shieldingTx;
  element('pool-recovery-note').hidden = !isV1 || !complete;
  for (const id of ['retry', 'recover', 'relay', 'new-deposit']) element<HTMLButtonElement>(id).disabled = submitting || !connected;
  element('new-deposit').hidden = !complete && !recovered;
  element('receipt-details').hidden = !deposit.fundingTx && !deposit.recoveryTx;
  const rows = element('receipt-rows');
  const signature = [deposit.address, deposit.fundingTx, deposit.shieldingTx, deposit.recoveryTx, deposit.commitment].join(':');
  if (rows.dataset.signature !== signature) {
    rows.dataset.signature = signature;
    rows.replaceChildren();
    for (const [label, value] of [['Deposit address', deposit.address], ['Token transfer', deposit.fundingTx],
      ['Shielding', deposit.shieldingTx], ['Recovery', deposit.recoveryTx],
      ['Private commitment', deposit.commitment], ['Recovery wallet', state.recovery]] as const) {
      if (value) rows.append(receiptRow(label, value));
    }
  }
}

async function request(path: string, body?: Record<string, unknown>): Promise<AppState> {
  const response = await fetch(path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  if (!response.ok) {
    const result: { error?: string } = await response.json();
    throw new Error(result.error ?? 'The local service could not complete the request.');
  }
  return response.json() as Promise<AppState>;
}

async function action(path: string, body: Record<string, unknown>) {
  if (submitting) return;
  submitting = true;
  actionVersion++;
  message('');
  render();
  try {
    state = await request(path, body);
    editing = false;
    connected = true;
  } catch (error) { message(error instanceof Error ? error.message : 'Could not complete this action.'); }
  finally { submitting = false; render(); }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  try { quoteAmount(amount.value.trim(), selectedProtocol(), selectedAsset()); }
  catch (error) { message(error instanceof Error ? error.message : 'Check the amount.'); return; }
  if (selectedProtocol() === 'railgun') void action('/api/deposits', { protocol: 'railgun', amount: amount.value.trim() });
  else void createV1();
});
async function createV1() {
  if (submitting || !state) return;
  submitting = true; actionVersion++; message(''); render();
  try {
    const code = parseV1ReceiveCode(receiveCode.value.trim());
    const asset = code.asset === ZeroAddress ? 'ETH' : code.asset === state.v1.token ? 'USDC' : undefined;
    if (!asset) throw new Error('This receive code uses an asset unavailable on the local test chain.');
    if (asset !== selectedAsset()) throw new Error(`Choose ${asset} to match the receive code.`);
    const quote = quoteAmount(amount.value.trim(), 'privacy-pools-v1', asset);
    const block = await provider.getBlock('latest');
    if (!block) throw new Error('Could not read the local chain.');
    const receive = await prepareV1PublicReceive(provider, { ...state.v1, chainId: BigInt(state.v1.chainId) },
      { relayer: state.relayer, feeRecipient: state.v1.feeRecipient,
        token: asset === 'ETH' ? ZeroAddress : state.v1.token, amount: BigInt(quote.amount),
        gasFee: BigInt(quote.gasFee), deadline: BigInt(block.timestamp + 3600) }, code);
    // This page has only public receive instructions, never the recipient's secrets.
    state = await request('/api/deposits', { protocol: 'privacy-pools-v1', asset,
      amount: amount.value.trim(), recoveryFile: receive.recovery });
    editing = false;
  } catch (error) { message(error instanceof Error ? error.message : 'Could not create the receive address.'); }
  finally { submitting = false; render(); }
}
protocolSelect.addEventListener('change', () => {
  assetSelect.querySelector<HTMLOptionElement>('[value="ETH"]')!.disabled = selectedProtocol() === 'railgun';
  if (selectedProtocol() === 'railgun' && selectedAsset() === 'ETH') { assetSelect.value = 'USDC'; amount.value = '100'; }
  message(''); render();
});
assetSelect.addEventListener('change', () => { amount.value = selectedAsset() === 'ETH' ? '0.1' : '100'; message(''); preview(); });
amount.addEventListener('input', () => { message(''); preview(); });
element('copy-recipient').addEventListener('click', () => { if (state) void copy(state.recipient); });
element('copy-deposit').addEventListener('click', () => { if (state?.deposit) void copy(state.deposit.address); });
element('save-recovery').addEventListener('click', () => { void (async () => {
  const deposit = state?.deposit;
  if (!deposit || submitting) return;
  submitting = true; render(); message('');
  try {
    const response = await fetch(`/api/recovery?address=${encodeURIComponent(deposit.address)}`);
    if (!response.ok) throw new Error('Could not download the recovery file. Try again before sending funds.');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url; link.download = `recovery-${deposit.address}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    savedRecoveries.add(deposit.address);
  } catch (error) { message(error instanceof Error ? error.message : 'Could not save recovery file.'); }
  finally { submitting = false; render(); }
})(); });
for (const [id, endpoint] of [['fund', '/api/fund'], ['relay', '/api/relay'], ['retry', '/api/relay'], ['recover', '/api/recover']]) {
  element(id).addEventListener('click', () => { if (state?.deposit) void action(endpoint, { address: state.deposit.address }); });
}
element('new-deposit').addEventListener('click', () => {
  editing = true;
  element<HTMLDetailsElement>('receipt-details').open = false;
  message(''); render(); amount.focus();
});

async function poll() {
  try {
    if (!submitting) {
      const version = actionVersion;
      const next = await request('/api/state');
      // A poll started before an action must not replace the action's newer response.
      if (version !== actionVersion) return;
      if (!state) editing = !!receiveCode.value || !next.deposit;
      if (state && state.recipient !== next.recipient) {
        savedRecoveries.clear();
        editing = !next.deposit;
        message('The local service restarted. A fresh test wallet is ready.');
      }
      state = next;
      if (!connected) message('');
      connected = true;
    }
  } catch {
    connected = false;
    message('Cannot reach the local service. Start it with npm run dev; this page will reconnect.');
  }
  finally {
    render();
    setTimeout(() => { void poll(); }, 700);
  }
}
void poll();
