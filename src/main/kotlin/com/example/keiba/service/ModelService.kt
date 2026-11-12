package com.example.keiba.service

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

// ==================================================================================
// ModelService — 過去の実際のレースで予想モデルを「学習」し、「本当に当たるか」を測って選ぶ
// ==================================================================================
// 流れ:
//   1. 過去のレース (JRA の結果 + レース前の出馬表) を読む。Worker が自動で集め、/api/live/results で配っている
//   2. 各馬の特徴量 x を作る (画面の race-model.js の features / featureVector と同じ計算。テストで一致を確かめる)
//   3. 条件付きロジット (softmax) を最尤推定する:  pᵢ = exp(uᵢ) / Σⱼ exp(uⱼ)
//        uᵢ = α · log qᵢ + Σₖ βₖ · zᵢₖ      (q = 単勝オッズから作った市場の確率、z = 標準化した特徴量)
//   4. 「1 レースずつ外して学習し、外したレースで当てる」交差検証で、対数損失 (小さいほど正確) を比べる
//   5. 市場 (オッズそのまま) より、統計的にはっきり (2 標準誤差より) 良いモデルだけを採用する。
//      どれも良くなければ「市場」を採用する。データが増えるたびに学習し直すので、根拠ができた時点で自動で切り替わる
// 確率は softmax なので、合計は必ず 1 (100%)。

@Serializable data class PastRun(val place: Int? = null, val field: Int? = null, val grade: String = "", val diff: Double? = null, val distance: Int? = null, val surface: String = "", val corners: List<Int> = emptyList())
@Serializable data class CardRunner(val waku: Int? = null, val num: Int? = null, val name: String = "", val odds: Double? = null, val pop: Int? = null, val scratched: Boolean = false, val past: List<PastRun> = emptyList())
@Serializable data class CardHeader(val name: String = "", val grade: String = "", val distance: Int? = null, val surface: String = "")
@Serializable data class Card(val header: CardHeader = CardHeader(), val runners: List<CardRunner> = emptyList())
@Serializable data class Finisher(val place: Int? = null, val status: String = "", val num: Int? = null, val name: String = "", val pop: Int? = null)
/** 払戻金 1 件 (combo = 組番 "6-15"、yen = 100 円あたり) */
@Serializable data class Payout(val combo: String, val yen: Int)
@Serializable data class RaceResult(val order: List<Finisher> = emptyList(), val payouts: Map<String, List<Payout>> = emptyMap())
@Serializable data class PastRace(
    val id: String, val date: String = "", val venueName: String = "", @SerialName("race_no") val raceNo: Int = 0,
    val name: String = "", val grade: String = "", val card: Card, val result: RaceResult,
)

/** 1 頭分の特徴量 (race-model.js の features と同じ) */
data class Features(val form: Double, val distFit: Double, val surfFit: Double, val style: Int, val mu: Double, val runs: Int)

@Serializable
data class ModelScore(val name: String, val label: String, val logLoss: Double, val vsMarket: Double? = null, val vsMarketSe: Double? = null, val note: String = "")

/** 採用したモデル。画面 (race-model.js の fittedProbs) とローカル版の両方が、これで勝率を出す */
@Serializable
data class ModelParams(
    val version: Int = 1,
    val fittedAt: String = "",
    val races: Int = 0,
    val runners: Int = 0,
    val selected: String = "market",
    val alpha: Double = 1.0,
    val features: List<String> = FEATURE_NAMES,
    val mean: List<Double> = List(FEATURE_NAMES.size) { 0.0 },
    val sd: List<Double> = List(FEATURE_NAMES.size) { 1.0 },
    val beta: List<Double> = List(FEATURE_NAMES.size) { 0.0 },
    val report: List<ModelScore> = emptyList(),
    val note: String = "",
    val excludedRaces: Int = 0, // 出馬表に抜けがあり、使わなかったレースの数
)

val FEATURE_NAMES = listOf("form", "distFit", "unfamiliarSurface", "noRuns", "paceStyle", "waku")

object RaceFeatures {
    private val W = doubleArrayOf(0.4, 0.3, 0.2, 0.1)
    private val CLASS_BONUS = mapOf("GI" to 0.12, "GII" to 0.08, "GIII" to 0.05, "L" to 0.03, "J・GI" to 0.05, "J・GII" to 0.04, "J・GIII" to 0.03)

    /** 馬場の表記をそろえる (出馬表の見出しには「芝 内外」なども来る) */
    fun normSurface(s: String) = when {
        "ダート" in s -> "ダート"
        "障害" in s -> "障害"
        else -> "芝"
    }

    fun features(runner: CardRunner, surface: String, distance: Int?): Features {
        val runs = runner.past.filter { (it.place ?: 0) > 0 && (it.field ?: 0) > 1 }.take(4)
        var s = 0.0
        var sw = 0.0
        runs.forEachIndexed { k, p ->
            val rel = 1 - (p.place!! - 1).toDouble() / (p.field!! - 1)
            val behind = max(0.0, p.diff ?: 0.0) // 勝ったレースは 2 着との差 (負) が入るので 0 とみなす
            s += W[k] * (rel + (CLASS_BONUS[p.grade] ?: 0.0) - 0.04 * min(behind, 3.0))
            sw += W[k]
        }
        val form = if (sw > 0) s / sw else 0.4
        val same = runs.filter { it.surface == surface && (it.distance ?: 0) != 0 }
        var distFit = 0.0
        var surfFit = 0.0
        if (same.isNotEmpty() && (distance ?: 0) != 0) {
            val avg = same.sumOf { it.distance!!.toDouble() } / same.size
            distFit = -min(0.05, 0.02 * abs(distance!! - avg) / 400)
        } else if (runs.isNotEmpty()) surfFit = -0.03
        val corners = runs.filter { it.corners.isNotEmpty() }.map { it.corners[0].toDouble() / it.field!! }
        val ratio = if (corners.isEmpty()) null else corners.average()
        val style = when {
            ratio == null -> 2
            ratio < 0.15 -> 0
            ratio < 0.4 -> 1
            ratio < 0.7 -> 2
            else -> 3
        }
        return Features(form, distFit, surfFit, style, 1 + 0.25 * (form - 0.5) + distFit + surfFit, runs.size)
    }

    /** 逃げ・先行の頭数から想定ペース (1.2 ハイ / 1.0 ミドル / 0.8 スロー) */
    fun pace(styles: List<Int>): Double {
        val nige = styles.count { it == 0 }
        val senko = styles.count { it == 1 }
        return when {
            nige >= 2 || (nige == 1 && senko >= 5) -> 1.2
            nige == 0 || (nige == 1 && senko <= 2) -> 0.8
            else -> 1.0
        }
    }

    /** モデルに入れる特徴量の並び (FEATURE_NAMES の順) */
    fun vector(f: Features, pace: Double, waku: Int?) = doubleArrayOf(
        f.form, f.distFit, if (f.surfFit < 0) 1.0 else 0.0, if (f.runs == 0) 1.0 else 0.0, (pace - 1) * (f.style - 1.5), waku?.toDouble() ?: 4.5,
    )
}

/** 学習・評価に使う 1 レース分: 出走馬の特徴量 X、市場の確率 q、勝ち馬の位置 winner */
class TrainRace(val id: String, val x: List<DoubleArray>, val q: DoubleArray, val winner: Int, val features: List<Features>, val pace: Double)

class ModelService(private val resultsUrl: String? = null) {
    private val json = Json { ignoreUnknownKeys = true }

    @Volatile var params: ModelParams = bundled()
        private set

    /** 予想の成績 (学習し直すたびに、同じ過去のレースで計算し直す)。まだ学習していなければ null */
    @Volatile var backtest: Backtest? = null
        private set

    /** アプリに同梱した、最後に学習した結果 (ネットにつながらなくても使える) */
    private fun bundled(): ModelParams =
        javaClass.getResourceAsStream("/data/model-params.json")?.bufferedReader()?.use { json.decodeFromString(ModelParams.serializer(), it.readText()) } ?: ModelParams(note = "まだ学習していません (市場の確率を使います)")

    fun loadPastRaces(text: String): List<PastRace> = json.decodeFromString(text)

    /** 過去のレースを取ってきて学習し直す。取れなければ今の params のまま (例外は呼び出し側へ) */
    fun refit(): ModelParams {
        val url = resultsUrl ?: error("学習データの URL がありません")
        val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
        val res = client.send(HttpRequest.newBuilder(URI(url)).timeout(Duration.ofSeconds(30)).GET().build(), HttpResponse.BodyHandlers.ofString())
        check(res.statusCode() == 200) { "学習データを取得できませんでした (HTTP ${res.statusCode()})" }
        val races = loadPastRaces(res.body())
        val excluded = races.count { !isComplete(it) }
        params = fit(prepare(races)).copy(excludedRaces = excluded)
        backtest = BacktestService.compute(races, params)
        return params
    }

    companion object {
        /**
         * 出馬表に、結果に載っている馬 (取消・除外を除く) が全部そろっているか。
         * 出馬表の読み取りで抜けた馬がいると、市場の確率 (オッズの逆数の和で割る) も勝ち馬の確率もずれるので、
         * そのレースは学習にも答え合わせにも使わない。
         */
        fun isComplete(r: PastRace): Boolean {
            val onCard = r.card.runners.mapNotNull { it.num }.toSet()
            return r.result.order.filter { it.num != null && !Regex("取消|除外").containsMatchIn(it.status) }.all { it.num in onCard }
        }

        /** 過去のレース → 学習用。取消・除外と、オッズのない馬は外す。4 頭未満・勝ち馬不明のレースは使わない */
        fun prepare(races: List<PastRace>): List<TrainRace> = races.filter(::isComplete).mapNotNull { r ->
            val out = r.result.order.filter { Regex("取消|除外").containsMatchIn(it.status) }.mapNotNull { it.num }.toSet()
            val run = r.card.runners.filter { !it.scratched && it.num != null && it.num !in out && (it.odds ?: 0.0) > 0 }
            val winNum = r.result.order.firstOrNull { it.place == 1 }?.num
            val w = run.indexOfFirst { it.num == winNum }
            if (run.size < 4 || w < 0) return@mapNotNull null
            val surface = RaceFeatures.normSurface(r.card.header.surface)
            val f = run.map { RaceFeatures.features(it, surface, r.card.header.distance) }
            val pace = RaceFeatures.pace(f.map { it.style })
            val inv = run.map { 1 / it.odds!! }
            val sum = inv.sum()
            TrainRace(r.id, f.mapIndexed { i, v -> RaceFeatures.vector(v, pace, run[i].waku) }, inv.map { it / sum }.toDoubleArray(), w, f, pace)
        }

        fun softmax(u: DoubleArray): DoubleArray {
            val m = u.max()
            val e = u.map { exp(it - m) }
            val s = e.sum()
            return e.map { it / s }.toDoubleArray()
        }

        /** 学習したモデルの勝率 (race-model.js の fittedProbs と同じ式) */
        fun probs(p: ModelParams, x: List<DoubleArray>, q: DoubleArray): DoubleArray = softmax(DoubleArray(x.size) { i ->
            p.alpha * ln(q[i]) + x[i].indices.sumOf { j -> p.beta[j] * (x[i][j] - p.mean[j]) / p.sd[j] }
        })

        private fun logLoss(p: DoubleArray, w: Int) = -ln(max(p[w], 1e-6))

        /**
         * 条件付きロジットを最尤推定する (ニュートン法)。useMarket なら α も推定、useX なら β も推定。
         * β には L2 正則化 (λ/2)·|β|² を掛ける (少ないデータで係数が大きくなりすぎる「過学習」を防ぐ)。α には掛けない
         */
        fun estimate(train: List<TrainRace>, useMarket: Boolean, useX: Boolean, lambda: Double = 5.0): ModelParams {
            val k = FEATURE_NAMES.size
            val all = train.flatMap { it.x }
            val mean = if (useX) List(k) { j -> all.map { it[j] }.average() } else List(k) { 0.0 }
            val sd = if (useX) List(k) { j -> sqrt(all.map { (it[j] - mean[j]).let { d -> d * d } }.average()).takeIf { it > 1e-12 } ?: 1.0 } else List(k) { 1.0 }
            // 説明変数: [log q, z₁ … z_k] のうち使うものだけ
            val cols = buildList { if (useMarket) add(-1); if (useX) addAll(0 until k) }
            val dim = cols.size
            val theta = DoubleArray(dim) { if (useMarket && it == 0) 1.0 else 0.0 }
            fun row(r: TrainRace, i: Int) = DoubleArray(dim) { c -> if (cols[c] < 0) ln(r.q[i]) else (r.x[i][cols[c]] - mean[cols[c]]) / sd[cols[c]] }
            val penal = BooleanArray(dim) { cols[it] >= 0 }
            for (iter in 0 until 50) {
                val g = DoubleArray(dim)
                val h = Array(dim) { DoubleArray(dim) }
                for (r in train) {
                    val z = r.x.indices.map { row(r, it) }
                    val p = softmax(DoubleArray(z.size) { i -> z[i].indices.sumOf { c -> theta[c] * z[i][c] } })
                    val ez = DoubleArray(dim) { c -> z.indices.sumOf { i -> p[i] * z[i][c] } }
                    for (c in 0 until dim) g[c] += z[r.winner][c] - ez[c]
                    for (a in 0 until dim) for (b in 0 until dim) h[a][b] -= z.indices.sumOf { i -> p[i] * (z[i][a] - ez[a]) * (z[i][b] - ez[b]) }
                }
                for (c in 0 until dim) if (penal[c]) { g[c] -= lambda * theta[c]; h[c][c] -= lambda }
                val step = solve(h, g) // θ ← θ − H⁻¹ g
                for (c in 0 until dim) theta[c] -= step[c]
                if (step.maxOf { abs(it) } < 1e-10) break // 収束した
            }
            val beta = List(k) { j -> cols.indexOf(j).let { c -> if (c >= 0) theta[c] else 0.0 } }
            return ModelParams(alpha = if (useMarket) theta[0] else 0.0, mean = mean, sd = sd, beta = beta)
        }

        /** 連立一次方程式 A·x = b (ガウスの消去法・部分ピボット)。次元は 7 以下なので十分 */
        fun solve(a0: Array<DoubleArray>, b0: DoubleArray): DoubleArray {
            val n = b0.size
            val a = Array(n) { a0[it].copyOf() }
            val b = b0.copyOf()
            for (c in 0 until n) {
                val piv = (c until n).maxBy { abs(a[it][c]) }
                a[c] = a[piv].also { a[piv] = a[c] }
                b[c] = b[piv].also { b[piv] = b[c] }
                for (r in c + 1 until n) {
                    val f = a[r][c] / a[c][c]
                    for (j in c until n) a[r][j] -= f * a[c][j]
                    b[r] -= f * b[c]
                }
            }
            val x = DoubleArray(n)
            for (r in n - 1 downTo 0) x[r] = (b[r] - (r + 1 until n).sumOf { a[r][it] * x[it] }) / a[r][r]
            return x
        }

        fun handProbs(r: TrainRace, runs: Int = 20000, seed: UInt = 20261109u) = handProbs(r.features, r.pace, runs, seed)

        /** 今のアプリの手動モデル (Zig の montecarlo.zig と同じ計算) の勝率。比較と、オッズがないときに使う */
        fun handProbs(features: List<Features>, pace: Double, runs: Int = 20000, seed: UInt = 20261109u): DoubleArray {
            var rng = seed
            fun next(): Double {
                rng = rng xor (rng shl 13); rng = rng xor (rng shr 17); rng = rng xor (rng shl 5)
                return (rng shr 8).toDouble() / 16777216.0
            }
            fun styleMul(s: Int) = when (s) {
                0 -> 1.04 - (pace - 1.0) * 0.30
                1 -> 1.02 - (pace - 1.0) * 0.12
                2 -> 1.00 + (pace - 1.0) * 0.15
                else -> 0.98 + (pace - 1.0) * 0.30
            }
            val n = min(18, features.size)
            val base = DoubleArray(n) { i -> (Math.round(features[i].mu * 1000) / 10.0 / 100.0) * styleMul(features[i].style) * (0.85 + 0.15 * 0.7) }
            val wins = IntArray(features.size)
            repeat(runs) {
                var best = 0
                var bestScore = -1e9
                for (i in 0 until n) {
                    val s = base[i] + (next() + next() + next() + next() - 2.0) * 0.11
                    if (s > bestScore) { best = i; bestScore = s }
                }
                wins[best]++
            }
            return DoubleArray(wins.size) { max(1e-4, wins[it].toDouble() / runs) }
        }

        /**
         * 学習と評価。交差検証 (1 レースずつ外す) で各モデルの対数損失を出し、市場より 2 標準誤差以上
         * 良いモデルがあれば、いちばん良いものを採用する。なければ市場 (α = 1, β = 0 → 勝率 = 市場の確率)。
         */
        fun fit(races: List<TrainRace>, fittedAt: String = java.time.LocalDate.now().toString()): ModelParams {
            if (races.size < 10) return ModelParams(fittedAt = fittedAt, races = races.size, note = "学習に使えるレースが少なすぎます (10 未満)。市場の確率を使います")
            val market = races.map { logLoss(it.q, it.winner) }
            fun cv(useMarket: Boolean, useX: Boolean) = races.indices.map { i ->
                val m = estimate(races.filterIndexed { j, _ -> j != i }, useMarket, useX)
                logLoss(probs(m, races[i].x, races[i].q), races[i].winner)
            }
            val per = linkedMapOf(
                "uniform" to races.map { ln(it.q.size.toDouble()) },
                "market" to market,
                "hand" to races.map { logLoss(handProbs(it), it.winner) },
                "features" to cv(false, true),
                "market_power" to cv(true, false),
                "market_features" to cv(true, true),
            )
            val labels = mapOf(
                "uniform" to "全頭同じ確率", "market" to "市場 (単勝オッズそのまま)", "hand" to "今の手動モデル (Zig と同じ・係数は手で決めた)",
                "features" to "特徴量だけで学習 (交差検証)", "market_power" to "市場の確率を補正 (q^α・交差検証)", "market_features" to "市場 + 特徴量 (交差検証)",
            )
            val report = per.map { (name, ll) ->
                val d = ll.zip(market) { a, b -> a - b }
                val se = sqrt(d.map { (it - d.average()).let { x -> x * x } }.sum() / (d.size - 1) / d.size)
                ModelScore(name, labels.getValue(name), ll.average(), if (name == "market") null else d.average(), if (name == "market") null else se)
            }
            // 採用できるのは、レースの前にオッズがあれば使えるもの (市場・市場の補正・市場 + 特徴量)
            val best = report.filter { it.name in setOf("market_power", "market_features") && it.vsMarket!! < -2 * it.vsMarketSe!! }.minByOrNull { it.logLoss }
            val selected = best?.name ?: "market"
            val p = when (selected) {
                "market_power" -> estimate(races, true, false)
                "market_features" -> estimate(races, true, true)
                else -> ModelParams()
            }
            return p.copy(
                fittedAt = fittedAt, races = races.size, runners = races.sumOf { it.q.size }, selected = selected, report = report,
                note = if (best == null) "市場 (単勝オッズ) より、はっきり良いモデルはまだありません。勝率は市場の確率を使います" else "${best.label} が市場より良かったので採用しました",
            )
        }
    }
}
