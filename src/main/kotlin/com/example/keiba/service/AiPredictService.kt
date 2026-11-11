package com.example.keiba.service

import com.example.keiba.data.CourseCatalog
import com.example.keiba.model.TrackCondition
import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.http.content.*
import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import org.slf4j.LoggerFactory
import java.io.File
import java.text.Normalizer
import java.time.LocalDate
import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.random.Random

// ==================================================================================
// AiPredictService — 生成 AI (Gemini / Claude) にレースを予想させる
// ==================================================================================
// 流れ:
//   1. 画面から届いたレース情報と、貼り付けられた出馬表のテキストを受け取る
//   2. 出馬表の中から名鑑 (LibraryService) にいる馬を探し、戦績・血統・能力値を「AI への資料」にする
//      競馬場の特徴 (CourseCatalog) と現地の天気 (WeatherService) も添える
//   3. AI に「決まった形の JSON で答えて」と頼み、返ってきた文章から JSON を取り出して画面に返す
// 出馬表やオッズを無料で取れる API はないため、最新情報は AI 自身の Web 検索 (Gemini は Google 検索、
// Claude は web_search ツール) か、ユーザーの貼り付けに頼る。
//
// API キーはこのパソコンの ~/.config/keiba-vision/ai-settings.json にだけ保存し、画面には返さない
// (末尾 4 文字だけ見せる)。環境変数 GEMINI_API_KEY / ANTHROPIC_API_KEY があれば、未設定のときに使う。

/** 画面から届くレース情報 */
@Serializable
data class AiRaceInput(
    val name: String = "",
    val date: String = "",
    val venue: String = "",      // 競馬場の短い名前 (東京 / 大井 など)
    val surface: String = "",    // 芝 / ダート
    val distance: Int? = null,
    val going: String = "",      // 良 / 稍重 / 重 / 不良
    val entries: String = "",    // 出走馬・メモ (貼り付けたテキスト、または JRA の出馬表から作ったテキスト)
    val runnerNames: List<String> = emptyList(), // JRA の出馬表から読み込んだときの出走馬名 (名鑑の照合に使う)
    val webSearch: Boolean = true,
    val test: Boolean = false    // テストモード: AI を呼ばずにダミーの予想を返す
)

@Serializable
data class AiPick(
    val number: Int? = null,
    val horse: String,
    val jockey: String = "",
    val mark: String = "",
    val winProb: Double = 0.0,   // 勝率 (%)
    val reason: String = "",
    val libraryTitle: String? = null // 名鑑にいる馬なら記事名 (詳細画面・3D に使う)
)

@Serializable
data class AiBet(val type: String = "", val selection: String = "", val comment: String = "")

@Serializable
data class AiSource(val title: String, val url: String)

/** AI 1 つ分の予想結果。失敗しても例外にせず ok = false と error で返す */
@Serializable
data class AiResult(
    val provider: String,
    val model: String,
    val ok: Boolean,
    val error: String? = null,
    val notice: String? = null,
    val elapsedSec: Double = 0.0,
    val outlook: String = "",
    val pace: String = "",
    val confidence: String = "",
    val notes: String = "",
    val predictions: List<AiPick> = emptyList(),
    val bets: List<AiBet> = emptyList(),
    val sources: List<AiSource> = emptyList(),
    val raw: String? = null,     // JSON を読み取れなかったときだけ、AI の回答をそのまま返す
    val test: Boolean = false
)

@Serializable
data class AiProviderStatus(val configured: Boolean, val fromEnv: Boolean, val keyHint: String, val model: String)

@Serializable
data class AiSettingsView(val gemini: AiProviderStatus, val claude: AiProviderStatus, val storedAt: String)

/** 設定の更新。キーは null か空文字なら「変えない」、clear で削除 */
@Serializable
data class AiSettingsUpdate(
    val geminiKey: String? = null,
    val claudeKey: String? = null,
    val geminiModel: String? = null,
    val claudeModel: String? = null,
    val clearGemini: Boolean = false,
    val clearClaude: Boolean = false
)

/** 出馬表の中で見つかった名鑑の馬 */
@Serializable
data class LibraryMatch(
    val title: String,
    val name: String,
    val rating: Int,
    val surface: String,
    val bestDistance: Int?,
    val gradedWins: Int,
    val birthYear: Int?,
    val color: String
)

@Serializable
data class LookupRequest(val text: String = "", val names: List<String> = emptyList())

/** AI の API が返したエラー。code は HTTP ステータス、retryAfterSec は「◯秒後に再試行して」の指示 */
class AiApiError(message: String, val code: Int = 0, val retryAfterSec: Double? = null) : Exception(message)

class AiPredictService(
    private val library: LibraryService,
    private val weather: WeatherService
) {
    private val log = LoggerFactory.getLogger(AiPredictService::class.java)
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true; encodeDefaults = true }
    private val dir = File(System.getProperty("user.home"), ".config/keiba-vision")
    private val settingsFile = File(dir, "ai-settings.json")
    private val historyFile = File(dir, "ai-history.json")
    private val lock = Any()

    // Web 検索つきの予想は 1〜3 分かかることがあるので、待ち時間を長めにとる
    private val http = HttpClient(CIO) {
        install(HttpTimeout) { requestTimeoutMillis = 300_000; connectTimeoutMillis = 15_000; socketTimeoutMillis = 300_000 }
        expectSuccess = false
    }

    // Gemini の無料枠は Google 検索の上限に先に当たりやすい。一度当たったら 1 時間は検索なしで頼む
    // (毎回「検索つき → 失敗 → 検索なし」と 2 回呼んで無料枠の回数を無駄にしないため)。
    @Volatile private var geminiSearchBlockedUntil = 0L

    @Serializable
    private data class Stored(
        val geminiKey: String = "",
        val claudeKey: String = "",
        val geminiModel: String = DEFAULT_GEMINI,
        val claudeModel: String = DEFAULT_CLAUDE
    )

    @Volatile private var stored: Stored = runCatching { json.decodeFromString<Stored>(settingsFile.readText()) }.getOrDefault(Stored())

    // ---------------------------------------------------------------- 設定
    private fun envGemini() = System.getenv("GEMINI_API_KEY") ?: System.getenv("GOOGLE_API_KEY") ?: ""
    private fun envClaude() = System.getenv("ANTHROPIC_API_KEY") ?: ""
    private fun geminiKey() = stored.geminiKey.ifBlank { envGemini() }
    private fun claudeKey() = stored.claudeKey.ifBlank { envClaude() }
    private fun hint(key: String) = when {
        key.length >= 8 -> "…" + key.takeLast(4)
        key.isNotEmpty() -> "設定済み"
        else -> ""
    }

    fun settings(): AiSettingsView {
        val s = stored
        return AiSettingsView(
            AiProviderStatus(geminiKey().isNotBlank(), s.geminiKey.isBlank() && envGemini().isNotBlank(), hint(geminiKey()), s.geminiModel),
            AiProviderStatus(claudeKey().isNotBlank(), s.claudeKey.isBlank() && envClaude().isNotBlank(), hint(claudeKey()), s.claudeModel),
            settingsFile.absolutePath
        )
    }

    fun updateSettings(u: AiSettingsUpdate): AiSettingsView {
        synchronized(lock) {
            val s = stored
            stored = s.copy(
                geminiKey = if (u.clearGemini) "" else u.geminiKey?.trim()?.takeIf { it.isNotEmpty() } ?: s.geminiKey,
                claudeKey = if (u.clearClaude) "" else u.claudeKey?.trim()?.takeIf { it.isNotEmpty() } ?: s.claudeKey,
                geminiModel = u.geminiModel?.trim()?.removePrefix("models/")?.takeIf { it.isNotEmpty() } ?: s.geminiModel,
                claudeModel = u.claudeModel?.trim()?.takeIf { it.isNotEmpty() } ?: s.claudeModel
            )
            writePrivate(settingsFile, json.encodeToString(Stored.serializer(), stored))
        }
        return settings()
    }

    // 鍵を含むファイルなので、Linux / macOS では自分だけが読めるようにする (Windows はユーザーフォルダの権限に任せる)
    private fun writePrivate(file: File, text: String) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(text)
        runCatching { tmp.setReadable(false, false); tmp.setReadable(true, true); tmp.setWritable(false, false); tmp.setWritable(true, true) }
        if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
    }

    // ---------------------------------------------------------------- 名鑑との照合
    /**
     * 出走馬の中から名鑑にいる馬を探す (最大 30 頭)。同じ名前の馬が複数いるときは新しい馬を採る。
     * - names (JRA の出馬表から読み込んだ出走馬名) があれば、その名前と完全に一致する馬だけ
     * - なければ貼り付けたテキストの中から探す。別の馬名の一部になっている名前 (例: 「キタサン」と
     *   「キタサンブラック」) は長いほうだけ、3 文字未満の名前は誤爆しやすいので対象外。
     *   父・母として書かれた名前 (「父 ディープインパクト」) と、競走名の一部 (「セントライト記念」) も除く
     */
    fun lookup(text: String, names: List<String> = emptyList()): List<LibraryMatch> {
        val best = LinkedHashMap<String, HorseView>()
        if (names.isNotEmpty()) {
            val wanted = names.map(::norm).filter { it.isNotEmpty() }.toSet()
            for (v in library.allHorses()) {
                val n = norm(v.horse.name)
                if (n !in wanted) continue
                val cur = best[n]
                if (cur == null || (v.horse.birthYear ?: 0) > (cur.horse.birthYear ?: 0)) best[n] = v
            }
            val order = names.map(::norm)
            return best.entries.sortedBy { order.indexOf(it.key) }.take(30).map { it.value.toMatch() }
        }
        // 空白は 1 つに詰めて残す (「ドウデュース ハーツクライ」のように並んだ名前の切れ目が分かるように)
        val hay = Normalizer.normalize(text, Normalizer.Form.NFKC).replace(Regex("\\s+"), " ").lowercase()
        if (hay.length < 3) return emptyList()
        for (v in library.allHorses()) {
            val n = norm(v.horse.name)
            if (n.length < 3 || !hay.contains(n) || !mentionedAsRunner(hay, n)) continue
            val cur = best[n]
            if (cur == null || (v.horse.birthYear ?: 0) > (cur.horse.birthYear ?: 0)) best[n] = v
        }
        val found = best.keys
        return best.filterKeys { n -> found.none { it != n && it.contains(n) } }
            .entries.sortedBy { hay.indexOf(it.key) }.take(30)
            .map { it.value.toMatch() }
    }

    private fun HorseView.toMatch() =
        LibraryMatch(horse.title, horse.name, rating, surface, bestDistance, gradedWins, horse.birthYear, horse.color)

    /**
     * テキストの中で「出走馬」として出てくる箇所が 1 つでもあるか。次のものは数えない:
     * - 別の馬名の一部 (「キングヘイロー」の中の「ヘイロー」): 前後がカタカナ・英字に続いている
     * - 父・母として書かれた名前 (「父 ディープインパクト」「母父 Vindication」)
     * - 競走名の一部 (「セントライト記念」)
     */
    private fun mentionedAsRunner(hay: String, n: String): Boolean {
        var i = hay.indexOf(n)
        while (i >= 0) {
            val prev = hay.getOrNull(i - 1)
            val next = hay.getOrNull(i + n.length)
            val before = hay.substring(maxOf(0, i - 4), i)
            val after = hay.substring(i + n.length, minOf(hay.length, i + n.length + 6))
            val partOfWord = (prev != null && WORD_CHAR.matches(prev.toString())) || (next != null && WORD_CHAR.matches(next.toString()))
            if (!partOfWord && '父' !in before && '母' !in before && !RACE_SUFFIX.containsMatchIn(after)) return true
            i = hay.indexOf(n, i + 1)
        }
        return false
    }

    private fun describe(m: LibraryMatch): String {
        val v = library.horse(m.title) ?: return m.name
        val h = v.horse
        val parts = mutableListOf<String>()
        listOfNotNull(h.birthYear?.let { "${it}年生" }, h.sex.takeIf { it.isNotBlank() }, h.color.takeIf { it.isNotBlank() })
            .takeIf { it.isNotEmpty() }?.let { parts += it.joinToString(" ") }
        if (h.sire.isNotBlank()) parts += "父 ${h.sire}" + (if (h.damSire.isNotBlank()) " / 母父 ${h.damSire}" else "")
        if (h.starts != null && h.wins != null) parts += "通算 ${h.starts}戦${h.wins}勝"
        h.earningsManYen?.let { parts += "獲得賞金 約${it}万円" }
        if (h.bigWins.isNotEmpty()) parts += "主な勝ち鞍: " + h.bigWins.take(6).joinToString("、") { "${it.race}(${it.grade})" }
        parts += "名鑑の能力値 ${v.rating} (45〜99)"
        if (v.surface != "不明") parts += "推定適性 ${v.surface}" + (v.bestDistance?.let { " 平均${it}m" } ?: "")
        if (h.trainer.isNotBlank()) parts += "調教師 ${h.trainer}"
        return "- ${h.name}: " + parts.joinToString(" / ")
    }

    // ---------------------------------------------------------------- 予想
    suspend fun predict(provider: String, input: AiRaceInput): AiResult {
        val started = System.nanoTime()
        val model = when (provider) {
            "gemini" -> stored.geminiModel
            "claude" -> stored.claudeModel
            else -> return AiResult(provider, "", false, "知らない AI です: $provider")
        }
        val matches = lookup(input.entries, input.runnerNames)
        fun elapsed() = ((System.nanoTime() - started) / 1e8).roundToInt() / 10.0
        return try {
            val reply = when {
                input.test -> demo(provider, input, matches)
                provider == "gemini" -> {
                    if (geminiKey().isBlank()) throw AiApiError("Gemini の API キーが未設定です。「APIキーとモデル」から設定してください。")
                    gemini(model, userPrompt(input, matches, input.webSearch), input.webSearch)
                }
                else -> {
                    if (claudeKey().isBlank()) throw AiApiError("Claude の API キーが未設定です。「APIキーとモデル」から設定してください。")
                    claude(model, userPrompt(input, matches, input.webSearch), input.webSearch)
                }
            }
            toResult(provider, if (input.test) "テストモード" else model, reply, matches, input.test).copy(elapsedSec = elapsed())
        } catch (e: AiApiError) {
            AiResult(provider, model, false, e.message, elapsedSec = elapsed())
        } catch (e: HttpRequestTimeoutException) {
            AiResult(provider, model, false, "時間内に回答がありませんでした。もう一度試すか、Web 検索を OFF にしてください。", elapsedSec = elapsed())
        } catch (e: Exception) {
            log.warn("AI 予想に失敗 ($provider)", e)
            AiResult(provider, model, false, "通信に失敗しました: ${e.message ?: e.javaClass.simpleName}\n→ インターネット接続を確認してください。", elapsedSec = elapsed())
        }
    }

    private class Reply(val text: String, val sources: List<AiSource> = emptyList(), val notice: String? = null)

    private suspend fun userPrompt(input: AiRaceInput, matches: List<LibraryMatch>, web: Boolean): String = buildString {
        appendLine("今日の日付: ${LocalDate.now()}")
        appendLine()
        appendLine("次のレースの勝ち馬を予想してください。")
        appendLine()
        if (input.name.isNotBlank()) appendLine("レース名: ${input.name.trim()}")
        if (input.date.isNotBlank()) appendLine("開催日: ${input.date}")
        if (input.venue.isNotBlank()) appendLine("競馬場: ${input.venue}")
        val course = listOfNotNull(input.surface.takeIf { it.isNotBlank() }, input.distance?.let { "${it}m" }).joinToString(" ")
        if (course.isNotBlank()) appendLine("コース: $course")
        if (input.going.isNotBlank()) appendLine("馬場状態: ${input.going}")

        CourseCatalog.all.find { it.short == input.venue }?.let { c ->
            appendLine("競馬場の特徴 (参考値): ${c.turn}回り・最後の直線 約${c.straightMeters.roundToInt()}m。${c.note}")
            // 当日か前日の予想のときだけ、いまの天気を添える (先の日付には意味がないため)
            val day = runCatching { LocalDate.parse(input.date) }.getOrNull()
            if (day == null || abs(day.toEpochDay() - LocalDate.now().toEpochDay()) <= 1) {
                runCatching { weather.getWeatherForRacecourse(c.short) }.getOrNull()?.takeIf { it.isLive }?.let { w ->
                    appendLine("現地のいまの天気 (Open-Meteo): ${w.weatherDescription} ${"%.1f".format(w.temperatureC)}℃・降水 ${w.precipitationMm}mm → 降水量からの推定馬場 ${GOING[w.trackConditionEstimate]}")
                }
            }
        }
        if (input.entries.isNotBlank()) {
            appendLine()
            appendLine("出走馬・メモ (ユーザー提供):")
            // JRA の出馬表は 18 頭 × 近 4 走で 1 万文字ほどになるので、余裕をもって 20,000 文字まで渡す
            appendLine(input.entries.trim().take(20_000))
        }
        if (matches.isNotEmpty()) {
            appendLine()
            appendLine("Keiba Vision の競走馬名鑑にある情報 (Wikipedia の記事から作った参考値。最新の成績とは限らない):")
            matches.forEach { appendLine(describe(it)) }
        }
        appendLine()
        appendLine(if (web) WEB_ON else WEB_OFF)
        append(LAST_LINE)
    }

    // ---------------------------------------------------------------- Gemini
    private suspend fun gemini(model: String, user: String, webWanted: Boolean): Reply {
        val url = "https://generativelanguage.googleapis.com/v1beta/models/${model.removePrefix("models/")}:generateContent"
        val headers = mapOf("x-goog-api-key" to geminiKey())
        var notice: String? = null
        var web = webWanted
        if (web && System.currentTimeMillis() < geminiSearchBlockedUntil) { web = false; notice = SEARCH_FALLBACK }
        fun body(search: Boolean) = buildJsonObject {
            putJsonObject("systemInstruction") { putJsonArray("parts") { addJsonObject { put("text", SYSTEM_PROMPT) } } }
            putJsonArray("contents") {
                addJsonObject {
                    put("role", "user")
                    putJsonArray("parts") { addJsonObject { put("text", if (search) user else user.replace(WEB_ON, WEB_OFF)) } }
                }
            }
            putJsonObject("generationConfig") { put("maxOutputTokens", 16384) }
            if (search) putJsonArray("tools") { addJsonObject { putJsonObject("google_search") {} } }
        }
        val resp = try {
            withRetry { postJson(url, headers, body(web)) }
        } catch (e: AiApiError) {
            if (!(web && e.code == 429)) throw e
            geminiSearchBlockedUntil = System.currentTimeMillis() + 3_600_000
            notice = SEARCH_FALLBACK
            withRetry { postJson(url, headers, body(false)) }
        }
        val cand = resp["candidates"]?.jsonArray?.firstOrNull()?.jsonObject
            ?: throw AiApiError("Gemini から回答がありませんでした: ${resp["promptFeedback"] ?: ""}")
        val text = cand["content"]?.jsonObject?.get("parts")?.jsonArray.orEmpty()
            .map { it.jsonObject }
            .filter { it["thought"]?.jsonPrimitive?.booleanOrNull != true }
            .joinToString("") { it["text"]?.jsonPrimitive?.contentOrNull ?: "" }
        val sources = cand["groundingMetadata"]?.jsonObject?.get("groundingChunks")?.jsonArray.orEmpty().mapNotNull { ch ->
            val w = ch.jsonObject["web"]?.jsonObject ?: return@mapNotNull null
            val uri = w["uri"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            AiSource(w["title"]?.jsonPrimitive?.contentOrNull ?: uri, uri)
        }
        return Reply(text, sources, notice)
    }

    // ---------------------------------------------------------------- Claude
    private suspend fun claude(model: String, user: String, web: Boolean): Reply {
        val url = "https://api.anthropic.com/v1/messages"
        val headers = mapOf("x-api-key" to claudeKey(), "anthropic-version" to "2023-06-01")
        val messages = mutableListOf<JsonElement>(buildJsonObject { put("role", "user"); put("content", user) })
        val texts = mutableListOf<String>()
        val sources = mutableListOf<AiSource>()
        // Web 検索が長引くと pause_turn (一時停止) で返ってくるので、続きを頼む (最大 5 回)
        repeat(5) {
            val body = buildJsonObject {
                put("model", model)
                put("max_tokens", 8000)
                put("system", SYSTEM_PROMPT)
                put("messages", JsonArray(messages))
                if (web) putJsonArray("tools") {
                    addJsonObject { put("type", "web_search_20250305"); put("name", "web_search"); put("max_uses", 6) }
                }
            }
            val resp = withRetry { postJson(url, headers, body) }
            val content = resp["content"]?.jsonArray ?: JsonArray(emptyList())
            for (b in content.map { it.jsonObject }) {
                when (b["type"]?.jsonPrimitive?.contentOrNull) {
                    "text" -> texts += b["text"]?.jsonPrimitive?.contentOrNull ?: ""
                    "web_search_tool_result" -> (b["content"] as? JsonArray)?.forEach { r ->
                        val o = r.jsonObject
                        val u = o["url"]?.jsonPrimitive?.contentOrNull ?: return@forEach
                        sources += AiSource(o["title"]?.jsonPrimitive?.contentOrNull ?: u, u)
                    }
                }
            }
            if (resp["stop_reason"]?.jsonPrimitive?.contentOrNull != "pause_turn") return Reply(texts.joinToString("\n"), sources)
            messages += buildJsonObject { put("role", "assistant"); put("content", content) }
        }
        return Reply(texts.joinToString("\n"), sources)
    }

    // ---------------------------------------------------------------- モデル一覧
    suspend fun models(provider: String): List<String> = when (provider) {
        "gemini" -> {
            if (geminiKey().isBlank()) throw AiApiError("先に Gemini の API キーを保存してください。")
            getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", mapOf("x-goog-api-key" to geminiKey()))["models"]
                ?.jsonArray.orEmpty().map { it.jsonObject }
                .filter { m -> m["supportedGenerationMethods"]?.jsonArray.orEmpty().any { it.jsonPrimitive.content == "generateContent" } }
                .mapNotNull { it["name"]?.jsonPrimitive?.contentOrNull?.removePrefix("models/") }
                .filter { it.startsWith("gemini") && !it.contains("tts") && !it.contains("image") }
                .distinct().sortedDescending()
        }
        "claude" -> {
            if (claudeKey().isBlank()) throw AiApiError("先に Claude の API キーを保存してください。")
            getJson("https://api.anthropic.com/v1/models?limit=100", mapOf("x-api-key" to claudeKey(), "anthropic-version" to "2023-06-01"))["data"]
                ?.jsonArray.orEmpty().mapNotNull { it.jsonObject["id"]?.jsonPrimitive?.contentOrNull }
        }
        else -> emptyList()
    }

    // ---------------------------------------------------------------- 通信の共通部分
    private suspend fun postJson(url: String, headers: Map<String, String>, body: JsonObject): JsonObject {
        val resp = http.post(url) {
            headers.forEach { (k, v) -> header(k, v) }
            setBody(TextContent(body.toString(), ContentType.Application.Json))
        }
        return parseResponse(resp)
    }

    private suspend fun getJson(url: String, headers: Map<String, String>): JsonObject =
        parseResponse(http.get(url) { headers.forEach { (k, v) -> header(k, v) } })

    private suspend fun parseResponse(resp: HttpResponse): JsonObject {
        val text = resp.bodyAsText()
        val code = resp.status.value
        if (code in 200..299) return json.parseToJsonElement(text).jsonObject
        val err = runCatching { json.parseToJsonElement(text).jsonObject["error"]?.jsonObject }.getOrNull()
        val msg = err?.get("message")?.jsonPrimitive?.contentOrNull ?: text.take(300)
        val retry = err?.get("details")?.jsonArray.orEmpty().firstNotNullOfOrNull { d ->
            (d as? JsonObject)?.get("retryDelay")?.jsonPrimitive?.contentOrNull?.removeSuffix("s")?.toDoubleOrNull()
        }
        val hint = when {
            code == 401 || code == 403 -> "→ API キーが正しくありません。「APIキーとモデル」で入れ直してください。"
            code == 404 -> "→ モデル名が見つかりません。「APIキーとモデル」の「一覧取得」で使えるモデルを選んでください。"
            code == 429 -> "→ 利用上限 (無料枠) に達しました。Web 検索を OFF にする、時間をおく、軽いモデル (flash-lite) にする、のどれかで通りやすくなります。"
            code == 500 || code == 503 || code == 529 -> "→ AI 側が混雑しています。少し時間をおいて再実行してください。"
            msg.contains("credit balance") -> "→ Claude API の残高がありません (Claude API に無料枠はありません)。"
            else -> ""
        }
        throw AiApiError("HTTP $code: ${msg.take(600)}" + if (hint.isNotEmpty()) "\n$hint" else "", code, retry)
    }

    /** 混雑 (5xx) と、短い待ち時間つきの 429 は、少し待って自動でやり直す (最大 3 回) */
    private suspend fun <T> withRetry(block: suspend () -> T): T {
        var attempt = 0
        while (true) {
            try {
                return block()
            } catch (e: AiApiError) {
                attempt++
                val wait = when {
                    e.code in setOf(500, 503, 529) -> 5.0 * attempt
                    e.code == 429 && e.retryAfterSec != null && e.retryAfterSec <= 60 -> e.retryAfterSec + 1
                    else -> null
                }
                if (wait == null || attempt >= 3) throw e
                delay((wait * 1000).toLong())
            }
        }
    }

    // ---------------------------------------------------------------- 回答の解析
    private fun toResult(provider: String, model: String, reply: Reply, matches: List<LibraryMatch>, test: Boolean): AiResult {
        val sources = reply.sources.distinctBy { it.url }.take(20)
        val obj = extractJson(reply.text)
            ?: return AiResult(provider, model, false, "回答から予想 (JSON) を読み取れませんでした。AI の回答をそのまま表示します。",
                reply.notice, sources = sources, raw = reply.text.take(20_000), test = test)
        var picks = obj["predictions"]?.jsonArray.orEmpty().mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val horse = str(o["horse"]).trim().ifEmpty { return@mapNotNull null }
            AiPick(
                number = str(o["number"]).trim().toIntOrNull(),
                horse = horse,
                jockey = str(o["jockey"]).trim(),
                mark = str(o["mark"]).trim(),
                winProb = str(o["win_prob"]).replace("%", "").trim().toDoubleOrNull()?.coerceAtLeast(0.0) ?: 0.0,
                reason = str(o["reason"]).trim()
            )
        }
        // 0〜1 の確率で返してきたときは % に直す
        val total = picks.sumOf { it.winProb }
        if (total > 0 && total <= 1.01) picks = picks.map { it.copy(winProb = it.winProb * 100) }
        val byName = matches.associateBy { norm(it.name) }
        picks = picks.map { p -> p.copy(libraryTitle = byName[norm(p.horse)]?.title ?: lookup(p.horse).singleOrNull()?.title) }
        if (picks.isEmpty()) return AiResult(provider, model, false, "予想した馬のリストが空でした。出走馬を貼り付けると予想しやすくなります。",
            reply.notice, sources = sources, raw = reply.text.take(20_000), test = test)
        val bets = obj["bets"]?.jsonArray.orEmpty().mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            AiBet(str(o["type"]), str(o["selection"]), str(o["comment"]))
        }
        return AiResult(provider, model, true, null, reply.notice, 0.0,
            str(obj["outlook"]), str(obj["pace"]), str(obj["confidence"]), str(obj["notes"]), picks, bets, sources, test = test)
    }

    // ---------------------------------------------------------------- テストモード
    /** AI を呼ばずにダミーの予想を作る。名鑑にいる馬は能力値が高いほど勝率が高くなるようにする */
    private suspend fun demo(provider: String, input: AiRaceInput, matches: List<LibraryMatch>): Reply {
        delay(600L + Random.nextLong(900))
        val rating = matches.associate { it.name to it.rating }
        // JRA の出馬表を読み込んだときは全出走馬、それ以外は名鑑で見つかった馬 → テキスト中のカタカナの名前の順
        val names = input.runnerNames.filter { it.isNotBlank() }.take(18)
            .ifEmpty { matches.map { it.name } }
            .ifEmpty { Regex("[ァ-ヴー]{3,9}").findAll(input.entries).map { it.value }.distinct().take(18).toList() }
            .ifEmpty { DEMO_HORSES }
        val rnd = Random(System.nanoTime() xor provider.hashCode().toLong())
        val w = names.map { n -> ((rating[n] ?: 62) - 40).toDouble().pow(2) * (0.5 + rnd.nextDouble()) }
        val sum = w.sum()
        val order = names.indices.sortedByDescending { w[it] }
        val marks = listOf("◎", "○", "▲", "△", "☆")
        val data = buildJsonObject {
            put("outlook", "テストモードのダミー予想です (AI は使っていないので料金はかかりません)。名鑑にいる馬は能力値が高いほど勝率を高くしています。")
            put("pace", "ダミー")
            putJsonArray("predictions") {
                order.forEachIndexed { rank, i ->
                    addJsonObject {
                        put("number", i + 1); put("horse", names[i]); put("jockey", "")
                        put("mark", marks.getOrElse(rank) { "" })
                        put("win_prob", (w[i] / sum * 1000).roundToInt() / 10.0)
                        put("reason", rating[names[i]]?.let { "名鑑の能力値 $it をもとにしたダミー評価" } ?: "ダミー評価")
                    }
                }
            }
            putJsonArray("bets") {
                addJsonObject { put("type", "馬連"); put("selection", "${order[0] + 1}-${order.getOrElse(1) { 0 } + 1}"); put("comment", "ダミーの買い目") }
            }
            put("confidence", "低")
            put("notes", "本物の予想をするときは「テストモード」を外してください。")
        }
        return Reply("```json\n$data\n```")
    }

    // ---------------------------------------------------------------- 履歴
    // 予想の履歴は画面が作った JSON をそのまま保存する (最大 300 件、新しい順)。
    fun history(): JsonArray = synchronized(lock) { loadHistory() }

    fun saveHistory(entry: JsonObject): Boolean = synchronized(lock) {
        val id = entry["id"]?.jsonPrimitive?.contentOrNull ?: return false
        val list = listOf<JsonElement>(entry) + loadHistory().filter { it.jsonObject["id"]?.jsonPrimitive?.contentOrNull != id }
        writePrivate(historyFile, JsonArray(list.take(300)).toString())
        true
    }

    fun deleteHistory(id: String): Boolean = synchronized(lock) {
        val list = loadHistory()
        val next = list.filter { it.jsonObject["id"]?.jsonPrimitive?.contentOrNull != id }
        if (next.size == list.size) return false
        writePrivate(historyFile, JsonArray(next).toString())
        true
    }

    private fun loadHistory(): JsonArray =
        runCatching { json.parseToJsonElement(historyFile.readText()).jsonArray }.getOrDefault(JsonArray(emptyList()))

    companion object {
        const val DEFAULT_GEMINI = "gemini-flash-latest"
        const val DEFAULT_CLAUDE = "claude-sonnet-5-5"

        // 馬名のすぐ後ろにこれが続くときは競走名の一部 (例: セントライト記念、ディープインパクトカップ)
        private val RACE_SUFFIX = Regex("^(記念|賞|ステークス|カップ|特別|杯|メモリアル|ハンデキャップ|ジャンプ)")
        // 馬名を作る文字 (カタカナ・長音・英字)。馬名の前後がこれだと、より長い別の名前の一部
        private val WORD_CHAR = Regex("[ァ-ヺーa-z]")
        private val GOING = mapOf(TrackCondition.FIRM to "良", TrackCondition.GOOD to "稍重", TrackCondition.YIELDING to "重", TrackCondition.SOFT to "不良")
        private val DEMO_HORSES = listOf("サンプルホープ", "テストランナー", "ダミーキング", "モックスター", "ホシノカケラ", "カゼノシルベ", "ミライノトビラ", "ハルカゼダンス")

        const val WEB_ON = "Web 検索を使って、このレースの最新の出馬表・枠順・オッズ・馬場状態・調教・前走内容を調べてから予想してください。"
        const val WEB_OFF = "Web 検索は使えません。上の情報とあなたの知識だけで予想してください。"
        const val LAST_LINE = "最後に指定の JSON 形式で回答してください。"
        const val SEARCH_FALLBACK = "Web 検索が利用上限 (無料枠) に達しているため、検索なしで予想しました。最新の出馬表を「出走馬・メモ」に貼り付けると精度が上がります。"

        val SYSTEM_PROMPT = """
            あなたは日本の競馬 (JRA・地方・海外) に精通したプロの競馬予想家です。
            与えられたレース情報をもとに、各馬の能力・近走成績・コース適性・距離適性・馬場適性・騎手・調教・枠順・展開・オッズを総合的に分析し、勝ち馬を予想してください。

            ルール:
            - Web 検索が使える場合は、必ず最新の出馬表・枠順・オッズ・馬場状態・調教・関係者コメントを調べてから予想すること。
            - 「Keiba Vision の競走馬名鑑にある情報」は Wikipedia 由来の参考値。最新の状態は検索結果やユーザーの情報を優先すること。
            - 実在しない馬や騎手を作り出してはいけない。出走馬が確認できない場合は notes にその旨を書くこと。
            - 最終回答は必ず次の形式の JSON を ```json ``` コードブロックで 1 つだけ出力すること (説明は JSON の中に書く)。

            ```json
            {
              "outlook": "レース全体の展望 (200字程度)",
              "pace": "予想される展開・ペース",
              "predictions": [
                {"number": 7, "horse": "馬名", "jockey": "騎手名", "mark": "◎", "win_prob": 28.5, "reason": "評価の根拠 (100字程度)"}
              ],
              "bets": [
                {"type": "馬連", "selection": "7-3", "comment": "狙いの理由"}
              ],
              "confidence": "高",
              "notes": "注意点・データ不足の情報など"
            }
            ```

            - predictions は評価の高い順に並べ、出走馬全頭 (多い場合は上位 10 頭以上) を入れる。
            - number は馬番 (数値)。分からなければ null。
            - mark は上位に ◎(本命) ○(対抗) ▲(単穴) △(連下) ☆(穴) を付け、それ以外は空文字 ""。
            - win_prob は勝つ確率 (%) の数値。全頭の合計がおよそ 100 になるようにする。
            - confidence は「高」「中」「低」のいずれか。
        """.trimIndent()

        /** 全角・半角や空白の違いを吸収して比べるための正規化 */
        fun norm(s: String) = Normalizer.normalize(s, Normalizer.Form.NFKC).replace(Regex("\\s"), "").lowercase()

        private fun str(e: JsonElement?): String = when (e) {
            null, JsonNull -> ""
            is JsonPrimitive -> e.contentOrNull ?: ""
            else -> e.toString()
        }

        /** AI の回答から JSON を取り出す。```json ブロック (最後のもの優先) → 最初の { から最後の } の順に試す */
        fun extractJson(text: String): JsonObject? {
            val blocks = Regex("```(?:json)?\\s*(\\{.*?\\})\\s*```", RegexOption.DOT_MATCHES_ALL).findAll(text).map { it.groupValues[1] }.toList().reversed()
            val s = text.indexOf('{')
            val e = text.lastIndexOf('}')
            val candidates = if (s >= 0 && e > s) blocks + text.substring(s, e + 1) else blocks
            for (c in candidates) runCatching { Json.parseToJsonElement(c) as? JsonObject }.getOrNull()?.let { return it }
            return null
        }
    }
}
