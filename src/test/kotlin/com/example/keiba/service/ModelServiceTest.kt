package com.example.keiba.service

import com.example.keiba.model.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ModelServiceTest {
    @Serializable data class Expected(val pace: Double, val styles: List<Int>, val X: List<List<Double>>, val q: List<Double>, val p: List<Double>)
    @Serializable data class FixtureRace(val race: PastRace, val expected: Expected)
    @Serializable data class Fixture(val params: ModelParams, val races: List<FixtureRace>)

    private val fixture: Fixture = Json { ignoreUnknownKeys = true }.decodeFromString(
        javaClass.getResource("/model-fixture.json")!!.readText(),
    )

    private fun close(a: Double, b: Double, eps: Double = 1e-9, msg: String = "") = assertTrue(abs(a - b) <= eps, "$msg: $a と $b が違う")

    // ---------- 画面 (race-model.js) と同じ値になるか ----------
    @Test fun featuresAndProbabilitiesMatchJavaScript() {
        val prepared = ModelService.prepare(fixture.races.map { it.race })
        assertEquals(fixture.races.size, prepared.size)
        prepared.zip(fixture.races).forEach { (r, fx) ->
            val e = fx.expected
            close(r.pace, e.pace, msg = "ペース")
            assertEquals(e.styles, r.features.map { it.style }, "脚質")
            r.x.zip(e.X).forEachIndexed { i, (a, b) -> a.indices.forEach { j -> close(a[j], b[j], msg = "特徴量 [$i][$j]") } }
            r.q.indices.forEach { close(r.q[it], e.q[it], msg = "市場の確率") }
            val p = ModelService.probs(fixture.params, r.x, r.q)
            p.indices.forEach { close(p[it], e.p[it], msg = "勝率") }
        }
    }

    // ---------- 推定が正しいか (答えの分かっている作りもののデータで) ----------
    private fun synthetic(nRaces: Int, beta1: Double, seed: Int): List<TrainRace> {
        val rnd = Random(seed)
        return List(nRaces) { r ->
            val n = 8 + rnd.nextInt(8)
            val x = List(n) { DoubleArray(FEATURE_NAMES.size) { rnd.nextDouble() } }
            val q0 = DoubleArray(n) { exp(rnd.nextDouble() * 3) }.let { a -> a.map { it / a.sum() }.toDoubleArray() }
            // 本当の勝率: 市場 (α = 1) + 1 つ目の特徴量 × beta1
            val u = DoubleArray(n) { i -> ln(q0[i]) + beta1 * (x[i][0] - 0.5) / 0.2887 }
            val p = ModelService.softmax(u)
            var acc = 0.0
            val t = rnd.nextDouble()
            val w = p.indices.first { acc += p[it]; acc >= t }
            TrainRace("s$r", x, q0, w, List(n) { Features(0.5, 0.0, 0.0, 2, 1.0, 1) }, 1.0)
        }
    }

    @Test fun estimationRecoversTrueCoefficient() {
        val m = ModelService.estimate(synthetic(1500, 0.8, 1), useMarket = true, useX = true, lambda = 0.0)
        close(m.alpha, 1.0, 0.12, "α")
        close(m.beta[0], 0.8, 0.12, "β₁")
        (1 until FEATURE_NAMES.size).forEach { close(m.beta[it], 0.0, 0.15, "関係ない特徴量の β") }
    }

    @Test fun selectsFeaturesOnlyWhenTheyReallyHelp() {
        assertEquals("market_features", ModelService.fit(synthetic(300, 1.2, 2)).selected, "特徴量が効くデータ")
        val p = ModelService.fit(synthetic(300, 0.0, 3))
        assertEquals("market", p.selected, "市場が正解のデータ")
        assertEquals(1.0, p.alpha)
        assertTrue(p.beta.all { it == 0.0 })
    }

    @Test fun tooFewRacesFallsBackToMarket() {
        val p = ModelService.fit(synthetic(5, 1.0, 4))
        assertEquals("market", p.selected)
    }

    @Test fun solveLinearSystem() {
        val x = ModelService.solve(arrayOf(doubleArrayOf(2.0, 1.0), doubleArrayOf(1.0, 3.0)), doubleArrayOf(3.0, 5.0))
        close(x[0], 0.8); close(x[1], 1.4)
    }

    // ---------- サンプル出馬表の予想 ----------
    private fun horse(n: Int, odds: Double, si: Double = 110.0, style: RunningStyle = RunningStyle.SENKO) =
        Horse(n, (n + 1) / 2, "馬$n", "牡4", 57.0, "騎手", "調教師", odds, n, 2, si, style, "父", "母父", 480, 0, 0.15, "A")
    private fun race(horses: List<Horse>) = Race("t", "テスト", "", 11, "東京", CourseType.TURF, 2000, "左", TrackCondition.FIRM, "G1", "15:40", 0, horses)

    @Test fun winProbabilitiesArePropbabilities() {
        val a = PredictorEngine().analyzeRace(race(listOf(2.5, 4.0, 6.0, 9.0, 15.0, 30.0, 50.0, 80.0).mapIndexed { i, o -> horse(i + 1, o) }))
        close(a.predictions.sumOf { it.winProbability }, 100.0, 0.5, "勝率の合計")
        close(a.predictions.sumOf { it.placeProbability }, 300.0, 0.5, "3 着以内の確率の合計")
        assertEquals(listOf("◎", "◯", "▲", "△", "△"), a.predictions.take(5).map { it.mark })
    }

    @Test fun expectedValueDependsOnOdds() {
        // 以前はオッズが打ち消されて、どの馬も同じ期待値になっていた
        val p = PredictorEngine.winProbabilities(listOf(2.0, 4.0, 8.0), 0.8)
        val ev = p.zip(listOf(2.0, 4.0, 8.0)) { a, b -> a * b }
        assertTrue(ev.distinct().size == 3, "期待値が馬ごとに違う: $ev")
    }

    @Test fun marketOnlyMeansNoBet() {
        // 本物のオッズは控除率のぶん、逆数の和が 1 を超える (ここでは 1.258 = 控除率 約 20%)
        val a = PredictorEngine().analyzeRace(race(listOf(2.0, 3.0, 5.0, 8.0, 15.0, 30.0).mapIndexed { i, o -> horse(i + 1, o) }))
        assertEquals(listOf("見送り"), a.betRecommendations.map { it.betType }, "市場どおりの見積もりでは期待値は 1 未満")
    }

    @Test fun top3ProbabilitiesSumToThree() {
        close(PredictorEngine.top3Probabilities(doubleArrayOf(0.4, 0.3, 0.15, 0.1, 0.05)).sum(), 3.0, 1e-9)
    }
}
