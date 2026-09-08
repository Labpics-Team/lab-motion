#!/usr/bin/env python3
"""Original, deterministic sound design for the 18-second Lab Motion film.

0–3s: almost silent air. 3 / 5.6s: small, soft edit accents.
6–8.6s: rising air. 8.6s: a restrained low pulse at the macro cut.
9–9.8s: an exhale as motion brakes. 10.8–13.8s: quiet pullback.
The beginning and ending are silent for a clean loop. No samples or music.

Requires NumPy and SciPy. Run: python scripts/preview/sound.py [output.wav]
"""

from pathlib import Path
import sys
import wave

import numpy as np
from scipy.signal import butter, sosfilt


RATE = 48_000
DURATION = 18.0
PEAK_DBFS = -6.0
FRAMES = round(RATE * DURATION)
RNG = np.random.default_rng(240908)
TIME = np.arange(FRAMES) / RATE


def smoothstep(x):
    """An eased, bounded transition with zero slope at either end."""
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def envelope(knots):
    result = np.zeros(FRAMES)
    for (start, a), (end, b) in zip(knots, knots[1:]):
        active = (TIME >= start) & (TIME < end)
        result[active] = a + (b - a) * smoothstep(
            (TIME[active] - start) / (end - start)
        )
    return result


def filtered_noise(low, high):
    """Smooth correlated air, normalized by RMS rather than a random peak."""
    raw = RNG.standard_normal(FRAMES)
    sos = butter(3, [low, high], btype="bandpass", fs=RATE, output="sos")
    noise = sosfilt(sos, raw)
    return noise / np.sqrt(np.mean(noise * noise))


def stereo_air(low, high, gain, width=0.25):
    center = filtered_noise(low, high)
    side = filtered_noise(low, high) * width
    return np.column_stack((center + side, center - side)) * gain[:, None]


def place(stereo, mono, at, gain=1.0, pan=0.0):
    start = round(at * RATE)
    count = min(len(mono), FRAMES - start)
    # Equal-power panning stays useful on headphones and when folded to mono.
    angle = (pan + 1.0) * np.pi / 4.0
    stereo[start:start + count, 0] += mono[:count] * gain * np.cos(angle)
    stereo[start:start + count, 1] += mono[:count] * gain * np.sin(angle)


def edit_touch(duration=0.17):
    """A soft felt touch, without the sharp edge of a UI click."""
    t = np.arange(round(duration * RATE)) / RATE
    contact = np.sin(2 * np.pi * 630 * t) * np.exp(-t / 0.012)
    body = np.sin(2 * np.pi * 185 * t) * np.exp(-t / 0.030)
    tap = (0.13 * contact + 0.31 * body) * smoothstep(t / 0.004)
    return tap * (1 - smoothstep((t - duration + 0.035) / 0.035))


def macro_pulse():
    """A short controlled pressure pulse, intentionally neither a boom nor a note."""
    t = np.arange(round(0.8 * RATE)) / RATE
    body = np.sin(2 * np.pi * 68 * t)
    detail = 0.17 * np.sin(2 * np.pi * 137 * t + 0.4)
    gain = smoothstep(t / 0.024) * np.exp(-t / 0.14)
    gain *= 1 - smoothstep((t - 0.59) / 0.21)
    return (body + detail) * gain


def render():
    bed = envelope([
        (0, 0), (0.5, 0.0006), (2.6, 0.0008), (3.1, 0.0014),
        (5.2, 0.0010), (5.6, 0.0018), (7.5, 0.0035),
        (8.6, 0.0042), (9.0, 0.0032), (9.8, 0.00035),
        (10.8, 0.0004), (12.0, 0.0013), (13.8, 0.0010),
        (16.0, 0.0004), (17.3, 0), (18, 0),
    ])
    result = stereo_air(360, 2_100, bed, width=0.18)

    # The accelerating layer opens spectrally, but remains quiet beneath the
    # low pulse. Its withdrawal makes the braking moment perceptible.
    rise = envelope([
        (0, 0), (5.85, 0), (6.8, 0.0016), (7.8, 0.006),
        (8.48, 0.009), (8.62, 0.0017), (9.0, 0.0013),
        (9.65, 0), (18, 0),
    ])
    result += stereo_air(900, 4_200, rise, width=0.36)

    brake = envelope([
        (0, 0), (8.95, 0), (9.10, 0.0065), (9.35, 0.007),
        (9.78, 0), (18, 0),
    ])
    result += stereo_air(170, 980, brake, width=0.14)

    # Two cuts receive touches; leaving the pullback unpunctuated avoids
    # making every camera decision sound like an interface notification.
    place(result, edit_touch(), 3.0, gain=0.28, pan=-0.10)
    place(result, edit_touch(), 5.6, gain=0.23, pan=0.10)
    place(result, macro_pulse(), 8.6, gain=0.43)

    # Remove residual DC, then use broad fades rather than a limiter. The
    # final 0.7 seconds and initial sample are exactly silent.
    result -= result.mean(axis=0)
    loop_fade = smoothstep(TIME / 0.15)
    loop_fade *= 1 - smoothstep((TIME - 16.8) / 0.5)
    result *= loop_fade[:, None]
    result *= (10 ** (PEAK_DBFS / 20)) / np.max(np.abs(result))
    return result


def main():
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_suffix(".wav")
    result = render()
    pcm = np.rint(result * 32767).astype("<i2")
    with wave.open(str(target), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(pcm.tobytes())

    measured = pcm.astype(np.float64) / 32768
    peak = np.max(np.abs(measured))
    rms = np.sqrt(np.mean(measured * measured))
    print(f"{target}: {DURATION:.1f}s, {RATE}Hz, stereo PCM16")
    print(f"Peak: {20 * np.log10(peak):.2f} dBFS; RMS: {20 * np.log10(rms):.2f} dBFS")
    print(f"Loop endpoints: {pcm[0].tolist()} / {pcm[-1].tolist()}")


if __name__ == "__main__":
    main()
