package com.example.keiba.service

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class LearnServiceTest {
    @Test
    fun chaptersAreWellFormed() {
        val ch = LearnService.chapters
        assertEquals(9, ch.size)
        assertEquals(ch.size, ch.map { it.id }.toSet().size)
        for (c in ch) {
            assertTrue(c.html.startsWith("<div>") && c.html.endsWith("</div>"), c.id)
            assertTrue(c.quiz.isNotEmpty(), c.id)
            c.quiz.forEach { assertTrue(it.answer in it.options.indices, "${c.id}: ${it.q}") }
        }
        // 図が入っている章
        assertTrue("lcard-row" in ch.first { it.id == "card" }.html)
        assertTrue("<svg viewBox" in ch.first { it.id == "style" }.html)
        assertTrue("bet-table" in ch.first { it.id == "bets" }.html)
    }
}
