package pics.lab.motion

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.TargetBasedAnimation
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.tween
import androidx.compose.runtime.MonotonicFrameClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.DisposableHandle
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.roundToLong

public enum class PlaybackState { Running, Paused, Finished, Stopped, Failed }
public enum class MotionResult { Finished, Stopped }

/**
 * One controller owns one animation job and one frame-clock subscription for all its values.
 * Create and call it on the UI thread, with the composition's coroutine scope. No global scheduler.
 */
public class MotionController(public val scope: CoroutineScope, reducedMotion: Boolean = false) {
    private var disposed = false
    private val values = mutableListOf<MotionValue>()
    private var active: MotionPlayback? = null
    public var reducedMotion: Boolean = reducedMotion
        set(value) {
            checkAlive()
            field = value
            if (value) active?.finish()
        }

    public fun value(initialValue: Float, label: String = ""): MotionValue {
        checkAlive()
        require(initialValue.isFinite()) { "initialValue must be finite" }
        return MotionValue(this, initialValue, label).also(values::add)
    }

    /** Validates and prepares the entire effect before interrupting the current operation. */
    public fun animate(effect: MotionEffect): MotionPlayback {
        checkAlive()
        require(effect.tracks.all { it.value.owner === this }) { "Every MotionValue must belong to this controller" }
        check(scope.coroutineContext[Job]?.isActive != false) { "The motion scope has been cancelled" }
        require(reducedMotion || scope.coroutineContext[MonotonicFrameClock] != null) { "Motion requires a Compose MonotonicFrameClock in its scope" }
        // Compilation samples the visible pose AND its physical velocity before cancellation.
        val compiled = effect.tracks.map(::compile)
        val next = MotionPlayback(scope, compiled)
        active?.stop()
        active = next
        if (reducedMotion) next.finish() else next.play()
        return next
    }

    public fun animate(block: MotionEffectBuilder.() -> Unit): MotionPlayback = animate(motionEffect(block))

    /** Idempotent. Values retain their last pose; no callbacks or clock work survive disposal. */
    public fun dispose() {
        if (disposed) return
        disposed = true
        active?.stop()
        active = null
        values.clear()
    }
    private fun checkAlive() { check(!disposed) { "MotionController is disposed" } }
}

internal data class Segment(val startMillis: Float, val animation: TargetBasedAnimation<Float, AnimationVector1D>) {
    val endMillis: Float = startMillis + animation.durationNanos / 1_000_000f
}
internal data class CompiledTrack(val value: MotionValue, val segments: List<Segment>, val initial: Float, val target: Float) {
    val durationMillis: Float = segments.last().endMillis
}

private fun compile(track: MotionTrack): CompiledTrack {
    val from = track.value.value
    val initialVelocity = track.value.velocity
    val segments = ArrayList<Segment>(track.targets.size)
    var previous = from
    for ((index, target) in track.targets.withIndex()) {
        val transition = track.transition
        val fractionA = track.times?.get(index) ?: index.toFloat() / track.targets.size
        val fractionB = track.times?.get(index + 1) ?: (index + 1f) / track.targets.size
        val spec = when (transition) {
            is MotionTransition.Spring -> transition.parameters.spec()
            is MotionTransition.Tween -> tween<Float>(
                durationMillis = (transition.durationMillis * fractionB).toInt() - (transition.durationMillis * fractionA).toInt(),
                easing = transition.ease.compose(),
            )
        }
        val animation = TargetBasedAnimation(spec, Float.VectorConverter, previous, target,
            initialVelocity = if (index == 0) initialVelocity else 0f)
        val start = if (transition is MotionTransition.Tween) track.delayMillis + (transition.durationMillis * fractionA).toInt().toFloat()
            else track.delayMillis.toFloat()
        val segment = Segment(start, animation)
        require(segment.endMillis.isFinite() && segment.endMillis <= Int.MAX_VALUE.toFloat() / 2) {
            "Effect duration cannot be represented by the Compose backend"
        }
        segments.add(segment)
        previous = target
    }
    return CompiledTrack(track.value, segments, from, track.targets.last())
}

/** Controls belong to one accepted operation. Retargeting settles the previous [finished] as Stopped. */
public class MotionPlayback internal constructor(
    private val scope: CoroutineScope,
    private val tracks: List<CompiledTrack>,
) {
    private var job: Job? = null
    private var revision = 0
    private val completion = CompletableDeferred<MotionResult>()
    // A lifecycle node, not a coroutine or frame waiter: pause/zero speed only stop the clock.
    private val lifetime = Job(scope.coroutineContext[Job])
    private var lifetimeCancellation: DisposableHandle? = null
    public val finished: Deferred<MotionResult> get() = completion
    public var state: PlaybackState by mutableStateOf(PlaybackState.Paused)
        private set
    public val durationMillis: Float = tracks.maxOfOrNull { it.durationMillis } ?: 0f
    public var timeMillis: Float by mutableFloatStateOf(0f)
        private set
    public var timeScale: Float = 1f
        set(value) {
            require(value.isFinite()) { "timeScale must be finite" }
            if (terminal || field == value) return
            field = value
            cancelClock()
            sample()
            if (state == PlaybackState.Running) runClock()
        }
    private val terminal: Boolean get() = state == PlaybackState.Finished || state == PlaybackState.Stopped || state == PlaybackState.Failed

    init {
        lifetimeCancellation = lifetime.invokeOnCompletion { cause -> if (cause != null) stop() }
        completion.invokeOnCompletion { cause -> if (cause is CancellationException) stop() }
    }

    public fun pause() {
        if (terminal || state == PlaybackState.Paused) return
        cancelClock()
        state = PlaybackState.Paused
        sample()
    }
    public fun play() {
        if (terminal || state == PlaybackState.Running) return
        state = PlaybackState.Running
        sample()
        runClock()
    }
    public fun seek(milliseconds: Float) {
        require(milliseconds.isFinite()) { "seek time must be finite" }
        if (terminal) return
        cancelClock()
        timeMillis = milliseconds.coerceIn(0f, durationMillis)
        sample()
        if (state == PlaybackState.Running) runClock()
    }
    public fun reverse() { timeScale = if (timeScale == 0f) -1f else -timeScale }
    /** Holds the current pose. Completion resolves normally, so a retarget is not an application error. */
    public fun stop() {
        if (terminal) return
        cancelClock()
        settle(PlaybackState.Stopped, MotionResult.Stopped)
    }
    public fun finish() {
        if (terminal) return
        cancelClock()
        timeMillis = durationMillis
        Snapshot.withMutableSnapshot { for (track in tracks) { track.value.value = track.target; track.value.velocity = 0f } }
        settle(PlaybackState.Finished, MotionResult.Finished)
    }

    private fun cancelClock() {
        revision++
        job?.cancel()
        job = null
    }
    private fun settle(newState: PlaybackState, result: MotionResult) {
        state = newState
        Snapshot.withMutableSnapshot { for (track in tracks) track.value.velocity = 0f }
        completion.complete(result)
        releaseLifetime()
    }
    private fun releaseLifetime() {
        lifetimeCancellation?.dispose()
        lifetimeCancellation = null
        lifetime.complete()
    }
    private fun runClock() {
        if (terminal || timeScale == 0f) return
        val destination = if (timeScale > 0f) durationMillis else 0f
        val distance = abs(destination - timeMillis)
        if (distance == 0f) {
            sample()
            settle(PlaybackState.Finished, MotionResult.Finished)
            return
        }
        val wallDuration = ceil(distance.toDouble() / abs(timeScale)).coerceAtMost(Int.MAX_VALUE.toDouble()).toInt()
        require(wallDuration > 0) { "Playback duration is not representable" }
        val runRevision = revision
        val clock = Animatable(timeMillis)
        job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                clock.animateTo(destination, tween(wallDuration, easing = LinearEasing), initialVelocity = 0f) {
                    if (runRevision == revision) {
                        timeMillis = value
                        sample()
                    }
                }
                if (runRevision == revision) settle(PlaybackState.Finished, MotionResult.Finished)
            } catch (error: CancellationException) {
                // An intentional control already moved revision. Parent-scope cancellation still settles callers.
                if (runRevision == revision) settle(PlaybackState.Stopped, MotionResult.Stopped)
                throw error
            } catch (error: Throwable) {
                if (runRevision == revision) {
                    state = PlaybackState.Failed
                    Snapshot.withMutableSnapshot { for (track in tracks) track.value.velocity = 0f }
                    completion.completeExceptionally(error)
                    releaseLifetime()
                }
            }
        }
    }
    private fun sample() {
        val physicalRate = if (state == PlaybackState.Running) timeScale else 0f
        Snapshot.withMutableSnapshot {
            for (track in tracks) {
                val handle = track.value
                if (timeMillis >= track.durationMillis) {
                    handle.value = track.target
                    handle.velocity = 0f
                    continue
                }
                var index = track.segments.lastIndex
                while (index > 0 && track.segments[index].startMillis > timeMillis) index--
                val segment = track.segments[index]
                if (timeMillis < segment.startMillis) {
                    handle.value = track.initial
                    handle.velocity = 0f
                } else {
                    val elapsed = ((timeMillis - segment.startMillis) * 1_000_000.0).roundToLong()
                    handle.value = segment.animation.getValueFromNanos(elapsed)
                    handle.velocity = segment.animation.getVelocityVectorFromNanos(elapsed).value * physicalRate
                    check(handle.value.isFinite() && handle.velocity.isFinite()) { "Non-finite sample for ${handle.label}" }
                }
            }
        }
    }
}
