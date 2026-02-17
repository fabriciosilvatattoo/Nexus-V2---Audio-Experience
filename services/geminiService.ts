
import { GoogleGenAI, GenerateContentResponse, Modality, FunctionDeclaration, Type } from "@google/genai";
import { MessageRole, ChatMessage } from "../types";
import { SYSTEM_INSTRUCTION } from "../constants";

// Initialize the client strictly with process.env.API_KEY
const apiKey = process.env.API_KEY || ''; 
const ai = new GoogleGenAI({ apiKey });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- Image Generation Logic ---
const generateImageFromPrompt = async (prompt: string): Promise<string> => {
  try {
    // Using gemini-2.5-flash-image for general image generation tasks
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [{ text: prompt }]
      },
      config: {
        // No specific image config needed for basic generation, keeping defaults
      }
    });

    // Iterate through parts to find the image
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return part.inlineData.data;
      }
    }
    throw new Error("No image data found in response");
  } catch (error) {
    console.error("Image Gen Error:", error);
    throw error;
  }
};

// --- Tool Definition ---
const generateImageTool: FunctionDeclaration = {
  name: 'generate_image',
  description: 'Gera uma imagem baseada em um prompt de texto. Use isso quando o usuário solicitar uma explicação visual ou desenho.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: {
        type: Type.STRING,
        description: 'A descrição detalhada da imagem a ser gerada (em inglês funciona melhor, traduza se necessário).',
      },
    },
    required: ['prompt'],
  },
};

// --- Main Chat Logic ---

export const sendMessageToNexus = async (
  history: ChatMessage[],
  newMessage: string
): Promise<{ text: string; image?: string }> => {
  const maxRetries = 3;
  let attempt = 0;

  while (true) {
    try {
      // Using gemini-3-flash-preview for text logic
      const modelId = "gemini-3-flash-preview";
      
      const contents = history
        .filter(msg => msg.role !== MessageRole.SYSTEM)
        .map(msg => ({
          role: msg.role === MessageRole.MODEL ? 'model' : 'user',
          parts: [{ text: msg.text }] // Note: We aren't sending back previous images in context to keep it simple textual context
        }));

      contents.push({
        role: 'user',
        parts: [{ text: newMessage }]
      });

      const response = await ai.models.generateContent({
        model: modelId,
        contents: contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: 0.7,
          tools: [{ functionDeclarations: [generateImageTool] }],
        }
      });

      // 1. Check for Function Calls (Image Generation)
      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        if (call.name === 'generate_image') {
          const prompt = call.args['prompt'] as string;
          
          // Execute the image generation model
          const base64Image = await generateImageFromPrompt(prompt);
          
          return {
            text: `Aqui está uma imagem gerada para: "${prompt}"`,
            image: base64Image
          };
        }
      }

      // 2. Standard Text Response
      const text = response.text;
      if (!text) {
        // Fallback if model calls tool but returns no text or generic error
        throw new Error("No response text generated.");
      }
      return { text };

    } catch (error: any) {
      const isQuotaError = error.toString().includes('429') || 
                           error.toString().includes('RESOURCE_EXHAUSTED') ||
                           error.status === 429;

      if (isQuotaError && attempt < maxRetries) {
        attempt++;
        const delay = Math.pow(2, attempt) * 2000;
        console.warn(`Gemini Quota Hit. Retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      console.error("Gemini API Error:", error);
      if (attempt >= maxRetries && isQuotaError) {
         return { text: "⚠️ O sistema está com alto tráfego (Erro 429). Aguarde um momento." };
      }
      return { text: "Desculpe, encontrei um erro ao processar sua solicitação." };
    }
  }
};

export const generateSpeech = async (text: string): Promise<string> => {
  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) throw new Error("No audio data generated.");
    return base64Audio;
  } catch (error) {
    console.error("Gemini TTS Error:", error);
    throw error;
  }
};
