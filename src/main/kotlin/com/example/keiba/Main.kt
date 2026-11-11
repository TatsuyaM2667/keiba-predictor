package com.example.keiba

import com.example.keiba.service.AuthService
import com.example.keiba.service.RaceService
import com.example.keiba.service.HorseView
import com.example.keiba.service.LibraryService
import com.example.keiba.service.ModelParams
import com.example.keiba.service.ModelService
import com.example.keiba.service.PredictorEngine
import com.example.keiba.service.WeatherService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.runBlocking
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.http.content.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.cors.routing.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import org.slf4j.LoggerFactory
import java.awt.Desktop
import java.net.URI

private const val LIVE_ORIGIN = "https://keiba-vision.pages.dev"
private val liveHttp = java.net.http.HttpClient.newBuilder().connectTimeout(java.time.Duration.ofSeconds(10)).build()
// 予想モデルの学習データ: Worker が集めた過去の実際のレース (結果 + レース前の出馬表)
private const val RESULTS_URL = "$LIVE_ORIGIN/api/live/results?limit=500"

@Serializable
// ==================================================================================
// Main.kt — アプリの入口。Web サーバー (Ktor + Netty) を起動し、URL ごとの処理を決める
// ==================================================================================
// 全体の構成:
//   ブラウザ ──(HTTP)──> このサーバー ──> 各 Service (データの取得・計算)
//   - /           … 画面 (static/index.html) を返す
//   - /static/... … CSS / JS / 画像 / 3D モデル / WebAssembly を返す
//   - /api/...    … JSON データを返す (画面の JS が fetch で呼ぶ)
// サーバーは「自分のパソコンの中だけ」で動き、ブラウザが http://localhost:8080 に接続する。
//
// 以下の 3 つは、ブラウザから POST される JSON の形 (受け取り用の型)。
data class FavoriteRequest(val horseName: String)

@Serializable
data class NoteRequest(val raceId: String, val note: String)

@Serializable
// 名鑑の詳細 API の返り値: 馬のデータ + Wikipedia の要約文 (取れなければ null)。
data class HorseDetail(val view: HorseView, val summary: String?)

// プログラムの開始地点。`./gradlew run` やビルド済みの bin/keiba-predictor から呼ばれる。
fun main(args: Array<String>) {
    // `--sync <dir>`: Wikipedia から最新データを取り、<dir>/library.json.gz に書いて終了 (同梱データの作成用)
    if (args.firstOrNull() == "--sync") {
        val dir = java.io.File(args.getOrNull(1) ?: "src/main/resources/data")
        val lib = LibraryService()
        runBlocking {
            val job = lib.refresh(java.io.File(dir, "library.json.gz"))!!
            while (job.isActive) { println(lib.progress); delay(3000) }
        }
        println(lib.status())
        return
    }

    // --- 各サービスを 1 つずつ作る (アプリ全体で共有する) ---
    // LibraryService は作った時点で同梱データを読み込み、古ければ裏で Wikipedia から更新を始める。
    // RaceService には天気サービスを渡し、同じキャッシュを共有させる。
    // `--export <dir>`: Cloudflare Pages 用に、API の中身を JSON ファイルとして書き出して終了
    // (Pages では Kotlin が動かないため、データは静的ファイルにし、検索は Pages Functions が行う)
    if (args.firstOrNull() == "--export") {
        exportStatic(java.io.File(args.getOrNull(1) ?: "pages/dist/data"))
        return
    }
    // `--fit [file]`: 過去の実際のレースで予想モデルを学習・評価し、結果を表示して file (同梱データ) に書いて終了
    if (args.firstOrNull() == "--fit") {
        val p = ModelService(RESULTS_URL).refit()
        val out = java.io.File(args.getOrNull(1) ?: "src/main/resources/data/model-params.json")
        out.writeText(Json { prettyPrint = true; encodeDefaults = true }.encodeToString(p) + "\n")
        printModelReport(p)
        println("書き出し: ${out.absolutePath}")
        return
    }

    val weatherService = WeatherService()
    val library = LibraryService().also { it.refreshIfStale() }
    // 予想モデル: 同梱の学習結果で始め、起動時と 12 時間ごとに最新の過去レースで学習し直す (失敗しても前の結果のまま)
    val modelService = ModelService(RESULTS_URL)
    kotlin.concurrent.thread(isDaemon = true, name = "model-refit") {
        while (true) {
            runCatching { modelService.refit() }
                .onSuccess { println("予想モデルを学習しました: ${it.races} レース、採用 = ${it.selected}") }
                .onFailure { println("予想モデルの学習をスキップしました (前の結果を使います): ${it.message}") }
            Thread.sleep(12 * 3600_000L)
        }
    }
    val raceService = RaceService(weatherService, PredictorEngine(sireStatsOf(library)) { modelService.params.alpha })
    val authService = AuthService()
    val encyclopediaService = com.example.keiba.service.EncyclopediaService()

    val port = System.getenv("PORT")?.toIntOrNull() ?: 8080
    // 0.0.0.0 = このパソコンのすべてのネットワークで待ち受ける。
    // 自分だけで使うなら "127.0.0.1" でもよいが、同じ Wi-Fi のスマホから見られるようにこの設定にしている。
    val host = "0.0.0.0"

    println("==================================================")
    println("Keiba Vision")
    println("環境: Chimera Linux (musl) / Arch Linux / Windows")
    println("サーバー起動中: http://localhost:$port")
    println("==================================================")

    val server = embeddedServer(Netty, port = port, host = host) {
        // ContentNegotiation: call.respond(Kotlin のオブジェクト) を自動で JSON に変換する仕組み。
        // encodeDefaults = true がないと、空文字やデフォルト値のフィールドが JSON から省略され、
        // 画面側の JS で undefined になってエラーの原因になる。
        install(ContentNegotiation) {
            json(Json {
                prettyPrint = false
                encodeDefaults = true // 空文字や空配列も省略せず返す (フロントで undefined にしない)
                isLenient = true
                ignoreUnknownKeys = true
            })
        }

        // CORS: 別のサイト (別のポート) の画面からこの API を呼べるようにする設定。
        // Cloudflare 版の画面など、別の場所から開いた場合に必要。
        install(CORS) {
            anyHost()
            allowHeader(HttpHeaders.ContentType)
            allowHeader(HttpHeaders.Authorization)
            allowMethod(HttpMethod.Options)
            allowMethod(HttpMethod.Put)
            allowMethod(HttpMethod.Patch)
            allowMethod(HttpMethod.Delete)
        }

        routing {
            // Wasm モジュールの明示的配信 (Content-Type: application/wasm) - staticResources より先に評価
            // WebAssembly は Content-Type が application/wasm でないとブラウザが高速な読み込み方法を使えないため、
            // .wasm だけはここで明示的に返す。下の staticResources より先に書くことで、こちらが優先される。
            get("/static/wasm/{fileName}") {
                val fileName = call.parameters["fileName"] ?: return@get call.respond(HttpStatusCode.BadRequest)
                val stream = Thread.currentThread().contextClassLoader.getResourceAsStream("static/wasm/$fileName")
                    ?: javaClass.getResourceAsStream("/static/wasm/$fileName")
                if (stream != null) {
                    call.respondBytes(stream.readBytes(), ContentType("application", "wasm"))
                } else {
                    call.respond(HttpStatusCode.NotFound)
                }
            }

            // 静的アセットの提供
            // src/main/resources/static/ 以下のファイル (CSS, JS, アイコン, 3D モデルなど) をそのまま返す。
            staticResources("/static", "static")

            // トップページ
            get("/") {
                val indexStream = javaClass.getResourceAsStream("/static/index.html")
                if (indexStream != null) {
                    call.respondBytes(indexStream.readBytes(), ContentType.Text.Html)
                } else {
                    call.respondText("index.html not found", status = HttpStatusCode.NotFound)
                }
            }

            get("/api/health") { call.respond(mapOf("status" to "ok", "version" to "2.0.0")) }

            // ライブラリ (Wikipedia / Wikidata 由来): 競走馬・競走・競馬場
            get("/api/library/status") { call.respond(library.status()) }
            post("/api/library/refresh") {
                library.refresh()
                call.respond(library.status())
            }
            // 名鑑の検索。例: /api/horses?q=オグリ&sort=rating&photo=1&offset=0&limit=48
            // 数値に変換できない値が来ても落ちないよう、toIntOrNull() ?: 既定値 にしている。
            get("/api/horses") {
                val q = call.request.queryParameters
                call.respond(library.searchHorses(
                    q["q"] ?: "", q["sort"] ?: "rating", q["photo"] == "1", q["sex"] ?: "", q["surface"] ?: "",
                    q["offset"]?.toIntOrNull() ?: 0, q["limit"]?.toIntOrNull() ?: 48
                ))
            }
            // 馬の詳細。記事名 (title) が必須で、なければ 400、名鑑にいなければ 404 を返す。
            get("/api/horses/detail") {
                val title = call.request.queryParameters["title"] ?: return@get call.respond(HttpStatusCode.BadRequest)
                val view = library.horse(title) ?: return@get call.respond(HttpStatusCode.NotFound)
                call.respond(HorseDetail(view, library.summary(title)))
            }
            get("/api/catalog/races") {
                val q = call.request.queryParameters
                call.respond(library.searchRaces(
                    q["q"] ?: "", q["course"] ?: "", q["grade"] ?: "", q["surface"] ?: "",
                    q["offset"]?.toIntOrNull() ?: 0, q["limit"]?.toIntOrNull() ?: 100
                ))
            }
            get("/api/courses") { call.respond(library.courses()) }
            // 採用した予想モデル (画面の race-model.js がこれで勝率を出す) と、交差検証の成績
            get("/api/model/params") { call.respond(modelService.params) }
            // 25 場の座標を Open-Meteo にまとめて渡し、現在の天気を 1 回のリクエストで取る。
            // 座標が分からない競馬場は除外する。
            get("/api/weather") {
                val points = library.courses().mapNotNull { c -> if (c.lat != null && c.lon != null) Triple(c.id, c.lat, c.lon) else null }
                call.respond(weatherService.currentFor(points))
            }
            // 写真の作者・ライセンス。files は "A.jpg|B.jpg" のように "|" 区切り。
            // 一度に大量に問い合わせられないよう、最大 100 件で切る。
            get("/api/media") {
                val files = call.request.queryParameters["files"]?.split("|")?.filter { it.isNotBlank() }?.take(100) ?: emptyList()
                call.respond(library.credits(files))
            }

            // 血統・品種・毛色 (アプリ内蔵の解説データ)
            route("/api/encyclopedia") {
                get("pedigree") { call.respond(encyclopediaService.getPedigreeLineages()) }
                get("breeds") { call.respond(encyclopediaService.getBreeds()) }
                get("coats") { call.respond(encyclopediaService.getCoatColors()) }
            }

            get("/api/native/info") {
                // 実際に同梱されている wasm のサイズを返す (無ければ 0)
                call.respond(listOf("keiba_physics", "montecarlo", "pedigree").associateWith { name ->
                    javaClass.getResource("/static/wasm/$name.wasm")?.openStream()?.use { it.readBytes().size } ?: 0
                })
            }

            // JRA の実際の開催日程・出馬表・オッズ。取得は Cloudflare 版 (keiba-vision-sync Worker が 1 分ごとに自動取得) が行い、
            // ローカル版はそれを中継するだけ (JRA へ直接アクセスする所を 1 か所にまとめて、負荷を増やさないため)。
            get("/api/live/{name}") {
                val name = call.parameters["name"]
                if (name !in setOf("schedule", "races", "race", "results", "status")) return@get call.respond(HttpStatusCode.NotFound)
                val qs = call.request.queryString().let { if (it.isEmpty()) "" else "?$it" }
                try {
                    val req = java.net.http.HttpRequest.newBuilder(URI("$LIVE_ORIGIN/api/live/$name$qs"))
                        .timeout(java.time.Duration.ofSeconds(15)).GET().build()
                    val res = withContext(Dispatchers.IO) { liveHttp.send(req, java.net.http.HttpResponse.BodyHandlers.ofString()) }
                    call.respondText(res.body(), ContentType.Application.Json, HttpStatusCode.fromValue(res.statusCode()))
                } catch (e: Exception) {
                    call.respond(HttpStatusCode.BadGateway, mapOf("error" to "最新データを取得できませんでした"))
                }
            }

            // 競馬データ API
            // レース予想 (アプリ内蔵のサンプル出馬表 3 レース)。
            route("/api/races") {
                get {
                    val list = raceService.getAllRacesSummary()
                    call.respond(list)
                }

                get("{raceId}") {
                    val id = call.parameters["raceId"] ?: return@get call.respond(HttpStatusCode.BadRequest)
                    val race = raceService.getRaceById(id)
                    if (race != null) {
                        call.respond(race)
                    } else {
                        call.respond(HttpStatusCode.NotFound)
                    }
                }

                get("{raceId}/analysis") {
                    val id = call.parameters["raceId"] ?: return@get call.respond(HttpStatusCode.BadRequest)
                    val analysis = raceService.getRaceAnalysis(id)
                    if (analysis != null) {
                        call.respond(analysis)
                    } else {
                        call.respond(HttpStatusCode.NotFound)
                    }
                }
            }

            // 認証 & ユーザーセッション API
            // サインイン (デモ)。サインインすると "keiba_session" という Cookie にランダムな合言葉 (トークン) を入れ、
            // 以降のリクエストではその Cookie でユーザーを見分ける。
            // httpOnly = true にすると、ページの JavaScript から Cookie を読めなくなる (盗まれにくくなる)。
            route("/api/auth") {
                get("me") {
                    val token = call.request.cookies["keiba_session"]
                    val user = authService.getSession(token)
                    if (user != null) {
                        call.respond(user)
                    } else {
                        call.respond(HttpStatusCode.Unauthorized)
                    }
                }

                post("login") {
                    val provider = call.request.queryParameters["provider"] ?: "demo"
                    val (token, profile) = authService.createDemoSession(provider)
                    call.response.cookies.append(
                        Cookie(
                            name = "keiba_session",
                            value = token,
                            path = "/",
                            httpOnly = true,
                            maxAge = 86400 * 30
                        )
                    )
                    call.respond(profile)
                }

                post("logout") {
                    val token = call.request.cookies["keiba_session"]
                    if (token != null) {
                        authService.logout(token)
                    }
                    call.response.cookies.append(
                        Cookie(
                            name = "keiba_session",
                            value = "",
                            path = "/",
                            maxAge = 0
                        )
                    )
                    call.respond(mapOf("status" to "logged_out"))
                }
            }

            // お気に入り馬 API
            post("/api/favorites") {
                val token = call.request.cookies["keiba_session"]
                if (token == null) {
                    call.respond(HttpStatusCode.Unauthorized)
                    return@post
                }
                val req = call.receive<FavoriteRequest>()
                val updated = authService.addFavorite(token, req.horseName)
                if (updated != null) {
                    call.respond(updated)
                } else {
                    call.respond(HttpStatusCode.Unauthorized)
                }
            }

            // 予想メモ API
            post("/api/notes") {
                val token = call.request.cookies["keiba_session"]
                if (token == null) {
                    call.respond(HttpStatusCode.Unauthorized)
                    return@post
                }
                val req = call.receive<NoteRequest>()
                val updated = authService.saveNote(token, req.raceId, req.note)
                if (updated != null) {
                    call.respond(updated)
                } else {
                    call.respond(HttpStatusCode.Unauthorized)
                }
            }
        }
    }

    // wait = false: サーバーを裏で動かしたまま、次の行 (ブラウザを開く処理) に進む。
    server.start(wait = false)

    println("Keiba Vision を起動しました")
    println("ブラウザで http://localhost:$port を開いてください")
    println("--------------------------------------------------")

    // クロスプラットフォーム (Chimera Linux musl, Arch Linux, Windows) 対応ブラウザオープン
    if (System.getenv("NO_BROWSER") == null) openBrowserAcrossPlatforms("http://localhost:$port")

    // メインスレッド維持
    // 自分自身の終了を待つ = 永遠に待つ。これがないと main が終わってプログラムが終了してしまう。
    // Ctrl + C で止めるまでサーバーは動き続ける。
    Thread.currentThread().join()
}

/**
 * Chimera Linux (musl libc), Arch Linux, Windows のすべてで確実にブラウザを起動するマルチフォールバック関数
 */
// OS ごとに「既定のブラウザで URL を開く」方法が違うので、順番に試す。
//   Windows : rundll32 (失敗したら cmd /c start)
//   Linux   : xdg-open → gio → x-www-browser → firefox → chromium (最初に成功したもの)
//   macOS   : open
//   最後の手段: Java 標準の Desktop.browse
// どれも失敗したら、手動で開くよう案内を表示するだけでアプリは止めない。
fun openBrowserAcrossPlatforms(url: String) {
    try {
        Thread.sleep(1200) // サーバー起動待機
        val os = System.getProperty("os.name").lowercase()

        when {
            // Windows
            os.contains("win") -> {
                try {
                    Runtime.getRuntime().exec(arrayOf("rundll32", "url.dll,FileProtocolHandler", url))
                    return
                } catch (e: Exception) {
                    Runtime.getRuntime().exec(arrayOf("cmd.exe", "/c", "start", url))
                    return
                }
            }
            // Linux (Chimera Linux musl, Arch Linux, etc.)
            os.contains("linux") || os.contains("nix") -> {
                val openCommands = listOf(
                    arrayOf("xdg-open", url),
                    arrayOf("gio", "open", url),
                    arrayOf("x-www-browser", url),
                    arrayOf("firefox", url),
                    arrayOf("chromium", url)
                )

                for (cmd in openCommands) {
                    try {
                        val process = ProcessBuilder(*cmd).redirectErrorStream(true).start()
                        val exit = process.waitFor()
                        if (exit == 0) return
                    } catch (_: Exception) {
                        // 次のコマンドを試行
                    }
                }
            }
            // macOS / その他
            os.contains("mac") -> {
                Runtime.getRuntime().exec(arrayOf("open", url))
                return
            }
        }

        // AWT Desktop フォールバック (GUI環境サポート時)
        if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
            Desktop.getDesktop().browse(URI(url))
        } else {
            println("ブラウザ自動オープン: http://localhost:8080 をブラウザで開いてください。")
        }
    } catch (e: Exception) {
        println("ブラウザの自動オープンをスキップしました (手動で開いてください: $url): ${e.message}")
    }
}

/** Pages 用の静的データを書き出す。ファイル名は pages/functions/api/[[path]].ts が読む名前と一致させる */
fun exportStatic(dir: java.io.File) = runBlocking {
    val json = Json { encodeDefaults = true }
    val library = LibraryService()
    // 予想モデルは書き出すたびに学習し直す (取れなければ同梱の学習結果)
    val model = ModelService(RESULTS_URL).also { m -> runCatching { m.refit() }.onFailure { println("予想モデルの学習をスキップ: ${it.message}") } }
    val races = RaceService(WeatherService(), PredictorEngine(sireStatsOf(library)) { model.params.alpha })
    val encyclopedia = com.example.keiba.service.EncyclopediaService()
    dir.mkdirs()
    fun write(name: String, text: String) = java.io.File(dir, name).writeText(text)
    write("horses.json", json.encodeToString(library.allHorses()))
    write("model-params.json", json.encodeToString(model.params))
    write("races-catalog.json", json.encodeToString(library.allRaces()))
    write("courses.json", json.encodeToString(library.courses()))
    write("status.json", json.encodeToString(library.status()))
    write("pedigree.json", json.encodeToString(encyclopedia.getPedigreeLineages()))
    write("breeds.json", json.encodeToString(encyclopedia.getBreeds()))
    write("coats.json", json.encodeToString(encyclopedia.getCoatColors()))
    val sample = races.getAllRacesSummary()
    write("races.json", json.encodeToString(sample))
    // 予想は書き出した時点の天気で計算する
    sample.forEach { r -> races.getRaceAnalysis(r.id)?.let { write("analysis-${r.id}.json", json.encodeToString(it)) } }
    println("書き出し完了: ${dir.absolutePath} (${dir.list()?.size} ファイル)")
}

/**
 * 名鑑から、種牡馬ごとの産駒成績を作る (予想の「血統」に使う)。
 * 対象は重賞を勝った産駒。芝で勝った割合 (芝・ダート両方なら 0.5) と、勝った重賞の平均距離の平均。
 * 名鑑は裏で更新されることがあるので、中身が変わったら作り直す。
 */
fun sireStatsOf(library: LibraryService): (String) -> PredictorEngine.SireStat? {
    var cache: Pair<List<HorseView>, Map<String, PredictorEngine.SireStat>>? = null
    return { sire ->
        val views = library.allHorses()
        val map = cache?.takeIf { it.first === views }?.second ?: views
            .filter { it.horse.sire.isNotBlank() && it.surface != "不明" }
            .groupBy { it.horse.sire }
            .mapValues { (_, list) ->
                val turf = list.sumOf { v -> if (v.surface == "芝") 1.0 else if ("芝" in v.surface) 0.5 else 0.0 }
                PredictorEngine.SireStat(list.size, turf / list.size, list.mapNotNull { it.bestDistance }.takeIf { it.isNotEmpty() }?.average())
            }
            .also { cache = views to it }
        map[sire]
    }
}

/** 学習結果を表で表示する (--fit) */
fun printModelReport(p: ModelParams) {
    println("学習に使ったレース: ${p.races} (出走 ${p.runners} 頭)")
    println("対数損失 (小さいほど正確)。「市場との差」が −2×標準誤差 より小さければ、市場よりはっきり良い")
    for (r in p.report) {
        val diff = r.vsMarket?.let { "市場との差 %+.4f ± %.4f".format(it, r.vsMarketSe) } ?: ""
        println("  %-44s %.4f  %s".format(r.label, r.logLoss, diff))
    }
    println("採用: ${p.selected}  (α = %.3f)  ${p.note}".format(p.alpha))
}
