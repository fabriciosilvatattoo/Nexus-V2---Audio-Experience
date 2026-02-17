
export interface TextChunk {
  id: number;
  title: string;
  content: string;
}

export enum MessageRole {
  USER = 'user',
  MODEL = 'model',
  SYSTEM = 'system'
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  image?: string; // Base64 string for generated images
  timestamp: Date;
}

export interface AgentState {
  isThinking: boolean;
  messages: ChatMessage[];
}
