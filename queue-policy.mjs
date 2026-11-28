// Local operating target for keys with a 30 RPM (or larger) minute window.
// A burst credit is spent only on dispatch and is never a separate RPM slot.
export function requestWindow(lim, forecast) {
  if (lim.model !== 'global' || lim.windowMs !== 60000 || lim.max < 30) return { cap: lim.max, target: lim.max };
  const used = lim.stamps.length;
  const small = forecast > 0 && forecast <= 250000 && lim.tokenMax > 0;
  const spare = small && lim.tokenSum() + forecast <= lim.tokenMax * 0.8;
  const burst = used >= 25 && used < 27 && lim.burstCredits > 0 && spare;
  // At 27 with a credit left the next expiring slot may be usable before 25.
  const cap = spare && lim.burstCredits > 0 ? 27 : 25;
  return { cap, target: 25, burst };
}

// Candidates are the oldest non-paused request of each session. A protected
// turn may be passed only if its estimated start time stays intact.
export function chooseTicket(candidates, { now, focused, waitAfter, fitBoth }) {
  const guarded = candidates.filter(c => c.ticket.passed >= 3 || now - (c.ticket.prioritySince ?? c.ticket.arrived) >= 5000);
  const delaySafe = candidates.filter((c,index) => !c.wait.ms && guarded.every(g =>
    candidates.indexOf(g) >= index || (g.wait.ms > 0 && waitAfter(c.ticket, g.ticket) <= g.wait.ms)));
  if (!delaySafe.length) return null;
  const normal = delaySafe.filter(c => !c.ticket.background);
  const pool = normal.length ? normal : delaySafe.filter(c => guarded.includes(c) || candidates.every(g =>
    g.ticket.background || (g.wait.ms > 0 && waitAfter(c.ticket,g.ticket) <= g.wait.ms)));
  if (!pool.length) return null;
  const protectedReady = pool.find(c => guarded.includes(c));
  if (protectedReady) return protectedReady;
  const size = c => c.ticket.budget || c.ticket.estimate || Infinity;
  const smallest = pool.reduce((a,b) => size(a) <= size(b) ? a : b);
  const viewed = normal.find(c => c.ticket.session === focused);
  return viewed && (viewed === smallest || fitBoth(viewed.ticket, smallest.ticket)) ? viewed : smallest;
}
