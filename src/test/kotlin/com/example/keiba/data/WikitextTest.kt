package com.example.keiba.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class WikitextTest {
    private val oguri = """
        {{馬齢旧}}
        {{競走馬
        |名 = オグリキャップ
        |英 = {{lang|en|Oguri Cap}}<ref name="jbis" />
        |画 = [[ファイル:Oguri Cap in Yushun Stallion station.jpg|250px]]
        |性 = [[牡馬|牡]]<ref name="jbis" />
        |色 = [[芦毛]]
        |生 = [[1985年]][[3月27日]]
        |死 = {{死亡年月日と没馬齢|p=0|1985|03|27|2010|7|3}}
        |父 = [[ダンシングキャップ]]
        |母父 = [[シルバーシャーク (競走馬)|シルバーシャーク]]
        |調 = [[鷲見昌勇]]（[[笠松競馬場|笠松]]）<br />→[[瀬戸口勉]]（[[栗東トレーニングセンター|栗東]]）
        |績 = 32戦22勝<ref name="jbis" /><br />[[地方競馬|地方]]：12戦10勝
        |金 = 9億1251万2000円<ref name="jbis" /><br />地方：2281万円
        |medaltemplates =
        {{MedalGI|[[有馬記念]]|[[第33回有馬記念|1988年]]}}
        {{MedalGI|[[マイルチャンピオンシップ|マイルCS]]|1989年}}
        }}
        '''オグリキャップ'''は…
    """.trimIndent()

    @Test fun parsesHorseInfobox() {
        val h = Wikitext.parseHorse("オグリキャップ", oguri)!!
        assertEquals("オグリキャップ", h.name)
        assertEquals("Oguri Cap", h.nameEn)
        assertEquals("Oguri_Cap_in_Yushun_Stallion_station.jpg", h.image)
        assertEquals("牡", h.sex)
        assertEquals("芦毛", h.color)
        assertEquals(1985, h.birthYear)
        assertEquals("シルバーシャーク", h.damSire)
        assertEquals("鷲見昌勇（笠松）", h.trainer)
        assertEquals(32, h.starts)
        assertEquals(22, h.wins)
        assertEquals(91251L, h.earningsManYen)
        assertEquals(listOf("有馬記念", "マイルCS"), h.bigWins.map { it.race })
    }

    @Test fun parsesRaceAndSkipsForeign() {
        val r = Wikitext.parseRace("東京大賞典", """
            {{競馬の競走
            |馬場 = ダート
            |競走名 = 東京大賞典<br>Tokyo Daishoten<ref name="ICSC"/>
            |開催国 = {{Flagicon|JPN}}[[日本の競馬|日本]]
            |競馬場 = [[大井競馬場]]
            |距離 = 2000[[メートル|m]]
            |格付け = {{GI}}
            |1着賞金 = 1億円
            }}""".trimIndent())!!
        assertEquals("東京大賞典", r.name)
        assertEquals("Tokyo Daishoten", r.nameEn)
        assertEquals("大井競馬場", r.course)
        assertEquals(2000, r.distance)
        assertEquals("GI", r.grade)
        assertNull(Wikitext.parseRace("凱旋門賞", "{{競馬の競走\n|開催国 = フランス\n|競馬場 = ロンシャン競馬場\n}}"))
    }

    @Test fun birthYearFromTemplateAndGradeNormalized() {
        val h = Wikitext.parseHorse("X", "{{競走馬\n|名 = X\n|生 = {{生年月日と馬齢|2019|3|23}}\n}}")!!
        assertEquals(2019, h.birthYear)
        assertEquals("GI", Wikitext.normalizeGrade("G1"))
        assertEquals("JpnIII", Wikitext.normalizeGrade("Jpn3"))
    }

    // 騎手: 実際の記事と同じ形 (現役・中央) と (引退・地方 → 中央)
    @Test fun parsesActiveJockey() {
        val j = Wikitext.parseJockey("武豊", """
            {{騎手
            |画 =[[画像:Yutaka Take 2024.10.20.jpg|250px]]
            |名 = 武豊
            |国 = {{JPN}}
            |出 = [[滋賀県]][[栗太郡]]栗東町
            |生 = {{生年月日と年齢|1969|3|15}}
            |身 = 170 [[センチメートル|cm]]<ref name = "a"/>
            |団 = JRA・[[栗東トレーニングセンター]]<ref name = "a"/>
            |初 = 1987年3月1日
            |引 =
            |重 = 522勝（中央372勝、地方124勝、海外26勝）
            |G1 = 129勝（中央87勝、地方33勝、海外9勝）
            |通 = 25794戦4669勝（中央）<br>949戦212勝（地方）
            }}
        """.trimIndent())!!
        assertEquals("武豊", j.name)
        assertEquals("Yutaka_Take_2024.10.20.jpg", j.image)
        assertEquals(1969, j.birthYear)
        assertEquals(170.0, j.heightCm)
        assertEquals(1987, j.debutYear)
        assertEquals(25794, j.starts)
        assertEquals(4669, j.wins)
        assertEquals(522, j.gradedWins)
        assertEquals(129, j.g1Wins)
        assertEquals("中央", j.region)
        assertEquals(true, j.active)
    }

    @Test fun parsesRetiredJockeyFromLastAffiliation() {
        val j = Wikitext.parseJockey("安藤勝己", """
            {{騎手
            |名 = 安藤 勝己
            |生 = {{生年月日と年齢|1960|3|28}}
            |団 = [[岐阜県地方競馬組合]]<br />[[日本中央競馬会]]
            |引 = 2013年1月31日
            |通 = 20852戦4464勝
            }}
        """.trimIndent())!!
        assertEquals("中央", j.region, "最後の所属で決める")
        assertEquals(false, j.active)
        assertEquals(4464, j.wins)
        assertNull(Wikitext.parseJockey("馬", "{{競走馬\n|名 = A\n}}"), "騎手の記事でなければ null")
    }

    @Test fun parsesYenOnly() {
        assertEquals(10000L, Wikitext.manYen("1億円"))
        assertNull(Wikitext.manYen("$1,000,000"))
    }
}
