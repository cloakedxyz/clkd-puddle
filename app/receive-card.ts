import qrcode from 'qrcode-generator';
import {isAddress} from 'ethers';
import {fundingNetworks} from './networks.ts';

const el = (id: string) => document.getElementById(id)!;
let renderedAddress = '';

/** Encode the funding address, never the recovery owner. Network instructions remain explicit. */
export function showReceivingCode(address: string, chainId: number, chainName: string) {
  if (!isAddress(address)) throw new Error('Invalid receiving address.');
  el('funding-network-label').textContent = `Send on ${chainName}`;
  const network = fundingNetworks.find(network => network.chainId === chainId);
  const logo = el('funding-chain-logo') as HTMLImageElement;
  logo.hidden = !network;
  if (network) logo.src = `/assets/chains/${network.logo}.png`;
  if (address === renderedAddress) return;
  const code = qrcode(0, 'M'); code.addData(address); code.make();
  // Only validated hexadecimal addresses reach this library-generated SVG.
  el('receiving-qr').innerHTML = code.createSvgTag({cellSize: 4, margin: 16, scalable: true});
  renderedAddress = address;
}

export function renderReceiveSteps(prepared: boolean, saved: boolean, spent: boolean, quoted: boolean, recoveryOnly: boolean) {
  document.querySelector<HTMLElement>('.receive-heading')!.hidden = prepared;
  el('receive-title').textContent = !prepared ? 'Receive privately' : !saved ? 'Save your recovery file'
    : recoveryOnly ? 'Recover your funds' : spent ? 'Deposit complete' : 'Your receiving address';
  el('save-recovery-gate').hidden = saved;
  el('receive-info').hidden = !saved;
  el('backup-status').hidden = true;
  for (const id of ['balance-status', 'refresh-deposit', 'wallet-tools']) el(id).hidden = !saved;
  el('new-receive').hidden = false;
  el('new-receive').textContent = saved ? 'Create another address' : 'Back to setup';
  document.querySelector<HTMLElement>('.restore-panel')!.hidden = prepared;
  el('deposit-review').hidden = !quoted;
  el('net-amount').parentElement!.hidden = !quoted;
  const save = el('save-backup');
  const parent = saved ? el('saved-recovery-action') : el('save-recovery-gate');
  if (save.parentElement !== parent) parent.append(save);
  save.classList.toggle('primary', !saved); save.classList.toggle('secondary', saved);
  el('save-backup-label').textContent = saved ? 'Save recovery file again' : 'Save & show address';
}
