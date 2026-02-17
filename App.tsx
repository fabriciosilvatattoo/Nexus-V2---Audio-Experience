
import React from 'react';
import ChatInterface from './components/ChatInterface';

const App: React.FC = () => {
  return (
    <div className="min-h-screen bg-nexus-900 text-slate-300 font-sans selection:bg-nexus-500 selection:text-white">
      <ChatInterface />
    </div>
  );
};

export default App;
