package com.example.keiba.service

import com.example.keiba.model.*
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt

// ==================================================================================
// PredictorEngine — サンプル出馬表 (有馬記念など 3 レース) の予想
// ==================================================================================
// 2 つの数を、役割を分けて出す。
//   評価 (totalScore, 0〜100)
//     能力・近走・展開・調教・騎手・血統を 0〜100 にそろえた加重平均。「モデルの意見」。
//     サンプルには結果がないので、重みは手で決めた値 (学習できない)。
//   勝率 (winProbability, %)
//     いちばん正確な見積もり。過去の実際のレースで確かめると、今は「市場 (単勝オッズ)」がどのモデルより正確
//     (ModelService の交差検証)。そこで qᵢ = (1/オッズᵢ) / Σ(1/オッズ) を、学習した補正 α で qᵢ^α として使う。
//     確率なので合計は必ず 100%。
// 印は勝率の順。☆ は「評価の順位が、人気の順位より 3 つ以上高い馬」(モデルが市場と意見の違う馬)。
// 買い目は、勝率 × オッズ (期待値) が 1 を超える単勝だけをケリー基準の 1/4 で配分し、なければ「見送り」。
class PredictorEngine(
    private val sireStats: (String) -> SireStat? = { null },
    private val marketAlpha: () -> Double = { 1.0 },
) {
    /** 名鑑から作った、ある種牡馬の産駒の成績 (重賞を勝った産駒の頭数・芝で勝った割合・平均距離) */
    data class SireStat(val offspring: Int, val turfShare: Double, val meanDistance: Double?)

    fun analyzeRace(race: Race): RaceAnalysis {
        val paceForecast = analyzePace(race.horses)
        val paceComment = when (paceForecast) {
            "ハイペース" -> "逃げ・先行が多く、前が苦しくなる展開。差し・追込に向く流れです。"
            "スローペース" -> "逃げ馬が楽に行けそうな流れ。前に行ける馬が有利です。"
            else -> "平均的な流れ。脚質による有利不利は小さく、能力が素直に出やすい展開です。"
        }
        val scores = race.horses.map { scoreOf(it, race, paceForecast) }
        val p = winProbabilities(race.horses.map { it.odds }, marketAlpha())
        val place = top3Probabilities(p)

        // 印は勝率の順。☆ は評価の順位が人気 (勝率) の順位より 3 つ以上高い馬のうち、いちばん差の大きい馬
        val byP = p.indices.sortedByDescending { p[it] }
        val byScore = scores.indices.sortedByDescending { scores[it].total }
        val marks = arrayOfNulls<String>(p.size)
        listOf("◎", "◯", "▲", "△", "△").forEachIndexed { k, m -> byP.getOrNull(k)?.let { marks[it] = m } }
        p.indices.filter { marks[it] == null }
            .map { it to byP.indexOf(it) - byScore.indexOf(it) }
            .filter { it.second >= 3 }
            .maxByOrNull { it.second }
            ?.let { marks[it.first] = "☆" }

        val predictions = race.horses.mapIndexed { i, h ->
            val s = scores[i]
            PredictionScore(
                horseNumber = h.horseNumber,
                horseName = h.name,
                mark = marks[i] ?: "",
                totalScore = r1(s.total),
                speedScore = r1(s.speed),
                paceAdvantage = r1(s.pace),
                pedigreeScore = r1(s.pedigree),
                jockeyScore = r1(s.jockey),
                formScore = r1(s.form),
                winProbability = r1(p[i] * 100),
                placeProbability = r1(place[i] * 100),
                expectedValueScore = r1(p[i] * h.odds * 100), // 100 円買ったときに戻る額の期待値 (円)
                comments = comment(h, s, marks[i]),
            )
        }.sortedByDescending { it.winProbability }

        return RaceAnalysis(race, predictions, recommendations(race, p), paceForecast, paceComment)
    }

    // 逃げ・先行の頭数からペースを予想する (画面の race-model.js の paceOf、ModelService.pace と同じ規則)
    private fun analyzePace(horses: List<Horse>): String {
        val nige = horses.count { it.runningStyle == RunningStyle.NIGE }
        val senko = horses.count { it.runningStyle == RunningStyle.SENKO }
        return when {
            nige >= 2 || (nige == 1 && senko >= 5) -> "ハイペース"
            nige == 0 || (nige == 1 && senko <= 2) -> "スローペース"
            else -> "ミドルペース"
        }
    }

    private class Score(val speed: Double, val form: Double, val pace: Double, val training: Double, val jockey: Double, val pedigree: Double, val pedigreeKnown: Boolean) {
        // 重み (合計 1)。サンプルには結果がないので手で決めた値
        val total = speed * 0.35 + form * 0.15 + pace * 0.15 + training * 0.10 + jockey * 0.15 + pedigree * 0.10
    }

    private fun scoreOf(h: Horse, race: Race, pace: String): Score {
        val speed = ((h.speedIndex - 60.0) / 60.0 * 100.0).coerceIn(0.0, 100.0)
        val form = (100.0 - (h.recentRank - 1) * 12.0).coerceIn(20.0, 100.0) // 前走 1 着 = 100、着順が 1 つ下がるごとに −12
        val paceFit = when (pace) {
            "ハイペース" -> mapOf(RunningStyle.SASHI to 92.0, RunningStyle.OIKOMI to 88.0, RunningStyle.SENKO to 65.0, RunningStyle.NIGE to 48.0)
            "スローペース" -> mapOf(RunningStyle.NIGE to 95.0, RunningStyle.SENKO to 88.0, RunningStyle.SASHI to 62.0, RunningStyle.OIKOMI to 45.0)
            else -> mapOf(RunningStyle.SENKO to 88.0, RunningStyle.SASHI to 86.0, RunningStyle.NIGE to 75.0, RunningStyle.OIKOMI to 70.0)
        }.getValue(h.runningStyle)
        val training = mapOf("S" to 100.0, "A+" to 90.0, "A" to 80.0, "B" to 65.0, "C" to 50.0)[h.trainingScore] ?: 70.0
        val jockey = (h.jockeyWinRate * 400.0).coerceIn(0.0, 100.0) // 勝率 25% で満点
        // 血統: 名鑑で、その父の産駒が重賞を勝った馬場と距離が今回に近いほど高い。産駒が 3 頭未満なら分からない (50)
        val st = sireStats(h.sire)?.takeIf { it.offspring >= 3 }
        val pedigree = if (st == null) 50.0 else {
            val surfaceShare = if (race.courseType == CourseType.TURF) st.turfShare else 1 - st.turfShare
            val distClose = st.meanDistance?.let { max(0.0, 1 - abs(it - race.distanceMeters) / 1000.0) } ?: 0.5
            100.0 * (0.6 * surfaceShare + 0.4 * distClose)
        }
        return Score(speed, form, paceFit, training, jockey, pedigree, st != null)
    }

    private fun comment(h: Horse, s: Score, mark: String?): String {
        val parts = mutableListOf<String>()
        if (s.training >= 90) parts += "調教の評価が高い"
        if (s.pace >= 85) parts += "想定ペースが脚質に向く"
        if (s.pedigreeKnown && s.pedigree >= 75) parts += "父の産駒は今回の馬場・距離で重賞を勝っている"
        if (h.recentRank == 1) parts += "前走 1 着" else if (h.recentRank <= 3) parts += "前走 ${h.recentRank} 着と好調"
        if (mark == "☆") parts += "評価は人気より高く、市場と意見が分かれる馬"
        return if (parts.isEmpty()) "目立つ材料は少ない。" else parts.joinToString("、") + "。"
    }

    private fun recommendations(race: Race, p: DoubleArray): List<BetRecommendation> {
        // ケリー基準: 賭ける割合 f = (p·O − 1) / (O − 1)。安全のため 1/4 だけ使う。p·O ≤ 1 なら賭けない
        val picks = race.horses.mapIndexedNotNull { i, h ->
            val ev = p[i] * h.odds
            if (ev > 1 && h.odds > 1) Triple(h, ev, 0.25 * (ev - 1) / (h.odds - 1)) else null
        }.sortedByDescending { it.third }.take(3)
        if (picks.isEmpty()) {
            return listOf(BetRecommendation("見送り", "-", 0.0, "-", 0,
                "勝率 × オッズ (期待値) が 1 を超える馬がいません。控除率があるので、市場どおりの見積もりでは長く続けるほど損をします。"))
        }
        val total = picks.sumOf { it.third }
        return picks.map { (h, ev, k) ->
            BetRecommendation("単勝", "${h.horseNumber} (${h.name})", h.odds, if (ev >= 1.2) "A" else "B", (k / total * 100).roundToInt(),
                "期待値 ${"%.2f".format(ev)}。資金の ${"%.1f".format(k * 100)}% (ケリー基準の 1/4)。")
        }
    }

    private fun r1(v: Double) = (v * 10).roundToInt() / 10.0

    companion object {
        /** 単勝オッズ → 勝率。市場の確率 q = (1/O) / Σ(1/O) を α 乗して合計 1 にそろえる (α = 1 なら市場そのまま) */
        fun winProbabilities(odds: List<Double>, alpha: Double): DoubleArray {
            val inv = odds.map { if (it > 0) 1 / it else 0.0 }
            val s = inv.sum()
            val w = inv.map { (it / s).pow(alpha) }
            val t = w.sum()
            return w.map { it / t }.toDoubleArray()
        }

        /** 各馬が 3 着以内に入る確率 (Harville の式。勝率が softmax のモデルではこの式が正しい) */
        fun top3Probabilities(p: DoubleArray): DoubleArray {
            val n = p.size
            val out = DoubleArray(n)
            for (a in 0 until n) for (b in 0 until n) {
                if (a == b) continue
                val pab = p[a] * p[b] / (1 - p[a])
                for (c in 0 until n) {
                    if (c == a || c == b) continue
                    val pabc = pab * p[c] / (1 - p[a] - p[b])
                    out[a] += pabc; out[b] += pabc; out[c] += pabc
                }
            }
            return out
        }
    }
}
