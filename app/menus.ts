/** Shared focus, keyboard and dismissal behavior for the two receiving selectors. */
export function setupChoiceMenu(picker: HTMLElement, toggle: HTMLButtonElement, menu: HTMLElement, isLocked: () => boolean) {
  const choices = () => Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).filter(button => !button.disabled);
  function close(focus = false) {
    menu.hidden = true; toggle.setAttribute('aria-expanded', 'false');
    if (focus) toggle.focus();
  }
  toggle.addEventListener('click', () => {
    if (isLocked()) return;
    const opening = menu.hidden; menu.hidden = !opening; toggle.setAttribute('aria-expanded', String(opening));
    if (opening) (choices().find(button => button.getAttribute('aria-pressed') === 'true') ?? choices()[0])?.focus();
  });
  document.addEventListener('click', event => {
    if (event.target instanceof Node && !picker.contains(event.target)) close();
  });
  picker.addEventListener('focusout', event => {
    if (event.relatedTarget instanceof Node && !picker.contains(event.relatedTarget)) close();
  });
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) {event.preventDefault(); close(true);}
    if (menu.hidden || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const enabled = choices(), current = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
    enabled[next]?.focus();
  });
  return {close};
}
