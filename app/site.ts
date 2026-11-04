export {};

const menu = document.querySelector<HTMLDetailsElement>('#site-menu')!;
const menuToggle = document.querySelector<HTMLElement>('#menu-toggle')!;

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

