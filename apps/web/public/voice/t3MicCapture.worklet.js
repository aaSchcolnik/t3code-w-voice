class T3MicCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      let sum = 0;
      for (let i = 0; i < channel.length; i++) {
        const sample = channel[i] || 0;
        sum += sample * sample;
      }
      // Computed access avoids oxlint treating MessagePort.postMessage as Window.postMessage.
      this.port["postMessage"]({
        samples: channel.slice(0),
        rms: Math.sqrt(sum / Math.max(1, channel.length)),
      });
    }
    return true;
  }
}

registerProcessor("t3-mic-capture", T3MicCapture);
