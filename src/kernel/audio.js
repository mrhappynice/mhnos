// src/kernel/audio.js

let audioCtx = null;

// Initialize the "Sound Card" (Must be triggered by user interaction first)
export function init() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

// Play a synthesized tone (Beep)
export function playTone(frequency, duration, type = 'sine', volume = 0.1) {
    if (!audioCtx) init();
    
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = type; // sine, square, sawtooth, triangle
    osc.frequency.value = frequency;

    // Connect: Oscillator -> Gain -> Speakers
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    // Envelope (fade out slightly to avoid clicking)
    const now = audioCtx.currentTime;
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.start(now);
    osc.stop(now + duration);
}