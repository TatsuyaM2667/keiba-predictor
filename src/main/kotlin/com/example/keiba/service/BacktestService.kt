package com.example.keiba.service

import kotlinx.serialization.Serializable
import kotlin.math.ln
import kotlin.math.max

// ==================================================================================
// BacktestService — 「予想の成績」: 過去の実際のレースを、レース前の情報だけで予想し直して答え合わせする
// ==================================================================================
// 1 レースごとに:
//   1. 出走馬 (取消・除外を除く) の特徴量から、採用モデルの勝率を出す (オッズが欠けていれば手動モデル)
//   2. 勝率の高い順に印 (◎◯▲△) を付け、7 通りの買い方 + アプリの買い目 + 1 番人気の単勝 を 1 点 100 円で買ったことにする
//   3. JRA の実際の払戻金で、いくら戻ったかを数える
//   4. 勝ち馬に付けていた確率から、対数損失 (予想の正確さ) を出す
// 画面 (予想の成績) は、この結果を表とグラフにするだけ。

/** 1 頭の要約 (表に出す用) */
@Serializable data class BacktestPick(val num: Int, val name: String, val pop: Int? = null, val place: Int? = null)

@Serializable data class PlanResult(val name: String, val cost: Int, val back: Int)

@Serializable
data class BacktestRace(
    val id: String,
    val date: String,
    val venueName: String,
    val raceNo: Int,
    val name: String,
    val grade: String,
    val winPayout: Int,
    val honmei: BacktestPick,
    val taiko: BacktestPick?,
    val favorite: BacktestPick?,
    val winner: BacktestPick?,
    val plans: List<PlanResult>,
    val logLossModel: Double?,
    val logLossHand: Double?,
    val logLossMarket: Double?,
)

@Serializable data class PlanTotal(val name: String, val races: Int, val hit: Int, val cost: Int, val back: Int)

@Serializable
data class BacktestSummary(
    val races: Int,
    val from: String,
    val to: String,
    val honmeiWin: Double,
    val honmeiTop3: Double,
    val favoriteWin: Double,
    val favoriteTop3: Double,
    val logLossModel: Double,
    val logLossHand: Double,
    val logLossMarket: Double,
    val plans: List<PlanTotal>,
    val excludedRaces: Int = 0, // 出馬表に抜けがあり、使わなかったレースの数
)

@Serializable
data class Backtest(val computedAt: String, val selected: String, val summary: BacktestSummary, val races: List<BacktestRace>)

object BacktestService {
    // 馬券の種類: 順番を問うか (払戻表の組番の書き方が変わる)
    private val ORDERED = setOf("umatan", "tierce")
    const val APP_PLAN = "アプリの買い目 (期待値 1 超えの単勝)"
    const val FAVORITE_PLAN = "1番人気の単勝 (比較用)"

    /** 印の順 (勝率の高い順の出走表の番号) → 7 つの買い方 (画面の race-model.js の planTickets と同じ) */
    fun planTickets(order: List<Int>): List<Pair<String, List<Pair<String, List<Int>>>>> {
        val a = order.getOrNull(0) ?: return emptyList()
        val (b, c, d) = listOf(1, 2, 3).map { order.getOrNull(it) }
        val plans = mutableListOf<Pair<String, List<Pair<String, List<Int>>>>>(
            "単勝 ◎" to listOf("win" to listOf(a)),
            "複勝 ◎" to listOf("place" to listOf(a)),
        )
        if (b != null) plans += "ワイド ◎-◯" to listOf("wide" to listOf(a, b))
        if (b != null && c != null && d != null) {
            plans += "馬連 ◎→◯▲△" to listOf(b, c, d).map { "umaren" to listOf(a, it) }
            plans += "馬単 ◎→◯▲△" to listOf(b, c, d).map { "umatan" to listOf(a, it) }
            plans += "3連複 ◎◯▲△ ボックス" to listOf(listOf(a, b, c), listOf(a, b, d), listOf(a, c, d), listOf(b, c, d)).map { "trio" to it }
            plans += "3連単 ◎ 1着固定 → ◯▲△" to listOf(b to c, b to d, c to b, c to d, d to b, d to c).map { (x, y) -> "tierce" to listOf(a, x, y) }
        }
        return plans
    }

    /** 実際の払戻金で、馬券 1 点 (100 円) がいくら戻ったか。組番は、順番を問わない券種は小さい順に「-」でつなぐ */
    fun payoutOf(payouts: Map<String, List<Payout>>, type: String, nums: List<Int>): Int {
        val key = (if (type in ORDERED) nums else nums.sorted()).joinToString("-")
        return payouts[type]?.firstOrNull { it.combo.replace(Regex("\\s"), "") == key }?.yen ?: 0
    }

    private fun logLoss(p: Double) = -ln(max(p, 1e-4))

    /** 1 レース分。予想に使える出走馬が 4 頭未満、または単勝の払戻がないレースは null */
    fun evaluate(r: PastRace, params: ModelParams): BacktestRace? {
        if (!ModelService.isComplete(r)) return null // 出馬表に抜けがあるレースは使わない
        val out = r.result.order.filter { Regex("取消|除外").containsMatchIn(it.status) }.mapNotNull { it.num }.toSet()
        val run = r.card.runners.filter { !it.scratched && it.num != null && it.num !in out }
        if (run.size < 4 || r.result.payouts["win"].isNullOrEmpty()) return null
        val surface = RaceFeatures.normSurface(r.card.header.surface)
        val f = run.map { RaceFeatures.features(it, surface, r.card.header.distance) }
        val pace = RaceFeatures.pace(f.map { it.style })
        val hand = ModelService.handProbs(f, pace)
        val odds = run.map { it.odds ?: 0.0 }
        val inv = odds.map { if (it > 0) 1 / it else 0.0 }
        val q = inv.map { it / inv.sum() }.toDoubleArray()
        // 採用モデルは市場のオッズを使うので、オッズが 1 頭でも欠けていれば手動モデル
        val p = if (odds.all { it > 0 }) ModelService.probs(params, f.mapIndexed { i, v -> RaceFeatures.vector(v, pace, run[i].waku) }, q) else hand
        val order = p.indices.sortedByDescending { p[it] }
        val num = { i: Int -> run[i].num!! }
        val placeOf = r.result.order.filter { it.num != null }.associate { it.num!! to it.place }
        val fav = odds.indices.filter { odds[it] > 0 }.minByOrNull { odds[it] }
        val win = { i: Int -> payoutOf(r.result.payouts, "win", listOf(num(i))) }
        val plans = planTickets(order).map { (name, tickets) ->
            PlanResult(name, tickets.size * 100, tickets.sumOf { (type, picks) -> payoutOf(r.result.payouts, type, picks.map(num)) })
        }.toMutableList()
        // アプリの買い目: 勝率 × オッズ が 1 を超える単勝 (ケリー基準で賭ける馬)
        val evPicks = run.indices.filter { odds[it] > 1 && p[it] * odds[it] > 1 }
        plans += PlanResult(APP_PLAN, evPicks.size * 100, evPicks.sumOf(win))
        plans += PlanResult(FAVORITE_PLAN, if (fav != null) 100 else 0, fav?.let(win) ?: 0)
        val w = run.indices.firstOrNull { placeOf[num(it)] == 1 }
        val pick = { i: Int -> BacktestPick(num(i), run[i].name, run[i].pop, placeOf[num(i)]) }
        return BacktestRace(
            r.id, r.date, r.venueName, r.raceNo, r.name.ifBlank { r.card.header.name }, r.grade,
            r.result.payouts["win"]?.firstOrNull()?.yen ?: 0,
            pick(order[0]), order.getOrNull(1)?.let(pick), fav?.let(pick), w?.let(pick), plans,
            w?.let { logLoss(p[it]) }, w?.let { logLoss(hand[it]) }, w?.let { if (q[it] > 0) logLoss(q[it]) else null },
        )
    }

    fun compute(races: List<PastRace>, params: ModelParams, computedAt: String = java.time.LocalDate.now().toString()): Backtest? {
        val rows = races.mapNotNull { evaluate(it, params) }.sortedWith(compareBy({ it.date }, { it.id }))
        if (rows.isEmpty()) return null
        val n = rows.size.toDouble()
        val rate = { cond: (BacktestRace) -> Boolean -> rows.count(cond) / n }
        val ll = rows.filter { it.logLossModel != null && it.logLossMarket != null }
        val mean = { sel: (BacktestRace) -> Double? -> ll.mapNotNull(sel).average() }
        val totals = rows.first().plans.indices.map { k ->
            val list = rows.mapNotNull { it.plans.getOrNull(k) }.filter { it.cost > 0 }
            PlanTotal(rows.first().plans[k].name, list.size, list.count { it.back > 0 }, list.sumOf { it.cost }, list.sumOf { it.back })
        }
        val summary = BacktestSummary(
            rows.size, rows.first().date, rows.last().date,
            rate { it.honmei.place == 1 }, rate { (it.honmei.place ?: 99) <= 3 },
            rate { it.favorite?.place == 1 }, rate { (it.favorite?.place ?: 99) <= 3 },
            mean { it.logLossModel }, mean { it.logLossHand }, mean { it.logLossMarket }, totals,
            races.count { !ModelService.isComplete(it) },
        )
        return Backtest(computedAt, params.selected, summary, rows)
    }
}
