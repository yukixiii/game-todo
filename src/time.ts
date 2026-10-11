export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}

/**
 * Parses a frontmatter date value into epoch ms.
 * Accepts ISO strings with or without offset (no offset = local time),
 * "YYYY-MM-DD HH:mm" and date-only values (treated as local 23:59:59).
 */
export function parseDate(value: unknown): number | undefined {
	if (value instanceof Date) return isNaN(value.getTime()) ? undefined : value.getTime();
	if (typeof value === "number") return value;
	if (typeof value !== "string") return undefined;
	const s = value.trim();
	if (!s) return undefined;
	const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
	if (dateOnly) {
		const [, y, m, d] = dateOnly;
		return new Date(Number(y), Number(m) - 1, Number(d), 23, 59, 59).getTime();
	}
	const t = Date.parse(s.replace(" ", "T"));
	return isNaN(t) ? undefined : t;
}

/**
 * Parses a wall-clock time "YYYY-MM-DD HH:mm[:ss]" that is expressed in a fixed UTC offset.
 */
export function parseWallClock(value: string, offsetHours: number): number | undefined {
	const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
	if (!m) return undefined;
	const [, y, mo, d, h, mi, s] = m;
	const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
	return utc - offsetHours * HOUR;
}

/** Formats epoch ms as an ISO string in the machine's local offset, e.g. 2026-11-04T04:59+09:00. */
export function formatLocalIso(ms: number): string {
	const d = new Date(ms);
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const abs = Math.abs(off);
	const sec = d.getSeconds() ? `:${pad(d.getSeconds())}` : "";
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}:${pad(d.getMinutes())}${sec}` +
		`${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
	);
}

/** Short human display: "10/15(水) 11:00". */
export function formatShort(ms: number): string {
	const d = new Date(ms);
	const wd = "日月火水木金土"[d.getDay()];
	return `${d.getMonth() + 1}/${d.getDate()}(${wd}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "1時間30分" style duration for minutes. */
export function formatMinutes(min: number): string {
	const m = Math.round(min);
	if (m < 60) return `${m}分`;
	const h = Math.floor(m / 60);
	return m % 60 ? `${h}時間${m % 60}分` : `${h}時間`;
}

/** Signed duration for slack display: "+2日3時間" / "-45分". */
export function formatSpan(ms: number): string {
	const sign = ms < 0 ? "-" : "+";
	let min = Math.round(Math.abs(ms) / MINUTE);
	const d = Math.floor(min / 1440);
	min -= d * 1440;
	const h = Math.floor(min / 60);
	min -= h * 60;
	if (d) return `${sign}${d}日${h ? `${h}時間` : ""}`;
	if (h) return `${sign}${h}時間${min ? `${min}分` : ""}`;
	return `${sign}${min}分`;
}
