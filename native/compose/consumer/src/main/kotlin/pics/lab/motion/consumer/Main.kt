package pics.lab.motion.consumer

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.coroutines.withTimeout
import pics.lab.motion.*
import java.awt.Rectangle
import java.awt.Robot
import java.io.File
import javax.imageio.ImageIO
import kotlin.math.abs

/** A renderer's prepared path and scalar handles: no SVG parsing or string lookup per frame. */
private class PreparedPart(motion: MotionController) {
    val rotation = motion.value(0f, "reload.rotate")
    val opacity = motion.value(1f, "reload.opacity")
    val path = Path().apply { moveTo(76f, 22f); lineTo(96f, 22f); lineTo(96f, 42f) }
}

fun main(args: Array<String>) {
    if ("--verify" in args) { verifyInstalledArtifact(); return }
    application {
        Window(onCloseRequest = ::exitApplication, title = "Lab Motion · Native", state = rememberWindowState(width = 640.dp, height = 440.dp)) {
            val scope = rememberCoroutineScope()
            val motion = remember { MotionController(scope) }
            val part = remember { PreparedPart(motion) }
            var turn by remember { mutableIntStateOf(0) }
            var reduced by remember { mutableStateOf(false) }
            DisposableEffect(motion) { onDispose { motion.dispose() } }
            fun turn(): MotionPlayback {
                turn++
                return motion.animate {
                    to(part.rotation, turn * 180f, MotionTransition.Spring(MotionSpring.response(420f, .2f)))
                    keyframes(part.opacity, listOf(.35f, 1f), 450)
                }
            }
            Column(Modifier.fillMaxSize().background(Color(0xff101115)).padding(36.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                BasicText("Один жест. Один таймлайн.", style = TextStyle(Color.White, 25.sp))
                BasicText("Нативное движение заранее подготовленных частей", style = TextStyle(Color(0xff9da3b5), 15.sp))
                Canvas(Modifier.size(120.dp)) {
                    scale(size.width / 120f, size.height / 120f, Offset.Zero) {
                        rotate(part.rotation.value, Offset(60f, 60f)) {
                            drawArc(Color(0xff92a5ff).copy(alpha = part.opacity.value.coerceIn(0f, 1f)), -45f, 290f, false, Offset(24f, 24f), androidx.compose.ui.geometry.Size(72f, 72f), style = Stroke(7f))
                            drawPath(part.path, Color(0xff92a5ff).copy(alpha = part.opacity.value.coerceIn(0f, 1f)), style = Stroke(7f))
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    BasicText("Повернуть ↗", Modifier.clickable { turn() }.padding(12.dp), TextStyle(Color.White, 17.sp))
                    BasicText(if (reduced) "Движение отключено" else "Уменьшить движение", Modifier.clickable {
                        reduced = !reduced
                        motion.reducedMotion = reduced
                    }.padding(12.dp), TextStyle(Color(0xffb9c4ff), 17.sp))
                }
            }
            if ("--smoke" in args) LaunchedEffect(Unit) {
                window.isAlwaysOnTop = true
                window.toFront()
                turn(); delay(80)
                withTimeout(5000) { check(turn().finished.await() == MotionResult.Finished) }
                check(abs(part.rotation.value - 360f) < .1f)
                motion.reducedMotion = true
                turn()
                check(part.rotation.value == 540f && part.opacity.value == 1f)
                delay(80)
                val content = window.contentPane
                val at = content.locationOnScreen
                val output = File("build/native-consumer.png").apply { parentFile.mkdirs() }
                ImageIO.write(Robot().createScreenCapture(Rectangle(at.x, at.y, content.width, content.height)), "png", output)
                motion.dispose()
                println("Native window: rendered, retargeted, reduced motion, disposed. Screenshot: ${output.absolutePath}")
                exitApplication()
            }
        }
    }
}

/** Runs against Maven artifacts only, with the same broadcast frame clock used by Compose. */
private fun verifyInstalledArtifact() = runBlocking {
    val clock = BroadcastFrameClock()
    val motion = MotionController(CoroutineScope(coroutineContext + clock))
    val rotation = motion.value(0f, "part.rotate")
    val opacity = motion.value(1f, "part.opacity")
    suspend fun frame(ms: Long) { clock.sendFrame(ms * 1_000_000); yield() }
    val first = motion.animate { to(rotation, 180f); to(opacity, .4f) }
    frame(0); frame(100)
    val pose = rotation.value
    val speed = rotation.velocity
    check(pose > 0f && speed > 0f)
    val second = motion.animate { to(rotation, -90f); to(opacity, 1f) }
    check(first.finished.await() == MotionResult.Stopped)
    check(abs(rotation.value - pose) < .001f && abs(rotation.velocity - speed) < .001f)
    second.pause(); check(!clock.hasAwaiters)
    second.seek(100f); second.reverse(); second.play()
    frame(100); frame(110)
    check(rotation.value.isFinite() && opacity.value.isFinite())
    motion.reducedMotion = true
    check(rotation.value == -90f && opacity.value == 1f)
    check(second.finished.await() == MotionResult.Finished && !clock.hasAwaiters)
    motion.reducedMotion = false
    val third = motion.animate { to(rotation, 360f) }
    motion.dispose()
    check(third.finished.await() == MotionResult.Stopped && !clock.hasAwaiters)
    println("Installed Maven artifact: shared clock, retarget pose/velocity, controls, reduced motion, disposal PASS")
}
