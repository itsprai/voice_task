// VoiceRecorder — unchanged from v1
// Wraps Web Speech API and dispatches custom events:
//   voice:start  voice:interim  voice:result  voice:end  voice:error

class VoiceRecorder {
  constructor() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { this.supported = false; return; }
    this.supported    = true;
    this.recognition  = new SR();
    this.recognition.continuous     = true;
    this.recognition.interimResults = true;
    this.recognition.lang           = 'en-US';
    this.listening    = false;
    this._transcript  = '';
    this._bind();
  }

  _bind() {
    this.recognition.onstart = () => {
      this.listening   = true;
      this._transcript = '';
      document.dispatchEvent(new CustomEvent('voice:start'));
    };

    this.recognition.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) this._transcript += e.results[i][0].transcript + ' ';
        else interim += e.results[i][0].transcript;
      }
      const display = (this._transcript + interim).trim();
      if (display) document.dispatchEvent(new CustomEvent('voice:interim', { detail: display }));
    };

    this.recognition.onerror = e => {
      this.listening = false;
      const messages = {
        'not-allowed':    'Microphone access denied. Enable it in your browser settings.',
        'no-speech':      'Nothing heard. Tap again and speak clearly.',
        'network':        'Network error. Check your connection.',
        'audio-capture':  'No microphone found on this device.'
      };
      document.dispatchEvent(new CustomEvent('voice:error', {
        detail: messages[e.error] || 'Microphone error. Please try again.'
      }));
    };

    this.recognition.onend = () => {
      this.listening = false;
      const full = this._transcript.trim();
      if (full) document.dispatchEvent(new CustomEvent('voice:result', { detail: full }));
      document.dispatchEvent(new CustomEvent('voice:end'));
    };
  }

  start() {
    if (!this.supported) {
      document.dispatchEvent(new CustomEvent('voice:error', {
        detail: 'Voice input not supported. Use Chrome on Android or Safari on iOS.'
      }));
      return;
    }
    if (this.listening) { this.recognition.stop(); return; }
    try { this.recognition.start(); }
    catch { document.dispatchEvent(new CustomEvent('voice:error', { detail: 'Could not start microphone. Try again.' })); }
  }

  stop() { if (this.listening) this.recognition.stop(); }
}
