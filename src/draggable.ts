/** Pointer movement below this many pixels is a click, not a drag. */
const DRAG_THRESHOLD = 4;
const MARGIN = 8;

export type Position = { x: number; y: number };

/** Keeps a fixed-position element fully on screen; returns the corrected position. */
export function clampToViewport(el: HTMLElement, pos: Position): Position {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(Math.min(Math.max(pos.x, MARGIN), Math.max(MARGIN, window.innerWidth - r.width - MARGIN))),
    y: Math.round(Math.min(Math.max(pos.y, MARGIN), Math.max(MARGIN, window.innerHeight - Math.min(r.height, 120) - MARGIN))),
  };
}

export function placeAt(el: HTMLElement, pos: Position): void {
  el.style.left = `${pos.x}px`;
  el.style.top = `${pos.y}px`;
  el.style.right = 'auto';
  // Let a tall panel scroll instead of running off the bottom of the window.
  el.style.maxHeight = `${window.innerHeight - pos.y - MARGIN}px`;
}

/**
 * Lets the user drag `el` (position: fixed) by pressing on it, except on buttons and
 * form controls. `canStart` limits where a drag may begin; `onClick` fires for presses
 * that did not move; `onDrop` receives the final position.
 */
export function makeDraggable(
  el: HTMLElement,
  opts: {
    canStart: (target: Element) => boolean;
    onDrop: (pos: Position) => void;
    onClick?: () => void;
  },
): void {
  let start: { px: number; py: number; x: number; y: number; id: number } | null = null;
  let dragging = false;

  el.addEventListener('pointerdown', (e) => {
    const target = e.composedPath()[0];
    if (e.button !== 0 || !(target instanceof Element)) return;
    if (target.closest('button, input, select, textarea, label, a') || !opts.canStart(target)) return;
    const r = el.getBoundingClientRect();
    start = { px: e.clientX, py: e.clientY, x: r.left, y: r.top, id: e.pointerId };
    dragging = false;
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  el.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.px;
    const dy = e.clientY - start.py;
    if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragging = true;
    el.classList.add('asl-dragging');
    placeAt(el, clampToViewport(el, { x: start.x + dx, y: start.y + dy }));
  });

  const end = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    start = null;
    el.classList.remove('asl-dragging');
    if (dragging) {
      const r = el.getBoundingClientRect();
      opts.onDrop({ x: Math.round(r.left), y: Math.round(r.top) });
    } else if (e.type === 'pointerup') {
      opts.onClick?.();
    }
    dragging = false;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
