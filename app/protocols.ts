import {setupChoiceMenu} from './menus.ts';

export const privacyProtocols = [
  {id: 'railgun', name: 'RAILGUN', logo: 'railgun', available: true},
  {id: 'privacy-pools-v1', name: 'Privacy Pools v1', logo: 'privacy-pools', available: false},
  {id: 'privacy-pools-v2', name: 'Privacy Pools v2', logo: 'privacy-pools', available: false},
] as const;
export const protocolLogoFiles = [...new Set(privacyProtocols.map(protocol => `assets/protocols/${protocol.logo}.png`))];

/** Planned protocols are display-only. They cannot change the RAILGUN receiving terms. */
export function setupProtocolPicker(destinationName: string, isLocked: () => boolean) {
  document.getElementById('destination-chain')!.textContent = `on ${destinationName}`;
  const picker = document.getElementById('protocol-picker')!;
  const toggle = document.getElementById('protocol-menu-toggle') as HTMLButtonElement;
  const menu = document.getElementById('protocol-menu')!;
  const {close} = setupChoiceMenu(picker, toggle, menu, isLocked);
  const choices = privacyProtocols.map(protocol => {
    const button = document.createElement('button'); button.type = 'button';
    button.id = `protocol-option-${protocol.id}`; button.className = 'chain-choice protocol-choice';
    const logo = document.createElement('img'); logo.src = `/assets/protocols/${protocol.logo}.png`;
    logo.className = 'protocol-logo'; logo.width = logo.height = 28; logo.alt = '';
    const name = document.createElement('span'); name.textContent = protocol.name;
    const status = document.createElement('span'); status.className = 'chain-choice-state';
    status.textContent = protocol.available ? 'Available' : 'Coming soon';
    button.append(logo, name, status); button.setAttribute('aria-pressed', String(protocol.id === 'railgun'));
    button.addEventListener('click', () => {if (protocol.id === 'railgun' && !isLocked()) close(true);});
    menu.append(button); return {button, available: protocol.available};
  });
  function render() {
    toggle.disabled = isLocked();
    for (const {button, available} of choices) button.disabled = isLocked() || !available;
    if (isLocked()) close();
  }
  render(); return {render};
}
