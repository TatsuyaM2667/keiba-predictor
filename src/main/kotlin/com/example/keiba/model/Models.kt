package com.example.keiba.model

import kotlinx.serialization.Serializable

@Serializable
// ==================================================================================
// Models.kt — サーバーと画面の間でやりとりするデータの形
// ==================================================================================
// @Serializable を付けたクラスは、そのまま JSON に変換して画面に返せる。
// enum はブラウザ側では "TURF" "FIRM" のような文字列として届く。
enum class CourseType {
    TURF, // 芝
    DIRT  // ダート
}

@Serializable
enum class TrackCondition {
    FIRM,     // 良
    GOOD,     // 稍重
    YIELDING, // 重
    SOFT      // 不良
}

@Serializable
enum class RunningStyle {
    NIGE,    // 逃げ
    SENKO,   // 先行
    SASHI,   // 差し
    OIKOMI   // 追込
}

@Serializable
// レース予想 (サンプル出馬表) の 1 頭分。名鑑の馬は model/Library.kt の HorseEntry。
data class Horse(
    val horseNumber: Int,
    val postPosition: Int, // 枠番 (1-8)
    val name: String,
    val sexAge: String,    // 牡4, 牝5, セン6 etc.
    val weightCarry: Double, // 斤量 (58.0kg etc.)
    val jockey: String,
    val trainer: String,
    val odds: Double,
    val popularity: Int,
    val recentRank: Int,
    val speedIndex: Double, // スピード指数 (60.0 - 120.0)
    val runningStyle: RunningStyle,
    val sire: String,       // 父
    val damSire: String,    // 母父
    val horseWeight: Int,   // 馬体重 (kg)
    val weightDiff: Int,    // 体重増減 (+2, -4 etc.)
    val jockeyWinRate: Double, // 騎手勝率 (0.0 - 1.0)
    val trainingScore: String  // 調教評価 (S, A+, A, B, C)
)

@Serializable
data class WeatherInfo(
    val location: String,
    val temperatureC: Double,
    val weatherDescription: String,
    val weatherIcon: String,
    val windSpeedKmh: Double,
    val precipitationMm: Double,
    val trackConditionEstimate: TrackCondition,
    val isLive: Boolean = false
)

@Serializable
data class PredictionScore(
    val horseNumber: Int,
    val horseName: String,
    val mark: String,          // ◎, ◯, ▲, △, ☆
    val totalScore: Double,     // 評価 (0〜100)。モデルの意見 (重みは手で決めた値)
    val speedScore: Double,     // 能力 (スピード指数を 0〜100 に)
    val paceAdvantage: Double,  // 展開との相性
    val pedigreeScore: Double,  // 血統 (名鑑の産駒成績から)
    val jockeyScore: Double,    // 騎手 (勝率から)
    val formScore: Double,      // 近走 (前走の着順から)
    val winProbability: Double, // 勝率 (%)。全頭の合計は 100
    val placeProbability: Double, // 3 着以内に入る確率 (%)。全頭の合計は 300
    val expectedValueScore: Double, // 100 円買ったときに戻る額の期待値 (円)。100 を超えれば得
    val comments: String        // 短評
)

@Serializable
data class BetRecommendation(
    val betType: String,      // 単勝, 複勝, 馬連, ワイド, 3連複, 3連単
    val combination: String,  // 例: "9", "9 - 5", "9 - 5 - 1"
    val oddsEstimate: Double,
    val confidence: String,   // S, A, B, C
    val allocationPercent: Int, // 資金配分 (%)
    val reason: String
)

@Serializable
data class Race(
    val id: String,
    val name: String,
    val subtitle: String,
    val raceNumber: Int,
    val racecourse: String,     // 東京, 中山, 京都, 阪神 etc.
    val courseType: CourseType,
    val distanceMeters: Int,
    val turnDirection: String,  // 右, 左, 直線
    val condition: TrackCondition,
    val grade: String,          // G1, G2, G3, OP
    val postTime: String,       // 15:40 etc.
    val prizeFirstYen: Long,    // 1着賞金
    val horses: List<Horse>,
    val weather: WeatherInfo? = null
)

@Serializable
data class RaceAnalysis(
    val race: Race,
    val predictions: List<PredictionScore>,
    val betRecommendations: List<BetRecommendation>,
    val paceForecast: String,   // ハイペース, ミドルペース, スローペース
    val paceComment: String
)

@Serializable
data class UserProfile(
    val id: String,
    val name: String,
    val email: String,
    val avatarUrl: String,
    val provider: String, // "github" | "google" | "demo"
    val favoriteHorses: List<String> = emptyList(),
    val notes: Map<String, String> = emptyMap() // raceId -> memo
)


@Serializable
data class PedigreeLineage(
    val id: String,
    val name: String,
    val founder: String,
    val keyStallions: List<String>,
    val turfAptitude: String,
    val dirtAptitude: String,
    val distanceRange: String,
    val characteristics: String,
    val representativeHorses: List<String>
)



@Serializable
data class HorseBreed(
    val id: String,
    val name: String,
    val origin: String,
    val heightCm: String,
    val weightKg: String,
    val use: String,
    val description: String,
    val bodyHex: String,
    val build: Double // 体格の太さ (図の描画用 0.8=細身 〜 1.4=重種)
)

@Serializable
data class CoatColor(
    val name: String,
    val reading: String,
    val bodyHex: String,
    val maneHex: String,
    val description: String,
    val famousHorse: String
)
