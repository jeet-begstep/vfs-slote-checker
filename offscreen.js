// Hidden page whose only job is to play the notification sound,
// because MV3 service workers have no Audio/DOM APIs.

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'play-sound') return;

  const audio = new Audio(msg.source);
  audio.volume = typeof msg.volume === 'number' ? msg.volume : 0.7;
  audio.play().catch((err) => console.warn('Audio play rejected:', err));
});
