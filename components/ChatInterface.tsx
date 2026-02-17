
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage } from "@google/genai";
import { ChatMessage, MessageRole } from '../types';
import { sendMessageToNexus, generateSpeech } from '../services/geminiService';
import { SYSTEM_INSTRUCTION } from '../constants';
import { float32ToBase64, base64ToAudioBuffer } from '../utils/audioUtils';

interface ChatInterfaceProps {
  // Removed props as it is now main component
}

const ChatInterface: React.FC<ChatInterfaceProps> = () => {
  // --- Text Chat State ---
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: MessageRole.MODEL,
      text: "Olá! Sou o Nexus V2. Posso ajudar com textos, código ou criar imagens para explicar conceitos. Sobre o que vamos conversar hoje?",
      timestamp: new Date()
    }
  ]);
  const [input, setInput] = useState('');
  const [isTextLoading, setIsTextLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // --- Live Voice State ---
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [voiceVolume, setVoiceVolume] = useState(0); 
  const [aiSpeaking, setAiSpeaking] = useState(false); 

  // --- Robust Audio Refs ---
  const liveClientRef = useRef<GoogleGenAI | null>(null);
  const liveSessionRef = useRef<Promise<any> | null>(null);
  
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const mountedRef = useRef(true);
  const isInterruptedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!isVoiceMode) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isVoiceMode]);

  // --- Interaction Logic ---

  const handleSendText = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isTextLoading) return;

    if (isVoiceMode) {
        stopAudioOutput();
        isInterruptedRef.current = true;
    }

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: MessageRole.USER,
      text: input,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMsg]);
    const textToSend = input;
    setInput('');
    setIsTextLoading(true);

    try {
      const response = await sendMessageToNexus(messages, textToSend);
      
      const botMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: MessageRole.MODEL,
        text: response.text,
        image: response.image, // Handle image
        timestamp: new Date()
      };
      setMessages(prev => [...prev, botMsg]);

      // Speak response in voice mode (Hybrid)
      if (isVoiceMode && mountedRef.current) {
          try {
              const base64Audio = await generateSpeech(response.text);
              if (outputAudioContextRef.current) {
                  const buffer = base64ToAudioBuffer(base64Audio, outputAudioContextRef.current);
                  playAudioResponse(buffer);
              }
          } catch (e) {
              console.error("Failed to speak text response", e);
          }
      }

    } catch (error) {
        console.error(error);
    } finally {
      setIsTextLoading(false);
      isInterruptedRef.current = false;
    }
  };

  // --- Live Voice Logic ---

  const connectVoiceSession = async () => {
    if (isConnected || isConnecting) return;
    
    setIsConnecting(true);

    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      inputAudioContextRef.current = new AudioContextClass({ sampleRate: 16000 });
      outputAudioContextRef.current = new AudioContextClass({ sampleRate: 24000 });

      const apiKey = process.env.API_KEY || '';
      liveClientRef.current = new GoogleGenAI({ apiKey });

      const sessionPromise = liveClientRef.current.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: ['AUDIO'], 
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
        },
        callbacks: {
          onopen: async () => {
            if (mountedRef.current) {
                setIsConnected(true);
                setIsConnecting(false);
                await startMicrophone(sessionPromise);
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            handleLiveMessage(message);
          },
          onclose: () => {
            if (mountedRef.current) {
                setIsConnected(false);
                setIsVoiceMode(false);
                setAiSpeaking(false);
            }
          },
          onerror: (err) => {
            console.error("Live Session Error:", err);
            if (mountedRef.current) {
                disconnectVoiceSession();
                setIsVoiceMode(false);
            }
          }
        }
      });
      
      liveSessionRef.current = sessionPromise;

    } catch (err) {
      console.error("Failed to connect voice:", err);
      setIsConnecting(false);
    }
  };

  const startMicrophone = async (sessionPromise: Promise<any>) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
      });
      mediaStreamRef.current = stream;

      if (!inputAudioContextRef.current) return;
      await inputAudioContextRef.current.resume();

      const source = inputAudioContextRef.current.createMediaStreamSource(stream);
      const processor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
      scriptProcessorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
        const rms = Math.sqrt(sum / inputData.length);
        
        if (mountedRef.current) {
            setVoiceVolume(Math.min(rms * 5, 1));
        }

        const base64Data = float32ToBase64(inputData);
        sessionPromise.then(session => {
          session.sendRealtimeInput({
            media: { mimeType: 'audio/pcm;rate=16000', data: base64Data }
          });
        });
      };

      source.connect(processor);
      processor.connect(inputAudioContextRef.current.destination);

    } catch (err) {
      console.error("Microphone error:", err);
      disconnectVoiceSession();
    }
  };

  const handleLiveMessage = async (message: LiveServerMessage) => {
    if (message.serverContent?.interrupted) {
      stopAudioOutput();
      isInterruptedRef.current = true;
      return; 
    }
    if (message.serverContent?.turnComplete) {
        isInterruptedRef.current = false;
        setTimeout(() => { if(mountedRef.current) setAiSpeaking(false); }, 500);
    }

    const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (audioData && outputAudioContextRef.current && !isInterruptedRef.current) {
        if (!aiSpeaking) setAiSpeaking(true);
        const audioBuffer = base64ToAudioBuffer(audioData, outputAudioContextRef.current, 24000);
        playAudioResponse(audioBuffer);
    }
  };

  const playAudioResponse = (buffer: AudioBuffer) => {
    if (!outputAudioContextRef.current) return;
    const ctx = outputAudioContextRef.current;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    if (nextStartTimeRef.current < now) {
        nextStartTimeRef.current = now;
    } else if (nextStartTimeRef.current > now + 0.5 && activeSourcesRef.current.size === 0) {
        nextStartTimeRef.current = now;
    }

    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += buffer.duration;

    activeSourcesRef.current.add(source);
    source.onended = () => {
      activeSourcesRef.current.delete(source);
    };
  };

  const stopAudioOutput = () => {
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); source.disconnect(); } catch (e) {}
    });
    activeSourcesRef.current.clear();
    if (outputAudioContextRef.current) {
        nextStartTimeRef.current = outputAudioContextRef.current.currentTime;
    }
    if (mountedRef.current) setAiSpeaking(false);
  };

  const disconnectVoiceSession = () => {
    stopAudioOutput();
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    liveSessionRef.current = null;
    if (mountedRef.current) {
        setIsConnected(false);
        setIsConnecting(false);
        setVoiceVolume(0);
        setAiSpeaking(false);
    }
  };

  const toggleVoiceMode = () => {
    if (isVoiceMode) {
      disconnectVoiceSession();
      setIsVoiceMode(false);
    } else {
      setIsVoiceMode(true);
      connectVoiceSession();
    }
  };

  return (
    <div className="flex flex-col h-screen bg-nexus-900 overflow-hidden relative">
      
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-nexus-800 bg-nexus-900/95 backdrop-blur z-30">
        <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-white shadow-lg ${
                isConnected ? 'bg-nexus-accent animate-pulse' : 'bg-gradient-to-br from-nexus-500 to-indigo-600'
            }`}>N</div>
            <div>
                <h2 className="text-white font-bold tracking-wide">Nexus V2</h2>
                <span className="text-[10px] uppercase tracking-widest text-nexus-400 font-semibold">
                    {isVoiceMode ? 'Live Voice' : 'Chat & Imagem'}
                </span>
            </div>
        </div>
        <button 
          onClick={toggleVoiceMode}
          className={`px-4 py-2 rounded-full transition-all flex items-center gap-2 font-medium text-sm border ${
            isVoiceMode 
              ? 'bg-red-500/10 text-red-400 border-red-500/50 hover:bg-red-500/20' 
              : 'bg-nexus-800 text-slate-300 border-slate-700 hover:text-white hover:bg-nexus-700'
          }`}
        >
           {isVoiceMode ? (
             <>
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
                Encerrar Voz
             </>
           ) : (
             <>
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
                Conversar (Live)
             </>
           )}
        </button>
      </div>

      {isVoiceMode ? (
        // --- VOICE MODE UI ---
        <div className="flex-1 flex flex-col relative overflow-hidden bg-gradient-to-b from-nexus-900 to-black animate-fade-in">
           <div className="flex-1 flex items-center justify-center relative">
               <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div 
                    className="w-64 h-64 bg-nexus-500/10 rounded-full blur-3xl transition-all duration-100 ease-out"
                    style={{ transform: `scale(${1 + voiceVolume})` }}
                  ></div>
               </div>
               <div className="relative z-10 flex flex-col items-center">
                  <div 
                    className={`w-40 h-40 rounded-full flex items-center justify-center transition-all duration-200 shadow-[0_0_50px_rgba(59,130,246,0.3)] ${
                       aiSpeaking 
                         ? 'bg-nexus-accent scale-110 shadow-[0_0_100px_rgba(16,185,129,0.5)]' 
                         : isConnected 
                            ? 'bg-gradient-to-br from-nexus-400 to-indigo-600' 
                            : 'bg-slate-800'
                    }`}
                    style={{ transform: aiSpeaking ? 'scale(1.05)' : `scale(${1 + (voiceVolume * 0.3)})` }}
                  >
                    {isConnecting ? (
                      <svg className="animate-spin h-10 w-10 text-white/80" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    ) : aiSpeaking ? (
                       <div className="flex gap-2 items-center">
                           <div className="w-2 h-8 bg-white animate-[bounce_1s_infinite]"></div>
                           <div className="w-2 h-12 bg-white animate-[bounce_1s_infinite_0.1s]"></div>
                           <div className="w-2 h-8 bg-white animate-[bounce_1s_infinite_0.2s]"></div>
                       </div>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
                    )}
                  </div>
                  <div className="mt-8 text-center z-10 space-y-2">
                    <h3 className="text-2xl font-bold text-white transition-all">
                      {isConnecting ? "Conectando..." : aiSpeaking ? "Nexus falando..." : "Ouvindo..."}
                    </h3>
                  </div>
               </div>
           </div>
           
           {/* Hybrid Input for Voice Mode */}
           <div className="p-6 bg-nexus-900/90 backdrop-blur-md border-t border-nexus-800 z-20">
               <div className="max-w-2xl mx-auto">
                   <form onSubmit={handleSendText} className="relative">
                     <input 
                        type="text" 
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Digite algo para interromper ou pedir uma imagem..."
                        className="w-full bg-nexus-800/50 text-white border border-slate-700 rounded-full pl-6 pr-14 py-4 focus:outline-none focus:border-nexus-500 transition-colors placeholder:text-slate-500"
                     />
                     <button 
                        type="submit"
                        disabled={!input.trim() || isTextLoading}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-nexus-500 rounded-full text-white disabled:opacity-50 hover:bg-nexus-400 transition-colors"
                     >
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                     </button>
                   </form>
               </div>
           </div>
        </div>
      ) : (
        // --- TEXT CHAT UI (Main) ---
        <>
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 scroll-smooth">
            <div className="max-w-3xl mx-auto space-y-6">
                {messages.map((msg) => (
                <div 
                    key={msg.id} 
                    className={`flex flex-col ${msg.role === MessageRole.USER ? 'items-end' : 'items-start'}`}
                >
                    <div 
                    className={`max-w-[90%] sm:max-w-[80%] rounded-2xl px-5 py-4 text-base leading-relaxed shadow-lg ${
                        msg.role === MessageRole.USER 
                        ? 'bg-nexus-500 text-white rounded-tr-none' 
                        : 'bg-nexus-800 text-slate-200 rounded-tl-none border border-slate-700'
                    }`}
                    >
                    <div className="whitespace-pre-wrap">{msg.text}</div>
                    </div>

                    {/* Image Rendering */}
                    {msg.image && (
                        <div className="mt-3 max-w-sm w-full animate-fade-in">
                            <div className="rounded-xl overflow-hidden border border-slate-700 shadow-2xl relative group">
                                <img 
                                    src={`data:image/png;base64,${msg.image}`} 
                                    alt="Generated by AI" 
                                    className="w-full h-auto object-cover"
                                />
                                <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2">
                                    <span className="text-xs text-white font-medium">Gerado via Gemini 2.5 Flash Image</span>
                                </div>
                            </div>
                        </div>
                    )}
                    
                    <span className="text-[10px] text-slate-500 mt-1 px-1">
                        {msg.role === MessageRole.USER ? 'Você' : 'Nexus AI'} • {msg.timestamp.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                    </span>
                </div>
                ))}
                
                {isTextLoading && (
                <div className="flex justify-start">
                    <div className="bg-nexus-800 rounded-2xl rounded-tl-none px-5 py-4 border border-slate-700 flex items-center gap-2">
                        <span className="w-2 h-2 bg-nexus-400 rounded-full animate-bounce"></span>
                        <span className="w-2 h-2 bg-nexus-400 rounded-full animate-bounce delay-75"></span>
                        <span className="w-2 h-2 bg-nexus-400 rounded-full animate-bounce delay-150"></span>
                    </div>
                </div>
                )}
                <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="p-4 sm:p-6 border-t border-nexus-800 bg-nexus-900 z-20">
            <div className="max-w-3xl mx-auto relative">
                <form onSubmit={handleSendText}>
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Converse ou peça: 'Crie uma imagem de...'"
                        className="w-full bg-nexus-800 text-white rounded-2xl pl-6 pr-14 py-4 focus:outline-none focus:ring-2 focus:ring-nexus-500 border border-slate-700 shadow-inner text-base transition-all"
                    />
                    <button 
                        type="submit"
                        disabled={isTextLoading || !input.trim()}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-2.5 bg-nexus-500 text-white rounded-xl hover:bg-nexus-400 disabled:opacity-50 disabled:hover:bg-nexus-500 transition-all shadow-lg hover:shadow-nexus-500/30"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                    </button>
                </form>
                <div className="mt-2 text-center">
                    <p className="text-[10px] text-slate-500">
                        O Nexus pode cometer erros. Verifique informações importantes.
                    </p>
                </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default ChatInterface;
