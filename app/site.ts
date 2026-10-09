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

const protocols = document.querySelector<HTMLElement>('#protocols')!;
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
  if (reducedMotion.matches || document.hidden || protocols.matches(':hover, :focus-within')) return;
  timer = setTimeout(() => {
    show((current + 1) % links.length);
    schedule();
  }, 2_800);
}

function configureRotation() {
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
  // Keyboard focus reveals either link, including the one currently out of view.
  const index = links.findIndex(link => link === event.target);
  if (index >= 0) show(index);
});
protocols.addEventListener('focusout', () => queueMicrotask(schedule));
document.addEventListener('visibilitychange', schedule);
reducedMotion.addEventListener('change', configureRotation);
configureRotation();

