/** The prototype page. Without parameters: free flight (flying.ts). ?pose=<seconds>: a still view (still.ts).
 *  ?auto=perf or ?auto=flicker: a report (auto.ts). For all of them: ?stab=0|1|2 (default 2), &sync=1 builds tiles on
 *  the main thread (the flicker report does so unless sync=0), &profile=1 times each graphics pass, &timers=N keeps N
 *  timer queries in flight (for runs without a frame limit), &dbg=1 shows world cover, and the scale constants of scale.ts. For all of them too, the combat load test (combat.ts):
 *  &scene=combat|heavy, &ships= &bolts= &particles=. For all of them too, the world scenes (world.ts): &scene=gas|moon|ring, and
 *  &look=<name> for a still of one of the scene's viewpoints.
 *  ?check=occlusion: the occlusion check (check.ts). */
import { runReport } from './auto';
import { CHECK_ROOM, runCheck } from './check';
import { fly } from './flying';
import { openPage, params } from './page';
import { showStill } from './still';

const auto = params.get('auto');
const sync = auto === 'flicker' ? params.get('sync') !== '0' : params.get('sync') === '1';

try {
  const check = params.get('check') === 'occlusion';
  const page = openPage(sync || check, check ? CHECK_ROOM : undefined);
  if (check) runCheck(page);
  else if (auto === 'perf' || auto === 'flicker') runReport(page, auto);
  else if (params.has('pose') || params.has('look') || params.get('measure') === '1' || params.get('dump') === '1') showStill(page);
  else fly(page);
} catch (e) {
  document.getElementById('info')!.textContent = `The prototype could not start: ${e instanceof Error ? e.message : e}`;
  throw e;
}
