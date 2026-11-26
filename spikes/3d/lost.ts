/** A lost graphics context (a graphics reset, or sleep) is not restored: the page says so and its loop stops. */
export const LOST_TEXT = 'The graphics context was lost (a graphics reset or sleep can do this).\nReload the page to continue.';

/** Watches `canvas`, and calls `show` with the message if its context is lost. The result tells whether it was. The
 *  event's default is left alone, which means the browser does not restore the context. */
export function watchContext(canvas: EventTarget, show: (text: string) => void): () => boolean {
  let lost = false;
  canvas.addEventListener('webglcontextlost', () => { lost = true; show(LOST_TEXT); });
  return () => lost;
}
