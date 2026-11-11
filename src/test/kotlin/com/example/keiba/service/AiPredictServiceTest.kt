package com.example.keiba.service

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class AiPredictServiceTest {
    @Test
    fun extractsLastJsonCodeBlock() {
        val text = """
            調べました。まず下書き:
            ```json
            {"predictions": []}
            ```
            最終回答:
            ```json
            {"predictions": [{"number": 7, "horse": "ドウデュース", "win_prob": 30}], "confidence": "高"}
            ```
        """.trimIndent()
        val obj = assertNotNull(AiPredictService.extractJson(text))
        assertEquals("高", obj["confidence"]?.jsonPrimitive?.content)
        assertEquals("ドウデュース", obj["predictions"]!!.jsonArray[0].jsonObject["horse"]!!.jsonPrimitive.content)
    }

    @Test
    fun extractsBareJsonWithoutCodeFence() {
        val obj = assertNotNull(AiPredictService.extractJson("""結果は {"pace": "スロー", "predictions": []} です"""))
        assertEquals("スロー", obj["pace"]?.jsonPrimitive?.content)
    }

    @Test
    fun returnsNullWhenThereIsNoJson() {
        assertNull(AiPredictService.extractJson("すみません、出走馬が分かりませんでした。"))
        assertNull(AiPredictService.extractJson("{ 壊れた JSON"))
    }

    // 名鑑との照合は同梱データ (Wikipedia の競走馬) を使う。LibraryService は作るだけなら通信しない
    private val service by lazy { AiPredictService(LibraryService(), WeatherService()) }

    @Test
    fun lookupSkipsSiresDamsAndRaceNames() {
        val text = """
            1枠1番 ドウデュース ・ 牡5 ・ 父 ハーツクライ / 母 ダストアンドダイヤモンズ / 母父 Vindication
              近走: 2024-09-15 中山 セントライト記念(GII) 芝2200m 1着/15頭
            2枠2番 イクイノックス ・ 牡4 ・ 父 キタサンブラック / 母 シャトーブランシュ
        """.trimIndent()
        val names = service.lookup(text).map { it.name }
        assertEquals(listOf("ドウデュース", "イクイノックス"), names)
    }

    @Test
    fun lookupIgnoresNamesInsideLongerNames() {
        // 「キングヘイロー」の中の「ヘイロー」は出走馬ではない。空白で区切られた名前は別の馬として数える
        val text = "1 スターズオンアース 母父 キングヘイロー\n2 ドウデュース イクイノックス"
        assertEquals(listOf("スターズオンアース", "ドウデュース", "イクイノックス"), service.lookup(text).map { it.name })
    }

    @Test
    fun lookupWithRunnerNamesUsesExactNamesOnly() {
        val names = service.lookup("父 ディープインパクト ほか", listOf("イクイノックス", "名鑑にいない馬")).map { it.name }
        assertEquals(listOf("イクイノックス"), names)
    }

    @Test
    fun normalizesWidthAndSpaces() {
        assertEquals(AiPredictService.norm("ドウデュース"), AiPredictService.norm(" ﾄﾞｳﾃﾞｭｰｽ "))
        assertEquals(AiPredictService.norm("Ｃ．デムーロ"), AiPredictService.norm("C.デムーロ"))
    }
}
