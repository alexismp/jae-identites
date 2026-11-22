package com.jae.scanner.quality

import android.graphics.Bitmap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.tasks.await

enum class DetectedDocumentKind(val label: String) {
    IDENTITY("Pièce d'identité"),
    LICENCE_TENUP("Licence FFT / Ten'Up")
}

data class PostCaptureResult(
    val isValid: Boolean,
    val message: String,
    val detectedKind: DetectedDocumentKind = DetectedDocumentKind.LICENCE_TENUP,
    val detectedTextChars: Int = 0,
    val mrzData: MrzData? = null,
    val detectedLicenceNumber: String? = null
)

/**
 * Contrat de validation & classification automatique par contenu (sans choix manuel de mode).
 */
interface PostCaptureValidator {
    suspend fun validate(bitmap: Bitmap): PostCaptureResult
}

/**
 * Classification automatique par contenu (ML Kit Text Recognition) :
 * 1. Détecte d'abord une pièce d'identité (MRZ ICAO 9303 ou mots-clés CNI / passeport).
 * 2. Sinon bascule automatiquement sur la branche Licence FFT / Ten'Up (attestation paysage ou bout d'écran web/mobile).
 */
class MlKitTextPostCaptureValidator(
    private val minCharCount: Int = 12
) : PostCaptureValidator {

    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

    companion object {
        private val FFT_LICENCE_REGEX = Regex("\\b\\d{7}\\s?[A-Z]\\b")
        private val FFT_KEYWORDS = listOf("FFT", "LICENCE", "CLASSEMENT", "TENNIS", "TEN'UP", "TENUP")
        private val FORBIDDEN_DOC_KEYWORDS = listOf(
            "PERMIS DE CONDUIRE",
            "DRIVING LICENCE",
            "DRIVING LICENSE",
            "FÜHRERSCHEIN",
            "FUHRERSCHEIN",
            "PATENTE DI GUIDA",
            "PERMISO DE CONDUCCION",
            "TITRE DE SEJOUR",
            "TITRE DE SÉJOUR",
            "CARTE DE SEJOUR",
            "CARTE DE SÉJOUR",
            "CARTE DE RESIDENT",
            "CARTE DE RÉSIDENT",
            "RESIDENCE PERMIT",
            "AUFENTHALTSTITEL"
        )
        private val ID_KEYWORDS = listOf(
            "CARTE NATIONALE",
            "D'IDENTITE",
            "D'IDENTITÉ",
            "IDENTITE",
            "IDENTITÉ",
            "REPUBLIQUE FRANCAISE",
            "RÉPUBLIQUE FRANÇAISE",
            "PASSEPORT",
            "PASSPORT",
            "IDENTITY CARD",
            "SURNAME",
            "GIVEN NAMES",
            "DATE DE NAISS",
            "LIEU DE NAISSANCE",
            "NOM D'USAGE",
            "DATE D'EXPIR",
            "DATE DE DELIVRANCE",
            "DATE DE DÉLIVRANCE",
            "DU DOCUMENT",
            "IDFRA",
            "I<FRA",
            "P<FRA",
            "PERSONALAUSWEIS",
            "REISEPASS",
            "CARTA D'IDENTITA",
            "PASAPORTE",
            "NATIONALITE",
            "NATIONALITÉ"
        )

        internal fun findFftLicenceNumber(rawText: String): String? {
            return FFT_LICENCE_REGEX.find(rawText.uppercase())?.value?.replace(" ", "")
        }

        internal fun hasFftKeywords(rawText: String): Boolean {
            val upper = rawText.uppercase()
            return FFT_KEYWORDS.any { upper.contains(it) }
        }

        internal fun hasIdentityKeywords(rawText: String): Boolean {
            val upper = rawText.uppercase()
            return ID_KEYWORDS.any { upper.contains(it) }
        }

        internal fun hasForbiddenDocumentKeywords(rawText: String): Boolean {
            val upper = rawText.uppercase()
            return FORBIDDEN_DOC_KEYWORDS.any { upper.contains(it) }
        }

        internal fun classifyText(rawText: String): PostCaptureResult {
            val charCount = rawText.replace("\\s+".toRegex(), "").length
            if (charCount < 12) {
                return PostCaptureResult(
                    isValid = false,
                    message = "Texte insuffisant ou illisible ($charCount car.). Veuillez rescanner.",
                    detectedTextChars = charCount
                )
            }

            // 0. Rejet immédiat des pièces non autorisées (permis de conduire, titres/cartes de séjour)
            if (hasForbiddenDocumentKeywords(rawText)) {
                return PostCaptureResult(
                    isValid = false,
                    message = "Document non autorisé (permis de conduire ou titre de séjour). Seuls CNI et passeport sont acceptés.",
                    detectedKind = DetectedDocumentKind.IDENTITY,
                    detectedTextChars = charCount
                )
            }

            // 1. Priorité : détection Pièce d'identité (MRZ ou mots-clés officiels)
            val mrz = MrzParser.parse(rawText)
            if (mrz != null) {
                val statusTag = if (mrz.checkDigitsValid) "Identité (MRZ valide" else "Identité (MRZ lue"
                val displayName = listOf(mrz.givenNames, mrz.surname)
                    .filter { it.isNotBlank() }
                    .joinToString(" ")
                return PostCaptureResult(
                    isValid = true,
                    message = "$statusTag · ${mrz.issuingCountry}) : $displayName",
                    detectedKind = DetectedDocumentKind.IDENTITY,
                    detectedTextChars = charCount,
                    mrzData = mrz
                )
            }

            val looksLikeMrz = rawText.contains("<<")
            if ((hasIdentityKeywords(rawText) || looksLikeMrz) && !hasFftKeywords(rawText)) {
                return PostCaptureResult(
                    isValid = true,
                    message = "Pièce d'identité détectée (analyse serveur)",
                    detectedKind = DetectedDocumentKind.IDENTITY,
                    detectedTextChars = charCount
                )
            }

            // 2. Sinon : branche Licence FFT / écran Ten'Up (peu importe l'orientation)
            val licenceNo = findFftLicenceNumber(rawText)
            return when {
                licenceNo != null && hasFftKeywords(rawText) -> PostCaptureResult(
                    isValid = true,
                    message = "Licence FFT détectée : $licenceNo",
                    detectedKind = DetectedDocumentKind.LICENCE_TENUP,
                    detectedTextChars = charCount,
                    detectedLicenceNumber = licenceNo
                )
                hasFftKeywords(rawText) -> PostCaptureResult(
                    isValid = true,
                    message = "Licence / Ten'Up détectée",
                    detectedKind = DetectedDocumentKind.LICENCE_TENUP,
                    detectedTextChars = charCount
                )
                licenceNo != null -> PostCaptureResult(
                    isValid = true,
                    message = "Licence FFT détectée : $licenceNo",
                    detectedKind = DetectedDocumentKind.LICENCE_TENUP,
                    detectedTextChars = charCount,
                    detectedLicenceNumber = licenceNo
                )
                else -> PostCaptureResult(
                    isValid = true,
                    message = "Document capturé ($charCount car., analyse serveur)",
                    detectedKind = DetectedDocumentKind.IDENTITY,
                    detectedTextChars = charCount
                )
            }
        }
    }

    override suspend fun validate(bitmap: Bitmap): PostCaptureResult {
        val image = InputImage.fromBitmap(bitmap, 0)
        val result = recognizer.process(image).await()
        return classifyText(result.text)
    }
}

/**
 * Point d'extension Gemini Nano via Android AICore / ML Kit GenAI (appareils récents compatibles).
 */
class GeminiNanoPostCaptureValidator(
    private val fallback: PostCaptureValidator = MlKitTextPostCaptureValidator()
) : PostCaptureValidator {
    override suspend fun validate(bitmap: Bitmap): PostCaptureResult {
        return fallback.validate(bitmap)
    }
}
