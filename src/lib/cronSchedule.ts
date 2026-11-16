// Human-readable descriptions of pg_cron schedules. Covers the shapes people
// actually write; anything else falls back to the raw expression (null).

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const SCHEDULE_PRESETS: { label: string; schedule: string }[] = [
  { label: "Every minute", schedule: "* * * * *" },
  { label: "Every 5 minutes", schedule: "*/5 * * * *" },
  { label: "Every 15 minutes", schedule: "*/15 * * * *" },
  { label: "Hourly", schedule: "0 * * * *" },
  { label: "Daily at 03:00", schedule: "0 3 * * *" },
  { label: "Weekly (Sunday 03:00)", schedule: "0 3 * * 0" },
  { label: "Monthly (1st, 03:00)", schedule: "0 3 1 * *" },
  { label: "Every 30 seconds", schedule: "30 seconds" },
];

const isNumber = (s: string) => /^\d+$/.test(s);
const pad = (s: string) => s.padStart(2, "0");

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function dayNames(field: string): string | null {
  if (field === "1-5") return "weekdays";
  if (field === "0,6" || field === "6,0") return "weekends";
  const parts = field.split(",");
  if (!parts.every(isNumber)) return null;
  const names = parts.map((p) => DAYS[Number(p) % 7]);
  return names.every(Boolean) ? names.join(", ") : null;
}

/// Describes a schedule in plain English, or returns null when it isn't one of the
/// recognized shapes. pg_cron runs schedules in the server's `cron.timezone` (GMT by
/// default), so the times are stated without a zone.
export function describeSchedule(schedule: string): string | null {
  const s = schedule.trim();
  const interval = /^(\d+) seconds?$/i.exec(s);
  if (interval) return interval[1] === "1" ? "Every second" : `Every ${interval[1]} seconds`;

  const f = s.split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  const anyDay = dom === "*" && mon === "*" && dow === "*";

  if (anyDay && hour === "*") {
    if (min === "*") return "Every minute";
    const step = /^\*\/(\d+)$/.exec(min);
    if (step) return `Every ${step[1]} minutes`;
    if (isNumber(min)) return `Hourly, at minute ${min}`;
    return null;
  }
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (anyDay && hourStep && isNumber(min)) {
    return `Every ${hourStep[1]} hours, at minute ${min}`;
  }
  if (!isNumber(min) || !isNumber(hour)) return null;
  const at = `${pad(hour)}:${pad(min)}`;

  if (anyDay) return `Daily at ${at}`;
  if (dom === "*" && mon === "*") {
    const days = dayNames(dow);
    return days ? `At ${at} on ${days}` : null;
  }
  if (dow === "*" && isNumber(dom)) {
    const day = ordinal(Number(dom));
    if (mon === "*") return `Monthly on the ${day} at ${at}`;
    if (isNumber(mon) && MONTHS[Number(mon) - 1]) {
      return `Yearly on ${MONTHS[Number(mon) - 1]} ${day} at ${at}`;
    }
  }
  if (dom === "$" && mon === "*" && dow === "*") return `Monthly on the last day at ${at}`;
  return null;
}
