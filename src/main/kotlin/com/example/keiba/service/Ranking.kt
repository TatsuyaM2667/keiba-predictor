package com.example.keiba.service

import kotlin.math.ln
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sqrt

// ==================================================================================
// Ranking — 勝率から 2 着・3 着の確率を出す「割引 Harville モデル」と、的中確率が最大になる買い目
// ==================================================================================
// これまでの Harville の式:
//   P(1 着 i, 2 着 j, 3 着 k) = pᵢ · pⱼ / (1 − pᵢ) · pₖ / (1 − pᵢ − pⱼ)
// は「1 着が決まったあとも、残りの馬の強さの比は勝率の比のまま」という仮定。実際のレースでは
// 人気馬は 2 着・3 着に「勝率から思うほどは」来ず、人気薄が思ったより来る (2・3 着争いはまぎれが大きい)。
// そこで、2 着・3 着の段では勝率を λ 乗して差を縮める (Lo & Bacon-Shone 1994、Benter 1994):
//   P(i, j, k) = pᵢ · pⱼ^λ₂ / Σ_{m≠i} p_m^λ₂ · pₖ^λ₃ / Σ_{m≠i,j} p_m^λ₃
// λ = 1 なら元の Harville。文献の値は λ₂ ≈ 0.81、λ₃ ≈ 0.65。
// このアプリでは、過去の実際のレースの 2 着・3 着で λ を最尤推定する。データが少ないうちは文献の値に寄せる
// (正規分布の事前分布をつけた MAP 推定。データが増えるほど、データの値に近づく)。
// 2 着の尤度は λ₂ だけ、3 着の尤度は λ₃ だけに依存するので、2 つは別々に 1 次元で推定できる。

object Ranking {
    const val PRIOR_L2 = 0.81
    const val PRIOR_L3 = 0.65
    /** 事前分布の標準偏差。λ が文献の値から ±0.1 くらいの範囲にあると考える */
    const val PRIOR_SD = 0.1

    /** 1 着 a・2 着 b・3 着 c になる確率 */
    fun orderProb(p: DoubleArray, l2: Double, l3: Double, a: Int, b: Int, c: Int): Double {
        if (a == b || b == c || a == c) return 0.0
        val w2 = DoubleArray(p.size) { max(p[it], 1e-12).pow(l2) }
        val w3 = DoubleArray(p.size) { max(p[it], 1e-12).pow(l3) }
        return p[a] * w2[b] / (w2.sum() - w2[a]) * w3[c] / (w3.sum() - w3[a] - w3[b])
    }

    /** 1 レース分の、2 着 (stage = 2) または 3 着 (stage = 3) の負の対数尤度 */
    fun stageLoss(p: DoubleArray, top: IntArray, stage: Int, lambda: Double): Double {
        val w = DoubleArray(p.size) { max(p[it], 1e-12).pow(lambda) }
        val rest = w.sum() - (0 until stage - 1).sumOf { w[top[it]] }
        return -ln(w[top[stage - 1]] / rest)
    }

    /**
     * λ の MAP 推定: Σ レースの負の対数尤度 + (λ − 事前の値)² / (2·事前の標準偏差²) を最小にする λ。
     * 目的関数は λ について凸 (指数型分布族の対数尤度) なので、黄金分割法で十分。
     */
    fun fitLambda(races: List<Pair<DoubleArray, IntArray>>, stage: Int, prior: Double, priorSd: Double = PRIOR_SD): Double {
        val use = races.filter { it.second.size >= stage }
        if (use.isEmpty()) return prior
        fun f(l: Double) = use.sumOf { (p, top) -> stageLoss(p, top, stage, l) } + (l - prior).let { it * it } / (2 * priorSd * priorSd)
        var lo = 0.2
        var hi = 1.6
        val g = (sqrt(5.0) - 1) / 2
        var x1 = hi - g * (hi - lo)
        var x2 = lo + g * (hi - lo)
        var f1 = f(x1)
        var f2 = f(x2)
        repeat(60) {
            if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = f(x1) }
            else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = f(x2) }
        }
        return (lo + hi) / 2
    }

    /** 馬券の種類ごとの、すべての組み合わせの確率 (組み合わせ = 出走表の何番目か。順不同の券種は小さい順) */
    class Tables(val n: Int, val win: Map<List<Int>, Double>, val place: Map<List<Int>, Double>, val umaren: Map<List<Int>, Double>,
                 val wide: Map<List<Int>, Double>, val umatan: Map<List<Int>, Double>, val trio: Map<List<Int>, Double>, val tierce: Map<List<Int>, Double>) {
        fun of(type: String): Map<List<Int>, Double> = when (type) {
            "win" -> win; "place" -> place; "umaren" -> umaren; "wide" -> wide; "umatan" -> umatan; "trio" -> trio; "tierce" -> tierce
            else -> emptyMap()
        }
        /** その券種で、当たる確率が高い順に k 点 (同じ点数で的中率が最大になる買い目) */
        fun top(type: String, k: Int): List<List<Int>> = of(type).entries.sortedByDescending { it.value }.take(k).map { it.key }
    }

    /** 1〜3 着のすべての並び (n ≤ 18 なら 4,896 通り) を数え上げて、各券種の確率を出す。複勝は 7 頭以下なら 2 着まで */
    fun tables(p: DoubleArray, l2: Double, l3: Double): Tables {
        val n = p.size
        val w2 = DoubleArray(n) { max(p[it], 1e-12).pow(l2) }
        val w3 = DoubleArray(n) { max(p[it], 1e-12).pow(l3) }
        val s2 = w2.sum()
        val s3 = w3.sum()
        val win = HashMap<List<Int>, Double>()
        val place = HashMap<List<Int>, Double>()
        val umaren = HashMap<List<Int>, Double>()
        val wide = HashMap<List<Int>, Double>()
        val umatan = HashMap<List<Int>, Double>()
        val trio = HashMap<List<Int>, Double>()
        val tierce = HashMap<List<Int>, Double>()
        fun add(m: HashMap<List<Int>, Double>, k: List<Int>, v: Double) { m[k] = (m[k] ?: 0.0) + v }
        for (a in 0 until n) {
            win[listOf(a)] = p[a]
            for (b in 0 until n) {
                if (b == a) continue
                val pab = p[a] * w2[b] / (s2 - w2[a])
                add(umatan, listOf(a, b), pab)
                add(umaren, listOf(a, b).sorted(), pab)
                if (n <= 7) { add(place, listOf(a), pab); add(place, listOf(b), pab) }
                for (c in 0 until n) {
                    if (c == a || c == b) continue
                    val pabc = pab * w3[c] / (s3 - w3[a] - w3[b])
                    tierce[listOf(a, b, c)] = pabc
                    add(trio, listOf(a, b, c).sorted(), pabc)
                    if (n > 7) { add(place, listOf(a), pabc); add(place, listOf(b), pabc); add(place, listOf(c), pabc) }
                    add(wide, listOf(a, b).sorted(), pabc); add(wide, listOf(a, c).sorted(), pabc); add(wide, listOf(b, c).sorted(), pabc)
                }
            }
        }
        return Tables(n, win, place, umaren, wide, umatan, trio, tierce)
    }

    /**
     * 7 つの代表的な買い方。点数は以前 (◎ を軸にした決め打ち) と同じにして、組み合わせだけを
     * 「モデルで当たる確率が高い順」に選ぶ。同じ点数 (同じ投資額) なら、これが的中率の最大になる。
     * 戻り値: (名前, [(券種, 出走表の何番目か)])
     */
    fun plans(t: Tables): List<Pair<String, List<Pair<String, List<Int>>>>> = buildList {
        add("単勝 ◎" to t.top("win", 1).map { "win" to it })
        add("複勝 (3着内率 1位)" to t.top("place", 1).map { "place" to it })
        if (t.n >= 3) add("ワイド 的中率最大 1点" to t.top("wide", 1).map { "wide" to it })
        if (t.n >= 4) {
            add("馬連 的中率最大 3点" to t.top("umaren", 3).map { "umaren" to it })
            add("馬単 的中率最大 3点" to t.top("umatan", 3).map { "umatan" to it })
            add("3連複 的中率最大 4点" to t.top("trio", 4).map { "trio" to it })
            add("3連単 的中率最大 6点" to t.top("tierce", 6).map { "tierce" to it })
        }
    }

    /** 買い方 1 つの的中率 (どれか 1 点でも当たる確率)。1〜3 着の全部の並びで数える */
    fun hitRate(p: DoubleArray, l2: Double, l3: Double, tickets: List<Pair<String, List<Int>>>): Double {
        val n = p.size
        var s = 0.0
        for (a in 0 until n) for (b in 0 until n) for (c in 0 until n) {
            if (a == b || b == c || a == c) continue
            if (tickets.any { (type, picks) -> hits(type, picks, a, b, c, n) }) s += orderProb(p, l2, l3, a, b, c)
        }
        return s
    }

    /** 1〜3 着が a, b, c のとき、その馬券が当たりか (race-model.js の hits と同じ規則) */
    fun hits(type: String, picks: List<Int>, a: Int, b: Int, c: Int, n: Int): Boolean {
        fun top3(i: Int) = i == a || i == b || i == c
        return when (type) {
            "win" -> picks[0] == a
            "place" -> if (n <= 7) picks[0] == a || picks[0] == b else top3(picks[0])
            "umaren" -> picks.toSet() == setOf(a, b)
            "wide" -> picks[0] != picks[1] && top3(picks[0]) && top3(picks[1])
            "umatan" -> picks[0] == a && picks[1] == b
            "trio" -> picks.toSet() == setOf(a, b, c)
            "tierce" -> picks == listOf(a, b, c)
            else -> false
        }
    }
}
