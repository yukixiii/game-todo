import { DAY, HOUR } from "./time";

export interface ServerClock {
	/** Server UTC offset in hours, e.g. 8 for Asia servers. */
	utcOffset: number;
	/** Daily reset hour in server time. */
	resetHour: number;
	/** Default weekly reset weekday (0 = Sunday) for a bare "weekly" rule. */
	weeklyResetDay: number;
}

export interface Period {
	start: number;
	end: number;
	/** Server-local date of the period start, YYYY-MM-DD. */
	label: string;
}

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export type Rule =
	| { kind: "daily" }
	| { kind: "weekly"; dow: number }
	| { kind: "monthly"; day: number }
	| { kind: "interval"; days: number; anchor: { y: number; m: number; d: number } };

export function parseRule(text: string, clock: ServerClock): Rule | null {
	const s = text.trim().toLowerCase();
	if (s === "daily") return { kind: "daily" };
	if (s === "weekly") return { kind: "weekly", dow: clock.weeklyResetDay };
	let m = /^weekly:(sun|mon|tue|wed|thu|fri|sat)$/.exec(s);
	if (m) return { kind: "weekly", dow: DOW[m[1]] };
	m = /^monthly:(\d{1,2})$/.exec(s);
	if (m) {
		const day = Number(m[1]);
		return day >= 1 && day <= 28 ? { kind: "monthly", day } : null;
	}
	m = /^interval:(\d+)@(\d{4})-(\d{2})-(\d{2})$/.exec(s);
	if (m) {
		const days = Number(m[1]);
		if (days < 1) return null;
		return { kind: "interval", days, anchor: { y: Number(m[2]), m: Number(m[3]), d: Number(m[4]) } };
	}
	return null;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * Returns the period containing `now`. All arithmetic happens in "server wall-clock" space:
 * shifting by the UTC offset lets us use UTC getters as if they were server-local.
 */
export function currentPeriod(rule: Rule, now: number, clock: ServerClock): Period {
	const shift = clock.utcOffset * HOUR;
	const reset = clock.resetHour * HOUR;
	// Server-local time, then moved back by the reset hour so that "day" boundaries fall on 00:00.
	const t = now + shift - reset;
	const day0 = Math.floor(t / DAY) * DAY; // UTC-midnight of the current reset-day
	const toReal = (wall: number) => wall + reset - shift;
	const label = (wall: number) => {
		const d = new Date(wall);
		return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	};

	switch (rule.kind) {
		case "daily":
			return { start: toReal(day0), end: toReal(day0 + DAY), label: label(day0) };
		case "weekly": {
			const dow = new Date(day0).getUTCDay();
			const start = day0 - ((dow - rule.dow + 7) % 7) * DAY;
			return { start: toReal(start), end: toReal(start + 7 * DAY), label: label(start) };
		}
		case "monthly": {
			const d = new Date(day0);
			const y = d.getUTCFullYear();
			let mo = d.getUTCMonth();
			if (d.getUTCDate() < rule.day) mo -= 1;
			const start = Date.UTC(y, mo, rule.day);
			const end = Date.UTC(y, mo + 1, rule.day);
			return { start: toReal(start), end: toReal(end), label: label(start) };
		}
		case "interval": {
			const anchor = Date.UTC(rule.anchor.y, rule.anchor.m - 1, rule.anchor.d);
			const len = rule.days * DAY;
			const start = anchor + Math.floor((day0 - anchor) / len) * len;
			return { start: toReal(start), end: toReal(start + len), label: label(start) };
		}
	}
}

export function kindForRule(rule: Rule): "daily" | "weekly" | "periodic" {
	return rule.kind === "daily" ? "daily" : rule.kind === "weekly" ? "weekly" : "periodic";
}
