import type { PeriodPolicy } from "@cst/shared";

export function describePeriod(p: PeriodPolicy): string {
  switch (p.kind) {
    case "calendar_day":
      return "Once per calendar day";
    case "rolling_24h":
      return "Once per rolling 24 hours";
    case "calendar_week":
      return `Once per week (starts ${p.weekStartsOn === 0 ? "Sunday" : "Monday"})`;
    case "calendar_month":
      return "Once per calendar month";
    case "permanent":
      return "Only the first accepted solution ever";
    case "custom_hours":
      return `Once per ${p.hours} hours`;
  }
}
