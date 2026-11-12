package com.example.keiba.data

import com.example.keiba.model.BigWin
import com.example.keiba.model.HorseEntry
import com.example.keiba.model.JockeyEntry
import com.example.keiba.model.RaceEntry

// ==================================================================================
// Wikitext.kt — Wikipedia の「ウィキテキスト」(記事の元の書式) を読むパーサ
// ==================================================================================
// Wikipedia の記事は HTML ではなく、次のような独自の書式で書かれています。
//
//   {{競走馬
//   |名 = オグリキャップ
//   |父 = [[ダンシングキャップ]]
//   |績 = 32戦22勝<ref name="jbis" />
//   }}
//
//   - {{ ... }}   … 「テンプレート」。{{競走馬 ...}} が記事右上の表 (インフォボックス)
//   - |キー = 値  … テンプレートの引数
//   - [[A|B]]     … 記事 A へのリンクで、画面には B と表示される
//   - <ref>...</ref> … 出典の脚注 (表示には不要なので消す)
//
// このファイルの仕事は「ウィキテキスト → HorseEntry / RaceEntry (Kotlin のデータ)」の変換です。
// 本格的なパーサ (Parsoid 等) は重いので、必要な部分だけを正規表現と括弧の数え上げで読みます。
// 単体テストは src/test/kotlin/com/example/keiba/data/WikitextTest.kt にあります。
/** Wikipedia のウィキテキストからインフォボックスを取り出す最小限のパーサ */
object Wikitext {
    // --- よく使う正規表現 (毎回コンパイルしないよう object の中で 1 回だけ作る) ---
    // refPair  : <ref name="x">本文</ref> 形式の脚注。DOT_MATCHES_ALL で改行をまたいでも一致させる
    // refSelf  : <ref name="x" /> 形式 (中身のない参照)
    // comment  : <!-- 編集者向けのコメント -->
    // fileLink : [[ファイル:Foo.jpg|250px]] の "Foo.jpg" 部分を取り出す (日本語/英語どちらの書き方も)
    // link     : [[記事名|表示名]] → 表示名、[[記事名]] → 記事名 に置き換えるためのもの
    // lang     : {{lang|en|Oguri Cap}} → "Oguri Cap"
    // gradeTpl : {{GI}} {{JpnIII}} {{G1}} のような格付けテンプレート → 中の文字だけ残す
    // oneArgTpl: {{Nowrap|文字}} のような「引数 1 つをそのまま表示する」テンプレート
    // anyTpl   : 残ったテンプレートを丸ごと消すためのもの (入れ子でない最内側から順に消える)
    // html     : <span> などの HTML タグ
    // br       : 改行タグ <br> <br/> <br /> (値の区切りとして " / " に置き換える)
    private val refPair = Regex("<ref[^>/]*>.*?</ref>", RegexOption.DOT_MATCHES_ALL)
    private val refSelf = Regex("<ref[^>]*/>")
    private val comment = Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL)
    private val fileLink = Regex("\\[\\[(?:ファイル|File|画像|Image):([^|\\]]+)", RegexOption.IGNORE_CASE)
    private val link = Regex("\\[\\[(?:[^|\\]]*\\|)?([^\\]]+)\\]\\]")
    private val lang = Regex("\\{\\{\\s*lang\\s*\\|[^|}]+\\|([^}]+)\\}\\}", RegexOption.IGNORE_CASE)
    private val gradeTpl = Regex("\\{\\{\\s*((?:G|Jpn)(?:I{1,3}|[1-3])|L|OP)\\s*\\}\\}")
    private val oneArgTpl = Regex("\\{\\{\\s*(?:Nowrap|nowrap|small|Small|lang-en|Lang-en)\\s*\\|([^{}]*)\\}\\}")
    private val anyTpl = Regex("\\{\\{[^{}]*\\}\\}")
    private val html = Regex("<[^>]+>")
    private val br = Regex("<br\\s*/?>", RegexOption.IGNORE_CASE)

    // 脚注・コメントを消す。最初に行うのは、脚注の中に "|" や "}}" が入っていて
    // 後の区切り処理を狂わせることがあるため。
    fun stripRefs(s: String) = s.replace(comment, "").replace(refPair, "").replace(refSelf, "")

    /** `{{name ...}}` の中身 (外側の括弧なし)。入れ子の {{ }} を数えて終端を探す */
    // 例: template(記事全体, "競走馬") → "競走馬\n|名 = オグリキャップ\n|父 = ..." (外側の {{ }} を除いた中身)
    // 正規表現だけでは「対応する閉じ括弧」を見つけられない (テンプレートは入れ子になる) ため、
    // 開始位置から 1 文字ずつ進み、"{{" で深さ +1、"}}" で深さ -1 して、深さ 0 に戻った所を終端とする。
    // names を複数渡すと、見つかった最初のテンプレート名を使う (表記ゆれ対策)。
    fun template(text: String, vararg names: String): String? {
        for (name in names) {
            // (?=\||\n|\}\}) は「名前の直後が | か改行か }} であること」の先読み。
            // これがないと "競走馬" で "競走馬の血統" のような別テンプレートにも一致してしまう。
            val m = Regex("\\{\\{\\s*" + Regex.escape(name) + "\\s*(?=\\||\\n|\\}\\})").find(text) ?: continue
            var depth = 0
            var i = m.range.first
            while (i < text.length - 1) {
                when {
                    text.startsWith("{{", i) -> { depth++; i += 2 }
                    text.startsWith("}}", i) -> {
                        depth--; i += 2
                        if (depth == 0) return text.substring(m.range.first + 2, i - 2)
                    }
                    else -> i++
                }
            }
        }
        return null
    }

    /** 最上位の `|` で区切って key=value に */
    // テンプレートの中身を "|" で区切って key=value の Map にする。
    // ただし値の中の [[A|B]] や {{lang|en|X}} にも "|" があるので、単純な split("|") は使えない。
    // t = テンプレートの入れ子の深さ、l = リンクの入れ子の深さ。両方 0 の "|" だけを区切りとみなす。
    // parts[0] はテンプレート名 ("競走馬") なので drop(1) で捨てる。"=" のない引数 (位置引数) は無視。
    fun params(body: String): Map<String, String> {
        val parts = mutableListOf<String>()
        val sb = StringBuilder()
        var t = 0
        var l = 0
        var i = 0
        while (i < body.length) {
            when {
                body.startsWith("{{", i) -> { t++; sb.append("{{"); i += 2; continue }
                body.startsWith("}}", i) -> { t--; sb.append("}}"); i += 2; continue }
                body.startsWith("[[", i) -> { l++; sb.append("[["); i += 2; continue }
                body.startsWith("]]", i) -> { l--; sb.append("]]"); i += 2; continue }
                body[i] == '|' && t <= 0 && l <= 0 -> { parts += sb.toString(); sb.clear(); i++; continue }
            }
            sb.append(body[i]); i++
        }
        parts += sb.toString()
        return parts.drop(1).mapNotNull { p ->
            val k = p.indexOf('=')
            if (k <= 0) null else p.substring(0, k).trim() to p.substring(k + 1).trim()
        }.toMap()
    }

    /** 表示用のプレーンテキストに */
    // インフォボックスの値を画面に出せるプレーンテキストにする。順番に意味がある:
    //   1. 脚注を消し、<br> を " / " に (「地方：12戦10勝 / 中央：20戦12勝」のように区切りを残す)
    //   2. {{JPN}} (国旗テンプレート) → "日本"
    //   3. 中身を残したいテンプレート ({{lang}} {{GI}} {{Nowrap}}) を中身に置き換える
    //      → repeat するのは入れ子 ({{Nowrap|{{lang|..}}}}) を内側から順に剥がすため
    //   4. 残りのテンプレートは消す (内側から消えるので 4 回繰り返せば実用上十分)
    //   5. 画像リンクを消し、通常のリンクは表示名に、太字/斜体の ''' '' と HTML タグを消す
    //   6. 空白をまとめ、末尾に残った区切り " / " を落とす
    fun clean(v: String?): String {
        if (v.isNullOrBlank()) return ""
        var s = stripRefs(v).replace(br, " / ")
        s = s.replace(Regex("\\{\\{\\s*JPN\\s*\\}\\}"), "日本")
        s = s.replace(lang, "$1").replace(gradeTpl, "$1")
        repeat(3) { s = s.replace(oneArgTpl, "$1") }
        repeat(4) { s = s.replace(anyTpl, "") }
        s = s.replace(Regex("\\[\\[(?:ファイル|File|画像|Image):[^\\]]*\\]\\]", RegexOption.IGNORE_CASE), "")
        s = s.replace(link, "$1").replace("'''", "").replace("''", "").replace(html, "")
        s = s.replace("&nbsp;", " ").replace(Regex("[ \\t]+"), " ").replace(Regex("(\\s*/\\s*)+$"), "")
        return s.trim().trim('/').trim()
    }

    // インフォボックスの画像欄から Wikimedia Commons のファイル名を取り出す。
    // 欄には "[[ファイル:A.jpg|250px]]" と "A.jpg" の 2 通りの書き方があるので両方に対応。
    // 空白は "_" に揃える (Commons の URL とクレジット API のキーを一致させるため)。
    fun imageName(v: String?): String? {
        if (v.isNullOrBlank()) return null
        fileLink.find(v)?.let { return it.groupValues[1].trim().replace(' ', '_') }
        val plain = clean(v)
        return if (Regex("\\.(jpe?g|png|gif|svg|webp|tiff?)$", RegexOption.IGNORE_CASE).containsMatchIn(plain)) plain.replace(' ', '_') else null
    }

    // "1985年3月27日" のような文字列から 4 桁の年を取る。
    private fun year(s: String) = Regex("(\\d{4})年").find(s)?.groupValues?.get(1)?.toIntOrNull()

    /** "[[1985年]]" のほか "{{生年月日と馬齢|2019|3|23}}" のようなテンプレートにも対応 */
    private fun yearRaw(raw: String?): Int? = raw?.let {
        year(clean(it)) ?: Regex("\\|\\s*(1[6-9]\\d{2}|20\\d{2})\\s*\\|").find(it)?.groupValues?.get(1)?.toIntOrNull()
    }

    /** G1 / Jpn1 → GI / JpnI に揃える */
    fun normalizeGrade(g: String): String = g.replace(Regex("^(G|Jpn)([1-3])$")) { m -> m.groupValues[1] + "I".repeat(m.groupValues[2].toInt()) }

    /** 国内の競馬場 (現役 + 主な廃止場) */
    // 「開催国」欄が空の競走記事を国内と判定するための競馬場名リスト。
    // 海外の競走 (凱旋門賞など) も同じテンプレートを使うので、ここで国内だけに絞る。
    private val domesticCourses = Regex("^(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉|帯広|門別|盛岡|水沢|浦和|船橋|大井|川崎|金沢|笠松|名古屋|園田|姫路|高知|佐賀|旭川|岩見沢|北見|上山|足利|宇都宮|高崎|三条|紀三井寺|益田|福山|荒尾|中津|ホッカイドウ|宇都宮|春木|東京競馬場)")

    /** "9億1251万2000円" → 91251 (万円)。円以外の通貨は null */
    // 賞金の文字列を「万円」単位の数値にする (能力値の計算で使う)。
    //   "9億1251万2000円" → 億=9, 万=1251 → 9*10000 + 1251 = 91251
    //   "1億円"           → 10000
    //   "$4,562,000" や "4,562,000ドル" → 円ではないので null (通貨をまたいだ比較はしない)
    // m.value == "円" のチェックは、数字のない "円" だけに一致したケースを除外するため。
    fun manYen(s: String): Long? {
        val m = Regex("(?:(\\d+)億)?(?:(\\d+)万)?(?:\\d+)?円").find(s.replace(",", "")) ?: return null
        if (m.value == "円") return null
        val oku = m.groupValues[1].toLongOrNull() ?: 0
        val man = m.groupValues[2].toLongOrNull() ?: 0
        return oku * 10000 + man
    }

    // {{MedalGI|[[有馬記念]]|[[第33回有馬記念|1988年]]}} のような「主な勝ち鞍」テンプレート。
    // group1 = 格付け (GI / JpnII など)、group2 = 競走名の部分。
    // 競走名の部分は [[A|B]] の中の "|" で途切れないよう、リンクをひとかたまりとして読む:
    //   (?: \[\[ [^\]]* \]\]  … リンク 1 個まるごと
    //      | [^|}\[]       … それ以外の、区切りでない 1 文字 )*
    private val medal = Regex("\\{\\{\\s*Medal\\s*((?:G|Jpn)I{1,3})\\s*\\|\\s*((?:\\[\\[[^\\]]*\\]\\]|[^|}\\[])*)")

    // {{騎手}} インフォボックス → JockeyEntry。テンプレートがなければ null (騎手の記事ではない)。
    // 所属団体は「A<br />→B」のように変遷が書かれるので、地域 (中央/地方/海外) は最後の所属で決める。
    fun parseJockey(title: String, wikitext: String): JockeyEntry? {
        val body = template(stripRefs(wikitext), "騎手") ?: return null
        val p = params(body)
        fun g(vararg k: String) = k.firstNotNullOfOrNull { p[it]?.takeIf(String::isNotBlank) }
        val record = clean(g("通", "通算成績"))
        val rm = Regex("([\\d,]+)戦([\\d,]+)勝").find(record)
        fun firstInt(s: String) = Regex("([\\d,]+)勝").find(s)?.groupValues?.get(1)?.replace(",", "")?.toIntOrNull()
        val affiliation = clean(g("団", "所属団体"))
        val last = affiliation.split(" / ", "→").map { it.trim() }.lastOrNull { it.isNotBlank() } ?: ""
        val country = clean(g("国"))
        val region = when {
            Regex("日本中央競馬会|JRA|トレーニングセンター").containsMatchIn(last) -> "中央"
            Regex("競馬組合|地方|競馬協会|ばんえい|特別区|競馬事務所|県|市|町").containsMatchIn(last) -> "地方"
            last.isNotBlank() -> "海外"
            country == "日本" -> "不明"
            else -> "海外"
        }
        val retired = clean(g("引", "引退"))
        val death = yearRaw(g("死", "死没"))
        val debut = clean(g("初", "初騎乗"))
        return JockeyEntry(
            title = title,
            name = clean(g("名", "騎手名")).ifBlank { title.substringBefore(" (") },
            image = imageName(g("画", "画像")),
            imageCaption = clean(g("説", "画像説明")),
            country = country,
            birthplace = clean(g("出", "出身地")),
            birthYear = yearRaw(g("生", "生年月日")),
            deathYear = death,
            heightCm = Regex("(\\d+(?:\\.\\d+)?)\\s*(?:cm|センチ)").find(clean(g("身", "身長")))?.groupValues?.get(1)?.toDoubleOrNull(),
            affiliation = affiliation,
            stable = clean(g("厩", "所属厩舎")),
            debut = debut,
            debutYear = yearRaw(g("初", "初騎乗")),
            retired = retired,
            starts = rm?.groupValues?.get(1)?.replace(",", "")?.toIntOrNull(),
            wins = rm?.groupValues?.get(2)?.replace(",", "")?.toIntOrNull(),
            recordText = record,
            gradedWins = firstInt(clean(g("重", "重賞勝利"))),
            g1Wins = firstInt(clean(g("G1", "GI勝利"))),
            region = region,
            active = retired.isBlank() && death == null,
        )
    }

    // {{競走馬}} インフォボックス → HorseEntry。テンプレートがなければ null (競走馬の記事ではない)。
    // キーは記事によって短い名前 (名・父・績) と長い名前 (馬名・生涯成績) が混在するので、
    // g("績", "生涯成績", "競走成績") のように候補を並べて最初に値があったものを使う。
    fun parseHorse(title: String, wikitext: String): HorseEntry? {
        val body = template(stripRefs(wikitext), "競走馬") ?: return null
        val p = params(body)
        fun g(vararg k: String) = k.firstNotNullOfOrNull { p[it]?.takeIf(String::isNotBlank) }
        val record = clean(g("績", "生涯成績", "競走成績"))
        // "32戦22勝 / 地方：12戦10勝 / ..." の最初の "N戦M勝" を通算成績とみなす。
        val rm = Regex("(\\d+)戦(\\d+)勝").find(record)
        val earnings = clean(g("金", "獲得賞金"))
        // 勝ち鞍は "medaltemplates" 引数にまとまっていることが多いが、ない記事もあるので本文全体も探す。
        // distinct() は同じ競走を複数回勝った馬 (有馬記念 2 勝など) の重複を 1 件にするため。
        val wins = medal.findAll(p["medaltemplates"] ?: body).map {
            BigWin(it.groupValues[1], clean(it.groupValues[2]))
        }.filter { it.race.isNotBlank() }.distinct().toList()
        val name = clean(g("名", "馬名")).ifBlank { title.substringBefore(" (") }
        return HorseEntry(
            title = title,
            name = name,
            nameEn = clean(g("英", "欧字表記")),
            image = imageName(g("画", "画像")),
            imageCaption = clean(g("説", "画像説明")),
            sex = clean(g("性", "性別")),
            color = clean(g("色", "毛色")),
            breed = clean(g("種", "品種")),
            birthYear = yearRaw(g("生", "生誕")),
            deathYear = yearRaw(g("死", "死没")),
            sire = clean(g("父")),
            dam = clean(g("母")),
            damSire = clean(g("母父")),
            breeder = clean(g("産", "生産")),
            country = clean(g("国", "生国")),
            // 馬主・調教師は "A / →B" のように変遷が書かれるので、最初の 1 人だけを残す。
            owner = clean(g("主", "馬主")).substringBefore(" / ").substringBefore("→").trim(),
            trainer = clean(g("調", "調教師")).substringBefore(" / ").substringBefore("→").trim(),
            starts = rm?.groupValues?.get(1)?.toIntOrNull(),
            wins = rm?.groupValues?.get(2)?.toIntOrNull(),
            recordText = record,
            earningsText = earnings,
            earningsManYen = manYen(earnings.substringBefore(" / ")),
            honors = clean(g("冠", "受賞")),
            bigWins = wins
        )
    }

    // {{競馬の競走}} インフォボックス → RaceEntry。海外の競走は null を返して除外する。
    fun parseRace(title: String, wikitext: String): RaceEntry? {
        val body = template(stripRefs(wikitext), "競馬の競走") ?: return null
        val p = params(body)
        fun g(vararg k: String) = k.firstNotNullOfOrNull { p[it]?.takeIf(String::isNotBlank) }
        val country = clean(g("開催国"))
        val course = clean(g("競馬場")).substringBefore(" / ")
        // 国内判定: 開催国に「日本」とあるか、開催国が空で競馬場名が国内のものなら国内。
        val domestic = country.contains("日本") || (country.isBlank() && domesticCourses.containsMatchIn(course))
        if (!domestic) return null
        // "東京大賞典<br>Tokyo Daishoten" は clean() で "東京大賞典 / Tokyo Daishoten" になるので、
        // " / " の前を日本語名、後ろを英語名として使う。
        val nameRaw = clean(g("競走名")).split(" / ")
        return RaceEntry(
            title = title,
            name = nameRaw.firstOrNull()?.ifBlank { null } ?: title.substringBefore(" ("),
            nameEn = nameRaw.getOrNull(1) ?: "",
            course = course,
            surface = clean(g("馬場")),
            // "2000[[メートル|m]]" → clean() 後 "2000m" → 3〜5 桁の数字を距離 (m) とする。
            distance = Regex("(\\d{3,5})").find(clean(g("距離")).replace(",", ""))?.value?.toIntOrNull(),
            grade = normalizeGrade(clean(g("格付け")).substringBefore(" / ").trim()),
            prize = clean(g("1着賞金")).substringBefore(" / "),
            founded = clean(g("創設")),
            season = clean(g("施行時期", "開催時期")),
            organizer = clean(g("主催者")),
            condition = clean(g("条件")),
            image = imageName(g("画像"))
        )
    }
}
