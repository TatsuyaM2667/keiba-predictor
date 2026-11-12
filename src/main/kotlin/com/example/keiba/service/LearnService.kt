package com.example.keiba.service

import kotlinx.html.*
import kotlinx.html.stream.createHTML
import kotlinx.serialization.Serializable

// ==================================================================================
// LearnService — 「はじめての競馬」(チュートリアル) の中身
// ==================================================================================
// 9 章の本文・図・確認クイズを、kotlinx.html (Kotlin で HTML を組み立てる仕組み) で作る。
// 画面 (learn.js) は、ここで作った HTML を表示し、クイズの正解判定と読み終えた章の記録だけを行う。
// 文章を直すときは、この 1 ファイルだけを見ればよい。

@Serializable data class QuizItem(val q: String, val options: List<String>, val answer: Int, val why: String)
@Serializable data class Chapter(val id: String, val title: String, val html: String, val quiz: List<QuizItem>)

object LearnService {
    /** アイコン (static/icons/sprite.svg) を出す HTML。画面の util.js の icon() と同じ形 */
    private fun icon(name: String, cls: String = "") = """<svg class="$cls" aria-hidden="true"><use href="/static/icons/sprite.svg#i-$name"/></svg>"""

    /** 枠の色の馬番 (画面の util.js の wakuBadge() と同じ形) */
    private fun wakuBadge(num: Int, waku: Int) = """<span class="waku num" style="--c:var(--w$waku);--t:var(--w${waku}t)">$num</span>"""

    private fun FlowContent.note(iconName: String, text: String) = p("note") {
        unsafe { +icon(iconName) }
        span { +text }
    }

    /** 「<b>見出し</b> — 説明」の形の箇条書き */
    private fun UL.term(head: String, text: String) = li { b { +head }; +" — $text" }

    // ---------------- 図 ----------------

    /** 出馬表の 1 行に、各欄の番号を付けたもの */
    private fun FlowContent.cardFigure() = figure("lfig") {
        div("lcard-row") {
            val cells = listOf(
                wakuBadge(5, 3),
                "<b>サンプルホース</b><small>父 サンプル × 母の父 テスト</small>",
                "牡4", "57.0kg", "騎手 A", "486kg (+4)",
                "<b>3.5</b><small>1番人気</small>",
            )
            cells.forEachIndexed { i, c -> span("c") { attributes["data-n"] = "${i + 1}"; unsafe { +c } } }
        }
        ol("lcard-legend") {
            listOf(
                "枠番と馬番" to "色が枠 (1〜8)、数字が馬番 (1〜18)。内側 (小さい数字) ほどコースの内を走りやすい",
                "馬名と血統" to "父と母の父。距離や馬場の向き不向きのヒントになる",
                "性齢" to "牡 (オス)・牝 (メス)・セ (去勢したオス) と年齢",
                "斤量" to "騎手と鞍などを合わせた、馬が背負う重さ",
                "騎手" to "乗り替わり (前走と違う騎手) も予想の材料",
                "馬体重" to "当日の体重と前走からの増減。大きく増減していると調子を疑う人が多い",
                "単勝オッズと人気" to "当たったら賭け金の何倍が戻るか。低いほど多くの人が買っている",
            ).forEach { (h, t) -> li { b { +h }; +" — $t" } }
        }
        figcaption { +"出馬表 (しゅつばひょう) の 1 行。レース予想の画面の表も同じ並びです" }
    }

    /** 脚質ごとの位置取り (左が先頭) */
    private fun FlowContent.styleFigure() = figure("lfig") {
        data class G(val name: String, val x: Int, val n: Int, val note: String)
        val groups = listOf(G("逃げ", 70, 1, "先頭を走る"), G("先行", 190, 3, "前のほう"), G("差し", 330, 4, "中団から"), G("追込", 470, 2, "最後方から"))
        val dots = groups.flatMap { g -> (0 until g.n).map { k -> """<circle cx="${g.x + (k % 2) * 22 - (if (g.n > 1) 11 else 0)}" cy="${62 + (k % 3) * 16}" r="7" class="horse-dot"/>""" } }
        val labels = groups.joinToString("") { g ->
            """<text x="${g.x}" y="130" text-anchor="middle" class="t-label">${g.name}</text><text x="${g.x}" y="145" text-anchor="middle" class="t-small">${g.note}</text>"""
        }
        unsafe {
            +"""<svg viewBox="0 0 580 150" role="img" aria-label="脚質ごとの位置取り。左が先頭で、逃げ・先行・差し・追込の順に後ろになる">
              <rect x="10" y="44" width="560" height="64" rx="10" class="track"/>
              <line x1="20" x2="20" y1="40" y2="112" class="goal"/><text x="24" y="34" class="t-small">← 進む向き (ゴールはこちら)</text>
              ${dots.joinToString("")}$labels</svg>"""
        }
        figcaption { +"脚質 (きゃくしつ) = レースでの位置取りのくせ。先頭がハイペースで飛ばすと、前の馬が最後に疲れて、後ろの差し・追込が届きやすくなります" }
    }

    /** 馬券の種類ごとに、1〜3 着のどこを当てるか */
    private fun FlowContent.betFigure() = figure("lfig") {
        // picks: 対象の着順。3 は「3 着以内ならどこでも」の意味
        data class Bet(val name: String, val what: String, val picks: List<Int>, val ordered: Boolean, val takeout: String)
        val bets = listOf(
            Bet("単勝", "1着の馬", listOf(1), false, "20%"),
            Bet("複勝", "3着までに入る馬 (1頭)", listOf(3), false, "20%"),
            Bet("枠連", "1着・2着の枠の組み合わせ", listOf(1, 2), false, "22.5%"),
            Bet("馬連", "1着・2着の2頭 (順不同)", listOf(1, 2), false, "22.5%"),
            Bet("ワイド", "3着までに入る2頭 (順不同)", listOf(3, 3), false, "22.5%"),
            Bet("馬単", "1着・2着を着順どおり", listOf(1, 2), true, "25%"),
            Bet("3連複", "1〜3着の3頭 (順不同)", listOf(1, 2, 3), false, "25%"),
            Bet("3連単", "1〜3着を着順どおり", listOf(1, 2, 3), true, "27.5%"),
        )
        table("table bet-table") {
            thead { tr { listOf("馬券", "当てるもの", "対象の着順", "控除率").forEach { th { +it } } } }
            tbody {
                bets.forEach { bet ->
                    tr {
                        td { b { +bet.name } }
                        td { +bet.what }
                        td("slots") {
                            (1..3).forEach { k -> span(if (bet.picks[0] == 3 || k in bet.picks) "slot on" else "slot") { +"${k}着" } }
                            if (bet.ordered) small { +"順番も" }
                        }
                        td("num") { +bet.takeout }
                    }
                }
            }
        }
        figcaption { +"下に行くほど当てにくく、そのぶん配当が大きくなります。控除率は売上のうち払い戻しに回らない割合 (JRA)" }
    }

    /** 売上 → 控除 → 払戻 の流れ */
    private fun FlowContent.poolFigure() = figure("lfig") {
        div("pool") {
            div("pool-bar") {
                span("keep") { style = "width:20%"; +"控除 20%"; small { +"運営・賞金・国庫など" } }
                span("back") { style = "width:80%"; +"払い戻し 80%"; small { +"当たった人で分ける" } }
            }
            p("pool-eq num") {
                +"例: 単勝の売上 1 億円、ある馬の単勝が 2,000 万円売れていて、その馬が勝った場合"
                br()
                +"払戻 = 1 億円 × 0.8 ÷ 2,000 万円 = "
                b { +"4.0 倍" }
                +" (100 円が 400 円に)"
            }
        }
        figcaption { +"オッズは「みんながどの馬に賭けたか」で決まる (パリミュチュエル方式)。締め切りまで変わり続けます" }
    }

    // ---------------- 章 ----------------

    private fun chapter(id: String, title: String, quiz: List<QuizItem>, body: DIV.() -> Unit) =
        Chapter(id, title, createHTML(prettyPrint = false).div { body() }, quiz)

    private fun quiz(q: String, options: List<String>, answer: Int, why: String) = QuizItem(q, options, answer, why)

    val chapters: List<Chapter> by lazy {
        listOf(
            chapter("basics", "競馬ってなに?", listOf(quiz("中央競馬 (JRA) の競馬場はいくつ?", listOf("10 か所", "25 か所", "47 か所"), 0,
                "札幌から小倉まで 10 か所です。地方競馬を合わせると、このアプリの「競馬場」画面の 25 か所になります。"))) {
                p { +"競馬は、十数頭の馬が決められた距離を走り、着順を競うスポーツです。日本の競馬には大きく 2 つあります。" }
                ul {
                    term("中央競馬 (JRA)", "札幌・函館・福島・新潟・東京・中山・中京・京都・阪神・小倉の 10 か所。主に土曜・日曜に開催し、1 日に 1 か所で 12 レース行います")
                    term("地方競馬 (NAR)", "大井・船橋・園田など、各地の自治体が開催。平日の開催も多く、ナイター (夜のレース) もあります")
                }
                p {
                    +"1 つのレースの流れは、"
                    listOf("出走馬の発表 (出馬表)", "パドック (下見所) で馬の様子を見せる", "本馬場入場", "ゲートからスタート", "ゴール", "着順と払戻金の確定")
                        .forEachIndexed { i, s -> if (i > 0) +" → "; b { +s } }
                    +" です。馬券 (勝馬投票券) は発走の少し前まで買えます。"
                }
                note("info", "このアプリのレース予想は、中央競馬 (JRA) の今週のレースを自動で表示します。")
            },
            chapter("class", "レースの格とクラス", listOf(quiz("一番格が高いのはどれ?", listOf("GIII", "GI", "リステッド (L)"), 1, "GI > GII > GIII > リステッド > 一般のオープン の順です。"))) {
                p { +"馬は勝つたびに上のクラスへ上がります。強さが近い馬どうしで走らせるための仕組みです。" }
                div("ladder") {
                    listOf("新馬", "未勝利", "1勝クラス", "2勝クラス", "3勝クラス", "オープン (リステッド L)", "GIII", "GII", "GI").forEachIndexed { i, c ->
                        if (i > 0) unsafe { +icon("chevron-right") }
                        span { style = "--i:$i"; +c }
                    }
                }
                ul {
                    li { b { +"新馬戦" }; +" — まだ 1 度もレースに出ていない馬だけのレース。"; b { +"未勝利戦" }; +" はまだ勝っていない馬のレース" }
                    li { b { +"重賞 (じゅうしょう)" }; +" — GI・GII・GIII の格付けがあるレース。"; b { +"GI" }; +" が最高格で、日本ダービー・有馬記念・ジャパンカップなどがあります" }
                    term("三冠", "3 歳の馬が 1 年に 1 度しか出られない 3 つの GI。皐月賞・日本ダービー・菊花賞 (牝馬は桜花賞・オークス・秋華賞)")
                }
                h4 { +"斤量 (きんりょう) の決め方" }
                ul {
                    term("馬齢・定量", "年齢と性別だけで決まる (例: 牝馬は 2kg 軽い)")
                    term("別定", "これまでに勝ったレースや賞金で重くなる")
                    term("ハンデ", "強い馬ほど重くして、どの馬にも勝つチャンスがあるようにする")
                }
            },
            chapter("course", "コースと馬場", listOf(quiz("馬場状態で一番水を含んで重いのは?", listOf("稍重", "良", "不良"), 2, "良 → 稍重 → 重 → 不良 の順に重くなります。"))) {
                ul {
                    term("芝とダート", "芝は草の上、ダートは砂の上を走ります。得意な馬場は馬によって違い、血統にも表れます。障害レースは、柵や水たまりを跳び越えます")
                    term("右回り・左回り", "東京・中京・新潟は左回り、ほかの多くは右回りです")
                    term("距離", "おおよそ 1,400m までが短距離、1,600m 前後がマイル、2,400m くらいまでが中距離、それより長いと長距離です")
                    li { b { +"馬場状態" }; +" — 雨などで "; b { +"良 → 稍重 (ややおも) → 重 → 不良" }; +" と重くなります。重い馬場が得意な馬もいます" }
                    term("枠", "内側の枠は走る距離が短くて有利なことが多いですが、コースや馬場によって変わります")
                }
                note("info", "ホーム画面では、天気と降水量から推定した各競馬場の馬場状態を見られます (公式発表ではありません)。")
            },
            chapter("card", "出馬表の読み方", listOf(quiz("単勝オッズ 3.5 倍の馬に 1,000 円賭けて勝ったら、いくら戻る?", listOf("1,350 円", "3,500 円", "4,500 円"), 1,
                "戻る額 = 賭け金 × オッズ = 1,000 × 3.5 = 3,500 円です (賭け金を含む)。"))) {
                p { +"出馬表は、そのレースに出る馬の一覧です。予想に必要な情報はほとんどここにあります。" }
                cardFigure()
                p { +"枠の色は 1 白・2 黒・3 赤・4 青・5 黄・6 緑・7 橙・8 桃 と決まっていて、騎手の帽子の色と同じです。過去のレースの成績 (近走) も出馬表に載っていて、このアプリの予想はそこから計算しています。" }
            },
            chapter("style", "脚質と展開", listOf(quiz("逃げ馬が 3 頭いるレース。有利になりやすいのは?", listOf("逃げ・先行", "差し・追込"), 1,
                "先頭争いでペースが速くなり、前の馬が疲れるので、後ろで力をためた差し・追込が届きやすくなります。"))) {
                styleFigure()
                ul {
                    term("逃げ", "スタートから先頭に立つ。自分のペースで走れれば強い")
                    term("先行", "先頭のすぐ後ろ。安定して上位に来やすい")
                    term("差し", "中団で力をためて、最後の直線で前の馬を抜く")
                    term("追込", "最後方から一気に追い込む。展開がはまると大きく勝つ")
                }
                p {
                    +"逃げ・先行の馬が多いと先頭争いが激しくなって "; b { +"ハイペース" }
                    +" になり、前の馬が最後にバテやすくなります。逆に少ないと "; b { +"スローペース" }
                    +" になり、前の馬がそのまま残りやすくなります。この「展開」を読むのが予想の面白いところです。"
                }
            },
            chapter("bets", "馬券の種類", listOf(
                quiz("1着と2着を「順番どおり」に当てる馬券は?", listOf("馬連", "馬単", "ワイド"), 1, "馬単は順番どおり、馬連は順番を問いません。ワイドは 3 着以内の 2 頭です。"),
                quiz("3連複を 4 頭ボックスで買うと何点?", listOf("4 点", "12 点", "24 点"), 0, "4 頭から 3 頭を選ぶ組み合わせは 4C3 = 4 通りです (3連単なら並べ方も数えるので 24 点)。"),
            )) {
                p { +"馬券は 100 円から、1 点ごとに買います。当てるものが多いほど難しく、配当は大きくなります。" }
                betFigure()
                ul {
                    li { +"複勝は、出走が 7 頭以下のレースでは 2 着までが対象です。枠連は 8 頭以下のレースでは発売されません" }
                    term("流し", "1 頭 (軸) を決めて、相手を何頭か選ぶ買い方。例: 馬連 5 → 1・3・8 は 3 点")
                    term("ボックス", "選んだ馬のすべての組み合わせを買う。例: 3連複 4 頭ボックスは 4 点")
                    term("フォーメーション", "1 着・2 着・3 着の候補をそれぞれ選んで組み合わせる")
                    li { +"このほか、指定された 5 レースの勝ち馬をすべて当てる "; b { +"WIN5" }; +" があります" }
                }
                note("ticket", "3D シミュレーションの「予想ゲーム」で、仮想のお金で全種類の馬券を試せます。")
            },
            chapter("odds", "オッズと払戻のしくみ", listOf(quiz("勝つ確率 20% と考える馬の単勝が 6.0 倍。期待値は?", listOf("1.2 (得)", "0.8 (損)", "6.0"), 0,
                "0.2 × 6.0 = 1.2 で、1 を超えるので予想上は得です。ただし確率の見積もりが正しい場合に限ります。"))) {
                poolFigure()
                ul {
                    li { +"オッズが低い = 多くの人が買っている = 勝つと思われている (人気)" }
                    li { +"払戻は 100 円あたり 10 円単位で、端数は切り捨てです。当たっても 100 円を下回ることはありません (元返し)" }
                    li { +"控除率があるので、全部の馬を買うと必ず損をします。"; b { +"単勝オッズの逆数を全部足すと 1 より大きくなる" }; +" のはそのためです" }
                }
                h4 { +"期待値" }
                p { +"「勝つ確率 × オッズ」が 1 を超える馬券は、長い目で見て得になる計算です。例えば勝つ確率が 30% だと思う馬の単勝が 4.0 倍なら、0.3 × 4.0 = 1.2 で得、3.0 倍なら 0.9 で損です。このアプリの「買い目」は、この考え方で選んでいます。" }
            },
            chapter("predict", "予想の考え方とアプリの使い方", listOf(quiz("強いと思う馬の単勝が 1.5 倍。予想勝率は 50%。買う?", listOf("買う (強いから)", "買わない (期待値 0.75)"), 1,
                "0.5 × 1.5 = 0.75 で 1 を下回ります。強い馬でも、人気しすぎていると長い目で見て損になります。"))) {
                p { +"予想でよく見るポイントと、このアプリでの見方です。" }
                ul {
                    term("近走の成績", "最近のレースで何着だったか、どの格のレースか → 出馬表の「指数」と、予想の見解の 1 行目")
                    term("距離と馬場の経験", "今回と同じ条件で走ったことがあるか")
                    term("展開", "逃げ・先行の数からペースを読み、有利な脚質を考える")
                    term("オッズとの比較", "強い馬でも人気しすぎていたら買わない。予想勝率と市場の確率を比べる")
                }
                div("tour") {
                    listOf(
                        Triple("#/races", "flag", "レース予想" to "今週の JRA のレース。印・見解・買い方の比較"),
                        Triple("#/results", "chart-line", "予想の成績" to "過去のレースで、どれだけ当たったか"),
                        Triple("#/sim", "rotate-3d", "3D シミュレーション" to "予想ゲームで、馬券を買ってレースを見る"),
                        Triple("#/tools", "calculator", "払戻計算" to "買い目の点数と払戻を計算"),
                    ).forEach { (href, ic, t) -> a(href, classes = "card") { unsafe { +icon(ic) }; b { +t.first }; span { +t.second } } }
                }
                p("fine") {
                    +"予想の数学をもっと詳しく知りたい人は、"
                    a("https://keiba-vision-docs.pages.dev/learn/live", target = "_blank") { rel = "noopener"; +"ドキュメント" }
                    +" を読んでください。"
                }
            },
            chapter("safe", "楽しむときの約束", listOf(quiz("馬券を買えるのは何歳から?", listOf("18 歳", "20 歳"), 1, "競馬法で、20 歳未満は馬券を買うことができません。"))) {
                ul {
                    li { +"馬券は "; b { +"20 歳以上" }; +" でないと買えません (法律で決まっています)" }
                    li { +"使うお金は、なくなっても困らない範囲であらかじめ決めておきましょう。負けを取り返そうとして賭け金を増やすのは危険です" }
                    li { +"控除率があるので、平均すると賭けたお金より戻るお金のほうが少なくなります。このアプリの予想も、当たりを約束するものではありません" }
                    li { +"のめり込みが心配なときは、JRA や各自治体の相談窓口に相談できます" }
                }
                p { +"予想ゲームやシミュレーションなら、お金を使わずに予想を楽しめます。" }
            },
        )
    }
}
