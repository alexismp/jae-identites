package com.jae.scanner.auth

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Gestion de session Firebase Auth strictement OAuth (aucun mot de passe).
 * La connexion s'effectue via le navigateur système (Google / Microsoft / Apple)
 * qui redirige vers `jaescanner://auth`, puis le jeton est rafraîchi automatiquement.
 */
class FirebaseAuthManager(context: Context) {

    companion object {
        private const val PREFS_NAME = "jae_firebase_auth"
        private const val KEY_EMAIL = "email"
        private const val KEY_ID_TOKEN = "id_token"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
        private const val KEY_EXPIRES_AT = "expires_at_ms"
        private const val FIREBASE_API_KEY = "AIzaSyDQ2viUbTqy-lwz_EUf_YLrYiWfTOkRPPw"
    }

    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    fun getCurrentEmail(): String? = prefs.getString(KEY_EMAIL, null)?.takeIf { it.isNotBlank() }

    fun isSignedIn(): Boolean = !prefs.getString(KEY_REFRESH_TOKEN, null).isNullOrBlank()

    fun signOut() {
        prefs.edit().clear().apply()
    }

    fun saveOAuthSession(email: String, idToken: String, refreshToken: String) {
        val expiresAtMs = System.currentTimeMillis() + 50L * 60L * 1000L
        saveSession(email.trim(), idToken.trim(), refreshToken.trim(), expiresAtMs)
    }

    suspend fun getValidIdToken(): String? = withContext(Dispatchers.IO) {
        val currentToken = prefs.getString(KEY_ID_TOKEN, null)
        val refreshToken = prefs.getString(KEY_REFRESH_TOKEN, null) ?: return@withContext null
        val expiresAt = prefs.getLong(KEY_EXPIRES_AT, 0L)

        if (!currentToken.isNullOrBlank() && System.currentTimeMillis() < expiresAt) {
            return@withContext currentToken
        }

        runCatching {
            val form = "grant_type=refresh_token&refresh_token=$refreshToken"
            val req = Request.Builder()
                .url("https://securetoken.googleapis.com/v1/token?key=$FIREBASE_API_KEY")
                .post(form.toRequestBody("application/x-www-form-urlencoded".toMediaType()))
                .build()

            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val json = JSONObject(resp.body?.string().orEmpty())
                val newIdToken = json.optString("id_token")
                val newRefresh = json.optString("refresh_token", refreshToken)
                val expiresInSec = json.optString("expires_in", "3600").toLongOrNull() ?: 3600L
                val newExpiresAt = System.currentTimeMillis() + (expiresInSec - 120L).coerceAtLeast(60L) * 1000L
                if (newIdToken.isBlank()) return@use null
                val email = getCurrentEmail().orEmpty()
                saveSession(email, newIdToken, newRefresh, newExpiresAt)
                newIdToken
            }
        }.getOrNull()
    }

    private fun saveSession(email: String, idToken: String, refreshToken: String, expiresAtMs: Long) {
        prefs.edit()
            .putString(KEY_EMAIL, email)
            .putString(KEY_ID_TOKEN, idToken)
            .putString(KEY_REFRESH_TOKEN, refreshToken)
            .putLong(KEY_EXPIRES_AT, expiresAtMs)
            .apply()
    }
}
