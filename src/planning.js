import { DateTime } from 'luxon';
import { ZONE } from './calendar.js';
import { RecordError, validate } from './records.js';
import { summarizeExam } from './overview.js';
import { mergeIntervals, subtractIntervals } from './intervals.js';
import { normalizePlanningPreferences, planningParameters } from './planning-policy.js';

const MINUTE = 60000;
const iso = ms => DateTime.fromMillis(ms, { zone: ZONE }).toISO();
const floorMinutes = ms => Math.max(0, Math.floor(ms / MINUTE));
const NOTES = [
  'Recommendations only: no events, tasks, estimates or preparation states are created or changed; no time is reserved and no notification is scheduled.',
  'Availability is based only on cached published commitments and the displayed study preferences, not a guarantee of personal availability.',
  'Recorded effort is total estimated effort, not measured remaining work. Starter budgets are suggestions, not invented effort estimates or promises of completion.',
  'Date-only deadlines/exams are planned before their date; same-day work with an unknown deadline time requires clarification. Overdue assignments are explicitly recovery work, never on-time completion.',
  'Blocked periods include buffers and conservative exclusions, not invented class/exam durations. Sessions also reserve the displayed break on both sides.',
  'Only free periods at least the minimum session length are listed. Allocation is a deterministic greedy heuristic, not an optimality or impossibility proof; small residual budgets can remain unallocated.',
];
function cutoff(date, time) {
  if (!date) return null;
  return DateTime.fromISO(time ? `${date}T${time}` : date, { zone: ZONE });
}
function workloadFor(service, now, input, policy) {
  const work = [];
  for (const kind of ['assignments', 'exams']) {
    for (const row of service.store.listRecords(kind)) {
      if (kind === 'assignments' && row.status === 'completed') continue;
      if (kind === 'exams' && (row.preparationStatus === 'ready' || !['upcoming', 'time_unknown_today', 'undated'].includes(summarizeExam(row, now).timingStatus))) continue;
      const isAssignment = kind === 'assignments';
      const title = isAssignment ? row.title : row.subject;
      if (input.subject && ![title, row.course, ...(row.topics ?? [])].some(value => value?.toLowerCase().includes(input.subject.toLowerCase()))) continue;
      const dueDate = isAssignment ? row.dueDate : row.examDate;
      const dueTime = isAssignment ? row.dueTime : row.startTime;
      const estimatedMinutes = isAssignment ? row.estimatedMinutes : null;
      const overdue = isAssignment && service.records.present('assignments', row, now).deadlineState === 'overdue';
      const boundary = cutoff(dueDate, dueTime);
      const cutoffReason = overdue ? 'overdue_recovery' : !dueDate ? 'no_deadline' : dueTime ? 'exact_deadline' : 'before_date_only_deadline';
      work.push({
        id: `${isAssignment ? 'assignment' : 'exam'}:${row.id}`, recordId: row.id,
        kind: isAssignment ? 'assignment' : 'exam', title, course: row.course ?? null, topics: row.topics ?? [],
        dueDate, dueTime, priority: row.priority ?? null, status: row.status ?? row.preparationStatus,
        estimatedMinutes, budgetMinutes: estimatedMinutes ?? policy.starterMinutes,
        budgetBasis: estimatedMinutes === null ? 'starter_suggestion' : 'record_estimate',
        urgency: overdue ? 'overdue' : dueDate ? 'dated' : 'undated',
        deadlineAt: dueDate && dueTime ? boundary.toISO() : null,
        planningCutoff: overdue ? null : boundary?.toISO() ?? null, cutoffReason,
        reason: overdue ? 'Overdue recovery; the recorded deadline has already passed.' : dueDate ? 'Dated work: earliest date first, then priority, progress and effort.' : 'Undated work: no deadline or urgency has been assumed.',
        allocatedMinutes: 0, unallocatedMinutes: estimatedMinutes ?? policy.starterMinutes, unallocatedReason: null,
      });
    }
  }
  if (input.subject && !work.length) work.push({
    id: 'requested-topic', recordId: null, kind: 'requested', title: input.subject, course: null, topics: [],
    dueDate: null, dueTime: null, priority: null, status: 'requested', estimatedMinutes: null,
    budgetMinutes: input.minutes ?? policy.starterMinutes, budgetBasis: input.minutes ? 'user_request' : 'starter_suggestion',
    urgency: 'undated', deadlineAt: null, planningCutoff: null, cutoffReason: 'no_deadline',
    reason: 'Explicitly requested study topic; not a stored assignment or exam.',
    allocatedMinutes: 0, unallocatedMinutes: input.minutes ?? policy.starterMinutes, unallocatedReason: null,
  });
  if (input.subject && input.minutes && work.length === 1 && work[0].estimatedMinutes === null) {
    work[0].budgetMinutes = input.minutes;
    work[0].unallocatedMinutes = input.minutes;
    work[0].budgetBasis = 'user_request';
  }
  const urgency = { overdue: 0, dated: 1, undated: 2 }, priority = { high: 0, normal: 1, low: 2 };
  work.sort((a, b) => urgency[a.urgency] - urgency[b.urgency]
    || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || (a.dueTime ?? '00:00').localeCompare(b.dueTime ?? '00:00')
    || (priority[a.priority ?? 'normal'] - priority[b.priority ?? 'normal'])
    || Number(!['in_progress'].includes(a.status)) - Number(!['in_progress'].includes(b.status))
    || a.budgetMinutes - b.budgetMinutes || a.id.localeCompare(b.id));
  return work;
}
function localWindow(day, time) {
  if (time === '24:00') return day.plus({ days: 1 });
  const wall = `${day.toISODate()}T${time}`;
  const result = DateTime.fromISO(wall, { zone: ZONE });
  // Never silently shift a nonexistent wall time or choose an ambiguous offset.
  return result.isValid && result.toFormat("yyyy-MM-dd'T'HH:mm") === wall && result.getPossibleOffsets().length === 1 ? result : null;
}
function allocate(workload, free, policy, input, availability, horizonStart) {
  const sessions = [], used = new Map();
  let remaining = free.map(period => ({ ...period }));
  let total = 0;
  for (const task of workload) {
    const cutoffMs = task.planningCutoff ? Date.parse(task.planningCutoff) : Infinity;
    while (task.unallocatedMinutes >= policy.minSessionMinutes) {
      let chosen;
      for (const period of remaining) {
        const dailyLeft = policy.dailyLimitMinutes - (used.get(period.date) ?? 0);
        let minutes = Math.min(policy.maxSessionMinutes, task.unallocatedMinutes, dailyLeft,
          (input.minutes ?? Infinity) - total, floorMinutes(Math.min(period.end, cutoffMs) - period.start));
        if (minutes < policy.minSessionMinutes) continue;
        const tail = task.unallocatedMinutes - minutes;
        // Avoid a tiny residual when it can be split into two valid blocks.
        if (tail > 0 && tail < policy.minSessionMinutes && minutes - (policy.minSessionMinutes - tail) >= policy.minSessionMinutes
          && floorMinutes(Math.min(period.end, cutoffMs) - period.start) >= task.unallocatedMinutes + policy.breakMinutes
          && dailyLeft >= task.unallocatedMinutes && (input.minutes ?? Infinity) - total >= task.unallocatedMinutes) minutes -= policy.minSessionMinutes - tail;
        chosen = { period, minutes };
        break;
      }
      if (!chosen) break;
      const { period, minutes } = chosen;
      const end = period.start + minutes * MINUTE;
      sessions.push({ taskId: task.id, kind: task.kind, title: task.title, start: iso(period.start), end: iso(end), minutes,
        tentative: availability !== 'calendar_based', budgetBasis: task.budgetBasis, reason: task.reason, topics: task.topics });
      used.set(period.date, (used.get(period.date) ?? 0) + minutes);
      total += minutes;
      task.allocatedMinutes += minutes;
      task.unallocatedMinutes -= minutes;
      remaining = subtractIntervals(remaining, [{ start: period.start - policy.breakMinutes * MINUTE, end: end + policy.breakMinutes * MINUTE }]);
    }
    if (task.unallocatedMinutes) task.unallocatedReason = availability === 'unavailable' ? 'calendar_unavailable'
      : task.planningCutoff && Date.parse(task.planningCutoff) <= horizonStart
        ? task.cutoffReason === 'before_date_only_deadline' ? 'deadline_time_unknown' : 'outside_planning_window'
        : task.unallocatedMinutes < policy.minSessionMinutes ? 'below_minimum_block'
          : input.minutes !== undefined && input.minutes - total < policy.minSessionMinutes ? 'requested_limit'
            : 'insufficient_time_within_constraints';
  }
  sessions.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.taskId.localeCompare(b.taskId));
  return { sessions, used, total };
}

export function buildStudyPlan(service, now, rawInput = {}) {
  validate(planningParameters, rawInput);
  const input = { ...rawInput, date: rawInput.date ?? now.toISODate(), days: rawInput.days ?? 7,
    ...(rawInput.subject ? { subject: rawInput.subject.trim() } : {}) };
  const from = DateTime.fromISO(input.date, { zone: ZONE });
  if (!from.isValid || input.date < now.toISODate() || input.date > now.plus({ years: 1 }).toISODate()) throw new RecordError('Planning date must be a valid Paris date from today through one year ahead.');
  const to = from.plus({ days: input.days });
  const policy = normalizePlanningPreferences(input.preferences ?? {}, service.planningPolicy);
  const calendar = { ...service.syncStatus(), queryError: null };
  const workload = workloadFor(service, now, input, policy);
  const warnings = [], excludedDates = [], blocks = [], windows = [], days = [];
  const warn = (code, message, recordIds = []) => warnings.push({ code, message, recordIds });
  const exclude = (day, end, reason, recordIds) => {
    if (end <= from || day >= to) return;
    blocks.push({ start: day.toMillis(), end: end.toMillis() });
    excludedDates.push({ date: day.toISODate(), reason, recordIds });
  };
  const padding = policy.eventBufferMinutes * MINUTE;
  const addBusy = (start, end) => blocks.push({ start: start - padding, end: end + padding });
  if (!calendar.hasCache) warn('calendar_missing', 'No successful university calendar cache. Availability and session recommendations are withheld.');
  else {
    try {
      for (const event of service.scheduleBetween(from.minus({ minutes: policy.eventBufferMinutes }), to.plus({ minutes: policy.eventBufferMinutes })).events) {
        const start = Date.parse(event.start), end = Date.parse(event.end);
        if (end > start) addBusy(start, end);
        else {
          const day = DateTime.fromISO(event.start).setZone(ZONE).startOf('day');
          exclude(day, day.plus({ days: 1 }), 'Calendar event has no known positive duration; its day is conservatively excluded.', [event.id]);
          warn('event_duration_unknown', 'A point/zero-duration calendar event cannot establish availability; its date is excluded.', [event.id]);
        }
      }
    } catch {
      calendar.queryError = 'Cached calendar could not be expanded. Availability and session recommendations are withheld.';
      warn('calendar_unreadable', calendar.queryError);
    }
    if (calendar.error) warn('calendar_refresh_failed', 'Using the last successful cache after a failed refresh. Suggestions are provisional.');
    const last = calendar.lastSyncedAt ? DateTime.fromISO(calendar.lastSyncedAt) : null;
    if (!last?.isValid || last > now || now.diff(last, 'hours').hours > 24) warn('calendar_stale', 'The cache has an unknown synchronization time or is over 24 hours old. Confirm the timetable before following suggestions.');
  }
  for (const row of service.store.listRecords('exams')) {
    const exam = summarizeExam(row, now);
    if (!exam.examDate) { warn('exam_date_unknown', 'An undated exam cannot be placed on the calendar. Availability is provisional.', [row.id]); continue; }
    const day = DateTime.fromISO(exam.examDate, { zone: ZONE });
    if (exam.startsAt && exam.endsAt) {
      addBusy(Date.parse(exam.startsAt), Date.parse(exam.endsAt));
    } else if (exam.durationMinutes !== null) {
      // With no start time, the latest possible start is bounded by the date's
      // exclusive end. This is a conservative bound, not an invented start/end.
      const start = day.minus({ minutes: policy.eventBufferMinutes });
      const end = day.plus({ days: 1, minutes: exam.durationMinutes + policy.eventBufferMinutes });
      if (end > from && start < to) {
        exclude(start, end, 'Exam start unknown: conservative latest-finish bound, not an actual exam interval.', [row.id]);
        warn('exam_timing_unknown', 'An exam has no start time. Its date and possible spillover, plus buffers, are conservatively excluded using its known duration.', [row.id]);
      }
    } else if (day >= now.startOf('day') && day.minus({ minutes: policy.eventBufferMinutes }) < to) {
      // An unknown duration has no invented upper bound. A future/current exam
      // excludes the rest of this finite planning horizon from its possible start.
      const start = (exam.startsAt ? DateTime.fromISO(exam.startsAt) : day).minus({ minutes: policy.eventBufferMinutes });
      exclude(start, to, 'Exam finish unknown: remainder of horizon excluded, not an assumed exam duration.', [row.id]);
      warn('exam_timing_unknown', 'An exam has no known duration. The remainder of the horizon from its possible start is excluded; clarify its finish to recover usable periods.', [row.id]);
    } else if (day < now.startOf('day') && !exam.endsAt) {
      warn('past_exam_finish_unknown', 'A past dated exam has no known finish. It is not assigned an invented ongoing interval; confirm it has ended before relying on these provisional periods.', [row.id]);
    }
  }
  const earliest = Math.ceil(now.toMillis() / MINUTE) * MINUTE;
  for (let offset = 0; offset < input.days; offset++) {
    const day = from.plus({ days: offset });
    days.push({ date: day.toISODate(), freeMinutes: 0, plannedMinutes: 0 });
    if (!policy.weekdays.includes(day.weekday)) continue;
    for (const window of policy.windows) {
      const start = localWindow(day, window.start), end = localWindow(day, window.end);
      if (!start || !end) {
        excludedDates.push({ date: day.toISODate(), reason: 'Study-window boundary is nonexistent/ambiguous during a Paris DST transition.', recordIds: [] });
        warn('study_window_dst', 'A study window was skipped rather than guessing its DST offset. Choose unambiguous boundary times.');
        continue;
      }
      if (end.toMillis() > Math.max(start.toMillis(), earliest)) windows.push({ date: day.toISODate(), start: Math.max(start.toMillis(), earliest), end: end.toMillis() });
    }
  }
  const availability = !calendar.hasCache || calendar.queryError ? 'unavailable' : warnings.length ? 'provisional' : 'calendar_based';
  const merged = mergeIntervals(blocks).map(block => ({ start: Math.max(block.start, from.toMillis()), end: Math.min(block.end, to.toMillis()) })).filter(block => block.end > block.start);
  const free = availability === 'unavailable' ? [] : subtractIntervals(windows, merged)
    .map(period => ({ ...period, start: Math.ceil(period.start / MINUTE) * MINUTE, end: Math.floor(period.end / MINUTE) * MINUTE }))
    .filter(period => floorMinutes(period.end - period.start) >= policy.minSessionMinutes);
  const { sessions, used, total } = allocate(workload, free, policy, input, availability, Math.max(from.toMillis(), earliest));
  const freePeriods = free.map(period => ({ date: period.date, start: iso(period.start), end: iso(period.end), minutes: floorMinutes(period.end - period.start) }));
  for (const day of days) {
    day.freeMinutes = freePeriods.filter(period => period.date === day.date).reduce((sum, period) => sum + period.minutes, 0);
    day.plannedMinutes = used.get(day.date) ?? 0;
  }
  const summary = {
    freeMinutes: days.reduce((sum, day) => sum + day.freeMinutes, 0), plannedMinutes: total,
    targetMinutes: workload.reduce((sum, task) => sum + task.budgetMinutes, 0),
    unallocatedMinutes: workload.reduce((sum, task) => sum + task.unallocatedMinutes, 0),
    requestedMinutes: input.minutes ?? null, requestedShortfallMinutes: input.minutes === undefined ? null : input.minutes - total,
    unknownEffortCount: workload.filter(task => task.estimatedMinutes === null).length,
    undatedWorkCount: workload.filter(task => task.dueDate === null).length, overdueWorkCount: workload.filter(task => task.urgency === 'overdue').length,
  };
  const insights = [
    ...(availability === 'unavailable' ? ['Synchronize a usable university calendar before treating any period as available.'] : []),
    ...(!workload.length ? ['No matching active work. Add assignments/exams or specify an explicit study subject; no academic task has been invented.'] : []),
    ...(summary.overdueWorkCount ? [`${summary.overdueWorkCount} overdue assignment(s) need recovery; recommendations do not make their deadlines on time.`] : []),
    ...(summary.undatedWorkCount ? [`${summary.undatedWorkCount} work item(s) have no known deadline; clarify dates instead of assuming urgency.`] : []),
    ...(summary.unknownEffortCount ? [`${summary.unknownEffortCount} item(s) have unknown effort; displayed budgets are user-requested goals or starter suggestions, not effort estimates.`] : []),
    ...(summary.unallocatedMinutes ? [`${summary.unallocatedMinutes} budget minute(s) are not covered by this plan. Check per-item reasons, deadline times, available periods and study limits; this is not a claim that all work is impossible before its actual deadline.`] : []),
    ...(sessions.length ? [`First suggested focus: ${sessions[0].title}. Sessions are proposals only, not completed work or reserved events.`] : []),
  ];
  return { timezone: ZONE, generatedAt: now.toISO(), range: { from: from.toISO(), to: to.toISO() }, subject: input.subject ?? null,
    availability, calendar, policy, warnings, notes: [...NOTES], insights, excludedDates,
    blockedPeriods: merged.map(block => ({ start: iso(block.start), end: iso(block.end) })), freePeriods, days, workload, sessions, summary };
}
