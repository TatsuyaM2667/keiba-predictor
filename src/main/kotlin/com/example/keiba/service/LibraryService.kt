package com.example.keiba.service

import com.example.keiba.data.CourseCatalog
import com.example.keiba.data.WikiClient
import com.example.keiba.model.*
import kotlinx.coroutines.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory
import java.io.File
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import kotlin.math.log10
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

// ==================================================================================
// LibraryService.kt — 名鑑・競走一覧・競馬場の「データの置き場」
// ==================================================================================
// データの流れ:
//   1. 起動時: ~/.cache/keiba-vision/library.json.gz (前回の更新結果) があればそれを、
//      なければ jar に同梱の /data/library.json.gz を読む → 起動直後から検索できる
//   2. データが 7 日より古ければ、裏 (別スレッド) で Wikipedia から取り直す (refreshIfStale)
//   3. 取り直しが終わったらキャッシュに保存し、メモリ上のデータを丸ごと差し替える (install)
// メモリ上の検索は単純な線形探索。6,000 頭程度なら 1 回数ミリ秒なので索引は作っていない。
/** 名鑑で返す 1 頭分 (元データ + 戦績から計算した参考値) */
@Serializable
data class HorseView(
    val horse: HorseEntry,
    // rating の実際の範囲は 45〜99 (withPercentileRating を参照)
    val rating: Int,          // 戦績から算出した参考能力値 (40〜99)
    val surface: String,      // 芝 / ダート / 芝・ダート / 不明 (勝った重賞の馬場から推定)
    val bestDistance: Int?,   // 勝った重賞の平均距離
    val gradedWins: Int
)

@Serializable
data class HorsePage(val total: Int, val items: List<HorseView>)

@Serializable
data class JockeyPage(val total: Int, val items: List<JockeyEntry>)

@Serializable
data class JockeyDetail(val jockey: JockeyEntry, val summary: String?)

@Serializable
data class RacePage(val total: Int, val items: List<RaceEntry>)

@Serializable
data class LibraryStatus(
    val generatedAt: String,
    val horses: Int,
    val horsesWithPhoto: Int,
    val races: Int,
    val jockeys: Int,
    val courses: Int,
    val syncing: Boolean,
    val progress: String
)

// WikiClient を引数で受け取れるのは、テストで偽物に差し替えられるようにするため。
class LibraryService(private val wiki: WikiClient = WikiClient()) {
    private val log = LoggerFactory.getLogger(LibraryService::class.java)
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = false }
    private val cacheFile = File(System.getProperty("user.home"), ".cache/keiba-vision/library.json.gz")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // @Volatile: 裏のスレッドが install() で書き換えた値を、リクエスト処理のスレッドがすぐ読めるようにする。
    // snapshot / views / byTitle は「丸ごと新しいものに差し替える」だけで、中身を書き換えることはない。
    // そのためロックなしでも、読む側が中途半端な状態を見ることはない。
    // summaries (要約) と credits (写真の作者) は、表示されたものから順に溜めていくキャッシュ。
    // 複数のリクエストから同時に書かれるので ConcurrentHashMap を使う。
    @Volatile private var snapshot: LibrarySnapshot = load()
    @Volatile private var views: List<HorseView> = buildViews(snapshot)
    @Volatile private var byTitle: Map<String, HorseView> = views.associateBy { it.horse.title }
    @Volatile var syncing = false; private set
    @Volatile var progress = ""; private set
    private val summaries = ConcurrentHashMap<String, String>()
    private val credits = ConcurrentHashMap<String, MediaCredit>()

    // 読み込み元の候補を優先順に並べ、最初に読めたものを使う (キャッシュ → 同梱データ)。
    // キャッシュが壊れていても、警告を出して同梱データに切り替えるだけで起動は続ける。
    // どちらもなければ空のデータで起動する (画面は「0 頭」と表示される)。
    private fun load(): LibrarySnapshot {
        val sources = listOfNotNull(
            cacheFile.takeIf { it.isFile }?.let { { it.inputStream() } },
            javaClass.getResource("/data/library.json.gz")?.let { url -> { url.openStream() } }
        )
        for (open in sources) {
            runCatching { GZIPInputStream(open()).bufferedReader().use { json.decodeFromString<LibrarySnapshot>(it.readText()) } }
                .onSuccess { return it }
                .onFailure { log.warn("ライブラリの読み込みに失敗: ${it.message}") }
        }
        return LibrarySnapshot(generatedAt = "", horses = emptyList(), races = emptyList())
    }

    /** 1 週間より古ければバックグラウンドで最新化 */
    fun refreshIfStale() {
        val age = runCatching { Duration.between(Instant.parse(snapshot.generatedAt), Instant.now()) }.getOrNull()
        if (age == null || age > Duration.ofDays(7)) refresh()
    }

    // Wikipedia からの取り直しを、裏のコルーチンで始める。すでに実行中なら何もせず null を返す。
    // writeTo を変えられるのは `--sync` で同梱データ (src/main/resources/data) を作り直すため。
    // 失敗しても手元のデータはそのまま使い続け、理由は progress に入れて設定画面に表示する。
    fun refresh(writeTo: File = cacheFile): Job? {
        if (syncing) return null
        syncing = true
        return scope.launch {
            try {
                val next = sync()
                writeTo.parentFile?.mkdirs()
                GZIPOutputStream(writeTo.outputStream()).bufferedWriter().use { it.write(json.encodeToString(LibrarySnapshot.serializer(), next)) }
                install(next)
                log.info("ライブラリ更新: 競走馬 ${next.horses.size} / 競走 ${next.races.size} / 騎手 ${next.jockeys.size}")
            } catch (e: Exception) {
                log.warn("ライブラリ更新に失敗 (手元のデータを使い続けます): ${e.message}")
                progress = "更新に失敗しました: ${e.message}"
            } finally {
                syncing = false
            }
        }
    }

    // 競馬場 (25 件) → 競走 (約 1,400 記事) → 競走馬 (約 5,900 記事) の順に取る。数分かかる。
    // 並び順を記事名で固定しているのは、保存したファイルの差分を見やすくするため。
    private suspend fun sync(): LibrarySnapshot {
        progress = "競馬場の情報を取得中"
        val media = wiki.fetchCourseMedia(CourseCatalog.all.map { it.qid })
        val races = wiki.fetchRaces { progress = it }
        val horses = wiki.fetchHorses { progress = it }
        val jockeys = wiki.fetchJockeys { progress = it }
        progress = "完了"
        return LibrarySnapshot(Instant.now().toString(), horses.sortedBy { it.title }, races.sortedBy { it.title }, media, jockeys.sortedBy { it.title })
    }

    private fun install(s: LibrarySnapshot) {
        snapshot = s
        views = buildViews(s)
        byTitle = views.associateBy { it.horse.title }
    }

    // 各馬に「推定の得意な馬場と距離」を付ける。
    // その馬が勝った重賞 (bigWins) を競走一覧と名前で突き合わせ、
    // 勝った競走に芝が多ければ芝、ダートが多ければダート、距離は平均、という単純な推定。
    // 競走名は記事名 ("有馬記念") と表示名 ("有馬記念（グランプリ）") の両方で引けるようにしている。
    // 勝ち鞍のない馬や、記事のない競走しか勝っていない馬は「不明」になる。
    private fun buildViews(s: LibrarySnapshot): List<HorseView> {
        val raceByName = HashMap<String, RaceEntry>()
        s.races.forEach { r -> raceByName.putIfAbsent(r.name, r); raceByName.putIfAbsent(r.title, r) }
        return s.horses.map { h ->
            val won = h.bigWins.mapNotNull { raceByName[it.race] ?: raceByName[it.race.substringBefore(" (")] }
            val turf = won.count { it.surface.contains("芝") }
            val dirt = won.count { it.surface.contains("ダート") }
            val surface = when {
                turf > 0 && dirt > 0 -> "芝・ダート"
                turf > 0 -> "芝"
                dirt > 0 -> "ダート"
                else -> "不明"
            }
            val dists = won.mapNotNull { it.distance }
            HorseView(h, 0, surface, dists.takeIf { it.isNotEmpty() }?.average()?.roundToInt(), h.bigWins.size)
        }.let(::withPercentileRating)
    }

    // 素点をそのまま表示すると、上位の名馬が軒並み上限に張り付いて差が見えなくなる。
    // そこで「全頭の中で下から何% の位置か (p = 0〜1)」に変換し、45 + 54 * p^2 で 45〜99 に配る。
    // p を 2 乗するので、中位の馬は低めに、上位ほど 1 点の重みが大きくなる (99 になるのは全体の約 0.5%)。
    /** 素点の順位 (パーセンタイル) で 45〜99 に配る。上位ほど間隔が詰まり 99 はごく一部になる */
    private fun withPercentileRating(list: List<HorseView>): List<HorseView> {
        if (list.isEmpty()) return list
        val raw = list.map { rawScore(it.horse) }
        val order = raw.indices.sortedBy { raw[it] }
        val rating = IntArray(list.size)
        order.forEachIndexed { rank, i ->
            val p = if (list.size == 1) 1.0 else rank.toDouble() / (list.size - 1)
            rating[i] = (45 + 54 * p * p).roundToInt()
        }
        return list.mapIndexed { i, v -> v.copy(rating = rating[i]) }
    }

    // 素点 = 18 * sqrt(勝率) + GI勝利数 * 3 (最大 9 勝分) + 重賞勝利数 * 0.6 (最大 15 勝分) + 賞金点
    //   - 勝率に sqrt を掛けるのは、勝率 0.1 と 0.2 の差を、0.8 と 0.9 の差より大きく扱うため
    //   - 賞金点 = log10(1 + 賞金(万円)) * 3 (最大 15)。桁が 1 つ増えるごとに +3 点
    //   - 戦績が書かれていない馬は勝率 0.25、賞金が円でない (海外の馬) は賞金点 6 で仮置きする
    // 「実力」ではなく、記事に書かれた実績を数値にしただけのもの。
    /** 戦績 (勝率・G1 勝ち数・獲得賞金) から作る素点。実力を正確に表すものではない */
    private fun rawScore(h: HorseEntry): Double {
        val starts = h.starts ?: 0
        val winRate = if (starts > 0) (h.wins ?: 0).toDouble() / starts else 0.25
        val top = h.bigWins.count { it.grade.endsWith("I") && !it.grade.endsWith("II") }
        val graded = h.bigWins.size
        val money = h.earningsManYen?.let { min(log10(1.0 + it) * 3.0, 15.0) } ?: 6.0
        return 18 * sqrt(winRate) + min(top, 9) * 3.0 + min(graded, 15) * 0.6 + money
    }

    fun status() = LibraryStatus(
        snapshot.generatedAt, snapshot.horses.size, snapshot.horses.count { it.image != null },
        snapshot.races.size, snapshot.jockeys.size, CourseCatalog.all.size, syncing, progress
    )

    /**
     * 騎手名鑑の検索。q は名前・出身地・所属に含まれれば一致。region は 中央 / 地方 / 海外、active = true なら現役だけ。
     * 並び順: g1 (GI 勝利数) / wins (通算勝利数) / new (若い順) / name (名前順)
     */
    fun searchJockeys(q: String, region: String, active: Boolean, sort: String, offset: Int, limit: Int): JockeyPage {
        val needle = q.trim()
        val list = snapshot.jockeys.filter { j ->
            (needle.isEmpty() || j.name.contains(needle) || j.title.contains(needle) || j.birthplace.contains(needle) || j.affiliation.contains(needle)) &&
                (region.isEmpty() || j.region == region) && (!active || j.active)
        }
        val sorted = when (sort) {
            "wins" -> list.sortedWith(compareByDescending<JockeyEntry> { it.wins ?: -1 }.thenByDescending { it.g1Wins ?: -1 })
            "new" -> list.sortedByDescending { it.birthYear ?: 0 }
            "name" -> list.sortedBy { it.name }
            else -> list.sortedWith(compareByDescending<JockeyEntry> { it.g1Wins ?: -1 }.thenByDescending { it.wins ?: -1 })
        }
        return JockeyPage(sorted.size, sorted.drop(offset.coerceAtLeast(0)).take(limit.coerceIn(1, 200)))
    }

    fun jockey(title: String) = snapshot.jockeys.firstOrNull { it.title == title }
    fun allJockeys(): List<JockeyEntry> = snapshot.jockeys

    // 名鑑の検索。q (キーワード) は馬名・英名・父・母・勝ち鞍のどれかに含まれれば一致。
    // asSequence() で絞り込みを遅延評価にし、途中のリストを作らないようにしている。
    // limit は 1〜200 に制限する (巨大なページを要求されてもサーバーが重くならないように)。
    fun searchHorses(q: String, sort: String, photoOnly: Boolean, sex: String, surface: String, offset: Int, limit: Int): HorsePage {
        val needle = q.trim().lowercase()
        var list = views.asSequence()
        if (needle.isNotEmpty()) list = list.filter { v ->
            val h = v.horse
            h.name.lowercase().contains(needle) || h.nameEn.lowercase().contains(needle) ||
                h.sire.contains(needle) || h.dam.contains(needle) || h.bigWins.any { it.race.contains(needle) }
        }
        if (photoOnly) list = list.filter { it.horse.image != null }
        if (sex.isNotBlank()) list = list.filter { it.horse.sex.startsWith(sex) }
        if (surface.isNotBlank()) list = list.filter { it.surface.contains(surface) }
        val sorted = when (sort) {
            "name" -> list.sortedBy { it.horse.name }
            "new" -> list.sortedByDescending { it.horse.birthYear ?: 0 }
            "old" -> list.sortedBy { it.horse.birthYear ?: 9999 }
            "wins" -> list.sortedByDescending { it.gradedWins }
            else -> list.sortedWith(compareByDescending<HorseView> { it.rating }.thenByDescending { it.gradedWins })
        }.toList()
        return HorsePage(sorted.size, sorted.drop(offset).take(limit.coerceIn(1, 200)))
    }

    fun horse(title: String) = byTitle[title]

    // 静的書き出し (--export) 用: 全頭・全競走をそのまま返す
    fun allHorses(): List<HorseView> = views
    fun allRaces(): List<RaceEntry> = snapshot.races

    // 要約は 1 回取ったら覚えておく (同じ馬を何度開いても Wikipedia に 1 回しか問い合わせない)。
    suspend fun summary(title: String): String? =
        summaries[title] ?: wiki.summary(title)?.also { summaries[title] = it }

    // 競走一覧の検索。並び順は 格付け (GI → GII → GIII → その他 → なし) → 競走名。
    // grade は完全一致 ("GI" で GII/GIII まで出ないように)。
    fun searchRaces(q: String, course: String, grade: String, surface: String, offset: Int, limit: Int): RacePage {
        val needle = q.trim()
        val list = snapshot.races.filter { r ->
            (needle.isEmpty() || r.name.contains(needle) || r.title.contains(needle)) &&
                (course.isEmpty() || r.course.contains(course)) &&
                (grade.isEmpty() || r.grade == grade) &&
                (surface.isEmpty() || r.surface.contains(surface))
        }.sortedWith(compareBy<RaceEntry>({ gradeOrder(it.grade) }, { it.name }))
        return RacePage(list.size, list.drop(offset).take(limit.coerceIn(1, 500)))
    }

    private fun gradeOrder(g: String) = when {
        g.matches(Regex("(G|Jpn)I")) -> 0
        g.matches(Regex("(G|Jpn)II")) -> 1
        g.matches(Regex("(G|Jpn)III")) -> 2
        g.isNotBlank() -> 3
        else -> 4
    }

    // アプリ内蔵の競馬場データに、Wikidata から取った座標と写真を重ねて返す。
    fun courses(): List<Racecourse> = CourseCatalog.all.map { c ->
        val m = snapshot.courseMedia[c.qid]
        c.copy(lat = m?.lat, lon = m?.lon, image = m?.image)
    }

    // まだ知らない写真だけを 50 件ずつ問い合わせる。失敗しても例外にせず、分かった分だけ返す
    // (クレジットが表示できないだけで、画面そのものは壊さない)。
    suspend fun credits(files: List<String>): List<MediaCredit> {
        val missing = files.filter { !credits.containsKey(it) }.distinct()
        missing.chunked(50).forEach { batch -> runCatching { wiki.credits(batch) }.getOrNull()?.forEach { credits[it.file] = it } }
        return files.mapNotNull { credits[it] }
    }
}
