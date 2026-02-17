/**
 * Converts a Float32Array (from AudioContext) to a PCM Int16 Base64 string.
 * This is required for sending audio to the Gemini Live API.
 */
export function float32ToBase64(data: Float32Array): string {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
      // Clamp values between -1 and 1 and scale to Int16 range
      const s = Math.max(-1, Math.min(1, data[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    // Convert Int16Array to binary string
    let binary = '';
    const bytes = new Uint8Array(int16.buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  
  /**
   * Decodes a Base64 PCM string into an AudioBuffer.
   * Gemini Live API returns raw PCM data.
   */
  export function base64ToAudioBuffer(
    base64: string,
    ctx: AudioContext,
    sampleRate: number = 24000
  ): AudioBuffer {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const int16 = new Int16Array(bytes.buffer);
    const frameCount = int16.length;
    
    // Create buffer: 1 channel (mono)
    const buffer = ctx.createBuffer(1, frameCount, sampleRate);
    const channelData = buffer.getChannelData(0);
    
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = int16[i] / 32768.0;
    }
    
    return buffer;
  }