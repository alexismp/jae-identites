package com.jae.scanner.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.FlashAuto
import androidx.compose.material.icons.filled.FlashOff
import androidx.compose.material.icons.filled.FlashlightOn
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.jae.scanner.network.ScanUploader
import com.jae.scanner.quality.GeminiNanoPostCaptureValidator
import com.jae.scanner.quality.ImageQualityAnalyzer
import com.jae.scanner.quality.QualityReport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

private enum class LightingMode(val label: String) {
    OFF("Flash off"),
    AUTO_FLASH("Flash auto"),
    TORCH("Torche")
}

private data class FailedScanNotice(
    val time: String,
    val localLabel: String,
    val reason: String
)

@Composable
fun ScannerScreen() {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()

    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val uploader = remember { ScanUploader() }
    val validator = remember { GeminiNanoPostCaptureValidator() }

    var previewViewRef by remember { mutableStateOf<PreviewView?>(null) }
    var camera by remember { mutableStateOf<Camera?>(null) }
    var imageCapture by remember { mutableStateOf<ImageCapture?>(null) }
    var lightingMode by remember { mutableStateOf(LightingMode.OFF) }
    var qualityReport by remember { mutableStateOf(QualityReport()) }
    var toastMessage by remember { mutableStateOf<String?>(null) }
    var isCapturing by remember { mutableStateOf(false) }

    // Suivi asynchrone non-bloquant des envois et erreurs OCR
    var pendingCount by remember { mutableIntStateOf(0) }
    var successCount by remember { mutableIntStateOf(0) }
    val failedScans = remember { mutableStateListOf<FailedScanNotice>() }
    var showErrorsDialog by remember { mutableStateOf(false) }

    DisposableEffect(Unit) {
        onDispose {
            analysisExecutor.shutdown()
        }
    }

    fun applyLighting(mode: LightingMode) {
        lightingMode = mode
        val cam = camera ?: return
        val capture = imageCapture ?: return
        when (mode) {
            LightingMode.OFF -> {
                cam.cameraControl.enableTorch(false)
                capture.flashMode = ImageCapture.FLASH_MODE_OFF
            }
            LightingMode.AUTO_FLASH -> {
                cam.cameraControl.enableTorch(false)
                capture.flashMode = ImageCapture.FLASH_MODE_AUTO
            }
            LightingMode.TORCH -> {
                capture.flashMode = ImageCapture.FLASH_MODE_OFF
                cam.cameraControl.enableTorch(true)
            }
        }
    }

    fun cycleLighting() {
        val next = when (lightingMode) {
            LightingMode.OFF -> LightingMode.TORCH
            LightingMode.TORCH -> LightingMode.AUTO_FLASH
            LightingMode.AUTO_FLASH -> LightingMode.OFF
        }
        applyLighting(next)
    }

    fun nowTime(): String = SimpleDateFormat("HH:mm:ss", Locale.FRANCE).format(Date())

    fun captureAndQueueAsync() {
        val capture = imageCapture ?: return
        if (isCapturing) return
        isCapturing = true
        toastMessage = "Capture..."

        capture.takePicture(
            ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageCapturedCallback() {
                override fun onCaptureSuccess(image: ImageProxy) {
                    val bitmap = imageProxyToBitmap(image)
                    image.close()

                    if (bitmap == null) {
                        toastMessage = "Erreur de décodage de l'image."
                        isCapturing = false
                        return
                    }

                    // Libérer immédiatement le bouton de capture pour enchaîner les scans sans latence !
                    isCapturing = false
                    pendingCount++
                    toastMessage = "Capturé — prêt pour le document suivant"

                    scope.launch(Dispatchers.IO) {
                        val validation = validator.validate(bitmap)
                        if (!validation.isValid) {
                            withContext(Dispatchers.Main) {
                                pendingCount = (pendingCount - 1).coerceAtLeast(0)
                                failedScans.add(
                                    0,
                                    FailedScanNotice(
                                        time = nowTime(),
                                        localLabel = "Scan rejeté en local",
                                        reason = validation.message
                                    )
                                )
                            }
                            return@launch
                        }

                        withContext(Dispatchers.Main) {
                            toastMessage = "${validation.message} (envoi en arrière-plan)"
                        }

                        val jpegBytes = bitmapToJpeg(bitmap, quality = 95)
                        val uploadResult = uploader.upload(jpegBytes)
                        uploadResult
                            .onSuccess { res ->
                                val ocrStatus = uploader.pollScanStatus(res.uploadedFile)
                                withContext(Dispatchers.Main) {
                                    pendingCount = (pendingCount - 1).coerceAtLeast(0)
                                    if (ocrStatus.isError) {
                                        failedScans.add(
                                            0,
                                            FailedScanNotice(
                                                time = nowTime(),
                                                localLabel = validation.message,
                                                reason = ocrStatus.summary
                                            )
                                        )
                                    } else {
                                        successCount++
                                    }
                                }
                            }
                            .onFailure { err ->
                                withContext(Dispatchers.Main) {
                                    pendingCount = (pendingCount - 1).coerceAtLeast(0)
                                    failedScans.add(
                                        0,
                                        FailedScanNotice(
                                            time = nowTime(),
                                            localLabel = validation.message,
                                            reason = "Échec upload : ${err.message}"
                                        )
                                    )
                                }
                            }
                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    toastMessage = "Erreur capture : ${exception.message}"
                    isCapturing = false
                }
            }
        )
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(camera, previewViewRef) {
                detectTapGestures { offset ->
                    val cam = camera ?: return@detectTapGestures
                    val view = previewViewRef ?: return@detectTapGestures
                    val point = view.meteringPointFactory.createPoint(offset.x, offset.y)
                    val action = FocusMeteringAction.Builder(point).build()
                    cam.cameraControl.startFocusAndMetering(action)
                }
            }
    ) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                val previewView = PreviewView(ctx)
                previewViewRef = previewView
                val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)
                cameraProviderFuture.addListener({
                    val cameraProvider = cameraProviderFuture.get()
                    val preview = Preview.Builder().build().also {
                        it.surfaceProvider = previewView.surfaceProvider
                    }
                    val capture = ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                        .build()

                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                        .also {
                            it.setAnalyzer(
                                analysisExecutor,
                                ImageQualityAnalyzer { report ->
                                    qualityReport = report
                                }
                            )
                        }

                    cameraProvider.unbindAll()
                    val boundCamera = cameraProvider.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        capture,
                        analysis
                    )
                    camera = boundCamera
                    imageCapture = capture
                    applyLighting(lightingMode)
                }, ContextCompat.getMainExecutor(ctx))
                previewView
            }
        )

        AutoDocumentOverlay(
            isQualityOk = qualityReport.isAcceptable,
            modifier = Modifier.fillMaxSize()
        )

        // Barre supérieure : qualité + compteurs asynchrones + alertes erreurs + Flash/Torche
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
                .align(Alignment.TopCenter),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Surface(
                    color = if (qualityReport.isAcceptable) Color(0xCC1B5E20) else Color(0xCCB71C1C),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.weight(1f).padding(end = 12.dp)
                ) {
                    Text(
                        text = qualityReport.hint,
                        color = Color.White,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)
                    )
                }

                IconButton(
                    onClick = { cycleLighting() },
                    modifier = Modifier.background(Color(0x99000000), CircleShape)
                ) {
                    val icon = when (lightingMode) {
                        LightingMode.OFF -> Icons.Default.FlashOff
                        LightingMode.AUTO_FLASH -> Icons.Default.FlashAuto
                        LightingMode.TORCH -> Icons.Default.FlashlightOn
                    }
                    Icon(
                        imageVector = icon,
                        contentDescription = lightingMode.label,
                        tint = if (lightingMode == LightingMode.TORCH) Color.Yellow else Color.White
                    )
                }
            }

            // Barre de statut asynchrone (non bloquante)
            if (pendingCount > 0 || successCount > 0 || failedScans.isNotEmpty()) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    if (pendingCount > 0 || successCount > 0) {
                        Surface(
                            color = Color(0xCC000000),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Text(
                                text = "En cours: $pendingCount · OK: $successCount",
                                color = Color.White,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                            )
                        }
                    }

                    if (failedScans.isNotEmpty()) {
                        Surface(
                            color = Color(0xE6C62828),
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.clickable { showErrorsDialog = true }
                        ) {
                            Row(
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Warning,
                                    contentDescription = "Erreurs",
                                    tint = Color.White,
                                    modifier = Modifier.size(16.dp)
                                )
                                Text(
                                    text = "${failedScans.size} échec(s) — voir",
                                    color = Color.White,
                                    fontWeight = FontWeight.Bold
                                )
                            }
                        }
                    }
                }
            }
        }

        // Zone inférieure : retour instantané + bouton de capture rapide
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 28.dp, start = 16.dp, end = 16.dp)
                .align(Alignment.BottomCenter),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            toastMessage?.let { msg ->
                Surface(
                    color = Color(0xCC000000),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Text(
                        text = msg,
                        color = Color.White,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp)
                    )
                }
                Spacer(modifier = Modifier.height(10.dp))
            }

            FloatingActionButton(
                onClick = { captureAndQueueAsync() },
                shape = CircleShape,
                modifier = Modifier.size(72.dp)
            ) {
                if (isCapturing) {
                    CircularProgressIndicator(modifier = Modifier.size(32.dp))
                } else {
                    Icon(
                        imageVector = Icons.Default.CameraAlt,
                        contentDescription = "Capturer",
                        modifier = Modifier.size(32.dp)
                    )
                }
            }
        }

        if (showErrorsDialog) {
            AlertDialog(
                onDismissRequest = { showErrorsDialog = false },
                title = { Text("Pièces non reconnues (${failedScans.size})") },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        failedScans.forEach { item ->
                            Column {
                                Text(
                                    text = "[${item.time}] ${item.localLabel}",
                                    fontWeight = FontWeight.Bold
                                )
                                Text(text = item.reason)
                            }
                        }
                    }
                },
                confirmButton = {
                    TextButton(onClick = { showErrorsDialog = false }) {
                        Text("Fermer")
                    }
                },
                dismissButton = {
                    TextButton(onClick = {
                        failedScans.clear()
                        showErrorsDialog = false
                    }) {
                        Text("Tout effacer")
                    }
                }
            )
        }
    }
}

@Composable
private fun AutoDocumentOverlay(
    isQualityOk: Boolean,
    modifier: Modifier = Modifier
) {
    Canvas(modifier = modifier) {
        val strokeColor = if (isQualityOk) Color(0xFF4CAF50) else Color.White.copy(alpha = 0.85f)
        val isLandscape = size.width > size.height
        val targetAspectRatio = 1.52f
        val maxWidth = size.width * if (isLandscape) 0.62f else 0.88f
        val maxHeight = size.height * if (isLandscape) 0.70f else 0.50f
        val rectWidth = minOf(maxWidth, maxHeight * targetAspectRatio)
        val rectHeight = rectWidth / targetAspectRatio
        drawRoundRect(
            color = strokeColor,
            topLeft = Offset((size.width - rectWidth) / 2f, (size.height - rectHeight) / 2f),
            size = Size(rectWidth, rectHeight),
            cornerRadius = CornerRadius(24f, 24f),
            style = Stroke(width = 5f)
        )
    }
}

private fun imageProxyToBitmap(image: ImageProxy): Bitmap? {
    val buffer = image.planes.firstOrNull()?.buffer ?: return null
    val bytes = ByteArray(buffer.remaining())
    buffer.get(bytes)
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
}

private fun bitmapToJpeg(bitmap: Bitmap, quality: Int): ByteArray {
    val stream = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream)
    return stream.toByteArray()
}
