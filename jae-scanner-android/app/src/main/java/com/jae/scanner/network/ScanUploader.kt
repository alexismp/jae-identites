package com.jae.scanner.network

import com.jae.scanner.BuildConfig
import com.jae.scanner.quality.MrzData
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

data class UploadResult(
    val uploadedFile: String,
    val viaSignedUrl: Boolean
)

data class DirectIdentityResult(
    val resultFile: String,
    val matched: Boolean,
    val summary: String
)

data class ScanStatusResult(
    val status: String, // pending, processing, done, error, timeout
    val summary: String,
    val isError: Boolean = false,
    val isTimeout: Boolean = false
)

data class ActiveMatchInfo(
    val matchId: String,
    val team1Name: String,
    val team2Name: String
) {
    fun displayLabel(): String {
        val teams = listOf(team1Name, team2Name)
            .filter { it.isNotBlank() }
            .joinToString(" vs ")
        return if (teams.isNotBlank()) "#$matchId · $teams" else "Rencontre #$matchId"
    }
}

/**
 * Téléverse l'image JPEG capturée (priorité Signed URL GCS sur jae-ocr, fallback POST /scan)
 * et suit le résultat ou les erreurs asynchrones du backend jae-ocr via GET /api/scan-status/<file>.
 */
class ScanUploader(
    private val ocrBaseUrl: String = BuildConfig.OCR_BACKEND_URL.trimEnd('/'),
    private val scannerBaseUrl: String = BuildConfig.SCANNER_BACKEND_URL.trimEnd('/'),
    private val apiKey: String = BuildConfig.SCANNER_API_KEY,
    private val tokenProvider: (suspend () -> String?)? = null
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    suspend fun fetchActiveMatch(): Result<ActiveMatchInfo> = withContext(Dispatchers.IO) {
        val bearerToken = tokenProvider?.invoke()
        runCatching {
            if (ocrBaseUrl.isBlank()) throw IOException("OCR_BACKEND_URL non configurée")
            if (bearerToken.isNullOrBlank()) throw IOException("Non connecté")

            val req = Request.Builder()
                .url("$ocrBaseUrl/api/me")
                .header("Authorization", "Bearer $bearerToken")
                .get()
                .build()

            client.newCall(req).execute().use { resp ->
                val rawBody = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}")
                val body = JSONObject(rawBody)
                val match = body.optJSONObject("activeMatch")
                    ?: throw IOException("Aucune rencontre active")
                val matchId = match.optString("matchId", "").trim()
                if (matchId.isBlank()) throw IOException("Identifiant de rencontre manquant")
                ActiveMatchInfo(
                    matchId = matchId,
                    team1Name = match.optString("team1Name", "Équipe 1").trim(),
                    team2Name = match.optString("team2Name", "Équipe 2").trim()
                )
            }
        }
    }

    suspend fun upload(jpegBytes: ByteArray): Result<UploadResult> = withContext(Dispatchers.IO) {
        val bearerToken = tokenProvider?.invoke()
        if (ocrBaseUrl.isNotBlank()) {
            val signedAttempt = uploadViaSignedUrl(jpegBytes, bearerToken)
            if (signedAttempt.isSuccess) return@withContext signedAttempt
        }
        uploadViaScannerEndpoint(jpegBytes)
    }

    /**
     * Envoie directement le nom/prénom extraits par MRZ (checksums ICAO 9303 valides)
     * au backend jae-ocr sans téléverser l'image ni solliciter le LLM.
     */
    suspend fun submitDirectIdentity(mrz: MrzData): Result<DirectIdentityResult> = withContext(Dispatchers.IO) {
        val bearerToken = tokenProvider?.invoke()
        runCatching {
            if (ocrBaseUrl.isBlank()) {
                throw IOException("OCR_BACKEND_URL non configurée")
            }
            val payload = JSONObject()
                .put("nom", mrz.surname)
                .put("prenom", mrz.givenNames)
                .put("document_subtype", "mrz_${mrz.format.name.lowercase()}")
                .put("issuing_country", mrz.issuingCountry)
                .put("check_digits_valid", mrz.checkDigitsValid)
                .put("source", "android_mrz")
                .toString()

            val reqBuilder = Request.Builder()
                .url("$ocrBaseUrl/api/identite/direct")
                .post(payload.toRequestBody("application/json".toMediaType()))

            if (!bearerToken.isNullOrBlank()) {
                reqBuilder.header("Authorization", "Bearer $bearerToken")
            } else if (apiKey.isNotBlank()) {
                reqBuilder.header("X-API-Key", apiKey)
            }

            client.newCall(reqBuilder.build()).execute().use { resp ->
                val rawBody = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    throw IOException("Erreur identité directe (${resp.code})")
                }
                val body = JSONObject(rawBody)
                val resultFile = body.optString("result_file")
                val matched = body.optBoolean("matched", false)
                val label = "${mrz.givenNames} ${mrz.surname}".trim()
                val summary = if (matched) {
                    "Validé sans LLM : $label"
                } else {
                    "Enregistré sans LLM : $label (en attente de licence/Ten'Up)"
                }
                DirectIdentityResult(
                    resultFile = resultFile,
                    matched = matched,
                    summary = summary
                )
            }
        }
    }

    suspend fun pollScanStatus(
        objectName: String,
        maxAttempts: Int = 40,
        intervalMs: Long = 2000L
    ): ScanStatusResult = withContext(Dispatchers.IO) {
        if (ocrBaseUrl.isBlank()) {
            return@withContext ScanStatusResult(
                status = "done",
                summary = "Envoyé ($objectName)"
            )
        }

        repeat(maxAttempts) {
            delay(intervalMs)
            val req = Request.Builder()
                .url("$ocrBaseUrl/api/scan-status/$objectName")
                .get()
                .build()

            val parsed = runCatching {
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return@use null
                    JSONObject(resp.body?.string().orEmpty())
                }
            }.getOrNull()

            if (parsed != null) {
                when (parsed.optString("status")) {
                    "done" -> {
                        val docType = parsed.optString("type", "")
                        val nom = parsed.optString("nom", "")
                        val prenom = parsed.optString("prenom", "")
                        val licence = parsed.optString("licence", "")
                        val label = listOf(prenom, nom).filter { it.isNotBlank() }.joinToString(" ")
                        val detail = buildString {
                            append("OCR OK")
                            if (docType.isNotBlank()) append(" ($docType)")
                            if (label.isNotBlank()) append(" : $label")
                            if (licence.isNotBlank() && licence != "null") append(" [$licence]")
                        }
                        return@withContext ScanStatusResult(status = "done", summary = detail)
                    }
                    "error" -> {
                        val err = parsed.optString("error", "Erreur OCR inconnue")
                        return@withContext ScanStatusResult(
                            status = "error",
                            summary = "Erreur backend OCR : $err",
                            isError = true
                        )
                    }
                }
            }
        }

        ScanStatusResult(
            status = "timeout",
            summary = "Délai dépassé (> 80s) — vérifiez le tableau ou rescannez si besoin",
            isTimeout = true
        )
    }

    private fun uploadViaSignedUrl(jpegBytes: ByteArray, bearerToken: String?): Result<UploadResult> {
        return runCatching {
            val jsonBody = JSONObject().put("content_type", "image/jpeg").toString()
            val urlReqBuilder = Request.Builder()
                .url("$ocrBaseUrl/api/upload-url")
                .post(jsonBody.toRequestBody("application/json".toMediaType()))

            if (!bearerToken.isNullOrBlank()) {
                urlReqBuilder.header("Authorization", "Bearer $bearerToken")
            } else if (apiKey.isNotBlank()) {
                urlReqBuilder.header("X-API-Key", apiKey)
            }

            val (signedUrl, objectName) = client.newCall(urlReqBuilder.build()).execute().use { resp ->
                if (!resp.isSuccessful) {
                    throw IOException("Signed URL indisponible (${resp.code})")
                }
                val body = JSONObject(resp.body?.string().orEmpty())
                val url = body.optString("upload_url")
                val name = body.optString("object_name")
                if (url.isBlank() || name.isBlank()) {
                    throw IOException("Réponse Signed URL invalide")
                }
                url to name
            }

            val putReq = Request.Builder()
                .url(signedUrl)
                .put(jpegBytes.toRequestBody("image/jpeg".toMediaType()))
                .header("Content-Type", "image/jpeg")
                .build()

            client.newCall(putReq).execute().use { putResp ->
                if (!putResp.isSuccessful) {
                    throw IOException("Échec PUT GCS (${putResp.code})")
                }
            }

            UploadResult(uploadedFile = objectName, viaSignedUrl = true)
        }
    }

    private fun uploadViaScannerEndpoint(jpegBytes: ByteArray): Result<UploadResult> {
        return runCatching {
            val fileName = "android-${UUID.randomUUID().toString().take(8)}.jpg"
            val requestBody = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart(
                    name = "file",
                    filename = fileName,
                    body = jpegBytes.toRequestBody("image/jpeg".toMediaType())
                )
                .build()

            val reqBuilder = Request.Builder()
                .url("$scannerBaseUrl/scan")
                .post(requestBody)

            if (apiKey.isNotBlank()) {
                reqBuilder.header("X-API-Key", apiKey)
            }

            client.newCall(reqBuilder.build()).execute().use { response ->
                val rawBody = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    val errorMsg = runCatching { JSONObject(rawBody).optString("error") }
                        .getOrNull()
                        .takeUnless { it.isNullOrBlank() }
                        ?: "Erreur serveur (${response.code})"
                    throw IOException(errorMsg)
                }

                val uploadedFile = JSONObject(rawBody).optString("uploaded_file")
                if (uploadedFile.isBlank()) {
                    throw IOException("Réponse inattendue du serveur")
                }
                UploadResult(uploadedFile = uploadedFile, viaSignedUrl = false)
            }
        }
    }
}
