package com.jae.scanner.quality

import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import kotlin.math.max
import kotlin.math.min

data class QualityReport(
    val blurScore: Double = 0.0,
    val isSharp: Boolean = false,
    val glareRatio: Double = 0.0,
    val hasGlare: Boolean = false,
    val contrastRange: Int = 0,
    val hasGoodContrast: Boolean = false
) {
    val isAcceptable: Boolean
        get() = isSharp && !hasGlare && hasGoodContrast

    val hint: String
        get() = when {
            hasGlare -> "Image surexposée ou reflet fort : inclinez ou coupez le flash"
            !isSharp -> "Image floue : stabilisez l'appareil"
            !hasGoodContrast -> "Contraste faible : améliorez l'éclairage"
            else -> "Qualité OK — prêt à scanner"
        }
}

/**
 * Analyseur temps réel sur le plan Y (luminance) de CameraX.
 * Utilise des seuils équilibrés compatibles aussi bien avec les pièces d'identité
 * qu'avec les attestations papier ou les écrans Ten'Up en mode clair.
 */
class ImageQualityAnalyzer(
    private val blurThreshold: Double = 80.0,
    private val glarePixelThreshold: Int = 254,
    private val glareRatioThreshold: Double = 0.40,
    private val contrastThreshold: Int = 45,
    private val onReport: (QualityReport) -> Unit
) : ImageAnalysis.Analyzer {

    private var lastAnalyzedMs = 0L

    override fun analyze(image: ImageProxy) {
        try {
            val now = System.currentTimeMillis()
            if (now - lastAnalyzedMs < 200L) return
            lastAnalyzedMs = now

            val yPlane = image.planes[0]
            val buffer = yPlane.buffer
            val rowStride = yPlane.rowStride
            val width = image.width
            val height = image.height

            val xStart = (width * 0.20).toInt().coerceAtLeast(1)
            val xEnd = (width * 0.80).toInt().coerceAtMost(width - 2)
            val yStart = (height * 0.20).toInt().coerceAtLeast(1)
            val yEnd = (height * 0.80).toInt().coerceAtMost(height - 2)

            var lapSum = 0.0
            var lapSqSum = 0.0
            var lapCount = 0

            var brightPixels = 0
            var totalPixels = 0
            var minLuma = 255
            var maxLuma = 0

            val step = 2
            var y = yStart
            while (y < yEnd) {
                val rowOffset = y * rowStride
                val prevRowOffset = (y - 1) * rowStride
                val nextRowOffset = (y + 1) * rowStride
                var x = xStart
                while (x < xEnd) {
                    val center = buffer.get(rowOffset + x).toInt() and 0xFF
                    if (center >= glarePixelThreshold) brightPixels++
                    minLuma = min(minLuma, center)
                    maxLuma = max(maxLuma, center)
                    totalPixels++

                    val top = buffer.get(prevRowOffset + x).toInt() and 0xFF
                    val bottom = buffer.get(nextRowOffset + x).toInt() and 0xFF
                    val left = buffer.get(rowOffset + x - 1).toInt() and 0xFF
                    val right = buffer.get(rowOffset + x + 1).toInt() and 0xFF

                    val lap = (top + bottom + left + right - 4 * center).toDouble()
                    lapSum += lap
                    lapSqSum += lap * lap
                    lapCount++

                    x += step
                }
                y += step
            }

            val blurVariance = if (lapCount > 0) {
                val mean = lapSum / lapCount
                (lapSqSum / lapCount) - (mean * mean)
            } else {
                0.0
            }

            val glareRatio = if (totalPixels > 0) brightPixels.toDouble() / totalPixels else 0.0
            val contrastRange = (maxLuma - minLuma).coerceAtLeast(0)

            onReport(
                QualityReport(
                    blurScore = blurVariance,
                    isSharp = blurVariance >= blurThreshold,
                    glareRatio = glareRatio,
                    hasGlare = glareRatio > glareRatioThreshold,
                    contrastRange = contrastRange,
                    hasGoodContrast = contrastRange >= contrastThreshold
                )
            )
        } finally {
            image.close()
        }
    }
}
