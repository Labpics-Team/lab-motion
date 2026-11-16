package pics.lab.motion

import androidx.compose.runtime.BroadcastFrameClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.math.abs
import kotlin.math.exp
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class MotionControllerTest {
    private class Scene(val test: TestScope) {
        val clock = BroadcastFrameClock()
        val scope = CoroutineScope(test.coroutineContext + Job(test.coroutineContext[Job]) + clock)
        val motion = MotionController(scope)
        fun frame(millis: Long) { test.runCurrent(); clock.sendFrame(millis * 1_000_000); test.runCurrent() }
        fun close() { motion.dispose(); scope.cancel() }
    }

    @Test fun springConvertsMassAndMatchesAnIndependentCriticalDampingSolution() = runTest {
        val scene = Scene(this)
        val spring = MotionSpring(2f, 200f, 40f)
        assertEquals(100f, spring.composeStiffness)
        assertEquals(1f, spring.dampingRatio)
        val x = scene.motion.value(0f)
        val run = scene.motion.animate { to(x, 1f, MotionTransition.Spring(spring)) }
        run.pause()
        for (ms in listOf(25, 50, 100, 200, 400)) {
            run.seek(ms.toFloat())
            val t = ms / 1000.0
            assertEquals((1 - (1 + 10 * t) * exp(-10 * t)).toFloat(), x.value, 0.0001f)
        }
        scene.close()
    }

    @Test fun retargetPreservesVisiblePositionAndNonzeroPhysicalVelocity() = runTest {
        val scene = Scene(this)
        val x = scene.motion.value(0f, "sheet.y")
        val first = scene.motion.animate { to(x, 100f) }
        scene.frame(0); scene.frame(80)
        val pose = x.value
        val speed = x.velocity
        assertTrue(pose > 0f && speed > 0f)
        val second = scene.motion.animate { to(x, -50f) }
        assertEquals(MotionResult.Stopped, first.finished.await())
        assertEquals(pose, x.value, 0.0001f)
        assertEquals(speed, x.velocity, 0.001f)
        scene.frame(80); scene.frame(81)
        assertTrue(x.value > pose, "momentum continues before changing direction: before=$pose after=${x.value} speed=$speed time=${second.timeMillis}")
        second.finish()
        assertEquals(-50f, x.value)
        scene.close()
    }

    @Test fun allPartsShareOneClockAndPauseSeekReverseAndFinishAreObservable() = runTest {
        val scene = Scene(this)
        val rotation = scene.motion.value(0f, "reload.rotate")
        val opacity = scene.motion.value(0f, "reload.opacity")
        val run = scene.motion.animate {
            to(rotation, 360f, MotionTransition.Tween(1000, MotionEase.Linear))
            to(opacity, 1f, MotionTransition.Tween(1000, MotionEase.Linear))
        }
        scene.frame(0); scene.frame(250)
        assertEquals(90f, rotation.value, 0.001f)
        assertEquals(0.25f, opacity.value, 0.0001f)
        run.pause()
        assertFalse(scene.clock.hasAwaiters)
        run.seek(750f)
        assertEquals(270f, rotation.value, 0.001f)
        assertEquals(0f, rotation.velocity)
        run.reverse()
        assertEquals(PlaybackState.Paused, run.state)
        run.play()
        assertTrue(rotation.velocity < 0)
        scene.frame(250); scene.frame(500)
        assertEquals(180f, rotation.value, 0.001f)
        run.finish()
        assertEquals(360f, rotation.value)
        assertEquals(1f, opacity.value)
        assertEquals(MotionResult.Finished, run.finished.await())
        assertFalse(scene.clock.hasAwaiters)
        scene.close()
    }

    @Test fun stopDisposeAndScopeCancellationLeaveNoClockWaiterAndSettleTheOperation() = runTest {
        val scene = Scene(this)
        val x = scene.motion.value(0f)
        val run = scene.motion.animate { to(x, 10f) }
        scene.frame(0); scene.frame(50)
        val pose = x.value
        run.stop()
        run.play(); run.finish(); run.seek(100f)
        assertEquals(pose, x.value)
        assertEquals(MotionResult.Stopped, run.finished.await())
        assertFalse(scene.clock.hasAwaiters)
        val next = scene.motion.animate { to(x, 20f) }
        scene.scope.cancel(); runCurrent()
        assertEquals(MotionResult.Stopped, next.finished.await())
        assertFalse(scene.clock.hasAwaiters)
        scene.motion.dispose(); scene.motion.dispose()
        assertFailsWith<IllegalStateException> { scene.motion.animate { to(x, 30f) } }

        for (hold in listOf<(MotionPlayback) -> Unit>({ it.pause() }, { it.timeScale = 0f })) {
            val heldScene = Scene(this)
            val heldValue = heldScene.motion.value(0f)
            val heldRun = heldScene.motion.animate { to(heldValue, 20f) }
            heldScene.frame(0); heldScene.frame(50)
            val heldPose = heldValue.value
            hold(heldRun)
            assertFalse(heldScene.clock.hasAwaiters)
            heldScene.scope.cancel(); runCurrent()
            assertTrue(heldRun.finished.isCompleted, "Scope cancellation must settle without a clock job")
            assertEquals(MotionResult.Stopped, heldRun.finished.await())
            assertEquals(PlaybackState.Stopped, heldRun.state)
            assertEquals(heldPose, heldValue.value)
            assertFalse(heldScene.clock.hasAwaiters)
            heldScene.motion.dispose()
        }
    }

    @Test fun reducedMotionIsImmediateIncludingAnInFlightPolicyChange() = runTest {
        val scene = Scene(this)
        val x = scene.motion.value(0f)
        val first = scene.motion.animate { to(x, 10f, delayMillis = 1000) }
        scene.motion.reducedMotion = true
        assertEquals(10f, x.value)
        assertEquals(MotionResult.Finished, first.finished.await())
        val next = scene.motion.animate { to(x, 20f) }
        assertEquals(20f, x.value)
        assertEquals(MotionResult.Finished, next.finished.await())
        assertFalse(scene.clock.hasAwaiters)
        scene.close()
    }

    @Test fun malformedReplacementDoesNotInterruptTheAcceptedEffect() = runTest {
        val scene = Scene(this)
        val other = MotionController(scene.scope)
        val x = scene.motion.value(0f)
        val run = scene.motion.animate { to(x, 10f) }
        assertFailsWith<IllegalArgumentException> { scene.motion.animate { to(x, Float.NaN) } }
        assertFailsWith<IllegalArgumentException> { scene.motion.animate { to(other.value(0f), 1f) } }
        assertEquals(PlaybackState.Running, run.state)
        assertFalse(run.finished.isCompleted)
        other.dispose(); scene.close()
    }

    @Test fun keyframeTimingDelayAndSpeedUseTheSameTimeline() = runTest {
        val scene = Scene(this)
        val x = scene.motion.value(0f)
        val run = scene.motion.animate {
            keyframes(x, listOf(10f, 0f), 1000, listOf(0f, .25f, 1f), delayMillis = 100)
        }
        run.timeScale = 2f
        scene.frame(0); scene.frame(25)
        assertEquals(0f, x.value)
        scene.frame(175)
        assertEquals(10f, x.value, 0.001f)
        run.timeScale = 0f
        assertFalse(scene.clock.hasAwaiters)
        val pose = x.value
        scene.frame(500)
        assertEquals(pose, x.value)
        run.timeScale = 1f
        scene.frame(500); scene.frame(1250)
        assertEquals(0f, x.value)
        assertEquals(MotionResult.Finished, run.finished.await())
        scene.close()
    }
}
