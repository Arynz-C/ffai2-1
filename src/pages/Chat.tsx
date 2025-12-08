import { useState, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ChatInput } from "@/components/chat/ChatInput";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Menu, LogOut, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { useSelectedModel } from "@/contexts/ModelContext";
import { supabase } from "@/integrations/supabase/client";
import firefliesLogo from "@/assets/fireflies-logo.png";
import { useChatHistory, type ChatMessage as HistoryMessage } from "@/hooks/useChatHistory";

export const Chat = () => {
  const { toast } = useToast();
  const { profile, signOut, checkSubscription } = useAuth();
  const { selectedModel } = useSelectedModel();
  const {
    chatSessions,
    currentChatId,
    loading,
    setCurrentChatId,
    createNewChatSession,
    saveMessage,
    updateChatTitle,
    deleteChatSession,
    getCurrentChatMessages,
    getChatHistoryForAI,
    updateMessageContent,
    addMessageToLocal,
    generateUniqueId
  } = useChatHistory();
  
  console.log('🔄 Current selected model from hook:', selectedModel);
  
  const [isTyping, setIsTyping] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [hasStartedChatting, setHasStartedChatting] = useState(false);

  // Prevent streaming from pausing when tab becomes hidden
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        console.log('Tab hidden - keeping streams active');
      } else {
        console.log('Tab visible - streams continue normally');
      }
    };

    const preventThrottling = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const renderLoop = () => {
        if (ctx) {
          ctx.clearRect(0, 0, 1, 1);
        }
        requestAnimationFrame(renderLoop);
      };
      renderLoop();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    preventThrottling();
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Get current messages from chat history
  const messages = getCurrentChatMessages();

  // Search RAG - Direct approach without tool calling
  const handleSearchRAG = async (query: string, messageId: string, chatId: string) => {
    try {
      console.log('🔍 Starting search for:', query);
      
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      
      updateMessageContent(messageId, '⏳ Mencari informasi...');
      setIsGenerating(true);

      // Step 1: Search for URLs
      console.log('📋 Step 1: Searching for URLs...');
      const searchResponse = await fetch(`${SUPABASE_URL}/functions/v1/ollama-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          prompt: query,
          action: 'search'
        }),
      });

      if (!searchResponse.ok) {
        throw new Error('Search failed');
      }

      const searchData = await searchResponse.json();
      const urls = searchData.urls || [];
      
      if (urls.length === 0) {
        const noResultMsg = 'Maaf, tidak ditemukan hasil pencarian untuk query tersebut.';
        updateMessageContent(messageId, noResultMsg);
        await saveMessage(chatId, noResultMsg, 'assistant');
        setIsGenerating(false);
        return;
      }

      console.log(`📋 Found ${urls.length} URLs:`, urls);
      updateMessageContent(messageId, `⏳ Membaca ${urls.length} sumber...`);

      // Step 2: Fetch content from each URL
      const fetchPromises = urls.slice(0, 3).map(async (url: string) => {
        try {
          const fetchResponse = await fetch(`${SUPABASE_URL}/functions/v1/ollama-proxy`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${SUPABASE_KEY}`,
            },
            body: JSON.stringify({
              action: 'web',
              url: url
            }),
          });

          if (fetchResponse.ok) {
            const data = await fetchResponse.json();
            return { url, content: data.content || '' };
          }
          return { url, content: '' };
        } catch {
          return { url, content: '' };
        }
      });

      const fetchedContents = await Promise.all(fetchPromises);
      const validContents = fetchedContents.filter(c => c.content.length > 100);

      if (validContents.length === 0) {
        const noContentMsg = 'Maaf, tidak dapat membaca konten dari sumber yang ditemukan.';
        updateMessageContent(messageId, noContentMsg);
        await saveMessage(chatId, noContentMsg, 'assistant');
        setIsGenerating(false);
        return;
      }

      console.log(`📋 Step 2: Fetched content from ${validContents.length} sources`);
      updateMessageContent(messageId, '⏳ Menganalisis informasi...');

      // Step 3: Send to AI with context
      const response = await fetch(`${SUPABASE_URL}/functions/v1/ollama-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          prompt: query,
          model: selectedModel,
          searchContext: validContents,
          messages: [
            { role: 'user', content: query }
          ]
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Failed to get AI response');
      }

      // Stream the response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || line.startsWith(':')) continue;
          if (!line.startsWith('data: ')) continue;

          const data = line.slice(6);
          if (data === '[DONE]') {
            // Add sources at the end
            fullContent += '\n\n---\n📚 **Sumber:**\n';
            validContents.forEach((item, idx) => {
              fullContent += `${idx + 1}. ${item.url}\n`;
            });
            updateMessageContent(messageId, fullContent);
            await saveMessage(chatId, fullContent, 'assistant');
            setIsGenerating(false);
            return;
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content') {
              fullContent += parsed.content;
              updateMessageContent(messageId, fullContent);
            }
          } catch {
            // Ignore parse errors
          }
        }
      }

      // Final save
      if (fullContent && !fullContent.includes('**Sumber:**')) {
        fullContent += '\n\n---\n📚 **Sumber:**\n';
        validContents.forEach((item, idx) => {
          fullContent += `${idx + 1}. ${item.url}\n`;
        });
      }
      updateMessageContent(messageId, fullContent);
      await saveMessage(chatId, fullContent, 'assistant');
      setIsGenerating(false);
      
    } catch (error) {
      console.error('Error in search RAG:', error);
      const errorMsg = 'Maaf, terjadi kesalahan saat mencari informasi.';
      updateMessageContent(messageId, errorMsg);
      await saveMessage(chatId, errorMsg, 'assistant');
      setIsGenerating(false);
    }
  };

  // Web RAG - Direct approach without tool calling
  const handleWebRAG = async (query: string, url: string, messageId: string, chatId: string) => {
    try {
      console.log('🌐 Starting web fetch for:', url);
      
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      
      updateMessageContent(messageId, '⏳ Membaca konten website...');
      setIsGenerating(true);

      // Step 1: Fetch web content
      const fetchResponse = await fetch(`${SUPABASE_URL}/functions/v1/ollama-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          action: 'web',
          url: url
        }),
      });

      if (!fetchResponse.ok) {
        throw new Error('Failed to fetch web content');
      }

      const fetchData = await fetchResponse.json();
      const content = fetchData.content || '';

      if (content.length < 100) {
        const noContentMsg = 'Maaf, tidak dapat membaca konten dari URL tersebut.';
        updateMessageContent(messageId, noContentMsg);
        await saveMessage(chatId, noContentMsg, 'assistant');
        setIsGenerating(false);
        return;
      }

      console.log(`📋 Fetched content, length: ${content.length}`);
      updateMessageContent(messageId, '⏳ Menganalisis konten...');

      // Step 2: Send to AI with context
      const response = await fetch(`${SUPABASE_URL}/functions/v1/ollama-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          prompt: query,
          model: selectedModel,
          webContext: { url, content },
          messages: [
            { role: 'user', content: query }
          ]
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Failed to get AI response');
      }

      // Stream the response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || line.startsWith(':')) continue;
          if (!line.startsWith('data: ')) continue;

          const data = line.slice(6);
          if (data === '[DONE]') {
            fullContent += `\n\n---\n🌐 **Sumber:** ${url}`;
            updateMessageContent(messageId, fullContent);
            await saveMessage(chatId, fullContent, 'assistant');
            setIsGenerating(false);
            return;
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content') {
              fullContent += parsed.content;
              updateMessageContent(messageId, fullContent);
            }
          } catch {
            // Ignore parse errors
          }
        }
      }

      // Final save
      if (fullContent && !fullContent.includes('**Sumber:**')) {
        fullContent += `\n\n---\n🌐 **Sumber:** ${url}`;
      }
      updateMessageContent(messageId, fullContent);
      await saveMessage(chatId, fullContent, 'assistant');
      setIsGenerating(false);
      
    } catch (error) {
      console.error('Error in web RAG:', error);
      const errorMsg = 'Maaf, terjadi kesalahan saat memproses konten web.';
      updateMessageContent(messageId, errorMsg);
      await saveMessage(chatId, errorMsg, 'assistant');
      setIsGenerating(false);
    }
  };

  const handleStopGeneration = () => {
    if (abortController) {
      console.log('🛑 Stopping generation...');
      abortController.abort();
      setAbortController(null);
      setIsGenerating(false);
      setIsTyping(false);
      
      toast({
        title: "Generation Stopped",
        description: "Response generation has been stopped.",
      });
    }
  };

  const handleSendMessage = async (content: string, image?: File) => {
    console.log('🤖 Using model:', selectedModel);
    
    if (!profile) {
      toast({
        title: "Authentication Required",
        description: "Please log in to use the chat.",
        variant: "destructive",
      });
      return;
    }

    let finalContent = content;
    let targetModel = selectedModel;
    let base64Image = null;
    
    if (image) {
      targetModel = "qwen3-vl:235b-cloud";
      console.log('🖼️ Image detected, switching to vision model:', targetModel);
      
      base64Image = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(image);
      });
      
      finalContent = content || "Describe this image in detail in Indonesian language.";
      console.log('🖼️ Image converted to base64, length:', base64Image.length);
    }

    let activeChatId = currentChatId;
    if (!activeChatId) {
      const title = finalContent.length > 50 ? finalContent.substring(0, 50) + "..." : finalContent;
      activeChatId = await createNewChatSession(title);
      if (!activeChatId) return;
    }

    const userMessage: HistoryMessage = {
      id: generateUniqueId(),
      content: finalContent,
      role: 'user',
      timestamp: new Date()
    };

    addMessageToLocal(activeChatId, userMessage);
    await saveMessage(activeChatId, finalContent, 'user');
    
    if (!hasStartedChatting) {
      const title = finalContent.length > 50 ? finalContent.substring(0, 50) + "..." : finalContent;
      await updateChatTitle(activeChatId, title);
      setHasStartedChatting(true);
      setSidebarOpen(false);
    }

    setIsTyping(true);

    try {
      let finalResponse = '';
      
      // Check for RAG commands
      if (finalContent.toLowerCase().startsWith('/cari ')) {
        const query = finalContent.substring(6).trim();
        if (query) {
          const aiMessageId = generateUniqueId();
          const aiMessage: HistoryMessage = {
            id: aiMessageId,
            content: '⏳ Mencari informasi...',
            role: 'assistant',
            timestamp: new Date()
          };
          addMessageToLocal(activeChatId, aiMessage);
          setIsGenerating(true);
          setIsTyping(false);
          
          await handleSearchRAG(query, aiMessageId, activeChatId);
        } else {
          finalResponse = 'Mohon masukkan kata kunci pencarian setelah /cari';
          const aiMessage: HistoryMessage = {
            id: generateUniqueId(),
            content: finalResponse,
            role: 'assistant',
            timestamp: new Date()
          };
          addMessageToLocal(activeChatId, aiMessage);
          await saveMessage(activeChatId, finalResponse, 'assistant');
          setIsTyping(false);
        }
        return;
      }
      
      else if (finalContent.toLowerCase().startsWith('/web ')) {
        const content = finalContent.substring(5).trim();
        const urlRegex = /(https?:\/\/[^\s]+)/i;
        const urlMatch = content.match(urlRegex);
        
        if (urlMatch) {
          const url = urlMatch[0];
          const question = content.replace(url, '').trim();
          
          if (question) {
            const aiMessageId = generateUniqueId();
            const aiMessage: HistoryMessage = {
              id: aiMessageId,
              content: '⏳ Membaca konten website...',
              role: 'assistant',
              timestamp: new Date()
            };
            addMessageToLocal(activeChatId, aiMessage);
            setIsTyping(false);
            setIsGenerating(true);
            
            await handleWebRAG(question, url, aiMessageId, activeChatId);
          } else {
            finalResponse = 'Mohon masukkan pertanyaan sebelum URL. Contoh: /web ambil fungsi yang ada di web https://example.com';
            const aiMessage: HistoryMessage = {
              id: generateUniqueId(),
              content: finalResponse,
              role: 'assistant',
              timestamp: new Date()
            };
            addMessageToLocal(activeChatId, aiMessage);
            await saveMessage(activeChatId, finalResponse, 'assistant');
            setIsTyping(false);
          }
        } else {
          finalResponse = 'Mohon masukkan URL yang valid. Contoh: /web ambil fungsi yang ada di web https://example.com';
          const aiMessage: HistoryMessage = {
            id: generateUniqueId(),
            content: finalResponse,
            role: 'assistant',
            timestamp: new Date()
          };
          addMessageToLocal(activeChatId, aiMessage);
          await saveMessage(activeChatId, finalResponse, 'assistant');
          setIsTyping(false);
        }
        return;
      }

      // Regular chat
      try {
        setIsGenerating(true);
        
        const controller = new AbortController();
        setAbortController(controller);
        
        const aiMessageId = generateUniqueId();
        const aiMessage: HistoryMessage = {
          id: aiMessageId,
          content: '',
          role: 'assistant',
          timestamp: new Date()
        };
        addMessageToLocal(activeChatId, aiMessage);

        const chatHistory = getChatHistoryForAI(activeChatId);
        
        const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
        const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
        
        const requestBody: any = {
          model: targetModel,
          messages: [
            ...chatHistory,
            { role: 'user', content: finalContent }
          ],
          stream: true,
        };

        if (base64Image) {
          requestBody.image = base64Image;
        }

        console.log('📤 Sending chat request:', { model: targetModel, messageCount: requestBody.messages.length });

        const response = await fetch(`${SUPABASE_URL}/functions/v1/ollama-proxy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_KEY}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
        }

        if (!response.body) {
          throw new Error('No response body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamedContent = '';
        let thinkingContent = '';
        let isThinking = false;

        setIsTyping(false);

        while (true) {
          const { done, value } = await reader.read();
          
          if (done) {
            console.log('✅ Stream completed');
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            if (line.startsWith(':')) continue;
            
            if (!line.startsWith('data: ')) continue;
            
            const data = line.slice(6);
            
            if (data === '[DONE]') {
              console.log('✅ Received [DONE] signal');
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              
              if (parsed.type === 'thinking') {
                if (!isThinking) {
                  isThinking = true;
                  thinkingContent = '💭 **Berpikir...**\n\n';
                }
                thinkingContent += parsed.content;
                updateMessageContent(aiMessageId, thinkingContent + '\n\n---\n\n' + streamedContent);
              } else if (parsed.type === 'content') {
                if (isThinking && !streamedContent) {
                  streamedContent = '💡 **Jawaban:**\n\n';
                }
                streamedContent += parsed.content;
                
                if (thinkingContent) {
                  updateMessageContent(aiMessageId, thinkingContent + '\n\n---\n\n' + streamedContent);
                } else {
                  updateMessageContent(aiMessageId, streamedContent);
                }
              } else if (parsed.type === 'error') {
                console.error('Stream error:', parsed.content);
                streamedContent += `\n\n❌ Error: ${parsed.content}`;
                updateMessageContent(aiMessageId, streamedContent);
              }
            } catch (parseError) {
              // Ignore parse errors
            }
          }
        }

        // Save the final message
        const finalMessage = thinkingContent 
          ? thinkingContent + '\n\n---\n\n' + streamedContent 
          : streamedContent;
        
        if (finalMessage.trim()) {
          await saveMessage(activeChatId, finalMessage, 'assistant');
        }

        setAbortController(null);
        setIsGenerating(false);

      } catch (error: any) {
        if (error.name === 'AbortError') {
          console.log('Request was aborted');
          setIsGenerating(false);
          setIsTyping(false);
          return;
        }
        
        console.error('Error calling Ollama:', error);
        
        const errorMessage = error.message || 'Terjadi kesalahan saat memproses permintaan.';
        
        const aiMessage: HistoryMessage = {
          id: generateUniqueId(),
          content: `❌ Error: ${errorMessage}`,
          role: 'assistant',
          timestamp: new Date()
        };
        addMessageToLocal(activeChatId, aiMessage);
        await saveMessage(activeChatId, aiMessage.content, 'assistant');
        
        toast({
          title: "Error",
          description: errorMessage,
          variant: "destructive",
        });
        
        setIsGenerating(false);
        setIsTyping(false);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      setIsTyping(false);
      setIsGenerating(false);
      
      toast({
        title: "Error",
        description: "Failed to send message. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleNewChat = async () => {
    const newChatId = await createNewChatSession("New Chat");
    if (newChatId) {
      setHasStartedChatting(false);
    }
  };

  const handleSelectChat = (chatId: string) => {
    setCurrentChatId(chatId);
    setHasStartedChatting(true);
    if (window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  };

  const handleDeleteChat = async (chatId: string) => {
    await deleteChatSession(chatId);
  };

  const handleLogout = async () => {
    await signOut();
    toast({
      title: "Logged Out",
      description: "You have been successfully logged out.",
    });
  };

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar */}
      <div className={`${sidebarOpen ? 'w-72 md:w-80' : 'w-0'} transition-all duration-300 overflow-hidden border-r border-border bg-card flex-shrink-0`}>
        <ChatSidebar 
          chatSessions={chatSessions}
          currentChatId={currentChatId || undefined}
          onSelectChat={handleSelectChat}
          onNewChat={handleNewChat}
          onDeleteChat={handleDeleteChat}
          onEditChat={async (chatId, newTitle) => await updateChatTitle(chatId, newTitle)}
        />
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="bg-card/80 backdrop-blur-sm border-b border-border px-3 md:px-6 py-3 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2 md:gap-4 min-w-0 flex-1">
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="text-muted-foreground hover:text-foreground flex-shrink-0"
            >
              <Menu className="h-5 w-5" />
            </Button>
            
            <div className="flex items-center gap-2 min-w-0">
              <img src={firefliesLogo} alt="FireFlies" className="h-6 w-6 md:h-8 md:w-8 flex-shrink-0" />
              <span className="font-bold text-base md:text-lg text-foreground hidden sm:inline truncate">FireFlies</span>
            </div>
            
            <div className="flex-shrink-0 min-w-0 max-w-[140px] md:max-w-[200px]">
              <ModelSelector />
            </div>
          </div>
          
          <div className="flex items-center gap-1 md:gap-2 flex-shrink-0">
            {profile && (
              <div className="hidden md:flex items-center gap-2 text-xs md:text-sm text-muted-foreground">
                <span className="px-2 py-1 bg-primary/10 text-primary rounded-full truncate max-w-[100px]">
                  {profile.subscription_plan || 'Free'}
                </span>
              </div>
            )}
            
            <Button
              variant="ghost"
              size="icon"
              onClick={() => window.location.href = '/pricing'}
              className="text-muted-foreground hover:text-foreground"
              title="Upgrade Plan"
            >
              <CreditCard className="h-4 w-4 md:h-5 md:w-5" />
            </Button>
            
            <ThemeToggle />
            
            <Button
              variant="ghost"
              size="icon"
              onClick={handleLogout}
              className="text-muted-foreground hover:text-destructive"
              title="Logout"
            >
              <LogOut className="h-4 w-4 md:h-5 md:w-5" />
            </Button>
          </div>
        </div>

        {/* Messages Area */}
        <ScrollArea className="flex-1 px-2 md:px-4 py-4">
          <div className="max-w-4xl mx-auto space-y-4">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-[60vh] text-center px-4">
                <img src={firefliesLogo} alt="FireFlies" className="h-16 w-16 md:h-20 md:w-20 mb-4 opacity-50" />
                <h2 className="text-xl md:text-2xl font-bold text-foreground mb-2">Selamat datang di FireFlies</h2>
                <p className="text-sm md:text-base text-muted-foreground max-w-md">
                  Mulai percakapan dengan mengetik pesan di bawah. Gunakan <code className="bg-muted px-1 rounded">/cari</code> untuk mencari informasi atau <code className="bg-muted px-1 rounded">/web</code> untuk menganalisis website.
                </p>
              </div>
            ) : (
              messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))
            )}
            
            {isTyping && <TypingIndicator />}
          </div>
        </ScrollArea>

        {/* Input Area */}
        <div className="p-2 md:p-4 border-t border-border bg-card/50">
          <div className="max-w-4xl mx-auto">
            <ChatInput 
              onSendMessage={handleSendMessage} 
              disabled={loading}
              isGenerating={isGenerating}
              onStopGeneration={handleStopGeneration}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Chat;
