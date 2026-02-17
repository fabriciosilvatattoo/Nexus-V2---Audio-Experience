import React, { useEffect, useState, useRef } from 'react';
import { TextChunk } from '../types';
import { generateSpeech } from '../services/geminiService';

interface AudioPlayerProps {
  currentChunk: TextChunk;
  nextChunk?: TextChunk;
  isPlaying: boolean;
  onPlayPause: () => void;
  onNext: () => void;
  onPrev: () => void;
  onFinish: () => void;
}

// Global cache to persist audio between re-renders and navigation
const audioCache = new Map<number, AudioBuffer>();

const AudioPlayer: React.FC<AudioPlayerProps> = ({ 
  currentChunk, 
  nextChunk,
  isPlaying, 
  onPlayPause, 
  onNext, 
  onPrev,
  onFinish
}) => {
  const [progress, setProgress] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryTrigger, setRetryTrigger] = useState(0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const startTimeRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);
  const loadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Initialize AudioContext
  useEffect(() => {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    audioContextRef.current = new AudioContextClass({ sampleRate: 24000 });
    
    return () => {
      stopPlayback();
      audioContextRef.current?.close();
    };
  }, []);

  // Helper: Stop current playback and loop
  const stopPlayback = () => {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch(e) {}
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
  };

  // Helper: Decode PCM Base64 to AudioBuffer
  const decodeAudio = (base64: string, ctx: AudioContext): AudioBuffer => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const pcm16 = new Int16Array(bytes.buffer);
    const frameCount = pcm16.length;
    const audioBuffer = ctx.createBuffer(1, frameCount, 24000);
    const channelData = audioBuffer.getChannelData(0);
    
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = pcm16[i] / 32768.0;
    }
    return audioBuffer;
  };

  const playBuffer = (buffer: AudioBuffer) => {
    if (!audioContextRef.current) return;
    const ctx = audioContextRef.current;

    stopPlayback();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    
    source.start(0);
    sourceRef.current = source;
    startTimeRef.current = ctx.currentTime;
    
    // Progress Loop
    const updateProgress = () => {
      if (ctx.state === 'running') {
        const elapsed = ctx.currentTime - startTimeRef.current;
        const duration = buffer.duration;
        
        if (elapsed >= duration) {
           setProgress(100);
           onFinish();
           stopPlayback();
           return;
        }

        const p = Math.min((elapsed / duration) * 100, 100);
        setProgress(p);
      }
      animationFrameRef.current = requestAnimationFrame(updateProgress);
    };
    
    animationFrameRef.current = requestAnimationFrame(updateProgress);
  };

  // Load and Play Logic with Debounce
  useEffect(() => {
    let active = true;

    const loadAudio = async () => {
        if (!audioContextRef.current) return;
        
        // Reset state for new chunk
        stopPlayback();
        setProgress(0);
        setError(null);
        setIsLoading(true);

        try {
            // Check cache immediately
            let buffer = audioCache.get(currentChunk.id);
            
            if (!buffer) {
                // Not in cache, fetch from API
                const base64 = await generateSpeech(currentChunk.content);
                if (!active) return;
                buffer = decodeAudio(base64, audioContextRef.current);
                audioCache.set(currentChunk.id, buffer);
            }

            if (active) {
                setIsLoading(false);
                if (isPlaying) {
                   if (audioContextRef.current.state === 'suspended') {
                       await audioContextRef.current.resume();
                   }
                   playBuffer(buffer);
                }
            }
        } catch (err) {
            console.error("Audio Load Error:", err);
            if (active) {
                setError("Cota excedida ou erro de rede.");
                setIsLoading(false);
            }
        }
    };

    // DEBOUNCE LOGIC:
    // If we have the audio in cache, play immediately.
    // If not, wait 1s before fetching to prevent spamming API on rapid skips.
    if (audioCache.has(currentChunk.id)) {
        loadAudio();
    } else {
        if (loadingTimeoutRef.current) clearTimeout(loadingTimeoutRef.current);
        loadingTimeoutRef.current = setTimeout(loadAudio, 1000);
    }

    return () => { 
        active = false; 
        if (loadingTimeoutRef.current) clearTimeout(loadingTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChunk, retryTrigger]); 

  // Play/Pause Toggle Effect
  useEffect(() => {
    if (!audioContextRef.current) return;
    const ctx = audioContextRef.current;

    const toggle = async () => {
        if (isPlaying) {
            await ctx.resume();
            
            // If stopped (finished) and user clicks play again, or initial load
            const buffer = audioCache.get(currentChunk.id);
            if (buffer && !sourceRef.current && !isLoading && !error) {
                 playBuffer(buffer);
            }
        } else {
            await ctx.suspend();
        }
    };
    toggle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-nexus-900 border-t border-nexus-800 p-4 pb-6 shadow-2xl z-50">
      <div className="max-w-4xl mx-auto flex flex-col gap-2">
        
        {/* Progress Bar */}
        <div className="w-full h-1 bg-nexus-800 rounded-full overflow-hidden mb-2 relative">
           {isLoading && (
              <div className="absolute inset-0 bg-nexus-800 overflow-hidden">
                  <div className="h-full bg-nexus-500/30 w-1/3 animate-[shimmer_1s_infinite] translate-x-[-100%]"></div>
              </div>
           )}
          <div 
            className={`h-full transition-all duration-100 ease-linear ${error ? 'bg-red-500' : 'bg-nexus-accent'}`}
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <span className={`text-xs font-bold tracking-wider uppercase ${error ? 'text-red-400' : 'text-nexus-400'}`}>
                {isLoading ? 'Carregando Áudio...' : (error ? 'Erro (Cota/Rede)' : 'Reproduzindo')}
            </span>
            <span className="text-white text-sm font-medium truncate max-w-[150px] sm:max-w-xs md:max-w-md">
              {currentChunk.title}
            </span>
          </div>

          <div className="flex items-center gap-4 sm:gap-6">
            <button 
              onClick={onPrev}
              className="text-slate-400 hover:text-white transition-colors"
              aria-label="Anterior"
              disabled={isLoading && !error}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5"></line></svg>
            </button>

            {error ? (
              <button 
                onClick={() => setRetryTrigger(prev => prev + 1)}
                className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white text-xs font-bold rounded-full uppercase tracking-wide transition-colors"
              >
                Tentar Novamente
              </button>
            ) : (
              <button 
                onClick={onPlayPause}
                disabled={isLoading && !audioCache.has(currentChunk.id)}
                className={`w-12 h-12 flex items-center justify-center rounded-full text-white shadow-lg shadow-nexus-500/30 transition-all transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed ${
                    error ? 'bg-red-500 hover:bg-red-600' : 'bg-nexus-500 hover:bg-nexus-400'
                }`}
              >
                {isLoading && !audioCache.has(currentChunk.id) ? (
                   <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                     <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                     <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                   </svg>
                ) : isPlaying ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                )}
              </button>
            )}

            <button 
              onClick={onNext}
              className="text-slate-400 hover:text-white transition-colors"
              aria-label="Próximo"
              disabled={isLoading && !error}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>
            </button>
          </div>
        </div>
      </div>
      <style>{`
        @keyframes shimmer {
            100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  );
};

export default AudioPlayer;