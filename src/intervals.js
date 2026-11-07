// Millisecond intervals use half-open [start, end) boundaries. These helpers
// are timezone-independent; callers construct Paris-local study-day windows.
export function mergeIntervals(intervals) {
  const sorted = intervals.filter(i => i.end > i.start).map(i => ({ start: i.start, end: i.end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push(interval);
  }
  return merged;
}
export function subtractIntervals(windows, exclusions) {
  const busy = mergeIntervals(exclusions);
  const result = [];
  for (const window of windows) {
    let cursor = window.start;
    for (const block of busy) {
      if (block.end <= cursor) continue;
      if (block.start >= window.end) break;
      if (block.start > cursor) result.push({ ...window, start: cursor, end: Math.min(block.start, window.end) });
      cursor = Math.max(cursor, block.end);
      if (cursor >= window.end) break;
    }
    if (cursor < window.end) result.push({ ...window, start: cursor });
  }
  return result;
}
