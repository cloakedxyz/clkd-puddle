import {setupChoiceMenu} from './menus.ts';

/** Cloaked's production networks and unchanged brand assets. Route availability is configured separately. */
export const fundingNetworks = [
  {chainId: 8453, name: 'Base', logo: 'base'},
  {chainId: 1, name: 'Ethereum', logo: 'ethereum'},
  {chainId: 10, name: 'Optimism', logo: 'optimism'},
  {chainId: 56, name: 'BNB Chain', logo: 'bnb'},
  {chainId: 42161, name: 'Arbitrum', logo: 'arbitrum'},
  {chainId: 4663, name: 'Robinhood', logo: 'robinhood'},
] as const;
export const chainLogoFiles = fundingNetworks.map(network => `assets/chains/${network.logo}.png`);

/** Native buttons keep the logo menu usable with keyboard, touch and screen readers. */
export function setupNetworkPicker(select: HTMLSelectElement, destinationChainId: number, isLocked: () => boolean) {
  const picker = document.getElementById('network-picker')!;
  const toggle = document.getElementById('chain-menu-toggle') as HTMLButtonElement;
  const menu = document.getElementById('chain-menu')!;
  const name = document.getElementById('selected-chain-name')!;
  const logo = document.getElementById('selected-chain-logo') as HTMLImageElement;
  const chainId = (option: HTMLOptionElement) => option.value ? Number(option.value) : destinationChainId;
  const existing = new Map(Array.from(select.options, option => [chainId(option), option]));
  for (const network of fundingNetworks) {
    if (existing.has(network.chainId)) continue;
    const option = document.createElement('option');
    option.value = String(network.chainId); option.textContent = network.name; option.disabled = true;
    select.append(option); existing.set(network.chainId, option);
  }
  const ordered = Array.from(select.options).sort((a, b) => {
    const rank = (option: HTMLOptionElement) => fundingNetworks.findIndex(network => network.chainId === chainId(option));
    return rank(a) - rank(b);
  });
  const choices = ordered.map(option => {
    const id = chainId(option), network = fundingNetworks.find(network => network.chainId === id);
    const choice = document.createElement('button');
    choice.type = 'button'; choice.className = 'chain-choice'; choice.id = `chain-option-${id}`;
    if (network) {
      const image = document.createElement('img'); image.src = `/assets/chains/${network.logo}.png`;
      image.className = 'chain-logo'; image.dataset.chainId = String(id); image.width = image.height = 20; image.alt = '';
      choice.append(image);
    }
    const label = document.createElement('span'); label.textContent = network?.name ?? option.textContent;
    const status = document.createElement('span'); status.className = 'chain-choice-state';
    choice.append(label, status); menu.append(choice);
    choice.addEventListener('click', () => {
      if (choice.disabled || isLocked()) return;
      select.value = option.value; select.dispatchEvent(new Event('change', {bubbles: true})); close(true);
    });
    return {option, choice, status};
  });
  const {close} = setupChoiceMenu(picker, toggle, menu, isLocked);
  function render() {
    const locked = isLocked(), option = select.selectedOptions[0], id = chainId(option);
    const network = fundingNetworks.find(network => network.chainId === id);
    select.disabled = toggle.disabled = locked;
    name.textContent = network?.name ?? option.textContent;
    toggle.setAttribute('aria-label', `Fund from ${name.textContent}`);
    logo.hidden = !network; logo.dataset.chainId = String(id);
    if (network) logo.src = `/assets/chains/${network.logo}.png`;
    for (const {option, choice, status} of choices) {
      choice.disabled = locked || option.disabled;
      choice.setAttribute('aria-pressed', String(option.selected));
      status.textContent = option.disabled ? 'Unavailable' : option.selected ? '✓' : '';
    }
    if (locked) close();
  }
  select.addEventListener('change', render);
  render(); return {render};
}
