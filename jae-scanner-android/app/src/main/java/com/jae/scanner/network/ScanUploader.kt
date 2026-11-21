package com.jae.scanner.network

import com.jae.scanner.BuildConfig
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

data class ScanStatusResult(
    val status: String, // pending, processing, done, error, timeout
    val summary: String,
    val isError: Boolean = false
)

/**
 * Téléverse l'image JPEG capturée (priorité Signed URL GCS sur jae-ocr, fallback POST /scan)
 * et suit le résultat ou les erreurs asynchrones du backend jae-ocr via GET /api/scan-status/<file>.
 */
class ScanUploader(
    private val ocrBaseUrl: String = BuildConfig.OCR_BACKEND_URL.trimEnd('/'),
    private val scannerBaseUrl: String = BuildConfig.SCANNER_BACKEND_URL.trimEnd('/'),
    private val apiKey: String = BuildConfig.SCANNER_API_KEY
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    suspend fun upload(jpegBytes: ByteArray): Result<UploadResult> = withContext(Dispatchers.IO) {
        if (ocrBaseUrl.isNotBlank()) {
            val signedAttempt = uploadViaSignedUrl(jpegBytes)
            if (signedAttempt.isSuccess) return@withContext signedAttempt
        }
        uploadViaScannerEndpoint(jpegBytes)
    }

    suspend fun pollScanStatus(
        objectName: String,
        maxAttempts: Int = 14,
        intervalMs: Long = 1500L
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
            summary = "Envoyé — traitement OCR toujours en cours sur le serveur"
        )
    }

    private fun uploadViaSignedUrl(jpegBytes: ByteArray): Result<UploadResult> {
        return runCatching {
            val jsonBody = JSONObject().put("content_type", "image/jpeg").toString()
            val urlReqBuilder = Request.Builder()
                .url("$ocrBaseUrl/api/upload-url")
                .post(jsonBody.toRequestBody("application/json".toMediaType()))

            if (apiKey.isNotBlank()) {
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
