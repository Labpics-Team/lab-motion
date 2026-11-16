package pics.lab.motion

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.SpringSpec
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.setValue
import kotlin.math.PI
import kotlin.math.sqrt

/** Stable observable handle. Read [value] in drawing/layout to avoid recomposing unrelated UI. */
public class MotionValue internal constructor(
    internal val owner: MotionController,
    initialValue: Float,
    public val label: String,
) {
    public var value: Float by mutableFloatStateOf(initialValue)
        internal set
    /** Physical value units per second, including playback direction and speed. */
    public var velocity: Float by mutableFloatStateOf(0f)
        internal set
}

/** The same mass/stiffness/damping contract as Lab Motion; Compose's unit mass is explicit. */
public data class MotionSpring(
    public val mass: Float,
    public val stiffness: Float,
    public val damping: Float,
    public val visibilityThreshold: Float = 0.001f,
) {
    init {
        require(mass.isFinite() && mass > 0) { "spring.mass must be finite and positive" }
        require(stiffness.isFinite() && stiffness > 0) { "spring.stiffness must be finite and positive" }
        require(damping.isFinite() && damping > 0) { "spring.damping must be finite and positive (undamped motion cannot finish)" }
        require(visibilityThreshold.isFinite() && visibilityThreshold > 0) { "spring.visibilityThreshold must be finite and positive" }
        require(composeStiffness.isFinite() && composeStiffness > 0 && dampingRatio.isFinite() && dampingRatio > 0) {
            "spring parameters cannot be represented by the Compose backend"
        }
    }
    public val composeStiffness: Float get() = stiffness / mass
    public val dampingRatio: Float get() = (damping.toDouble() / (2 * sqrt(stiffness.toDouble() * mass))).toFloat()
    internal fun spec(): SpringSpec<Float> = SpringSpec(dampingRatio, composeStiffness, visibilityThreshold)

    public companion object {
        /** response is the natural period in milliseconds; bounce = 1 - damping ratio. */
        public fun response(responseMillis: Float, bounce: Float = 0f): MotionSpring {
            require(responseMillis.isFinite() && responseMillis > 0) { "responseMillis must be finite and positive" }
            require(bounce.isFinite() && bounce >= 0 && bounce < 1) { "bounce must be in [0, 1)" }
            val frequency = 2 * PI * 1000 / responseMillis
            return MotionSpring(1f, (frequency * frequency).toFloat(), (2 * (1 - bounce) * frequency).toFloat())
        }
    }
}

public sealed interface MotionTransition {
    public data class Spring(public val parameters: MotionSpring = MotionSpring(MotionDefaults.Mass, MotionDefaults.Stiffness, MotionDefaults.Damping)) : MotionTransition
    public data class Tween(public val durationMillis: Int = MotionDefaults.DurationMillis, public val ease: MotionEase = MotionEase.Standard) : MotionTransition {
        init { require(durationMillis >= 0) { "durationMillis must not be negative" } }
    }
}

public sealed interface MotionEase {
    public data object Linear : MotionEase
    public data object Standard : MotionEase
    public data class Bezier(public val x1: Float, public val y1: Float, public val x2: Float, public val y2: Float) : MotionEase {
        init {
            require(x1.isFinite() && y1.isFinite() && x2.isFinite() && y2.isFinite() && x1 in 0f..1f && x2 in 0f..1f) {
                "Bezier coordinates must be finite, x1 and x2 in [0, 1]"
            }
        }
    }
}
internal fun MotionEase.compose(): Easing = when (this) {
    MotionEase.Linear -> LinearEasing
    MotionEase.Standard -> CubicBezierEasing(MotionDefaults.EaseX1, MotionDefaults.EaseY1, MotionDefaults.EaseX2, MotionDefaults.EaseY2)
    is MotionEase.Bezier -> CubicBezierEasing(x1, y1, x2, y2)
}

/** A prepared effect has no clock or renderer dependency; it binds only typed scalar handles. */
public class MotionEffect internal constructor(internal val tracks: List<MotionTrack>)
internal data class MotionTrack(
    val value: MotionValue,
    val targets: List<Float>,
    val transition: MotionTransition,
    val times: List<Float>?,
    val delayMillis: Int,
)

public class MotionEffectBuilder internal constructor() {
    internal val tracks = mutableListOf<MotionTrack>()

    /** Continues from the visible pose. Spring transitions also continue physical velocity. */
    public fun to(value: MotionValue, target: Float, transition: MotionTransition = MotionTransition.Spring(), delayMillis: Int = 0) {
        add(value, listOf(target), transition, null, delayMillis)
    }

    /** Targets exclude the current pose. [times] includes its zero time and ends at one. */
    public fun keyframes(value: MotionValue, targets: List<Float>, durationMillis: Int, times: List<Float>? = null,
                         ease: MotionEase = MotionEase.Linear, delayMillis: Int = 0) {
        add(value, targets, MotionTransition.Tween(durationMillis, ease), times, delayMillis)
    }

    private fun add(value: MotionValue, targets: List<Float>, transition: MotionTransition, times: List<Float>?, delayMillis: Int) {
        require(targets.isNotEmpty() && targets.all { it.isFinite() }) { "targets must be nonempty and finite" }
        require(delayMillis >= 0) { "delayMillis must not be negative" }
        require(tracks.none { it.value === value }) { "An effect may write a MotionValue only once: ${value.label}" }
        if (times != null) {
            require(times.size == targets.size + 1 && times.first() == 0f && times.last() == 1f &&
                times.all { it.isFinite() } && times.zipWithNext().all { (a, b) -> a < b }) {
                "times must increase from 0 to 1 and include the current pose"
            }
        }
        tracks.add(MotionTrack(value, targets.toList(), transition, times?.toList(), delayMillis))
    }
}

public fun motionEffect(block: MotionEffectBuilder.() -> Unit): MotionEffect =
    MotionEffect(MotionEffectBuilder().apply(block).tracks.toList())
