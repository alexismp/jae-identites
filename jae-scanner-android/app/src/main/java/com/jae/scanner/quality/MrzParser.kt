package com.jae.scanner.quality

/**
 * Données extraites d'une zone MRZ (Machine Readable Zone, norme ICAO 9303).
 */
data class MrzData(
    val format: MrzFormat,
    val issuingCountry: String,
    val surname: String,
    val givenNames: String,
    val documentNumber: String,
    val checkDigitsValid: Boolean
)

enum class MrzFormat {
    TD1_CNIE,        // 3 x 30 caractères (CNI française nouveau format, verso)
    TD2_CNI_ANCIEN,  // 2 x 36 caractères (CNI française ancien format, recto)
    TD3_PASSEPORT    // 2 x 44 caractères (Passeports français et étrangers)
}

/**
 * Parser MRZ ICAO 9303 pur Kotlin (TD1, TD2 FR, TD3) avec validation des check digits (modulo 10, poids 7-3-1).
 */
object MrzParser {

    private val weights = intArrayOf(7, 3, 1)

    fun parse(rawText: String): MrzData? {
        val candidateLines = rawText
            .lines()
            .map { normalizeMrzLine(it) }
            .filter { it.length >= 22 && it.contains('<') }

        if (candidateLines.size < 2) return null

        // 1. Essayer TD3 (2 lignes de 44 car. — Passeports)
        parseTd3(candidateLines)?.let { return it }

        // 2. Essayer TD2 FR (2 lignes de 36 car. — CNI française ancien format)
        parseTd2Fr(candidateLines)?.let { return it }

        // 3. Essayer TD1 (3 lignes de 30 car. — CNIe nouveau format, verso)
        parseTd1(candidateLines)?.let { return it }

        return null
    }

    private fun parseTd3(lines: List<String>): MrzData? {
        for (i in 0 until lines.size - 1) {
            val l1 = fitLength(lines[i], 44) ?: continue
            val l2 = fitLength(lines[i + 1], 44) ?: continue
            if (!l1.startsWith("P")) continue

            val country = l1.substring(2, 5).replace("<", "")
            val (surname, givenNames) = splitNameField(l1.substring(5, 44))
            if (surname.isBlank()) continue

            val docNumber = l2.substring(0, 9).replace("<", "")
            val docValid = verifyCheckDigit(l2.substring(0, 9), l2[9])
            val dobValid = verifyCheckDigit(l2.substring(13, 19), l2[19])
            val expValid = verifyCheckDigit(l2.substring(21, 27), l2[27])

            return MrzData(
                format = MrzFormat.TD3_PASSEPORT,
                issuingCountry = country,
                surname = surname,
                givenNames = givenNames,
                documentNumber = docNumber,
                checkDigitsValid = docValid && dobValid && expValid
            )
        }
        return null
    }

    private fun parseTd2Fr(lines: List<String>): MrzData? {
        for (i in 0 until lines.size - 1) {
            val l1 = fitLength(lines[i], 36) ?: continue
            val l2 = fitLength(lines[i + 1], 36) ?: continue
            if (!l1.startsWith("IDFRA")) continue

            val surname = sanitizeMrzName(l1.substring(5, 30))
            if (surname.isBlank()) continue

            val docNumber = l2.substring(0, 12).replace("<", "")
            val docValid = verifyCheckDigit(l2.substring(0, 12), l2[12])
            val givenNames = sanitizeMrzName(l2.substring(13, 27))
            val dobValid = verifyCheckDigit(l2.substring(27, 33), l2[33])

            return MrzData(
                format = MrzFormat.TD2_CNI_ANCIEN,
                issuingCountry = "FRA",
                surname = surname,
                givenNames = givenNames,
                documentNumber = docNumber,
                checkDigitsValid = docValid && dobValid
            )
        }
        return null
    }

    private fun parseTd1(lines: List<String>): MrzData? {
        for (i in 0 until lines.size - 2) {
            val l1Raw = lines[i].let { if (it.startsWith("1D")) "ID" + it.substring(2) else it }
            val l1 = fitLength(l1Raw, 30, tolerance = 6) ?: continue
            val l2 = fitLength(lines[i + 1], 30, tolerance = 4) ?: continue
            val l3 = fitLength(lines[i + 2], 30, tolerance = 8) ?: continue
            if (!(l1.startsWith("ID") || l1.startsWith("I<"))) continue

            val country = l1.substring(2, 5).replace("<", "")
            val docNumber = l1.substring(5, 14).replace("<", "")
            val docValid = verifyCheckDigit(l1.substring(5, 14), l1[14])
            val dobField = sanitizeMrzDigits(l2.substring(0, 6))
            val dobValid = verifyCheckDigit(dobField, l2[6])
            val expField = sanitizeMrzDigits(l2.substring(8, 14))
            val expValid = verifyCheckDigit(expField, l2[14])
            val (surname, givenNames) = splitNameField(l3)
            if (surname.isBlank()) continue

            return MrzData(
                format = MrzFormat.TD1_CNIE,
                issuingCountry = country,
                surname = surname,
                givenNames = givenNames,
                documentNumber = docNumber,
                checkDigitsValid = docValid && dobValid && expValid
            )
        }
        return null
    }

    private fun normalizeMrzLine(line: String): String {
        return line
            .uppercase()
            .replace(" ", "")
            .replace("«", "<<")
            .replace("»", ">>")
            .replace(Regex("[^A-Z0-9<]"), "")
    }

    private fun fitLength(line: String, expected: Int, tolerance: Int = 2): String? {
        return when {
            line.length == expected -> line
            line.length in (expected - tolerance)..(expected + tolerance) -> {
                if (line.length < expected) line.padEnd(expected, '<') else line.substring(0, expected)
            }
            else -> null
        }
    }

    private fun sanitizeMrzDigits(field: String): String {
        return field
            .replace('O', '0')
            .replace('Q', '0')
            .replace('I', '1')
            .replace('L', '1')
            .replace('S', '5')
            .replace('B', '8')
            .replace('Z', '2')
    }

    private fun sanitizeMrzName(field: String): String {
        return field
            .replace("<<", " ")
            .replace("<", " ")
            .replace('0', 'O')
            .replace('1', 'I')
            .replace('5', 'S')
            .replace('8', 'B')
            .replace('2', 'Z')
            .trim()
            .replace(Regex("\\s+"), " ")
    }

    private fun splitNameField(field: String): Pair<String, String> {
        val parts = field.split("<<", limit = 2)
        val surname = sanitizeMrzName(parts.getOrNull(0).orEmpty())
        val givenNames = sanitizeMrzName(parts.getOrNull(1).orEmpty())
        return surname to givenNames
    }

    internal fun computeCheckDigit(data: String): Int {
        var sum = 0
        data.forEachIndexed { index, ch ->
            val value = when (ch) {
                '<' -> 0
                in '0'..'9' -> ch - '0'
                in 'A'..'Z' -> ch - 'A' + 10
                else -> 0
            }
            sum += value * weights[index % 3]
        }
        return sum % 10
    }

    internal fun verifyCheckDigit(data: String, expectedChar: Char): Boolean {
        val normExpected = sanitizeMrzDigits(expectedChar.toString()).firstOrNull() ?: return false
        if (normExpected !in '0'..'9') return false
        return computeCheckDigit(data) == (normExpected - '0')
    }
}
