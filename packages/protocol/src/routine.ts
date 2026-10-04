import { z } from 'zod'
import { AttachmentId, MAX_CHAT_IMAGES } from './attachments'
import { ScheduledRun } from './schedule'
import { AGENT_KINDS, MAX_TASK_REPOS } from './task'

// A routine starts a run on a schedule: each time it comes due, a new conversation is opened
// and told what to do, unattended. Its runs are scheduled runs with the routine's id on them.

// Hourly runs align to local midnight, so the gaps stay even only when the count divides 24.
export const HOURLY_EVERY = [1, 2, 3, 4, 6, 8, 12] as const
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
// JS weekday: 0 is Sunday.
const Weekday = z.number().int().min(0).max(6)

export const RoutineSchedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hourly'), every: z.number().int().refine((every) => (HOURLY_EVERY as readonly number[]).includes(every)) }),
  z.object({ kind: z.literal('daily'), time: Time }),
  z.object({ kind: z.literal('weekdays'), time: Time }),
  z.object({ kind: z.literal('weekly'), days: z.array(Weekday).min(1).max(7), time: Time }),
  // Only when the user starts it by hand.
  z.object({ kind: z.literal('manual') })
])
export type RoutineSchedule = z.infer<typeof RoutineSchedule>

// 'auto': whichever installed agent has quota when the run comes due.
export const RoutineAgent = z.enum([...AGENT_KINDS, 'auto'])
export type RoutineAgent = z.infer<typeof RoutineAgent>

// What a run does: open a conversation for `agent` in these projects and send the text and
// images. model and effort only with a named agent. text or images must be given (core says
// routine-no-prompt otherwise).
export const RoutineTarget = z.object({
  kind: z.literal('new'),
  agent: RoutineAgent,
  projectPaths: z.array(z.string().trim().min(1)).max(MAX_TASK_REPOS),
  text: z.string().trim().max(100000),
  images: z.array(AttachmentId).max(MAX_CHAT_IMAGES).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.string().trim().min(1).max(200).optional()
})
export type RoutineTarget = z.infer<typeof RoutineTarget>

export const Routine = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  schedule: RoutineSchedule,
  target: RoutineTarget,
  // When it next comes due; null while paused or manual.
  nextRunAt: z.number().nullable(),
  lastFiredAt: z.number().nullable(),
  // Runs that finished, or could not start, which the user has not looked at.
  unread: z.number().int().nonnegative(),
  lastRun: ScheduledRun.nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Routine = z.infer<typeof Routine>

// Parsed one by one, so a routine a newer core describes differently drops alone.
export const RoutineList = z.array(z.unknown()).transform((routines) =>
  routines.flatMap((routine) => {
    const parsed = Routine.safeParse(routine)
    return parsed.success ? [parsed.data] : []
  })
)

// What the user may set; core keeps the rest.
export const RoutineFields = Routine.pick({ title: true, schedule: true, target: true, enabled: true }).partial({ enabled: true })
export type RoutineFields = z.infer<typeof RoutineFields>

// Times are local to the machine core runs on, built only through the Date(y, m, d, h, mi)
// constructor, so a change of clocks is handled by the platform: a time that does not exist
// on the spring-forward day rolls on an hour (the run goes an hour late, once); a time that
// comes twice on the fall-back day is taken the first time, and since the next occurrence is
// always strictly after now, the run does not go twice.

const DAYS_AHEAD = 14

function clock(time: string): [number, number] | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour < 24 && minute < 60 ? [hour, minute] : null
}

function allows(schedule: RoutineSchedule, weekday: number): boolean {
  if (schedule.kind === 'weekdays') return weekday >= 1 && weekday <= 5
  if (schedule.kind === 'weekly') return schedule.days.includes(weekday)
  return true
}

function validHourly(every: number): boolean {
  return (HOURLY_EVERY as readonly number[]).includes(every)
}

// Every time the schedule names on the day `offset` days from `from`, ascending.
function timesOn(schedule: RoutineSchedule, from: Date, offset: number): number[] {
  const day = (hour: number, minute: number) => new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, hour, minute, 0, 0).getTime()
  if (schedule.kind === 'manual') return []
  if (schedule.kind === 'hourly') {
    if (!validHourly(schedule.every)) return []
    const times: number[] = []
    for (let hour = 0; hour < 24; hour += schedule.every) times.push(day(hour, 0))
    return times
  }
  const at = clock(schedule.time)
  if (!at) return []
  if (schedule.kind === 'weekly' && (schedule.days.length === 0 || schedule.days.some((each) => !Number.isInteger(each) || each < 0 || each > 6))) return []
  const time = day(...at)
  return allows(schedule, new Date(time).getDay()) ? [time] : []
}

// The first time the schedule names strictly after `after`; null when it names none.
export function nextOccurrence(schedule: RoutineSchedule, after: number): number | null {
  const from = new Date(after)
  for (let offset = 0; offset <= DAYS_AHEAD; offset++) {
    const found = timesOn(schedule, from, offset).find((time) => time > after)
    if (found !== undefined) return found
  }
  return null
}

// The last time the schedule names at or before `at`: the one a machine that slept through
// several makes up for.
export function latestOccurrenceAtOrBefore(schedule: RoutineSchedule, at: number): number | null {
  const from = new Date(at)
  for (let offset = 0; offset >= -DAYS_AHEAD; offset--) {
    const found = timesOn(schedule, from, offset).findLast((time) => time <= at)
    if (found !== undefined) return found
  }
  return null
}

export function isValidSchedule(schedule: RoutineSchedule): boolean {
  return schedule.kind === 'manual' || nextOccurrence(schedule, 0) !== null
}

const pad = (value: number) => String(value).padStart(2, '0')

// What a routine's conversation is called: the routine, and when the run started, in local time.
export function routineRunTitle(title: string, startedAt: number): string {
  const at = new Date(startedAt)
  return `${title} · ${at.getMonth() + 1}月${at.getDate()}日 ${pad(at.getHours())}:${pad(at.getMinutes())}`
}
