package com.jae.scanner.quality

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MrzParserTest {

    @Test
    fun parsesTd3ForeignPassportWithValidCheckDigits() {
        val docNum = "C01X00T47"
        val docCheck = MrzParser.computeCheckDigit(docNum)
        val dob = "850812"
        val dobCheck = MrzParser.computeCheckDigit(dob)
        val exp = "300811"
        val expCheck = MrzParser.computeCheckDigit(exp)
        val l1 = "P<DEUMULLER<<LUKAS<HANS".padEnd(44, '<')
        val l2 = "$docNum${docCheck}DEU$dob${dobCheck}M$exp$expCheck".padEnd(43, '<') + "0"

        val parsed = MrzParser.parse("$l1\n$l2")
        assertNotNull(parsed)
        assertEquals(MrzFormat.TD3_PASSEPORT, parsed!!.format)
        assertEquals("DEU", parsed.issuingCountry)
        assertEquals("MULLER", parsed.surname)
        assertEquals("LUKAS HANS", parsed.givenNames)
        assertEquals("C01X00T47", parsed.documentNumber)
        assertTrue(parsed.checkDigitsValid)
    }

    @Test
    fun parsesTd2FrenchOldIdCard() {
        val docNum = "123456789012"
        val docCheck = MrzParser.computeCheckDigit(docNum)
        val dob = "850115"
        val dobCheck = MrzParser.computeCheckDigit(dob)
        val l1 = "IDFRA" + "MARTIN".padEnd(25, '<') + "750001"
        val l2 = "$docNum$docCheck" + "LEA<<MARIE<<<<" + "$dob${dobCheck}F0"

        val parsed = MrzParser.parse("$l1\n$l2")
        assertNotNull(parsed)
        assertEquals(MrzFormat.TD2_CNI_ANCIEN, parsed!!.format)
        assertEquals("FRA", parsed.issuingCountry)
        assertEquals("MARTIN", parsed.surname)
        assertEquals("LEA MARIE", parsed.givenNames)
        assertTrue(parsed.checkDigitsValid)
    }

    @Test
    fun parsesTd1FrenchNewIdCardBack() {
        val docNum = "X4RTBPFW4"
        val docCheck = MrzParser.computeCheckDigit(docNum)
        val dob = "900713"
        val dobCheck = MrzParser.computeCheckDigit(dob)
        val exp = "310211"
        val expCheck = MrzParser.computeCheckDigit(exp)
        val l1 = "IDFRA$docNum$docCheck".padEnd(30, '<')
        val l2 = "$dob${dobCheck}F$exp${expCheck}FRA".padEnd(30, '<')
        val l3 = "MARTIN<<LEA<SOPHIE".padEnd(30, '<')

        val parsed = MrzParser.parse("$l1\n$l2\n$l3")
        assertNotNull(parsed)
        assertEquals(MrzFormat.TD1_CNIE, parsed!!.format)
        assertEquals("FRA", parsed.issuingCountry)
        assertEquals("MARTIN", parsed.surname)
        assertEquals("LEA SOPHIE", parsed.givenNames)
        assertTrue(parsed.checkDigitsValid)
    }

    @Test
    fun detectsFftLicenceNumberOnTenUpText() {
        val sampleTenUp = "FFT Ten'Up\nMARTIN Léa\nLicence 1791510 T\nClassement 15/2"
        assertEquals("1791510T", MlKitTextPostCaptureValidator.findFftLicenceNumber(sampleTenUp))
        assertTrue(MlKitTextPostCaptureValidator.hasFftKeywords(sampleTenUp))
        assertNull(MlKitTextPostCaptureValidator.findFftLicenceNumber("Page d'accueil sans numéro"))

        val autoLicence = MlKitTextPostCaptureValidator.classifyText(sampleTenUp)
        assertTrue(autoLicence.isValid)
        assertEquals(DetectedDocumentKind.LICENCE_TENUP, autoLicence.detectedKind)

        val autoId = MlKitTextPostCaptureValidator.classifyText("RÉPUBLIQUE FRANÇAISE\nCARTE NATIONALE D'IDENTITÉ\nMARTIN Léa")
        assertTrue(autoId.isValid)
        assertEquals(DetectedDocumentKind.IDENTITY, autoId.detectedKind)
    }

    @Test
    fun rejectsDrivingLicenceAndResidencePermit() {
        val drivingLicence = MlKitTextPostCaptureValidator.classifyText("RÉPUBLIQUE FRANÇAISE\nPERMIS DE CONDUIRE\n1. MARTIN\n2. Léa")
        assertFalse(drivingLicence.isValid)

        val residencePermit = MlKitTextPostCaptureValidator.classifyText("RÉPUBLIQUE FRANÇAISE\nTITRE DE SÉJOUR\nCARTE DE RÉSIDENT\nMARTIN Léa")
        assertFalse(residencePermit.isValid)
    }

    @Test
    fun correctsOcrDigitsInMrzNameFields() {
        val docNum = "123456789012"
        val docCheck = MrzParser.computeCheckDigit(docNum)
        val dob = "900512"
        val dobCheck = MrzParser.computeCheckDigit(dob)
        val l1 = "IDFRA" + "FLECHARD".padEnd(25, '<') + "750001"
        val l2 = "$docNum$docCheck" + "CHARL0TTE<<ANN" + "$dob${dobCheck}F0"

        val parsed = MrzParser.parse("$l1\n$l2")
        assertNotNull(parsed)
        assertEquals("FLECHARD", parsed!!.surname)
        assertEquals("CHARLOTTE ANN", parsed.givenNames)
        assertTrue(parsed.checkDigitsValid)
    }

    @Test
    fun classifiesNewFrenchCnieRectoAndVersoAsIdentityNotLicence() {
        val cnieRecto = """
            NOM / Surname
            DUPONT
            PRÉNOMS / Given names
            Chloé Marie
            SEXE / Sex  NATIONALITÉ  DATE DE NAISS.
            F           FRA          14 06 1995
            N° DU DOCUMENT  DATE D'EXPIR.
            X4RTBPFW4       12 05 2033
        """.trimIndent()
        val rectoRes = MlKitTextPostCaptureValidator.classifyText(cnieRecto)
        assertTrue(rectoRes.isValid)
        assertEquals(DetectedDocumentKind.IDENTITY, rectoRes.detectedKind)

        val cnieVersoNoisyMrz = """
            TAILLE 1,68 m
            DATE DE DÉLIVRANCE 12 05 2023
            ADRESSE 12 RUE DE LA PAIX PARIS
            IDFRAX4RTBPFW41<<<<<<<<<<<<<<<
            9506143F3305121FRA<<<<<<<<<<<2
            DUPONT<<CHLOE<MARIE<<<<<<<<<<<
        """.trimIndent()
        val versoRes = MlKitTextPostCaptureValidator.classifyText(cnieVersoNoisyMrz)
        assertTrue(versoRes.isValid)
        assertEquals(DetectedDocumentKind.IDENTITY, versoRes.detectedKind)
    }
}
