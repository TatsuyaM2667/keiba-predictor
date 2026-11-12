package com.example.keiba.model

import kotlinx.serialization.Serializable

/** 日本語版 Wikipedia の {{競走馬}} 記事 1 件 */
@Serializable
data class HorseEntry(
    val title: String,              // 記事名 (一意キー)
    val name: String,
    val nameEn: String = "",
    val image: String? = null,      // Wikimedia Commons のファイル名
    val imageCaption: String = "",
    val sex: String = "",
    val color: String = "",         // 毛色
    val breed: String = "",
    val birthYear: Int? = null,
    val deathYear: Int? = null,
    val sire: String = "",
    val dam: String = "",
    val damSire: String = "",
    val breeder: String = "",
    val country: String = "",
    val owner: String = "",
    val trainer: String = "",
    val starts: Int? = null,
    val wins: Int? = null,
    val recordText: String = "",
    val earningsText: String = "",
    val earningsManYen: Long? = null, // 円建ての賞金のみ (万円)
    val honors: String = "",
    val bigWins: List<BigWin> = emptyList()
)

@Serializable
data class BigWin(val grade: String, val race: String)

/** 日本語版 Wikipedia の {{騎手}} 記事 1 件 */
@Serializable
data class JockeyEntry(
    val title: String,
    val name: String,
    val image: String? = null,
    val imageCaption: String = "",
    val country: String = "",       // 国 (日本以外は空のことがある)
    val birthplace: String = "",
    val birthYear: Int? = null,
    val deathYear: Int? = null,
    val heightCm: Double? = null,
    val affiliation: String = "",   // 所属団体 (変遷は " / " 区切り)
    val stable: String = "",        // 所属厩舎
    val debut: String = "",         // 初騎乗
    val debutYear: Int? = null,
    val retired: String = "",       // 引退 (空なら現役)
    val starts: Int? = null,        // 通算成績の最初の「N 戦 M 勝」
    val wins: Int? = null,
    val recordText: String = "",
    val gradedWins: Int? = null,    // 重賞勝利数
    val g1Wins: Int? = null,        // GI 勝利数
    val region: String = "",        // 中央 / 地方 / 海外 / 不明 (最後の所属団体から)
    val active: Boolean = false,
)

/** 日本語版 Wikipedia の {{競馬の競走}} 記事 1 件 */
@Serializable
data class RaceEntry(
    val title: String,
    val name: String,
    val nameEn: String = "",
    val course: String = "",        // 競馬場 (例: 東京競馬場)
    val surface: String = "",       // 芝 / ダート / 障害
    val distance: Int? = null,
    val grade: String = "",
    val prize: String = "",
    val founded: String = "",
    val season: String = "",
    val organizer: String = "",
    val condition: String = "",
    val image: String? = null
)

/** 現役の競馬場 (中央 10 + 地方 15) */
@Serializable
data class Racecourse(
    val id: String,
    val name: String,
    val short: String,
    val qid: String,
    val organizer: String,          // JRA / 地方 (主催者名)
    val category: String,           // 中央 / 地方 / ばんえい
    val region: String,
    val turn: String,               // 右 / 左 / 直線
    val surfaces: String,           // 芝・ダート など
    val straightMeters: Double,     // 最後の直線 (参考値)
    val note: String,
    val website: String,
    val youtubeChannel: String? = null,
    val youtubeLabel: String = "",
    val lat: Double? = null,
    val lon: Double? = null,
    val image: String? = null,
    val elevationProfile: List<Double> = emptyList()
)

@Serializable
data class LibrarySnapshot(
    val generatedAt: String,
    val horses: List<HorseEntry>,
    val races: List<RaceEntry>,
    val courseMedia: Map<String, CourseMedia> = emptyMap(),
    val jockeys: List<JockeyEntry> = emptyList()
)

@Serializable
data class CourseMedia(val lat: Double? = null, val lon: Double? = null, val image: String? = null)

@Serializable
data class MediaCredit(
    val file: String,
    val thumbUrl: String? = null,
    val pageUrl: String? = null,
    val artist: String = "",
    val license: String = ""
)
