chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "PLAY_NOTIFICATION_SOUND") return;

  playChime()
    .then(() => sendResponse({ success: true }))
    .catch((err) => {
      console.warn("[Pohoda Monitor] Sound playback failed:", err);
      sendResponse({ success: false });
    });

  return true;
});

function playChime() {
  return new Promise((resolve, reject) => {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);

    const notes = [
      { freq: 880, start: 0, dur: 0.12 },
      { freq: 1174.66, start: 0.1, dur: 0.18 },
      { freq: 1318.51, start: 0.22, dur: 0.28 }
    ];

    notes.forEach(({ freq, start, dur }) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      osc.connect(gain);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    });

    gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55);

    setTimeout(() => {
      ctx.close().then(resolve).catch(resolve);
    }, 600);
  });
}
