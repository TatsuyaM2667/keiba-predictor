package com.example.keiba.service

import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.pow
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RankingTest {
    private fun close(a: Double, b: Double, eps: Double = 1e-9, msg: String = "") = assertTrue(abs(a - b) <= eps, "$msg: $a と $b が違う")
    private val p = doubleArrayOf(0.35, 0.2, 0.15, 0.1, 0.08, 0.06, 0.04, 0.02)

    @Test fun lambdaOneIsHarville() {
        val h = p[0] * p[1] / (1 - p[0]) * p[2] / (1 - p[0] - p[1])
        close(Ranking.orderProb(p, 1.0, 1.0, 0, 1, 2), h, msg = "λ = 1 は元の Harville")
        close(PredictorEngine.top3Probabilities(p, 1.0, 1.0).sum(), 3.0, msg = "3 着以内の合計")
    }

    @Test fun tablesAreProbabilities() {
        val t = Ranking.tables(p, 0.81, 0.65)
        close(t.tierce.values.sum(), 1.0, 1e-9, "3連単の合計")
        close(t.trio.values.sum(), 1.0, 1e-9, "3連複の合計")
        close(t.umatan.values.sum(), 1.0, 1e-9, "馬単の合計")
        close(t.umaren.values.sum(), 1.0, 1e-9, "馬連の合計")
        close(t.wide.values.sum(), 3.0, 1e-9, "ワイド (当たりは 3 組)")
        close(t.place.values.sum(), 3.0, 1e-9, "複勝 (当たりは 3 頭)")
        close(t.win.values.sum(), 1.0, 1e-9, "単勝")
        // 割引すると、人気馬が 3 着以内に入る確率は元の Harville より下がり、人気薄は上がる
        val h = PredictorEngine.top3Probabilities(p, 1.0, 1.0)
        val d = PredictorEngine.top3Probabilities(p, 0.81, 0.65)
        assertTrue(d[0] < h[0] && d.last() > h.last(), "割引の向き: ${h.toList()} → ${d.toList()}")
    }

    @Test fun fewRunnersPlaceIsTop2() {
        val t = Ranking.tables(doubleArrayOf(0.4, 0.3, 0.2, 0.1), 0.81, 0.65)
        close(t.place.values.sum(), 2.0, 1e-9, "7 頭以下の複勝は 2 着まで")
    }

    /** λ₂ = 0.7、λ₃ = 0.55 で作ったレースから、λ を推定し直せるか */
    @Test fun fitRecoversLambda() {
        val rnd = Random(7)
        val races = List(3000) {
            val n = 8 + rnd.nextInt(9)
            val w = DoubleArray(n) { kotlin.math.exp(rnd.nextDouble() * 3.5) }
            val q = DoubleArray(n) { w[it] / w.sum() }
            fun draw(weights: DoubleArray, used: Set<Int>): Int {
                val tot = weights.indices.filter { it !in used }.sumOf { weights[it] }
                var acc = 0.0
                val t = rnd.nextDouble() * tot
                return weights.indices.filter { it !in used }.first { acc += weights[it]; acc >= t }
            }
            val a = draw(q, emptySet())
            val b = draw(DoubleArray(n) { q[it].pow(0.7) }, setOf(a))
            val c = draw(DoubleArray(n) { q[it].pow(0.55) }, setOf(a, b))
            q to intArrayOf(a, b, c)
        }
        close(Ranking.fitLambda(races, 2, 0.81, priorSd = 10.0), 0.7, 0.05, "λ₂")
        close(Ranking.fitLambda(races, 3, 0.65, priorSd = 10.0), 0.55, 0.05, "λ₃")
        // データが 0 なら事前の値
        close(Ranking.fitLambda(emptyList(), 2, 0.81), 0.81, msg = "データなし")
    }

    /** 新しい買い目 (確率の高い順) の的中率は、同じ点数の以前の買い目 (◎ 軸・ボックス) 以上 */
    @Test fun optimizedPlansHitAtLeastAsOften() {
        val (l2, l3) = 0.81 to 0.65
        val t = Ranking.tables(p, l2, l3)
        val old = mapOf(
            "umaren" to listOf(listOf(0, 1), listOf(0, 2), listOf(0, 3)),
            "trio" to listOf(listOf(0, 1, 2), listOf(0, 1, 3), listOf(0, 2, 3), listOf(1, 2, 3)),
            "tierce" to listOf(listOf(0, 1, 2), listOf(0, 1, 3), listOf(0, 2, 1), listOf(0, 2, 3), listOf(0, 3, 1), listOf(0, 3, 2)),
        )
        for ((type, tickets) in old) {
            val before = Ranking.hitRate(p, l2, l3, tickets.map { type to it })
            val after = Ranking.hitRate(p, l2, l3, t.top(type, tickets.size).map { type to it })
            assertTrue(after >= before - 1e-12, "$type: $before → $after")
        }
        assertEquals(7, Ranking.plans(t).size)
    }

    @Test fun stageLossMatchesOrderProb() {
        val top = intArrayOf(2, 0, 5)
        val total = -ln(p[2]) + Ranking.stageLoss(p, top, 2, 0.8) + Ranking.stageLoss(p, top, 3, 0.6)
        close(total, -ln(Ranking.orderProb(p, 0.8, 0.6, 2, 0, 5)), 1e-9, "尤度の分解")
    }
}
