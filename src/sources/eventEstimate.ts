/**
 * Rough play time of an event from its announcement, by category.
 *
 * No source publishes event play times, so these are judgement-based defaults per category, not a
 * fitted model. The category is detected from the title (both games put the event type there:
 * "期間限定戦闘イベント「…」", "イベント「…」：ログインで原石…") and from the body text.
 */

export interface EventEstimate {
	minutes: number;
	category: string;
}

interface Rule {
	category: string;
	minutes: number;
	/** Matched against the title. */
	title?: RegExp;
	/** Matched against the body text (all lines joined). */
	body?: RegExp;
}

/** First match wins, so cheap/specific categories come before broad ones. */
const RULES: Rule[] = [
	// Free character selection ("…の★5キャラクターを招待可能"), even when the title mentions 祈願.
	{ category: "キャラ招待", minutes: 5, title: /招待/ },
	{ category: "祈願", minutes: 10, title: /祈願|唱喚|確率UP/ },
	{ category: "ログイン", minutes: 5, title: /ログイン/, body: /^\d+日目$/m },
	{ category: "報酬アップ", minutes: 5, title: /2倍|ドロップ量|報酬アップ/ },
	{ category: "Web・アンケート", minutes: 10, title: /Web|ウェブ|アンケート|予測|コメント/ },
	{ category: "紀行・パス", minutes: 10, title: /紀行|先駆ラジオ|努力の褒賞|鍛錬の道/ },
	// "期間中に魔神任務をクリアすると…" — the quest itself is imported as its own task.
	{ category: "任務連動ボーナス", minutes: 5, title: /期間中に.*(任務|クリア)/ },
	{ category: "世界任務", minutes: 60, title: /^世界任務/ },
	{ category: "七聖召喚", minutes: 60, title: /七聖召喚/ },
	{ category: "周期コンテンツ", minutes: 60, title: /周期コンテンツ/ },
	{ category: "恒常イベント", minutes: 120, title: /恒常/ },
	// Multi-stage events ("第一段階 … 第二段階", "4つの段階に分かれ"), or Wuthering Waves events whose reward
	// is 1000+ 星声 (the version's main event, sometimes labelled "ミニイベント").
	{
		category: "大型イベント",
		minutes: 180,
		body: /第[一二三四五六七八九十]段階[\s\S]*第[二三四五六七八九十]段階|[2-9二三四五六七八九]つの段階|星声\*[1-9]\d{3,}/,
	},
	{ category: "探索", minutes: 120, title: /探索|探検|エリア/ },
	{ category: "ミニゲーム", minutes: 60, title: /ミニ/ },
	{ category: "収集", minutes: 60, title: /収集/ },
	{ category: "戦闘・挑戦", minutes: 60, title: /戦闘|挑戦|激戦|討伐|バトル/ },
	{ category: "依頼", minutes: 60, title: /依頼/ },
	// Spending rewards ("「月が照らす道」 イベント概要") only say so in the body.
	{ category: "課金報酬", minutes: 5, title: /チャージ/, body: /チャージ/ },
];

/** Unknown events: a mid-size default, labelled as such so the user knows it is a guess. */
const FALLBACK: EventEstimate = { category: "その他", minutes: 90 };

export function estimateEvent(title: string, bodyLines: string[] = []): EventEstimate {
	const body = bodyLines.join("\n");
	for (const r of RULES) {
		if ((r.title && r.title.test(title)) || (r.body && r.body.test(body))) {
			return { category: r.category, minutes: r.minutes };
		}
	}
	return FALLBACK;
}

export function eventEstimateBasis(e: EventEstimate): string {
	return `種類「${e.category}」の目安（実測データはないため要確認）`;
}
